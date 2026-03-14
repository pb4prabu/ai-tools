#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import {
  SafeFS,
  createSchema,
  loadProject,
  readMeta,
  generateNamespace,
  indexProject,
} from '@condex-ai/core'

const args = process.argv.slice(2)
const command = args[0]

async function main() {
  switch (command) {
    case 'index':
      return handleIndex()
    case 'status':
      return handleStatus()
    case 'invalidate':
      return handleInvalidate()
    case 'setup':
      return handleSetup()
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return printHelp()
    default:
      console.error(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

async function handleIndex() {
  const full = args.includes('--full')
  const positional = args.slice(1).find(a => !a.startsWith('--'))
  const targetPath = positional ? path.resolve(positional) : process.cwd()

  console.log(`Indexing: ${targetPath}${full ? ' (full)' : ''}`)

  const safeFs = new SafeFS(targetPath)
  const condexDir = path.join(targetPath, '.condex')
  fs.mkdirSync(condexDir, { recursive: true })
  const dbPath = path.join(condexDir, 'index.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  createSchema(db)

  // Try to load Java parser
  let parseFile: any
  let detectArch: any
  let parseSql: any
  let parseYaml: any
  try {
    const esmRequire = createRequire(import.meta.url)
    const javaPkg = esmRequire('@condex-ai/java')
    parseFile = javaPkg.parseJavaFile
    detectArch = javaPkg.detectArchitecture
    parseSql = javaPkg.parseSqlFile
    parseYaml = javaPkg.parseYamlFile
  } catch {
    console.log('Note: @condex-ai/java not found. Install it for Java parsing.')
  }

  const result = await indexProject(db, safeFs, {
    full,
    parseFile,
    detectArch,
    parseSql,
    parseYaml,
  })

  console.log(`Done!`)
  console.log(`  Project: ${result.projectName} (${result.projectId})`)
  console.log(`  Architecture: ${result.architecture ?? 'unknown'}`)
  console.log(`  Symbols: ${result.symbolCount}`)
  console.log(`  Files processed: ${result.filesProcessed}`)
  console.log(`  Files skipped: ${result.filesSkipped}`)
  console.log(`  Time: ${result.loadTimeMs}ms`)
  console.log(`  Mode: ${result.incremental ? 'incremental' : 'full'}`)
  console.log(`  Database: ${dbPath}`)
}

async function handleStatus() {
  const targetPath = args[1] ? path.resolve(args[1]) : process.cwd()
  const safeFs = new SafeFS(targetPath)

  const meta = await readMeta(safeFs)
  if (!meta) {
    console.log(`No index found at: ${targetPath}`)
    console.log(`Run: condex index ${targetPath === process.cwd() ? '.' : targetPath}`)
    return
  }

  const namespace = generateNamespace(targetPath)
  console.log(`Project: ${meta.projectName}`)
  console.log(`  ID: ${namespace}`)
  console.log(`  Root: ${meta.projectRoot}`)
  console.log(`  Language: ${meta.language ?? 'auto'}`)
  console.log(`  Architecture: ${meta.architecture ?? 'unknown'}`)
  console.log(`  Symbols: ${meta.symbolCount}`)
  console.log(`  Schema: ${meta.schemaCount}`)
  console.log(`  Config: ${meta.configCount}`)
  console.log(`  Last full index: ${meta.lastFullIndex ?? 'never'}`)
  console.log(`  Last incremental: ${meta.lastIncrementalIndex ?? 'never'}`)
  console.log(`  Tool version: ${meta.toolVersion}`)
  console.log(`  Files tracked: ${Object.keys(meta.fileHashes).length}`)
}

async function handleInvalidate() {
  const targetPath = args[1] ? path.resolve(args[1]) : process.cwd()
  const safeFs = new SafeFS(targetPath)
  const indexDir = safeFs.getIndexDir()

  try {
    await safeFs.rm(indexDir)
    console.log(`Index invalidated: ${targetPath}`)
  } catch (err: any) {
    if (err.code !== 'ENOENT') console.error(`Error removing index dir: ${err.message}`)
  }

  // Also remove persistent SQLite DB files
  const dbPath = path.join(targetPath, '.condex', 'index.db')
  for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
  console.log(`Database removed: ${dbPath}`)
  console.log('Next run will trigger a full re-index.')
}

async function handleSetup() {
  const targetPath = args[1] ? path.resolve(args[1]) : process.cwd()

  // Resolve condex-mcp server path
  const esmRequire = createRequire(import.meta.url)
  let serverPath: string
  try {
    serverPath = esmRequire.resolve('@condex-ai/core/server')
  } catch {
    // Fallback: try to find it relative to cli package
    const fallback = path.resolve(path.dirname(import.meta.url.replace('file://', '')), '../../condex-core/dist/server.js')
    if (fs.existsSync(fallback)) {
      serverPath = fallback
    } else {
      console.error('Could not find @condex-ai/core server. Make sure it is built.')
      process.exit(1)
    }
  }

  const mcpJson = {
    mcpServers: {
      condex: {
        command: 'node',
        args: [serverPath],
        env: {
          CONDEX_SEARCH_MODE: 'vector,bm25',
          CONDEX_BM25_MIN_SCORE: '0.3',
          CONDEX_VECTOR_MAX_DISTANCE: '0.95',
        },
      },
    },
  }

  const opencodeJson = {
    mcp: {
      condex: {
        type: 'local',
        command: ['node', serverPath],
        environment: {
          CONDEX_SEARCH_MODE: 'vector,bm25',
          CONDEX_BM25_MIN_SCORE: '0.3',
          CONDEX_VECTOR_MAX_DISTANCE: '0.95',
        },
        enabled: true,
      },
    },
  }

  // --- .mcp.json (Claude Code) ---
  const dotMcpPath = path.join(targetPath, '.mcp.json')
  if (fs.existsSync(dotMcpPath)) {
    const samplePath = path.join(targetPath, 'mcp.sample.jsonc')
    fs.writeFileSync(samplePath, '// Condex MCP config for Claude Code\n// Copy the "condex" entry below into your .mcp.json under "mcpServers"\n' + JSON.stringify(mcpJson, null, 2) + '\n')
    console.warn(`⚠  .mcp.json already exists — not overwriting.`)
    console.warn(`   Copy the condex snippet from: ${samplePath}`)
  } else {
    fs.writeFileSync(dotMcpPath, JSON.stringify(mcpJson, null, 2) + '\n')
    console.log(`✓ Created: ${dotMcpPath}`)
  }

  // --- opencode.json (OpenCode / Dayton) ---
  const opencodePath = path.join(targetPath, 'opencode.json')
  if (fs.existsSync(opencodePath)) {
    const samplePath = path.join(targetPath, 'opencode.sample.jsonc')
    fs.writeFileSync(samplePath, '// Condex MCP config for OpenCode / Dayton\n// Copy the "condex" entry below into your opencode.json under "mcp"\n' + JSON.stringify(opencodeJson, null, 2) + '\n')
    console.warn(`⚠  opencode.json already exists — not overwriting.`)
    console.warn(`   Copy the condex snippet from: ${samplePath}`)
  } else {
    fs.writeFileSync(opencodePath, JSON.stringify(opencodeJson, null, 2) + '\n')
    console.log(`✓ Created: ${opencodePath}`)
  }

  // Check vector readiness
  console.log(`\nServer: ${serverPath}`)
  console.log(``)

  const warnings: string[] = []

  // Check sqlite-vec
  try {
    const sqliteVec = esmRequire.resolve('sqlite-vec')
    console.log(`[ok] sqlite-vec: ${sqliteVec}`)
  } catch {
    warnings.push('sqlite-vec not found — vector search will be unavailable')
  }

  // Check embedding model
  try {
    esmRequire.resolve('@huggingface/transformers')
    console.log(`[ok] @huggingface/transformers: installed`)
    // Check if model is downloaded
    const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
    const modelDir = path.join(home, '.condex', 'models')
    if (fs.existsSync(modelDir) && fs.readdirSync(modelDir).length > 0) {
      console.log(`[ok] Embedding model cached: ${modelDir}`)
    } else {
      warnings.push('Embedding model not downloaded — will be downloaded on first run (requires internet)')
    }
  } catch {
    warnings.push('@huggingface/transformers not found — vector embeddings will be unavailable')
  }

  // Check multi-lang parser
  try {
    const multiLang = esmRequire('@condex-ai/multi-lang')
    const supported = multiLang.getSupportedLanguages()
    console.log(`[ok] Multi-lang parser: ${supported.length} languages (${supported.join(', ')})`)
  } catch {
    warnings.push('@condex-ai/multi-lang not found — only Java files will get fine-grained parsing')
  }

  // Check Java parser
  try {
    esmRequire.resolve('@condex-ai/java')
    console.log(`[ok] Java parser: available`)
  } catch {
    // Not a warning — multi-lang handles it
  }

  if (warnings.length > 0) {
    console.log(``)
    console.log(`⚠  WARNING: Condex MCP is NOT in its optimised form`)
    for (const w of warnings) {
      console.log(`   - ${w}`)
    }
    console.log(``)
    console.log(`   Vector search provides significantly better results than BM25 alone.`)
    console.log(`   The MCP will still work (falls back to BM25) but with reduced accuracy.`)
    console.log(``)
    console.log(`   To fix:`)
    console.log(`     cd ${path.dirname(serverPath).replace('/dist', '')}/../..`)
    console.log(`     npm install`)
    console.log(`     npm run download-model --workspace=packages/condex-core`)
  } else {
    console.log(``)
    console.log(`Condex MCP is fully configured with vector search enabled.`)
  }
}

function printHelp() {
  console.log(`
Condex CLI — Local-first code index for AI agents

Usage:
  condex setup [path]          Generate .mcp.json + opencode.json (merges if exists)
  condex index [path]          Index a project (default: current directory)
  condex index [path] --full   Force full re-index
  condex status [path]         Show index status
  condex invalidate [path]     Delete index (triggers re-index on next use)
  condex help                  Show this help

Examples:
  condex setup .               Add condex MCP config to current directory
  condex setup ~/my-project    Add condex MCP config to a specific project
  condex index .               Index current directory
  condex status                Show status of current directory
`.trim())
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
