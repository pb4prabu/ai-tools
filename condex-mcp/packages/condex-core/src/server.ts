#!/usr/bin/env node

// Block outbound network unless vector/hybrid is in the search chain (needs model download)
import { blockOutboundNetwork } from './security/network-guard.js'
const rawSearchMode = process.env.CONDEX_SEARCH_MODE ?? 'vector,bm25'
const needsNetwork = rawSearchMode.includes('vector') || rawSearchMode.includes('hybrid')
if (!needsNetwork) {
  blockOutboundNetwork()
} else {
  console.error(`[condex] Network guard DISABLED (vector/hybrid in chain — model download may be needed)`)
}

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { SafeFS } from './security/fs-guard.js'
import { generateNamespace } from './namespace/namespace.js'
import { createSchema } from './store/sqlite-store.js'
import { loadProject } from './store/loader.js'
import { indexProject, type ParseFileFn, type ParseFileWithRefsFn, type DetectArchFn, type ParseSqlFn, type ParseYamlFn } from './indexer/indexer.js'
import { IncrementalReindexer } from './indexer/incremental-reindexer.js'
import { TOOL_DEFINITIONS } from './mcp/tools.js'
import { dispatch } from './mcp/dispatcher.js'
import { setSavingsTracker } from './mcp/meta.js'
import { SavingsTracker } from './token/savings.js'
import type { HandlerContext } from './mcp/handlers.js'
import type { Embedder } from './embeddings/local-embed.js'
import { loadVec, insertVectors } from './retrieval/vector-search.js'
import { writeErrorLog, writeIndexStatus, initCondexDir, type IndexStatus } from './store/fs-store.js'

const PROJECT_ROOT = path.resolve(process.cwd())
const TOOL_VERSION = '1.0.0'

// Parse search chain: "vector,bm25" → ['vector', 'bm25']
// Default: vector first, BM25 fallback
type SearchMode = 'bm25' | 'vector' | 'hybrid'
const VALID_MODES = new Set<string>(['bm25', 'vector', 'hybrid'])
const SEARCH_CHAIN: SearchMode[] = (process.env.CONDEX_SEARCH_MODE ?? 'vector,bm25')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(s => VALID_MODES.has(s)) as SearchMode[]
if (SEARCH_CHAIN.length === 0) SEARCH_CHAIN.push('vector', 'bm25') // safe fallback

// Configurable thresholds via env vars
const BM25_MIN_SCORE = parseFloat(process.env.CONDEX_BM25_MIN_SCORE ?? '0.3')
const VECTOR_MAX_DISTANCE = parseFloat(process.env.CONDEX_VECTOR_MAX_DISTANCE ?? '0.95')

/**
 * Try to load the Java parser. Returns null if not installed.
 */
function loadJavaParser(): {
  parseFile: ParseFileFn
  parseFileWithRefs: ParseFileWithRefsFn
  detectArch: DetectArchFn
  parseSql: ParseSqlFn
  parseYaml: ParseYamlFn
} | null {
  try {
    const esmRequire = createRequire(import.meta.url)
    const javaPkg = esmRequire('@condex-ai/java')
    return {
      parseFile: javaPkg.parseJavaFile as ParseFileFn,
      parseFileWithRefs: javaPkg.parseJavaFileWithRefs as ParseFileWithRefsFn,
      detectArch: javaPkg.detectArchitecture as DetectArchFn,
      parseSql: javaPkg.parseSqlFile as ParseSqlFn,
      parseYaml: javaPkg.parseYamlFile as ParseYamlFn,
    }
  } catch {
    return null
  }
}

/**
 * Try to load the multi-language tree-sitter parser. Returns null if not installed.
 */
function loadMultiLangParser(): {
  parseMultiLangFile: (content: string, opts: { projectId: string; filePath: string }) => import('./types/symbol.js').Symbol[] | null
  detectLanguageFromExt: (filePath: string) => string | null
  getSupportedLanguages: () => string[]
  EXTENSION_MAP: Record<string, string>
} | null {
  try {
    const esmRequire = createRequire(import.meta.url)
    const multiLangPkg = esmRequire('@condex-ai/multi-lang')
    return {
      parseMultiLangFile: multiLangPkg.parseMultiLangFile,
      detectLanguageFromExt: multiLangPkg.detectLanguageFromExt,
      getSupportedLanguages: multiLangPkg.getSupportedLanguages,
      EXTENSION_MAP: multiLangPkg.EXTENSION_MAP,
    }
  } catch {
    return null
  }
}

/** Java file extensions handled by the Java parser */
const JAVA_EXTENSIONS = new Set(['.java'])

/**
 * Create a composite parser that routes .java to Java parser
 * and all other supported extensions to multi-lang tree-sitter parser.
 * Falls through to generic file parser (in indexer.ts) if neither handles the file.
 */
function createCompositeParser(
  javaParsers: ReturnType<typeof loadJavaParser>,
  multiLangParser: ReturnType<typeof loadMultiLangParser>
): ParseFileWithRefsFn | undefined {
  if (!javaParsers && !multiLangParser) return undefined

  return (content: string, opts: { projectId: string; filePath: string; profile?: any }) => {
    const ext = path.extname(opts.filePath).toLowerCase()

    // Route .java files to the Java parser (fine-grained: classes, methods, fields, annotations)
    if (JAVA_EXTENSIONS.has(ext) && javaParsers) {
      return javaParsers.parseFileWithRefs(content, opts)
    }

    // Route other supported files to multi-lang tree-sitter parser
    if (multiLangParser) {
      const symbols = multiLangParser.parseMultiLangFile(content, opts)
      if (symbols && symbols.length > 0) {
        return { symbols, refs: [] }
      }
    }

    // Return empty — indexer.ts will fall through to generic file parser
    return { symbols: [], refs: [] }
  }
}

async function main() {
  console.error(`[condex] Starting Condex MCP Server`)
  console.error(`[condex] Project root: ${PROJECT_ROOT}`)

  // Initialize SafeFS — restricts all file ops to project root
  const safeFs = new SafeFS(PROJECT_ROOT)

  // Initialize persistent SQLite at .condex/index.db
  const condexDir = path.join(PROJECT_ROOT, '.condex')
  fs.mkdirSync(condexDir, { recursive: true })
  const dbPath = path.join(condexDir, 'index.db')
  const dbExisted = fs.existsSync(dbPath)
  let db: InstanceType<typeof Database>
  try {
    db = new Database(dbPath)
  } catch {
    // Corrupt DB — delete and retry
    console.error(`[condex] WARNING: Corrupt index.db — recreating`)
    try { fs.unlinkSync(dbPath) } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal') } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm') } catch { /* ignore */ }
    db = new Database(dbPath)
  }
  db.pragma('journal_mode = WAL')
  createSchema(db) // uses IF NOT EXISTS — safe on existing DBs

  // Generate project namespace
  const namespace = generateNamespace(PROJECT_ROOT)
  const projectName = path.basename(PROJECT_ROOT)
  console.error(`[condex] Namespace: ${namespace}`)
  console.error(`[condex] Database: ${dbPath} (${dbExisted ? 'existing' : 'new'})`)

  // Load parsers
  const javaParsers = loadJavaParser()
  if (javaParsers) {
    console.error(`[condex] Java parser loaded`)
  }

  const multiLangParser = loadMultiLangParser()
  if (multiLangParser) {
    const supported = multiLangParser.getSupportedLanguages()
    console.error(`[condex] Multi-lang parser loaded (${supported.length} languages: ${supported.join(', ')})`)
  }

  // Create composite parser: Java → Java parser, others → multi-lang, fallback → generic
  const compositeParser = createCompositeParser(javaParsers, multiLangParser)

  // Auto-index on startup
  let architecture: string | null = null
  const indexStatus: IndexStatus = {
    searchMode: SEARCH_CHAIN.join(','),
    bm25: { status: 'not_started' },
    vector: { status: 'not_started' },
    lastUpdated: new Date().toISOString(),
  }

  const chainNeedsVector = SEARCH_CHAIN.includes('vector') || SEARCH_CHAIN.includes('hybrid')

  let bm25SymbolCount = 0
  try {
    if (dbExisted) {
      // Persistent DB exists — check if it has symbols (skip JSON loading)
      bm25SymbolCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?')
        .get(namespace) as any)?.cnt ?? 0
      if (bm25SymbolCount > 0) {
        // Read architecture from meta.json (lightweight)
        const { readMeta: readMetaStartup } = await import('./store/fs-store.js')
        const meta = await readMetaStartup(safeFs)
        architecture = meta?.architecture ?? null
        console.error(`[condex] Opened persistent DB: ${bm25SymbolCount} symbols`)
        indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
      } else {
        // DB exists but empty — fall through to JSON loading or full index
        console.error(`[condex] Persistent DB empty — loading from JSON or re-indexing`)
        const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
        if (safeFs.existsSync(metaPath)) {
          const loadResult = await loadProject(db, safeFs)
          if (loadResult) {
            architecture = loadResult.architecture
            bm25SymbolCount = loadResult.symbolCount
            console.error(`[condex] Loaded from JSON: ${loadResult.symbolCount} symbols in ${loadResult.loadTimeMs}ms`)
          }
          indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
        } else if (compositeParser) {
          console.error(`[condex] No existing index. Running full index...`)
          const result = await indexProject(db, safeFs, { full: true, parseFileWithRefs: compositeParser, detectArch: javaParsers?.detectArch, parseSql: javaParsers?.parseSql, parseYaml: javaParsers?.parseYaml })
          architecture = result.architecture
          bm25SymbolCount = result.symbolCount
          console.error(`[condex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files in ${result.loadTimeMs}ms`)
          indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
        } else {
          console.error(`[condex] No parser available and no existing index. Install @condex-ai/java or @condex-ai/multi-lang.`)
          indexStatus.bm25 = { status: 'skipped', error: 'No parser available', timestamp: new Date().toISOString() }
        }
      }
    } else {
      // Fresh DB — check for JSON index or run full index
      const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
      if (safeFs.existsSync(metaPath)) {
        const loadResult = await loadProject(db, safeFs)
        if (loadResult) {
          architecture = loadResult.architecture
          bm25SymbolCount = loadResult.symbolCount
          console.error(`[condex] Loaded from JSON into new DB: ${loadResult.symbolCount} symbols in ${loadResult.loadTimeMs}ms`)
        }
        indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
      } else if (compositeParser) {
        console.error(`[condex] No existing index. Running full index...`)
        const result = await indexProject(db, safeFs, { full: true, parseFileWithRefs: compositeParser, detectArch: javaParsers?.detectArch, parseSql: javaParsers?.parseSql, parseYaml: javaParsers?.parseYaml })
        architecture = result.architecture
        bm25SymbolCount = result.symbolCount
        console.error(`[condex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files in ${result.loadTimeMs}ms`)
        indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
      } else {
        console.error(`[condex] No parser available and no existing index. Install @condex-ai/java or @condex-ai/multi-lang.`)
        indexStatus.bm25 = { status: 'skipped', error: 'No parser available', timestamp: new Date().toISOString() }
      }
    }
  } catch (err: any) {
    console.error(`[condex] Error during startup indexing: ${err.message}`)
    indexStatus.bm25 = { status: 'failed', error: err.message, timestamp: new Date().toISOString() }
    try {
      await initCondexDir(safeFs)
      await writeErrorLog(safeFs, {
        phase: 'startup:bm25',
        message: err.message,
        stack: err.stack,
        context: { projectRoot: PROJECT_ROOT, searchChain: SEARCH_CHAIN },
      })
    } catch { /* best effort */ }
  }

  // Initialize embedder if vector/hybrid is in the chain
  console.error(`[condex] Search chain: [${SEARCH_CHAIN.join(', ')}]`)
  let embedder: Embedder | null = null
  let vecReady = false
  let effectiveSearchChain = [...SEARCH_CHAIN]

  if (chainNeedsVector) {
    // Step 1: Load sqlite-vec extension
    console.error(`[condex] [1/3] Loading sqlite-vec extension...`)
    try {
      loadVec(db)
      console.error(`[condex] [1/3] sqlite-vec loaded, symbol_vectors table ready`)
      vecReady = true
    } catch (err: any) {
      console.error(`[condex] WARNING: sqlite-vec failed to load: ${err.message}`)
      console.error(`[condex] Removing vector/hybrid from search chain`)
      indexStatus.vector = { status: 'failed', error: `sqlite-vec load failed: ${err.message}`, timestamp: new Date().toISOString() }
      effectiveSearchChain = effectiveSearchChain.filter(m => m === 'bm25')
      if (effectiveSearchChain.length === 0) effectiveSearchChain.push('bm25')
    }

    // Step 2: Load embedding model (skip if step 1 failed)
    if (vecReady) {
      console.error(`[condex] [2/3] Loading embedding model...`)
      try {
        const { getEmbedder: getEmbed, ensureModelDownloaded, getCacheDir } = await import('./embeddings/local-embed.js')
        const modelCacheDir = getCacheDir()
        console.error(`[condex] Model cache directory: ${modelCacheDir}`)
        await ensureModelDownloaded()
        embedder = await getEmbed()
        console.error(`[condex] [2/3] Embedder ready (${embedder.dimensions} dimensions)`)
      } catch (err: any) {
        console.error(`[condex] WARNING: Embedding model failed to load: ${err.message}`)
        console.error(`[condex] Removing vector/hybrid from search chain`)
        vecReady = false
        indexStatus.vector = { status: 'failed', error: `Embedding model failed: ${err.message}`, timestamp: new Date().toISOString() }
        effectiveSearchChain = effectiveSearchChain.filter(m => m === 'bm25')
        if (effectiveSearchChain.length === 0) effectiveSearchChain.push('bm25')
      }
    }

    // Step 3: Build vector index for existing symbols (skip if step 1 or 2 failed)
    if (vecReady && embedder) {
      // Check if persistent DB already has vectors
      let existingVecCount = 0
      try {
        existingVecCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbol_vectors').get() as any)?.cnt ?? 0
      } catch { /* table may not exist yet */ }

      if (existingVecCount > 0 && dbExisted) {
        console.error(`[condex] [3/3] Vector index loaded from persistent DB: ${existingVecCount} vectors`)
        indexStatus.vector = { status: 'success', symbolCount: existingVecCount, timestamp: new Date().toISOString() }
      } else {
        console.error(`[condex] [3/3] Building vector index...`)
        try {
          const { prepareSymbolText } = await import('./embeddings/local-embed.js')
          const allSymbols = db.prepare(
            'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
          ).all(namespace) as { id: string; qualified_name: string; signature: string; javadoc: string | null; kind: string }[]

          if (allSymbols.length > 0) {
            console.error(`[condex] Embedding ${allSymbols.length} symbols...`)
            const batchSize = 50
            for (let i = 0; i < allSymbols.length; i += batchSize) {
              const batch = allSymbols.slice(i, i + batchSize)
              const texts = batch.map(s => prepareSymbolText({
                qualifiedName: s.qualified_name,
                signature: s.signature,
                javadoc: s.javadoc,
                kind: s.kind,
              }))
              const embeddings = await embedder.embedBatch(texts)
              const vectors = batch.map((s, idx) => ({
                symbolId: s.id,
                embedding: embeddings[idx],
              }))
              insertVectors(db, vectors)
            }
            console.error(`[condex] [3/3] Vector index built for ${allSymbols.length} symbols`)
            indexStatus.vector = { status: 'success', symbolCount: allSymbols.length, timestamp: new Date().toISOString() }
          } else {
            console.error(`[condex] [3/3] WARNING: 0 symbols to embed — vector index is empty`)
            indexStatus.vector = { status: 'success', symbolCount: 0, error: 'No symbols to embed (BM25 index may be empty)', timestamp: new Date().toISOString() }
          }
        } catch (err: any) {
          console.error(`[condex] Error building vector index: ${err.message}`)
          indexStatus.vector = { status: 'failed', error: `Embedding failed: ${err.message}`, timestamp: new Date().toISOString() }
          try {
            await writeErrorLog(safeFs, {
              phase: 'startup:vector',
              message: err.message,
              stack: err.stack,
              context: { projectRoot: PROJECT_ROOT, searchChain: SEARCH_CHAIN, bm25SymbolCount },
            })
          } catch { /* best effort */ }
        }
      }
    } // end if (vecReady && embedder)
  } else {
    indexStatus.vector = { status: 'skipped', error: `Search chain [${SEARCH_CHAIN.join(',')}] does not include vector/hybrid`, timestamp: new Date().toISOString() }
  }

  // Write final index status
  indexStatus.lastUpdated = new Date().toISOString()
  try { await writeIndexStatus(safeFs, indexStatus) } catch { /* best effort */ }

  // Initialize savings tracker
  const savings = new SavingsTracker(safeFs)
  setSavingsTracker(savings)

  console.error(`[condex] Thresholds: bm25=${BM25_MIN_SCORE}, vector=${VECTOR_MAX_DISTANCE}`)

  // Initialize incremental reindexer for query-time change detection
  let reindexer: IncrementalReindexer | null = null
  if (compositeParser) {
    let prepareSymbolTextFn: ((s: { qualifiedName: string; signature: string; javadoc?: string | null; kind?: string }) => string) | undefined
    if (embedder) {
      const { prepareSymbolText } = await import('./embeddings/local-embed.js')
      prepareSymbolTextFn = prepareSymbolText
    }

    reindexer = new IncrementalReindexer({
      db,
      projectRoot: PROJECT_ROOT,
      projectId: namespace,
      parseFileWithRefs: compositeParser,
      embedder,
      prepareSymbolText: prepareSymbolTextFn,
    })

    // Seed the hash cache from the meta.json file hashes (or build from current files)
    try {
      const { readMeta } = await import('./store/fs-store.js')
      const meta = await readMeta(safeFs)
      if (meta?.fileHashes) {
        reindexer.initializeHashes(meta.fileHashes)
        console.error(`[condex] Incremental reindexer ready (tracking ${Object.keys(meta.fileHashes).length} files)`)
      } else {
        reindexer.initializeHashes({})
        console.error(`[condex] Incremental reindexer ready (no prior hashes, will index all on first query)`)
      }
    } catch {
      reindexer.initializeHashes({})
    }
  }

  if (effectiveSearchChain.join(',') !== SEARCH_CHAIN.join(',')) {
    console.error(`[condex] Effective search chain: [${effectiveSearchChain.join(', ')}] (requested: [${SEARCH_CHAIN.join(', ')}])`)
  }

  // Build handler context
  const ctx: HandlerContext = {
    db,
    safeFs,
    projectId: namespace,
    projectName,
    architecture,
    searchChain: effectiveSearchChain,
    embedder,
    thresholds: {
      bm25MinScore: BM25_MIN_SCORE,
      vectorMaxDistance: VECTOR_MAX_DISTANCE,
    },
    reindexer,
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'condex-mcp',
      version: TOOL_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  )

  // Register tool list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // For index_folder: use actual parser if available
    if (name === 'index_folder' && javaParsers) {
      const full = (args as any)?.full ?? false
      const result = await indexProject(db, safeFs, {
        full,
        parseFileWithRefs: javaParsers.parseFileWithRefs,
        detectArch: javaParsers.detectArch,
        parseSql: javaParsers.parseSql,
        parseYaml: javaParsers.parseYaml,
      })
      ctx.architecture = result.architecture

      // Refresh the reindexer hash cache after manual re-index
      if (reindexer) {
        try {
          const { readMeta: readMetaFn } = await import('./store/fs-store.js')
          const meta = await readMetaFn(safeFs)
          if (meta?.fileHashes) {
            reindexer.initializeHashes(meta.fileHashes)
          }
        } catch { /* ignore */ }
      }

      // Rebuild vector index for all symbols after re-index
      if (embedder) {
        try {
          const { prepareSymbolText: prepSymText } = await import('./embeddings/local-embed.js')
          const { clearVectors: clearVec } = await import('./retrieval/vector-search.js')
          const allSymbols = db.prepare(
            'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
          ).all(namespace) as { id: string; qualified_name: string; signature: string; javadoc: string | null; kind: string }[]

          if (allSymbols.length > 0) {
            clearVec(db, namespace)
            const batchSize = 50
            for (let i = 0; i < allSymbols.length; i += batchSize) {
              const batch = allSymbols.slice(i, i + batchSize)
              const texts = batch.map(s => prepSymText({
                qualifiedName: s.qualified_name,
                signature: s.signature,
                javadoc: s.javadoc,
                kind: s.kind,
              }))
              const embeddings = await embedder.embedBatch(texts)
              const vectors = batch.map((s, idx) => ({
                symbolId: s.id,
                embedding: embeddings[idx],
              }))
              insertVectors(db, vectors)
            }
            console.error(`[condex] Vector index rebuilt after index_folder (${allSymbols.length} symbols)`)
          }
        } catch (err: any) {
          console.error(`[condex] Failed to rebuild vector index after index_folder: ${err.message}`)
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: 'indexed',
            ...result,
          }, null, 2),
        }],
      }
    }

    const result = await dispatch(name, args ?? {}, ctx)
    return result
  })

  // Connect via stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`[condex] Server ready. ${TOOL_DEFINITIONS.length} tools available.`)
}

main().catch(err => {
  console.error(`[condex] Fatal error: ${err.message}`)
  process.exit(1)
})
