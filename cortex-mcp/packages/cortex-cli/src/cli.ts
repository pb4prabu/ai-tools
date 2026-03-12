#!/usr/bin/env node

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
} from '@cortex-ai/core'

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
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)

  // Try to load Java parser
  let parseFile: any
  let detectArch: any
  let parseSql: any
  let parseYaml: any
  try {
    const esmRequire = createRequire(import.meta.url)
    const javaPkg = esmRequire('@cortex-ai/java')
    parseFile = javaPkg.parseJavaFile
    detectArch = javaPkg.detectArchitecture
    parseSql = javaPkg.parseSqlFile
    parseYaml = javaPkg.parseYamlFile
  } catch {
    console.log('Note: @cortex-ai/java not found. Install it for Java parsing.')
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
}

async function handleStatus() {
  const targetPath = args[1] ? path.resolve(args[1]) : process.cwd()
  const safeFs = new SafeFS(targetPath)

  const meta = await readMeta(safeFs)
  if (!meta) {
    console.log(`No index found at: ${targetPath}`)
    console.log(`Run: cortex index ${targetPath === process.cwd() ? '.' : targetPath}`)
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
    console.log('Next run will trigger a full re-index.')
  } catch (err: any) {
    console.error(`Error: ${err.message}`)
  }
}

function printHelp() {
  console.log(`
Cortex CLI — Local-first code index for AI agents

Usage:
  cortex index [path]          Index a project (default: current directory)
  cortex index [path] --full   Force full re-index
  cortex status [path]         Show index status
  cortex invalidate [path]     Delete index (triggers re-index on next use)
  cortex help                  Show this help

Examples:
  cortex index .               Index current directory
  cortex index ~/my-project    Index a specific project
  cortex status                Show status of current directory
  cortex invalidate            Clear index for current directory
`.trim())
}

main().catch(err => {
  console.error(`Error: ${err.message}`)
  process.exit(1)
})
