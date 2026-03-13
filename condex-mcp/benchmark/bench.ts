#!/usr/bin/env npx tsx
/**
 * 3-Way Benchmark: Naive vs Condex BM25 vs Condex BM25+Vector
 *
 * Measures token costs for realistic developer queries against a sample monorepo.
 * Shows actual savings percentages for each approach.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

// Use the condex-core source directly (via tsx)
import { SafeFS } from '../packages/condex-core/src/security/fs-guard.js'
import { createSchema, insertProject, insertSymbols, getSymbolById } from '../packages/condex-core/src/store/sqlite-store.js'
import { searchBM25, type BM25Result } from '../packages/condex-core/src/retrieval/bm25.js'
import { applyConfidenceGate } from '../packages/condex-core/src/retrieval/confidence-gate.js'
import { countTokens } from '../packages/condex-core/src/token/counter.js'
import { generateNamespace } from '../packages/condex-core/src/namespace/namespace.js'
import { rrfFusion } from '../packages/condex-core/src/retrieval/rrf-fusion.js'
import type { Embedder } from '../packages/condex-core/src/embeddings/local-embed.js'
import type { VectorResult } from '../packages/condex-core/src/retrieval/vector-search.js'

// Java parser
import { parseJavaFile } from '../packages/condex-java/src/parser/java-parser.js'
import { detectArchitecture } from '../packages/condex-java/src/parser/arch-detector.js'

// ─── Config ────────────────────────────────────────────────

const SAMPLE_ROOT = path.join(__dirname, 'sample-mono')
const VECTOR_ENABLED = process.argv.includes('--vector')
const VERBOSE = process.argv.includes('--verbose')

// ─── Realistic Developer Queries ───────────────────────────

const QUERIES = [
  { query: 'order creation flow', description: 'How does order creation work?' },
  { query: 'payment processing', description: 'How are payments processed?' },
  { query: 'user authentication login', description: 'How does user auth work?' },
  { query: 'notification email sending', description: 'How are emails sent?' },
  { query: 'order cancellation refund', description: 'How to cancel an order and refund?' },
  { query: 'Kafka event listener', description: 'Where are Kafka events consumed?' },
  { query: 'REST controller endpoint API', description: 'What REST endpoints exist?' },
  { query: 'repository interface persistence', description: 'What repositories exist?' },
  { query: 'domain entity validation invariant', description: 'What domain invariants exist?' },
  { query: 'exception error handling', description: 'How are errors handled?' },
  { query: 'OrderStatus lifecycle transition', description: 'What are the order status transitions?' },
  { query: 'retry failed notification', description: 'How does notification retry work?' },
  { query: 'inventory availability check reserve', description: 'How does inventory reservation work?' },
  { query: 'BigDecimal amount currency', description: 'Where is money/amounts handled?' },
  { query: 'Spring Service annotation transactional', description: 'Which services are transactional?' },
]

// ─── Types ─────────────────────────────────────────────────

interface QueryResult {
  query: string
  description: string
  naive: { tokens: number; filesRead: number }
  bm25: { tokens: number; symbolsFound: number; topScore: number; gateFired: boolean }
  vector: { tokens: number; symbolsFound: number; rrfTop: number } | null
  smart: { tokens: number; symbolsFound: number; usedVector: boolean } | null
}

// ─── Phase 1: Index the Sample Mono Repo ───────────────────

function findJavaFiles(dir: string, base: string = ''): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = path.join(base, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.condex' || entry.name === 'node_modules') continue
      files.push(...findJavaFiles(dir, rel))
    } else if (entry.name.endsWith('.java')) {
      files.push(rel)
    }
  }
  return files
}

function indexSampleProject(db: Database.Database) {
  const projectId = generateNamespace(SAMPLE_ROOT)
  const projectName = 'acme-platform'

  // Find all Java files
  const javaFiles = findJavaFiles(SAMPLE_ROOT)
  const allFilePaths = javaFiles.map(f => f)

  // Detect architecture
  const profile = detectArchitecture(allFilePaths)

  console.log(`\n  Indexing ${javaFiles.length} Java files...`)
  console.log(`  Architecture: ${profile.architecture} (confidence: ${(profile.confidence * 100).toFixed(0)}%)`)

  // Parse all files
  const allSymbols: any[] = []
  for (const relPath of javaFiles) {
    const absPath = path.join(SAMPLE_ROOT, relPath)
    const content = fs.readFileSync(absPath, 'utf-8')
    try {
      const symbols = parseJavaFile(content, { projectId, filePath: relPath, profile })
      allSymbols.push(...symbols)
    } catch (err: any) {
      console.error(`  Warning: Error parsing ${relPath}: ${err.message}`)
    }
  }

  // Insert into SQLite
  insertProject(db, {
    projectId,
    projectName,
    projectRoot: SAMPLE_ROOT,
    language: 'java',
    architecture: profile.architecture,
    architectureConfidence: profile.confidence,
    symbolCount: allSymbols.length,
    schemaCount: 0,
    configCount: 0,
    toolVersion: '1.0.0',
  })

  insertSymbols(db, allSymbols)

  console.log(`  Indexed ${allSymbols.length} symbols across ${javaFiles.length} files\n`)
  return { projectId, projectName, javaFiles, allSymbols }
}

// ─── Phase 2: Naive Approach (No Condex) ───────────────────

/**
 * Simulate what an LLM would do without Condex:
 * 1. Search for files containing query keywords (like grep)
 * 2. Read entire matching files
 * 3. Token cost = sum of all tokens in matching files
 */
function naiveSearch(query: string, javaFiles: string[]): { tokens: number; filesRead: number } {
  const keywords = query.toLowerCase().split(/\s+/)

  // Find files that match any keyword (simulating grep)
  const matchingFiles: string[] = []
  for (const relPath of javaFiles) {
    const absPath = path.join(SAMPLE_ROOT, relPath)
    const content = fs.readFileSync(absPath, 'utf-8').toLowerCase()
    const pathLower = relPath.toLowerCase()

    // Check if file path or content matches any keyword
    if (keywords.some(kw => content.includes(kw) || pathLower.includes(kw))) {
      matchingFiles.push(absPath)
    }
  }

  // If no files match, LLM would read all files to be safe
  const filesToRead = matchingFiles.length > 0 ? matchingFiles : javaFiles.map(f => path.join(SAMPLE_ROOT, f))

  let totalTokens = 0
  for (const fp of filesToRead) {
    const content = fs.readFileSync(fp, 'utf-8')
    totalTokens += countTokens(content)
  }

  return { tokens: totalTokens, filesRead: filesToRead.length }
}

// ─── Phase 3: BM25-only Search ────────────────────────────

function bm25Search(
  db: Database.Database,
  query: string,
  projectId: string
): { tokens: number; symbolsFound: number; topScore: number; gateFired: boolean; resultIds: string[] } {
  const rawResults = searchBM25(db, query, projectId, undefined, 20)
  const gate = applyConfidenceGate(rawResults)

  if (!gate.passed) {
    const msg = `No confident results for "${query}"`
    return { tokens: countTokens(msg), symbolsFound: 0, topScore: gate.topScore, gateFired: true, resultIds: [] }
  }

  // Build compact response (same as handler)
  const results = gate.results.map((r: BM25Result) => ({
    symbolId: r.symbolId,
    qualifiedName: r.qualifiedName,
    signature: r.signature,
    kind: r.kind,
    filePath: r.filePath,
    springRole: r.springRole,
    hexRole: r.hexRole,
    bm25Score: Math.round(r.bm25Score * 1000) / 1000,
  }))

  const text = JSON.stringify(results, null, 2)
  return {
    tokens: countTokens(text),
    symbolsFound: results.length,
    topScore: gate.topScore,
    gateFired: false,
    resultIds: results.map((r: any) => r.symbolId),
  }
}

// ─── Phase 4: Vector + BM25 Hybrid Search ──────────────────

let vectorDb: Database.Database | null = null
let embedder: Embedder | null = null
let symbolTexts: Map<string, string> = new Map()

async function initVector(db: Database.Database, allSymbols: any[]) {
  if (!VECTOR_ENABLED) return

  console.log('  Initializing vector search...')

  // Dynamically import
  const { getEmbedder, prepareSymbolText } = await import(
    '../packages/condex-core/src/embeddings/local-embed.js'
  )

  console.log('  Loading embedding model (first run downloads ~130MB)...')
  embedder = await getEmbedder()
  console.log('  Model loaded!')

  // Load sqlite-vec
  const sqliteVec = require('sqlite-vec')
  sqliteVec.load(db)

  // Create vector table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_vectors USING vec0(
      symbol_id TEXT PRIMARY KEY,
      embedding float[768]
    )
  `)

  // Generate and store embeddings
  console.log(`  Generating embeddings for ${allSymbols.length} symbols...`)
  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO symbol_vectors (symbol_id, embedding) VALUES (?, ?)'
  )

  const batchSize = 10
  let processed = 0
  const insertBatch = db.transaction((items: { id: string; buf: Buffer }[]) => {
    for (const item of items) {
      insertStmt.run(item.id, item.buf)
    }
  })

  const batch: { id: string; buf: Buffer }[] = []
  for (const sym of allSymbols) {
    const text = prepareSymbolText(sym)
    symbolTexts.set(sym.id, text)

    const vec = await embedder!.embed(text)
    batch.push({ id: sym.id, buf: Buffer.from(vec.buffer) })

    if (batch.length >= batchSize) {
      insertBatch(batch)
      processed += batch.length
      batch.length = 0
      if (processed % 50 === 0) {
        process.stderr.write(`  ${processed}/${allSymbols.length} embeddings...\r`)
      }
    }
  }
  if (batch.length > 0) {
    insertBatch(batch)
    processed += batch.length
  }

  console.log(`  Generated ${processed} embeddings\n`)
}

async function hybridSearch(
  db: Database.Database,
  query: string,
  projectId: string
): Promise<{ tokens: number; symbolsFound: number; rrfTop: number; resultIds: string[] } | null> {
  if (!VECTOR_ENABLED || !embedder) return null

  // BM25 results
  const bm25Results = searchBM25(db, query, projectId, undefined, 20)

  // Vector results
  const queryVec = await embedder.embed(query)
  const queryBuf = Buffer.from(queryVec.buffer)

  let vectorResults: VectorResult[]
  try {
    const rows = db.prepare(`
      SELECT symbol_id AS symbolId, distance
      FROM symbol_vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT 60
    `).all(queryBuf) as VectorResult[]

    vectorResults = rows
      .filter((r: VectorResult) => r.symbolId.startsWith(`${projectId}::`))
      .slice(0, 20)
  } catch (err: any) {
    console.error(`  Vector search error: ${err.message}`)
    return null
  }

  // RRF fusion
  const fused = rrfFusion(bm25Results, vectorResults, 20)

  // Build compact response
  const results = fused.map(f => ({
    symbolId: f.symbolId,
    rrfScore: Math.round(f.rrfScore * 10000) / 10000,
    bm25Rank: f.bm25Rank,
    vectorRank: f.vectorRank,
  }))

  // Enrich with symbol data
  const enriched = results.map(r => {
    const sym = getSymbolById(db, r.symbolId)
    return {
      ...r,
      qualifiedName: sym?.qualifiedName ?? 'unknown',
      signature: sym?.signature ?? '',
      kind: sym?.kind ?? '',
      filePath: sym?.filePath ?? '',
    }
  })

  const text = JSON.stringify(enriched, null, 2)
  return {
    tokens: countTokens(text),
    symbolsFound: enriched.length,
    rrfTop: fused[0]?.rrfScore ?? 0,
    resultIds: enriched.map(r => r.symbolId),
  }
}

// ─── Phase 5: Smart Mode (BM25 first, vector fallback) ─────

async function smartSearch(
  db: Database.Database,
  query: string,
  projectId: string,
  bm25Result: ReturnType<typeof bm25Search>
): Promise<{ tokens: number; symbolsFound: number; usedVector: boolean } | null> {
  if (!VECTOR_ENABLED || !embedder) return null

  // If BM25 worked, use its (compact) result
  if (!bm25Result.gateFired && bm25Result.symbolsFound > 0) {
    return {
      tokens: bm25Result.tokens,
      symbolsFound: bm25Result.symbolsFound,
      usedVector: false,
    }
  }

  // BM25 gate fired → fall back to vector search (top 10, not 20)
  const queryVec = await embedder.embed(query)
  const queryBuf = Buffer.from(queryVec.buffer)

  try {
    const rows = db.prepare(`
      SELECT symbol_id AS symbolId, distance
      FROM symbol_vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT 30
    `).all(queryBuf) as VectorResult[]

    const filtered = rows
      .filter((r: VectorResult) => r.symbolId.startsWith(`${projectId}::`))
      .slice(0, 10) // Top 10, keep compact

    // Enrich with symbol data (same compact format as BM25)
    const enriched = filtered.map((r: VectorResult) => {
      const sym = getSymbolById(db, r.symbolId)
      return {
        symbolId: r.symbolId,
        qualifiedName: sym?.qualifiedName ?? 'unknown',
        signature: sym?.signature ?? '',
        kind: sym?.kind ?? '',
        filePath: sym?.filePath ?? '',
        springRole: sym?.springRole ?? null,
        distance: Math.round(r.distance * 1000) / 1000,
      }
    })

    const text = JSON.stringify(enriched, null, 2)
    return {
      tokens: countTokens(text),
      symbolsFound: enriched.length,
      usedVector: true,
    }
  } catch {
    return null
  }
}

// ─── Phase 6: Run Benchmark ────────────────────────────────

async function runBenchmark() {
  console.log('╔══════════════════════════════════════════════════════════════════════════════╗')
  console.log('║                    Condex MCP — Token Savings Benchmark                     ║')
  console.log('╚══════════════════════════════════════════════════════════════════════════════╝')

  if (VECTOR_ENABLED) {
    console.log('\n  Mode: Full comparison (Naive / BM25 / Hybrid / Smart)')
  } else {
    console.log('\n  Mode: BM25 Only (pass --vector for full 4-way comparison)')
  }

  // Create in-memory database
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)

  // Index sample project
  const { projectId, javaFiles, allSymbols } = indexSampleProject(db)

  // Calculate total project tokens (baseline)
  let totalProjectTokens = 0
  for (const relPath of javaFiles) {
    const content = fs.readFileSync(path.join(SAMPLE_ROOT, relPath), 'utf-8')
    totalProjectTokens += countTokens(content)
  }
  console.log(`  Total project size: ${totalProjectTokens.toLocaleString()} tokens across ${javaFiles.length} files`)

  // Initialize vector search if enabled
  await initVector(db, allSymbols)

  // Run queries
  const results: QueryResult[] = []
  const W = VECTOR_ENABLED ? 100 : 68

  console.log('\n  Running queries...\n')
  console.log('  ' + '─'.repeat(W))
  let header = `  ${'Query'.padEnd(35)} ${'Naive'.padStart(7)} ${'BM25'.padStart(7)}`
  if (VECTOR_ENABLED) header += ` ${'Hybrid'.padStart(7)} ${'Smart'.padStart(7)}`
  header += ` ${'BM25%'.padStart(7)}`
  if (VECTOR_ENABLED) header += ` ${'Hyb%'.padStart(7)} ${'Smt%'.padStart(7)}`
  console.log(header)
  console.log('  ' + '─'.repeat(W))

  for (const q of QUERIES) {
    const naive = naiveSearch(q.query, javaFiles)
    const bm25 = bm25Search(db, q.query, projectId)
    const vector = await hybridSearch(db, q.query, projectId)
    const smart = await smartSearch(db, q.query, projectId, bm25)

    const result: QueryResult = {
      query: q.query,
      description: q.description,
      naive,
      bm25: {
        tokens: bm25.tokens,
        symbolsFound: bm25.symbolsFound,
        topScore: bm25.topScore,
        gateFired: bm25.gateFired,
      },
      vector: vector ? {
        tokens: vector.tokens,
        symbolsFound: vector.symbolsFound,
        rrfTop: vector.rrfTop,
      } : null,
      smart: smart ? {
        tokens: smart.tokens,
        symbolsFound: smart.symbolsFound,
        usedVector: smart.usedVector,
      } : null,
    }
    results.push(result)

    const bm25Pct = naive.tokens > 0 ? ((1 - bm25.tokens / naive.tokens) * 100) : 0
    const vecPct = vector && naive.tokens > 0 ? ((1 - vector.tokens / naive.tokens) * 100) : 0
    const smartPct = smart && naive.tokens > 0 ? ((1 - smart.tokens / naive.tokens) * 100) : 0

    const label = q.query.length > 33 ? q.query.slice(0, 30) + '...' : q.query
    let line = `  ${label.padEnd(35)} ${naive.tokens.toString().padStart(7)} ${bm25.tokens.toString().padStart(7)}`
    if (VECTOR_ENABLED) {
      line += ` ${(vector?.tokens ?? 0).toString().padStart(7)}`
      line += ` ${(smart?.tokens ?? 0).toString().padStart(7)}`
    }
    line += ` ${bm25Pct.toFixed(1).padStart(6)}%`
    if (VECTOR_ENABLED) {
      line += ` ${vecPct.toFixed(1).padStart(6)}%`
      line += ` ${smartPct.toFixed(1).padStart(6)}%`
    }

    const flags: string[] = []
    if (bm25.gateFired) flags.push('gate')
    if (smart?.usedVector) flags.push('vec-fb')
    if (flags.length) line += ` [${flags.join(',')}]`

    console.log(line)
  }

  // ── Summary ──────────────────────────────────────────────

  console.log('  ' + '─'.repeat(W))

  const totalNaive = results.reduce((s, r) => s + r.naive.tokens, 0)
  const totalBM25 = results.reduce((s, r) => s + r.bm25.tokens, 0)
  const totalVector = results.reduce((s, r) => s + (r.vector?.tokens ?? 0), 0)
  const totalSmart = results.reduce((s, r) => s + (r.smart?.tokens ?? 0), 0)

  const bm25SavPct = ((1 - totalBM25 / totalNaive) * 100)
  const vecSavPct = totalVector > 0 ? ((1 - totalVector / totalNaive) * 100) : 0
  const smartSavPct = totalSmart > 0 ? ((1 - totalSmart / totalNaive) * 100) : 0

  let totLine = `  ${'TOTAL'.padEnd(35)} ${totalNaive.toString().padStart(7)} ${totalBM25.toString().padStart(7)}`
  if (VECTOR_ENABLED) {
    totLine += ` ${totalVector.toString().padStart(7)}`
    totLine += ` ${totalSmart.toString().padStart(7)}`
  }
  totLine += ` ${bm25SavPct.toFixed(1).padStart(6)}%`
  if (VECTOR_ENABLED) {
    totLine += ` ${vecSavPct.toFixed(1).padStart(6)}%`
    totLine += ` ${smartSavPct.toFixed(1).padStart(6)}%`
  }
  console.log(totLine)

  // ── Final Summary Box ──────────────────────────────────

  const B = 72
  console.log('\n' + '╔' + '═'.repeat(B) + '╗')
  console.log('║' + '  RESULTS SUMMARY'.padEnd(B) + '║')
  console.log('╠' + '═'.repeat(B) + '╣')
  console.log('║' + `  Project: acme-platform (${javaFiles.length} files, ${totalProjectTokens.toLocaleString()} tokens, ${allSymbols.length} symbols)`.padEnd(B) + '║')
  console.log('║' + `  Queries: ${QUERIES.length} realistic developer questions`.padEnd(B) + '║')
  console.log('║' + ''.padEnd(B) + '║')

  const approaches = [
    { name: 'Without Condex (Naive)', total: totalNaive, saved: 0, pct: 0, note: 'read all matching source files' },
    { name: 'Condex BM25 Only', total: totalBM25, saved: totalNaive - totalBM25, pct: bm25SavPct, note: `gate fires on ${results.filter(r => r.bm25.gateFired).length}/${QUERIES.length} queries` },
  ]
  if (VECTOR_ENABLED) {
    approaches.push(
      { name: 'Condex BM25+Vector Hybrid', total: totalVector, saved: totalNaive - totalVector, pct: vecSavPct, note: 'always returns results, more verbose' },
      { name: 'Condex Smart (BM25 + vec fallback)', total: totalSmart, saved: totalNaive - totalSmart, pct: smartSavPct, note: `vector fallback on ${results.filter(r => r.smart?.usedVector).length}/${QUERIES.length} queries` },
    )
  }

  for (const a of approaches) {
    console.log('║' + ''.padEnd(B) + '║')
    console.log('║' + `  ${a.name}`.padEnd(B) + '║')
    console.log('║' + `    Tokens: ${a.total.toLocaleString().padStart(8)}  │  Savings: ${a.pct.toFixed(1).padStart(5)}%  │  Saved: ${a.saved.toLocaleString().padStart(8)}`.padEnd(B) + '║')
    console.log('║' + `    ${a.note}`.padEnd(B) + '║')
  }

  console.log('║' + ''.padEnd(B) + '║')
  if (VECTOR_ENABLED) {
    console.log('║' + '  RECOMMENDED: Smart mode — best balance of savings + coverage'.padEnd(B) + '║')
  }
  console.log('╚' + '═'.repeat(B) + '╝')

  // Verbose details
  if (VERBOSE) {
    console.log('\n── Per-Query Details ─────────────────────────────\n')
    for (const r of results) {
      console.log(`  "${r.query}" — ${r.description}`)
      console.log(`    Naive:  ${r.naive.tokens.toString().padStart(6)} tok (${r.naive.filesRead} files)`)
      console.log(`    BM25:   ${r.bm25.tokens.toString().padStart(6)} tok (${r.bm25.symbolsFound} sym, score ${r.bm25.topScore.toFixed(3)}${r.bm25.gateFired ? ', GATE' : ''})`)
      if (r.vector) {
        console.log(`    Hybrid: ${r.vector.tokens.toString().padStart(6)} tok (${r.vector.symbolsFound} sym)`)
      }
      if (r.smart) {
        console.log(`    Smart:  ${r.smart.tokens.toString().padStart(6)} tok (${r.smart.symbolsFound} sym${r.smart.usedVector ? ', vec-fallback' : ''})`)
      }
      console.log()
    }
  }

  db.close()
}

// ─── Main ──────────────────────────────────────────────────

// Check sample project exists
if (!fs.existsSync(SAMPLE_ROOT)) {
  console.error('Sample project not found. Run: npx tsx benchmark/generate-sample.ts')
  process.exit(1)
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
