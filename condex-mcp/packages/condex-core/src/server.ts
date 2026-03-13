#!/usr/bin/env node

// Block outbound network unless vector/hybrid mode needs model download
import { blockOutboundNetwork } from './security/network-guard.js'
const searchMode = process.env.CONDEX_SEARCH_MODE ?? 'bm25'
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

const PROJECT_ROOT = path.resolve(process.cwd())
const TOOL_VERSION = '1.0.0'
const SEARCH_MODE = (process.env.CONDEX_SEARCH_MODE ?? 'bm25') as SearchMode

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

  // Auto-index on startup
  let architecture: string | null = null
  try {
    const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
    if (safeFs.existsSync(metaPath)) {
      // Existing index: load then run incremental
      const loadResult = await loadProject(db, safeFs)
      if (loadResult) {
        architecture = loadResult.architecture
        console.error(
          `[condex] Loaded: ${loadResult.symbolCount} symbols, ` +
          `${loadResult.schemaCount} schema, ${loadResult.configCount} config ` +
          `in ${loadResult.loadTimeMs}ms`
        )
      }
    } else if (javaParsers) {
      // No index: run full index
      console.error(`[condex] No existing index. Running full index...`)
      const result = await indexProject(db, safeFs, {
        full: true,
        parseFileWithRefs: javaParsers.parseFileWithRefs,
        detectArch: javaParsers.detectArch,
        parseSql: javaParsers.parseSql,
        parseYaml: javaParsers.parseYaml,
      })
      architecture = result.architecture
      console.error(
        `[condex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files ` +
        `in ${result.loadTimeMs}ms`
      )
    } else {
      console.error(`[condex] No parser available and no existing index.`)
    }
  } catch (err: any) {
    console.error(`[condex] Error during startup indexing: ${err.message}`)
  }

  // Initialize embedder for vector/hybrid modes
  console.error(`[condex] Search mode: ${SEARCH_MODE}`)
  let embedder: Embedder | null = null

  if (SEARCH_MODE === 'vector' || SEARCH_MODE === 'hybrid' || SEARCH_MODE === 'smart') {
    // Step 1: Load sqlite-vec extension — MUST succeed for vector modes
    console.error(`[condex] [1/3] Loading sqlite-vec extension...`)
    try {
      loadVec(db)
      console.error(`[condex] [1/3] sqlite-vec loaded, symbol_vectors table ready`)
    } catch (err: any) {
      console.error(`[condex] FATAL: sqlite-vec failed to load: ${err.message}`)
      console.error(err.stack)
      console.error(`[condex] Fix: run "npm install" to get sqlite-vec native binary for your platform, or use CONDEX_SEARCH_MODE=bm25`)
      process.exit(1)
    }

    // Step 2: Load embedding model — MUST succeed for vector modes
    console.error(`[condex] [2/3] Loading embedding model...`)
    try {
      const { getEmbedder: getEmbed, ensureModelDownloaded, getCacheDir } = await import('./embeddings/local-embed.js')
      const modelCacheDir = getCacheDir()
      console.error(`[condex] Model cache directory: ${modelCacheDir}`)
      await ensureModelDownloaded()
      embedder = await getEmbed()
      console.error(`[condex] [2/3] Embedder ready (${embedder.dimensions} dimensions)`)
    } catch (err: any) {
      console.error(`[condex] FATAL: Embedding model failed to load: ${err.message}`)
      console.error(err.stack)
      console.error(`[condex] Fix: run "npm run download-model --workspace=packages/condex-core" or use CONDEX_SEARCH_MODE=bm25`)
      process.exit(1)
    }

    // Step 3: Build vector index for existing symbols
    console.error(`[condex] [3/3] Building vector index...`)
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
    } else {
      console.error(`[condex] [3/3] WARNING: 0 symbols to embed — vector index is empty`)
    }
  }

  // Initialize savings tracker
  const savings = new SavingsTracker(safeFs)
  setSavingsTracker(savings)

  console.error(`[condex] Thresholds: bm25=${BM25_MIN_SCORE}, vector=${VECTOR_MAX_DISTANCE}, smart_bm25=${SMART_BM25_MIN_SCORE}, smart_vector=${SMART_VECTOR_MAX_DISTANCE}`)

  // Initialize incremental reindexer for query-time change detection
  let reindexer: IncrementalReindexer | null = null
  if (javaParsers) {
    let prepareSymbolTextFn: ((s: { qualifiedName: string; signature: string; javadoc?: string | null; kind?: string }) => string) | undefined
    if (embedder) {
      const { prepareSymbolText } = await import('./embeddings/local-embed.js')
      prepareSymbolTextFn = prepareSymbolText
    }

    reindexer = new IncrementalReindexer({
      db,
      projectRoot: PROJECT_ROOT,
      projectId: namespace,
      parseFileWithRefs: javaParsers.parseFileWithRefs,
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
