#!/usr/bin/env node

// ── FIRST THING: ensure OS-level network sandbox ──────────────
// If not already sandboxed, re-exec inside sandbox-exec (macOS) or unshare --net (Linux).
// Returns true if this is the parent (child is spawned, parent just waits).
import { ensureOsSandbox } from './security/sandbox-launcher.js'
const isParent = ensureOsSandbox()

// ── SECOND: block all outbound network at Node.js level ───────
// Runs in both parent and child — defense in depth. Harmless in parent.
import { blockOutboundNetwork } from './security/network-guard.js'
if (!isParent) {
  blockOutboundNetwork()
}

import fs, { existsSync } from 'node:fs'
import path, { join } from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { SafeFS } from './security/fs-guard.js'
import { generateNamespace } from './namespace/namespace.js'
import { createSchema } from './store/sqlite-store.js'
import { loadProject } from './store/loader.js'
import { indexProject, type ParseFileWithRefsFn, type DetectArchFn, type ParseSqlFn, type ParseYamlFn } from './indexer/indexer.js'
import { IncrementalReindexer } from './indexer/incremental-reindexer.js'
import { TOOL_DEFINITIONS } from './mcp/tools.js'
import { dispatch } from './mcp/dispatcher.js'
import { setSavingsTracker } from './mcp/meta.js'
import { SavingsTracker } from './token/savings.js'
import type { HandlerContext } from './mcp/handlers.js'
import type { Embedder } from './embeddings/local-embed.js'
import { loadVec } from './retrieval/vector-search.js'
import { buildVectorIndex, type PrepareSymbolTextFn } from './retrieval/vector-embed.js'
import { writeErrorLog, writeIndexStatus, initCondexDir, readMeta, type IndexStatus, type IndexPipelineStatus } from './store/fs-store.js'

const PROJECT_ROOT = path.resolve(process.cwd())
const TOOL_VERSION = '1.0.0'

// ── Search chain config ───────────────────────────────────

type SearchMode = 'bm25' | 'vector' | 'hybrid'
const VALID_MODES = new Set<string>(['bm25', 'vector', 'hybrid'])
const SEARCH_CHAIN: SearchMode[] = (process.env.CONDEX_SEARCH_MODE ?? 'vector,bm25')
  .split(',').map(s => s.trim().toLowerCase())
  .filter(s => VALID_MODES.has(s)) as SearchMode[]
if (SEARCH_CHAIN.length === 0) SEARCH_CHAIN.push('vector', 'bm25')

const BM25_MIN_SCORE = parseFloat(process.env.CONDEX_BM25_MIN_SCORE ?? '0.3')
const VECTOR_MAX_DISTANCE = parseFloat(process.env.CONDEX_VECTOR_MAX_DISTANCE ?? '0.95')

// ── Parser loaders ────────────────────────────────────────

function loadJavaParser() {
  try {
    const esmRequire = createRequire(import.meta.url)
    const pkg = esmRequire('@condex-ai/java')
    return {
      parseFileWithRefs: pkg.parseJavaFileWithRefs as ParseFileWithRefsFn,
      detectArch: pkg.detectArchitecture as DetectArchFn,
      parseSql: pkg.parseSqlFile as ParseSqlFn,
      parseYaml: pkg.parseYamlFile as ParseYamlFn,
    }
  } catch { return null }
}

function loadMultiLangParser() {
  try {
    const esmRequire = createRequire(import.meta.url)
    const pkg = esmRequire('@condex-ai/multi-lang')
    return {
      parseMultiLangFile: pkg.parseMultiLangFile as (content: string, opts: { projectId: string; filePath: string }) => import('./types/symbol.js').Symbol[] | null,
      getSupportedLanguages: pkg.getSupportedLanguages as () => string[],
    }
  } catch { return null }
}

const JAVA_EXTENSIONS = new Set(['.java'])

function createCompositeParser(
  javaParsers: ReturnType<typeof loadJavaParser>,
  multiLangParser: ReturnType<typeof loadMultiLangParser>,
): ParseFileWithRefsFn | undefined {
  if (!javaParsers && !multiLangParser) return undefined

  return (content, opts) => {
    const ext = path.extname(opts.filePath).toLowerCase()

    if (JAVA_EXTENSIONS.has(ext) && javaParsers) {
      return javaParsers.parseFileWithRefs(content, opts)
    }

    if (multiLangParser) {
      const symbols = multiLangParser.parseMultiLangFile(content, opts)
      if (symbols && symbols.length > 0) return { symbols, refs: [] }
    }

    return { symbols: [], refs: [] }
  }
}

// ── Database initialization ───────────────────────────────

function initDatabase(condexDir: string): { db: InstanceType<typeof Database>; dbExisted: boolean } {
  fs.mkdirSync(condexDir, { recursive: true })
  const dbPath = path.join(condexDir, 'index.db')
  const dbExisted = fs.existsSync(dbPath)

  let db: InstanceType<typeof Database>
  try {
    db = new Database(dbPath)
  } catch {
    console.error(`[condex] WARNING: Corrupt index.db — recreating`)
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(f) } catch { /* ignore */ }
    }
    db = new Database(dbPath)
  }

  db.pragma('journal_mode = WAL')
  createSchema(db)
  return { db, dbExisted }
}

// ── BM25 startup loading ──────────────────────────────────

async function loadOrIndexBm25(
  db: InstanceType<typeof Database>,
  safeFs: SafeFS,
  namespace: string,
  dbExisted: boolean,
  compositeParser: ParseFileWithRefsFn | undefined,
  javaParsers: ReturnType<typeof loadJavaParser>,
): Promise<{ symbolCount: number; architecture: string | null; status: IndexPipelineStatus }> {
  // Check persistent DB for existing symbols
  if (dbExisted) {
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM symbols WHERE project_id = ?')
      .get(namespace) as any)?.cnt ?? 0
    if (count > 0) {
      const meta = await readMeta(safeFs)
      console.error(`[condex] Opened persistent DB: ${count} symbols`)
      return {
        symbolCount: count,
        architecture: meta?.architecture ?? null,
        status: { status: 'success', symbolCount: count, timestamp: new Date().toISOString() },
      }
    }
    console.error(`[condex] Persistent DB empty — loading from JSON or re-indexing`)
  }

  // Try loading from JSON index
  const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
  if (safeFs.existsSync(metaPath)) {
    const loadResult = await loadProject(db, safeFs)
    if (loadResult) {
      console.error(`[condex] Loaded from JSON: ${loadResult.symbolCount} symbols in ${loadResult.loadTimeMs}ms`)
      return {
        symbolCount: loadResult.symbolCount,
        architecture: loadResult.architecture,
        status: { status: 'success', symbolCount: loadResult.symbolCount, timestamp: new Date().toISOString() },
      }
    }
  }

  // Full index from source
  if (compositeParser) {
    console.error(`[condex] No existing index. Running full index...`)
    const result = await indexProject(db, safeFs, {
      full: true,
      parseFileWithRefs: compositeParser,
      detectArch: javaParsers?.detectArch,
      parseSql: javaParsers?.parseSql,
      parseYaml: javaParsers?.parseYaml,
    })
    console.error(`[condex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files in ${result.loadTimeMs}ms`)
    return {
      symbolCount: result.symbolCount,
      architecture: result.architecture,
      status: { status: 'success', symbolCount: result.symbolCount, timestamp: new Date().toISOString() },
    }
  }

  console.error(`[condex] No parser available and no existing index. Install @condex-ai/java or @condex-ai/multi-lang.`)
  return {
    symbolCount: 0,
    architecture: null,
    status: { status: 'skipped', error: 'No parser available', timestamp: new Date().toISOString() },
  }
}

// ── Vector pipeline initialization ────────────────────────

async function initVectorPipeline(
  db: InstanceType<typeof Database>,
  namespace: string,
  dbExisted: boolean,
  safeFs: SafeFS,
): Promise<{
  embedder: Embedder | null
  prepareSymbolText: PrepareSymbolTextFn | undefined
  effectiveChain: SearchMode[]
  vectorStatus: IndexPipelineStatus
}> {
  let effectiveChain = [...SEARCH_CHAIN]

  // Step 1: Load sqlite-vec
  console.error(`[condex] [1/3] Loading sqlite-vec extension...`)
  try {
    loadVec(db)
    console.error(`[condex] [1/3] sqlite-vec loaded, symbol_vectors table ready`)
  } catch (err: any) {
    console.error(`[condex] WARNING: sqlite-vec failed to load: ${err.message}`)
    return degradeToBm25(effectiveChain, `sqlite-vec load failed: ${err.message}`)
  }

  // Step 2: Load embedding model
  console.error(`[condex] [2/3] Loading embedding model...`)
  let embedder: Embedder
  let prepareSymbolText: PrepareSymbolTextFn
  try {
    const embedModule = await import('./embeddings/local-embed.js')
    console.error(`[condex] Model cache directory: ${embedModule.getCacheDir()}`)
    await embedModule.ensureModelDownloaded()
    embedder = await embedModule.getEmbedder()
    prepareSymbolText = embedModule.prepareSymbolText
    console.error(`[condex] [2/3] Embedder ready (${embedder.dimensions} dimensions)`)
  } catch (err: any) {
    console.error(`[condex] WARNING: Embedding model failed to load: ${err.message}`)
    return degradeToBm25(effectiveChain, `Embedding model failed: ${err.message}`)
  }

  // Step 3: Build or load vector index
  let existingVecCount = 0
  try {
    existingVecCount = (db.prepare('SELECT COUNT(*) as cnt FROM symbol_vectors').get() as any)?.cnt ?? 0
  } catch { /* table may not exist */ }

  if (existingVecCount > 0 && dbExisted) {
    console.error(`[condex] [3/3] Vector index loaded from persistent DB: ${existingVecCount} vectors`)
    return {
      embedder, prepareSymbolText, effectiveChain,
      vectorStatus: { status: 'success', symbolCount: existingVecCount, timestamp: new Date().toISOString() },
    }
  }

  console.error(`[condex] [3/3] Building vector index...`)
  try {
    const count = await buildVectorIndex(db, namespace, embedder, prepareSymbolText)
    if (count > 0) {
      console.error(`[condex] [3/3] Vector index built for ${count} symbols`)
    } else {
      console.error(`[condex] [3/3] WARNING: 0 symbols to embed — vector index is empty`)
    }
    return {
      embedder, prepareSymbolText, effectiveChain,
      vectorStatus: { status: 'success', symbolCount: count, timestamp: new Date().toISOString() },
    }
  } catch (err: any) {
    console.error(`[condex] Error building vector index: ${err.message}`)
    try {
      await writeErrorLog(safeFs, {
        phase: 'startup:vector',
        message: err.message,
        stack: err.stack,
        context: { projectRoot: PROJECT_ROOT, searchChain: SEARCH_CHAIN },
      })
    } catch { /* best effort */ }
    return {
      embedder, prepareSymbolText, effectiveChain,
      vectorStatus: { status: 'failed', error: `Embedding failed: ${err.message}`, timestamp: new Date().toISOString() },
    }
  }
}

function degradeToBm25(chain: SearchMode[], error: string): {
  embedder: null
  prepareSymbolText: undefined
  effectiveChain: SearchMode[]
  vectorStatus: IndexPipelineStatus
} {
  console.error(`[condex] Removing vector/hybrid from search chain`)
  const filtered = chain.filter(m => m === 'bm25')
  return {
    embedder: null,
    prepareSymbolText: undefined,
    effectiveChain: filtered.length > 0 ? filtered : ['bm25'],
    vectorStatus: { status: 'failed', error, timestamp: new Date().toISOString() },
  }
}

// ── Reindexer initialization ──────────────────────────────

async function initReindexer(
  db: InstanceType<typeof Database>,
  namespace: string,
  compositeParser: ParseFileWithRefsFn | undefined,
  embedder: Embedder | null,
  prepareSymbolText: PrepareSymbolTextFn | undefined,
  safeFs: SafeFS,
): Promise<IncrementalReindexer | null> {
  if (!compositeParser) return null

  const reindexer = new IncrementalReindexer({
    db,
    projectRoot: PROJECT_ROOT,
    projectId: namespace,
    parseFileWithRefs: compositeParser,
    embedder,
    prepareSymbolText,
  })

  try {
    const meta = await readMeta(safeFs)
    if (meta?.fileHashes) {
      reindexer.initializeHashes(meta.fileHashes)
      console.error(`[condex] Incremental reindexer ready (tracking ${Object.keys(meta.fileHashes).length} files)`)
    } else {
      reindexer.initializeHashes({})
      console.error(`[condex] Incremental reindexer ready (no prior hashes)`)
    }
  } catch {
    reindexer.initializeHashes({})
  }

  return reindexer
}

// ── Main ──────────────────────────────────────────────────

async function main() {
  console.error(`[condex] Starting Condex MCP Server`)
  console.error(`[condex] Project root: ${PROJECT_ROOT}`)

  const safeFs = new SafeFS(PROJECT_ROOT)
  const condexDir = path.join(PROJECT_ROOT, '.condex')
  const { db, dbExisted } = initDatabase(condexDir)

  const namespace = generateNamespace(PROJECT_ROOT)
  const projectName = path.basename(PROJECT_ROOT)
  const dbPath = path.join(condexDir, 'index.db')
  console.error(`[condex] Namespace: ${namespace}`)
  console.error(`[condex] Database: ${dbPath} (${dbExisted ? 'existing' : 'new'})`)

  // Load parsers
  const javaParsers = loadJavaParser()
  if (javaParsers) console.error(`[condex] Java parser loaded`)

  const multiLangParser = loadMultiLangParser()
  if (multiLangParser) {
    console.error(`[condex] Multi-lang parser loaded (${multiLangParser.getSupportedLanguages().length} languages)`)
  }

  const compositeParser = createCompositeParser(javaParsers, multiLangParser)

  // Index status tracking
  const indexStatus: IndexStatus = {
    searchMode: SEARCH_CHAIN.join(','),
    bm25: { status: 'not_started' },
    vector: { status: 'not_started' },
    lastUpdated: new Date().toISOString(),
  }

  const chainNeedsVector = SEARCH_CHAIN.includes('vector') || SEARCH_CHAIN.includes('hybrid')

  // BM25 startup
  let architecture: string | null = null
  try {
    const bm25Result = await loadOrIndexBm25(db, safeFs, namespace, dbExisted, compositeParser, javaParsers)
    architecture = bm25Result.architecture
    indexStatus.bm25 = bm25Result.status
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

  // Vector pipeline
  console.error(`[condex] Search chain: [${SEARCH_CHAIN.join(', ')}]`)
  let embedder: Embedder | null = null
  let prepareSymbolTextFn: PrepareSymbolTextFn | undefined
  let effectiveSearchChain = [...SEARCH_CHAIN]

  if (chainNeedsVector) {
    const vecResult = await initVectorPipeline(db, namespace, dbExisted, safeFs)
    embedder = vecResult.embedder
    prepareSymbolTextFn = vecResult.prepareSymbolText
    effectiveSearchChain = vecResult.effectiveChain
    indexStatus.vector = vecResult.vectorStatus
  } else {
    indexStatus.vector = { status: 'skipped', error: `Chain [${SEARCH_CHAIN.join(',')}] does not include vector/hybrid`, timestamp: new Date().toISOString() }
  }

  // Write index status
  indexStatus.lastUpdated = new Date().toISOString()
  try { await writeIndexStatus(safeFs, indexStatus) } catch { /* best effort */ }

  // Savings tracker
  const savings = new SavingsTracker(safeFs)
  setSavingsTracker(savings)

  console.error(`[condex] Thresholds: bm25=${BM25_MIN_SCORE}, vector=${VECTOR_MAX_DISTANCE}`)

  // Incremental reindexer
  const reindexer = await initReindexer(db, namespace, compositeParser, embedder, prepareSymbolTextFn, safeFs)

  if (effectiveSearchChain.join(',') !== SEARCH_CHAIN.join(',')) {
    console.error(`[condex] Effective search chain: [${effectiveSearchChain.join(', ')}] (requested: [${SEARCH_CHAIN.join(', ')}])`)
  }

  // Build handler context
  const ctx: HandlerContext = {
    db, safeFs,
    projectId: namespace,
    projectName, architecture,
    searchChain: effectiveSearchChain,
    embedder,
    thresholds: { bm25MinScore: BM25_MIN_SCORE, vectorMaxDistance: VECTOR_MAX_DISTANCE },
    reindexer,
  }

  // Create MCP server
  const server = new Server(
    { name: 'condex-mcp', version: TOOL_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    // index_folder: use composite parser if available
    if (name === 'index_folder' && compositeParser) {
      return handleIndexFolderCall(db, safeFs, ctx, reindexer, namespace, embedder, prepareSymbolTextFn, compositeParser, javaParsers, args ?? {})
    }

    return dispatch(name, args ?? {}, ctx)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[condex] Server ready. ${TOOL_DEFINITIONS.length} tools available.`)
}

// ── index_folder handler ──────────────────────────────────

async function handleIndexFolderCall(
  db: InstanceType<typeof Database>,
  safeFs: SafeFS,
  ctx: HandlerContext,
  reindexer: IncrementalReindexer | null,
  namespace: string,
  embedder: Embedder | null,
  prepareSymbolTextFn: PrepareSymbolTextFn | undefined,
  compositeParser: ParseFileWithRefsFn,
  javaParsers: ReturnType<typeof loadJavaParser>,
  args: Record<string, unknown>,
) {
  const full = (args as any)?.full ?? false
  const result = await indexProject(db, safeFs, {
    full,
    parseFileWithRefs: compositeParser,
    detectArch: javaParsers?.detectArch,
    parseSql: javaParsers?.parseSql,
    parseYaml: javaParsers?.parseYaml,
  })
  ctx.architecture = result.architecture

  // Refresh reindexer hash cache
  if (reindexer) {
    try {
      const meta = await readMeta(safeFs)
      if (meta?.fileHashes) reindexer.initializeHashes(meta.fileHashes)
    } catch { /* ignore */ }
  }

  // Rebuild vector index
  if (embedder && prepareSymbolTextFn) {
    try {
      const count = await buildVectorIndex(db, namespace, embedder, prepareSymbolTextFn, { clear: true })
      console.error(`[condex] Vector index rebuilt after index_folder (${count} symbols)`)
    } catch (err: any) {
      console.error(`[condex] Failed to rebuild vector index after index_folder: ${err.message}`)
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ status: 'indexed', ...result }, null, 2) }],
  }
}

// Only start the server in the sandboxed child (or when sandbox was skipped).
// Parent process just waits for the child to exit.
if (!isParent) {
  // Vector mode: verify model is cached (can't download — network is blocked)
  const rawSearchMode_ = process.env.CONDEX_SEARCH_MODE ?? 'vector,bm25'
  const needsVector = rawSearchMode_.includes('vector') || rawSearchMode_.includes('hybrid')
  if (needsVector) {
    const cacheDir = process.env.CONDEX_MODEL_CACHE_DIR
      || join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.condex', 'models')
    const modelDir = join(cacheDir, 'nomic-ai', 'nomic-embed-text-v1.5')
    const requiredFiles = [
      'config.json',
      'tokenizer.json',
      'tokenizer_config.json',
      join('onnx', 'model_quantized.onnx'),
    ]
    const missing = requiredFiles.filter(f => !existsSync(join(modelDir, f)))
    if (missing.length > 0) {
      console.error(`[condex] FATAL: Vector mode requires the embedding model, but it is not cached.`)
      console.error(`[condex]   Missing: ${missing.join(', ')}`)
      console.error(`[condex]   Expected at: ${modelDir}`)
      console.error(`[condex]`)
      console.error(`[condex]   Run one of these to download the model first:`)
      console.error(`[condex]     npm run setup`)
      console.error(`[condex]     condex setup <project-path>`)
      console.error(`[condex]`)
      console.error(`[condex]   Network access is NEVER allowed at runtime — models must be pre-downloaded.`)
      process.exit(1)
    }
    console.error(`[condex] Vector model cached at ${modelDir}`)
  }

  main().catch(err => {
    console.error(`[condex] Fatal error: ${err.message}`)
    process.exit(1)
  })
}
