#!/usr/bin/env node

// Block outbound network unless vector/hybrid mode needs model download
import { blockOutboundNetwork } from './security/network-guard.js'
const searchMode = process.env.CORTEX_SEARCH_MODE ?? 'bm25'
if (searchMode === 'bm25') {
  blockOutboundNetwork()
} else {
  console.error(`[cortex] Network guard DISABLED for ${searchMode} mode (model download may be needed)`)
}

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
import { indexProject, type ParseFileFn, type DetectArchFn } from './indexer/indexer.js'
import { TOOL_DEFINITIONS } from './mcp/tools.js'
import { dispatch } from './mcp/dispatcher.js'
import { setSavingsTracker } from './mcp/meta.js'
import { SavingsTracker } from './token/savings.js'
import type { HandlerContext, SearchMode } from './mcp/handlers.js'
import type { Embedder } from './embeddings/local-embed.js'
import { loadVec, insertVectors } from './retrieval/vector-search.js'

const PROJECT_ROOT = path.resolve(process.cwd())
const TOOL_VERSION = '1.0.0'
const SEARCH_MODE = (process.env.CORTEX_SEARCH_MODE ?? 'bm25') as SearchMode

/**
 * Try to load the Java parser. Returns null if not installed.
 */
function loadJavaParser(): { parseFile: ParseFileFn; detectArch: DetectArchFn } | null {
  try {
    // Use createRequire anchored to THIS file's location so workspace
    // packages resolve correctly regardless of process.cwd()
    const esmRequire = createRequire(import.meta.url)
    const javaPkg = esmRequire('@cortex-ai/java')
    return {
      parseFile: javaPkg.parseJavaFile as ParseFileFn,
      detectArch: javaPkg.detectArchitecture as DetectArchFn,
    }
  } catch {
    return null
  }
}

async function main() {
  console.error(`[cortex] Starting Cortex MCP Server`)
  console.error(`[cortex] Project root: ${PROJECT_ROOT}`)

  // Initialize SafeFS — restricts all file ops to project root
  const safeFs = new SafeFS(PROJECT_ROOT)

  // Initialize in-memory SQLite
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)

  // Generate project namespace
  const namespace = generateNamespace(PROJECT_ROOT)
  const projectName = path.basename(PROJECT_ROOT)
  console.error(`[cortex] Namespace: ${namespace}`)

  // Load parsers
  const javaParsers = loadJavaParser()
  if (javaParsers) {
    console.error(`[cortex] Java parser loaded`)
  }

  // Auto-index on startup
  let architecture: string | null = null
  try {
    const metaPath = path.join(PROJECT_ROOT, '.cortex', 'index', 'meta.json')
    if (safeFs.existsSync(metaPath)) {
      // Existing index: load then run incremental
      const loadResult = await loadProject(db, safeFs)
      if (loadResult) {
        architecture = loadResult.architecture
        console.error(
          `[cortex] Loaded: ${loadResult.symbolCount} symbols, ` +
          `${loadResult.schemaCount} schema, ${loadResult.configCount} config ` +
          `in ${loadResult.loadTimeMs}ms`
        )
      }
    } else if (javaParsers) {
      // No index: run full index
      console.error(`[cortex] No existing index. Running full index...`)
      const result = await indexProject(db, safeFs, {
        full: true,
        parseFile: javaParsers.parseFile,
        detectArch: javaParsers.detectArch,
      })
      architecture = result.architecture
      console.error(
        `[cortex] Indexed: ${result.symbolCount} symbols from ${result.filesProcessed} files ` +
        `in ${result.loadTimeMs}ms`
      )
    } else {
      console.error(`[cortex] No parser available and no existing index.`)
    }
  } catch (err: any) {
    console.error(`[cortex] Error during startup indexing: ${err.message}`)
  }

  // Initialize embedder for vector/hybrid modes
  console.error(`[cortex] Search mode: ${SEARCH_MODE}`)
  let embedder: Embedder | null = null

  if (SEARCH_MODE === 'vector' || SEARCH_MODE === 'hybrid') {
    try {
      const { getEmbedder, prepareSymbolText } = await import('./embeddings/local-embed.js')
      console.error(`[cortex] Loading embedding model (first run downloads ~100MB)...`)
      embedder = await getEmbedder()
      console.error(`[cortex] Embedder ready (${embedder.dimensions} dimensions)`)

      // Load sqlite-vec and build vector index
      loadVec(db)
      const allSymbols = db.prepare(
        'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
      ).all(namespace) as { id: string; qualified_name: string; signature: string; javadoc: string | null; kind: string }[]

      if (allSymbols.length > 0) {
        console.error(`[cortex] Building vector index for ${allSymbols.length} symbols...`)
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
        console.error(`[cortex] Vector index built for ${allSymbols.length} symbols`)
      }
    } catch (err: any) {
      console.error(`[cortex] Failed to initialize embedder: ${err.message}`)
      console.error(`[cortex] Falling back to BM25-only mode`)
    }
  }

  // Initialize savings tracker
  const savings = new SavingsTracker(safeFs)
  setSavingsTracker(savings)

  // Build handler context
  const ctx: HandlerContext = {
    db,
    safeFs,
    projectId: namespace,
    projectName,
    architecture,
    searchMode: SEARCH_MODE,
    embedder,
  }

  // Create MCP server
  const server = new Server(
    {
      name: 'cortex-mcp',
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
        parseFile: javaParsers.parseFile,
        detectArch: javaParsers.detectArch,
      })
      ctx.architecture = result.architecture
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

  console.error(`[cortex] Server ready. ${TOOL_DEFINITIONS.length} tools available.`)
}

main().catch(err => {
  console.error(`[cortex] Fatal error: ${err.message}`)
  process.exit(1)
})
