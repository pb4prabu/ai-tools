#!/usr/bin/env node

// Block outbound network unless vector/hybrid mode needs model download
import { blockOutboundNetwork } from './security/network-guard.js'
const searchMode = process.env.CONDEX_SEARCH_MODE ?? 'smart'
if (searchMode === 'bm25') {
  blockOutboundNetwork()
} else {
  console.error(`[condex] Network guard DISABLED for ${searchMode} mode (model download may be needed)`)
}
// smart mode also needs embedder for vector fallback

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
import type { HandlerContext, SearchMode } from './mcp/handlers.js'
import type { Embedder } from './embeddings/local-embed.js'
import { loadVec, insertVectors } from './retrieval/vector-search.js'
import { writeErrorLog, writeIndexStatus, initCondexDir, type IndexStatus } from './store/fs-store.js'

const PROJECT_ROOT = path.resolve(process.cwd())
const TOOL_VERSION = '1.0.0'
const SEARCH_MODE = (process.env.CONDEX_SEARCH_MODE ?? 'smart') as SearchMode

// Configurable thresholds via env vars
const BM25_MIN_SCORE = parseFloat(process.env.CONDEX_BM25_MIN_SCORE ?? '0.3')
const VECTOR_MAX_DISTANCE = parseFloat(process.env.CONDEX_VECTOR_MAX_DISTANCE ?? '0.95')
const SMART_BM25_MIN_SCORE = parseFloat(process.env.CONDEX_SMART_BM25_MIN_SCORE ?? '0.5')
const SMART_VECTOR_MAX_DISTANCE = parseFloat(process.env.CONDEX_SMART_VECTOR_MAX_DISTANCE ?? '0.90')

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

  // Initialize in-memory SQLite
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)

  // Generate project namespace
  const namespace = generateNamespace(PROJECT_ROOT)
  const projectName = path.basename(PROJECT_ROOT)
  console.error(`[condex] Namespace: ${namespace}`)

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
    searchMode: SEARCH_MODE,
    bm25: { status: 'not_started' },
    vector: { status: 'not_started' },
    lastUpdated: new Date().toISOString(),
  }

  let bm25SymbolCount = 0
  try {
    const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
    if (safeFs.existsSync(metaPath)) {
      // Existing index: load then run incremental
      const loadResult = await loadProject(db, safeFs)
      if (loadResult) {
        architecture = loadResult.architecture
        bm25SymbolCount = loadResult.symbolCount
        console.error(
          `[condex] Loaded: ${loadResult.symbolCount} symbols, ` +
          `${loadResult.schemaCount} schema, ${loadResult.configCount} config ` +
          `in ${loadResult.loadTimeMs}ms`
        )
      }
      indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
    } else if (compositeParser) {
      // No index: run full index
      console.error(`[condex] No existing index. Running full index...`)
      const result = await indexProject(db, safeFs, {
        full: true,
        parseFileWithRefs: compositeParser,
        detectArch: javaParsers?.detectArch,
        parseSql: javaParsers?.parseSql,
        parseYaml: javaParsers?.parseYaml,
      })
      architecture = result.architecture
      bm25SymbolCount = result.symbolCount
      console.error(
        `[condex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files ` +
        `in ${result.loadTimeMs}ms`
      )
      indexStatus.bm25 = { status: 'success', symbolCount: bm25SymbolCount, timestamp: new Date().toISOString() }
    } else {
      console.error(`[condex] No parser available and no existing index. Install @condex-ai/java or @condex-ai/multi-lang.`)
      indexStatus.bm25 = { status: 'skipped', error: 'No parser available', timestamp: new Date().toISOString() }
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
        context: { projectRoot: PROJECT_ROOT, searchMode: SEARCH_MODE },
      })
    } catch { /* best effort */ }
  }

  // Initialize embedder — smart mode gracefully degrades, other modes require it
  console.error(`[condex] Search mode: ${SEARCH_MODE}`)
  let embedder: Embedder | null = null
  let vecReady = false

  if (SEARCH_MODE === 'vector' || SEARCH_MODE === 'hybrid' || SEARCH_MODE === 'smart') {
    // Step 1: Load sqlite-vec extension
    console.error(`[condex] [1/3] Loading sqlite-vec extension...`)
    try {
      loadVec(db)
      console.error(`[condex] [1/3] sqlite-vec loaded, symbol_vectors table ready`)
      vecReady = true
    } catch (err: any) {
      console.error(`[condex] sqlite-vec failed to load: ${err.message}`)
      if (SEARCH_MODE === 'smart') {
        console.error(`[condex] Degrading to BM25-only (vector unavailable)`)
        indexStatus.vector = { status: 'failed', error: `sqlite-vec load failed: ${err.message}`, timestamp: new Date().toISOString() }
      } else {
        console.error(`[condex] FATAL: sqlite-vec required for ${SEARCH_MODE} mode`)
        indexStatus.vector = { status: 'failed', error: `sqlite-vec load failed: ${err.message}`, timestamp: new Date().toISOString() }
        indexStatus.lastUpdated = new Date().toISOString()
        try { await writeIndexStatus(safeFs, indexStatus) } catch { /* best effort */ }
        process.exit(1)
      }
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
        console.error(`[condex] Embedding model failed to load: ${err.message}`)
        vecReady = false
        if (SEARCH_MODE === 'smart') {
          console.error(`[condex] Degrading to BM25-only (embedder unavailable)`)
          indexStatus.vector = { status: 'failed', error: `Embedding model failed: ${err.message}`, timestamp: new Date().toISOString() }
        } else {
          console.error(`[condex] FATAL: Embedder required for ${SEARCH_MODE} mode`)
          indexStatus.vector = { status: 'failed', error: `Embedding model failed: ${err.message}`, timestamp: new Date().toISOString() }
          indexStatus.lastUpdated = new Date().toISOString()
          try { await writeIndexStatus(safeFs, indexStatus) } catch { /* best effort */ }
          process.exit(1)
        }
      }
    }

    // Step 3: Build vector index for existing symbols (skip if step 1 or 2 failed)
    if (vecReady && embedder) {
    console.error(`[condex] [3/3] Building vector index...`)
    try {
      const { prepareSymbolText } = await import('./embeddings/local-embed.js')
      const allSymbols = db.prepare(
        'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
      ).all(namespace) as { id: string; qualified_name: string; signature: string; javadoc: string | null; kind: string }[]

      if (allSymbols.length > 0) {
        console.error(`[condex] Embedding ${allSymbols.length} symbols...`)
        const batchSize = 50
        let embedded = 0
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
          embedded += batch.length
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
          context: { projectRoot: PROJECT_ROOT, searchMode: SEARCH_MODE, bm25SymbolCount },
        })
      } catch { /* best effort */ }
    }
    } // end if (vecReady && embedder)
  } else {
    indexStatus.vector = { status: 'skipped', error: `Search mode is ${SEARCH_MODE} — vector not needed`, timestamp: new Date().toISOString() }
  }

  // Write final index status
  indexStatus.lastUpdated = new Date().toISOString()
  try { await writeIndexStatus(safeFs, indexStatus) } catch { /* best effort */ }

  // Initialize savings tracker
  const savings = new SavingsTracker(safeFs)
  setSavingsTracker(savings)

  console.error(`[condex] Thresholds: bm25=${BM25_MIN_SCORE}, vector=${VECTOR_MAX_DISTANCE}, smart_bm25=${SMART_BM25_MIN_SCORE}, smart_vector=${SMART_VECTOR_MAX_DISTANCE}`)

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

  // Build handler context
  const ctx: HandlerContext = {
    db,
    safeFs,
    projectId: namespace,
    projectName,
    architecture,
    searchMode: SEARCH_MODE,
    embedder,
    thresholds: {
      bm25MinScore: BM25_MIN_SCORE,
      vectorMaxDistance: VECTOR_MAX_DISTANCE,
      smartBm25MinScore: SMART_BM25_MIN_SCORE,
      smartVectorMaxDistance: SMART_VECTOR_MAX_DISTANCE,
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
