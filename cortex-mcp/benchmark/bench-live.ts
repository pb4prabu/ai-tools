#!/usr/bin/env npx tsx
/**
 * Live Benchmark: Runs all 4 modes against a real project.
 * Usage: npx tsx benchmark/bench-live.ts /path/to/project [--vector]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'

import { SafeFS } from '../packages/cortex-core/src/security/fs-guard.js'
import { createSchema } from '../packages/cortex-core/src/store/sqlite-store.js'
import { loadProject } from '../packages/cortex-core/src/store/loader.js'
import { searchBM25, type BM25Result } from '../packages/cortex-core/src/retrieval/bm25.js'
import { applyConfidenceGate } from '../packages/cortex-core/src/retrieval/confidence-gate.js'
import { countTokens } from '../packages/cortex-core/src/token/counter.js'
import { generateNamespace } from '../packages/cortex-core/src/namespace/namespace.js'
import { rrfFusion } from '../packages/cortex-core/src/retrieval/rrf-fusion.js'
import { vectorSearch, loadVec, insertVectors } from '../packages/cortex-core/src/retrieval/vector-search.js'
import { getEmbedder, prepareSymbolText } from '../packages/cortex-core/src/embeddings/local-embed.js'
import type { Embedder } from '../packages/cortex-core/src/embeddings/local-embed.js'
import type { VectorResult } from '../packages/cortex-core/src/retrieval/vector-search.js'

// ─── Config ────────────────────────────────────────────────

const PROJECT_ROOT = process.argv[2] || '/Users/praveen/PB_OWN/Urbanbarrow/urbanbarrow-mono'
const VECTOR_ENABLED = process.argv.includes('--vector')

// ─── Queries tailored for a Spring Boot monorepo ───────────

const QUERIES = [
  { query: 'REST controller endpoint API', description: 'What REST endpoints exist?' },
  { query: 'authentication login security', description: 'How does auth work?' },
  { query: 'repository interface persistence', description: 'What repositories exist?' },
  { query: 'service layer business logic', description: 'What services handle business logic?' },
  { query: 'exception error handling', description: 'How are errors handled?' },
  { query: 'configuration properties application', description: 'What config properties are used?' },
  { query: 'entity domain model', description: 'What domain entities exist?' },
  { query: 'Kafka event listener consumer', description: 'Where are events consumed?' },
  { query: 'Spring annotation transactional', description: 'Which methods are transactional?' },
  { query: 'validation constraint request', description: 'How is input validated?' },
  { query: 'database migration schema', description: 'How is the DB schema managed?' },
  { query: 'scheduled cron job task', description: 'What scheduled tasks exist?' },
  { query: 'notification email SMS push', description: 'How are notifications sent?' },
  { query: 'order creation flow', description: 'How does order creation work?' },
  { query: 'payment processing billing', description: 'How are payments handled?' },
]

// ─── Types ─────────────────────────────────────────────────

interface ModeResult {
  tokens: number
  symbols: number
  topScore: number
  gateFired: boolean
  timeMs: number
  topResults: string[]
  searchMode?: string // which mode actually handled it (for smart mode)
}

interface QueryResult {
  query: string
  description: string
  naive: { tokens: number; files: number; timeMs: number }
  bm25: ModeResult
  vector: ModeResult | null
  hybrid: ModeResult | null
  smart: ModeResult | null
}

// ─── Helpers ───────────────────────────────────────────────

function naiveCost(projectRoot: string, query: string, db: Database.Database, projectId: string): { tokens: number; files: number; timeMs: number } {
  const start = performance.now()
  // BM25 search to find relevant files, then sum up entire file sizes
  const results = searchBM25(db, query, projectId, undefined, 20)
  const uniqueFiles = [...new Set(results.map(r => r.filePath))]

  let totalTokens = 0
  for (const fp of uniqueFiles) {
    try {
      const fullPath = path.join(projectRoot, fp)
      const content = fs.readFileSync(fullPath, 'utf-8')
      totalTokens += countTokens(content)
    } catch {
      totalTokens += 500
    }
  }

  // If no results, estimate reading 5 random files
  if (uniqueFiles.length === 0) {
    totalTokens = 5000
  }

  return { tokens: totalTokens, files: uniqueFiles.length, timeMs: performance.now() - start }
}

function runBM25(db: Database.Database, query: string, projectId: string): ModeResult {
  const start = performance.now()
  const raw = searchBM25(db, query, projectId, undefined, 20)
  const gate = applyConfidenceGate(raw)

  const resultText = gate.passed
    ? JSON.stringify(gate.results.map(r => ({
        symbolId: r.symbolId, qualifiedName: r.qualifiedName,
        signature: r.signature, kind: r.kind, filePath: r.filePath,
      })), null, 2)
    : `No confident results for "${query}"`

  return {
    tokens: countTokens(resultText),
    symbols: gate.passed ? gate.results.length : 0,
    topScore: gate.topScore,
    gateFired: !gate.passed,
    timeMs: performance.now() - start,
    topResults: gate.passed
      ? gate.results.slice(0, 3).map(r => `${r.qualifiedName} (${r.kind})`)
      : [],
  }
}

async function runVector(db: Database.Database, query: string, projectId: string, embedder: Embedder): Promise<ModeResult> {
  const start = performance.now()
  const results = await vectorSearch(db, query, projectId, embedder, 20)

  const enriched = results.map(v => {
    const row = db.prepare('SELECT qualified_name, signature, kind, file_path FROM symbols WHERE id = ?').get(v.symbolId) as any
    return {
      symbolId: v.symbolId,
      qualifiedName: row?.qualified_name ?? v.symbolId,
      signature: row?.signature ?? '',
      kind: row?.kind ?? '',
      filePath: row?.file_path ?? '',
      distance: v.distance,
    }
  })

  const resultText = JSON.stringify(enriched, null, 2)

  return {
    tokens: countTokens(resultText),
    symbols: enriched.length,
    topScore: results.length > 0 ? Math.round((1 - results[0].distance) * 1000) / 1000 : 0,
    gateFired: false,
    timeMs: performance.now() - start,
    topResults: enriched.slice(0, 3).map(r => `${r.qualifiedName} (${r.kind})`),
  }
}

async function runHybrid(db: Database.Database, query: string, projectId: string, embedder: Embedder): Promise<ModeResult> {
  const start = performance.now()
  const bm25Results = searchBM25(db, query, projectId, undefined, 40)
  const vecResults = await vectorSearch(db, query, projectId, embedder, 40)
  const fused = rrfFusion(bm25Results, vecResults, 20)

  const enriched = fused.map(f => {
    const row = db.prepare('SELECT qualified_name, signature, kind, file_path FROM symbols WHERE id = ?').get(f.symbolId) as any
    return {
      symbolId: f.symbolId,
      qualifiedName: row?.qualified_name ?? f.symbolId,
      signature: row?.signature ?? '',
      kind: row?.kind ?? '',
      filePath: row?.file_path ?? '',
      rrfScore: f.rrfScore,
      bm25Rank: f.bm25Rank,
      vectorRank: f.vectorRank,
    }
  })

  const resultText = JSON.stringify(enriched, null, 2)

  return {
    tokens: countTokens(resultText),
    symbols: enriched.length,
    topScore: fused.length > 0 ? Math.round(fused[0].rrfScore * 10000) / 10000 : 0,
    gateFired: false,
    timeMs: performance.now() - start,
    topResults: enriched.slice(0, 3).map(r => `${r.qualifiedName} (${r.kind})`),
  }
}

async function runSmart(db: Database.Database, query: string, projectId: string, embedder: Embedder): Promise<ModeResult> {
  const start = performance.now()

  // Step 1: Try BM25
  const raw = searchBM25(db, query, projectId, undefined, 20)
  const gate = applyConfidenceGate(raw)

  if (gate.passed) {
    // BM25 confident — use it (cheapest path)
    const resultText = JSON.stringify(gate.results.map(r => ({
      symbolId: r.symbolId, qualifiedName: r.qualifiedName,
      signature: r.signature, kind: r.kind, filePath: r.filePath,
    })), null, 2)

    return {
      tokens: countTokens(resultText),
      symbols: gate.results.length,
      topScore: gate.topScore,
      gateFired: false,
      timeMs: performance.now() - start,
      topResults: gate.results.slice(0, 3).map(r => `${r.qualifiedName} (${r.kind})`),
      searchMode: 'bm25',
    }
  }

  // Step 2: BM25 gate fired — fall back to vector
  const results = await vectorSearch(db, query, projectId, embedder, 20)
  const enriched = results.map(v => {
    const row = db.prepare('SELECT qualified_name, signature, kind, file_path FROM symbols WHERE id = ?').get(v.symbolId) as any
    return {
      symbolId: v.symbolId,
      qualifiedName: row?.qualified_name ?? v.symbolId,
      signature: row?.signature ?? '',
      kind: row?.kind ?? '',
      filePath: row?.file_path ?? '',
      distance: v.distance,
    }
  })

  const resultText = JSON.stringify(enriched, null, 2)

  return {
    tokens: countTokens(resultText),
    symbols: enriched.length,
    topScore: results.length > 0 ? Math.round((1 - results[0].distance) * 1000) / 1000 : 0,
    gateFired: true,
    timeMs: performance.now() - start,
    topResults: enriched.slice(0, 3).map(r => `${r.qualifiedName} (${r.kind})`),
    searchMode: 'vector-fallback',
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`\n${'='.repeat(90)}`)
  console.log(`  CORTEX MCP — LIVE BENCHMARK`)
  console.log(`  Project: ${PROJECT_ROOT}`)
  console.log(`  Vector: ${VECTOR_ENABLED ? 'ENABLED' : 'DISABLED (use --vector to enable)'}`)
  console.log(`${'='.repeat(90)}\n`)

  // Initialize DB & load project
  const safeFs = new SafeFS(PROJECT_ROOT)
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)

  const projectId = generateNamespace(PROJECT_ROOT)
  console.log(`  Loading index...`)
  const loadResult = await loadProject(db, safeFs)
  if (!loadResult) {
    console.error('  ERROR: No index found. Run: cortex index --full')
    process.exit(1)
  }
  console.log(`  Loaded: ${loadResult.symbolCount} symbols, ${loadResult.schemaCount} schema, ${loadResult.configCount} config in ${loadResult.loadTimeMs}ms`)

  // Initialize vector search if enabled
  let embedder: Embedder | null = null
  if (VECTOR_ENABLED) {
    console.log(`\n  Loading embedding model (first run downloads ~100MB)...`)
    embedder = await getEmbedder()
    console.log(`  Embedder ready (${embedder.dimensions} dims)`)

    console.log(`  Building vector index for ${loadResult.symbolCount} symbols...`)
    loadVec(db)
    const allSymbols = db.prepare(
      'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
    ).all(projectId) as any[]

    const batchSize = 50
    for (let i = 0; i < allSymbols.length; i += batchSize) {
      const batch = allSymbols.slice(i, i + batchSize)
      const texts = batch.map((s: any) => prepareSymbolText({
        qualifiedName: s.qualified_name,
        signature: s.signature,
        javadoc: s.javadoc,
        kind: s.kind,
      }))
      const embeddings = await embedder.embedBatch(texts)
      insertVectors(db, batch.map((s: any, idx: number) => ({
        symbolId: s.id,
        embedding: embeddings[idx],
      })))
      if ((i + batchSize) % 500 === 0 || i + batchSize >= allSymbols.length) {
        process.stderr.write(`\r  Embedded ${Math.min(i + batchSize, allSymbols.length)}/${allSymbols.length} symbols`)
      }
    }
    console.log(`\n  Vector index ready.\n`)
  }

  // Run benchmark
  const results: QueryResult[] = []

  const modeCount = VECTOR_ENABLED ? 5 : 2
  console.log(`\n  Running ${QUERIES.length} queries across ${modeCount} modes...\n`)
  const V = VECTOR_ENABLED
  console.log(`  ${'Query'.padEnd(40)} ${'Naive'.padStart(8)} ${'BM25'.padStart(8)} ${V ? 'Vector'.padStart(8) : ''} ${V ? 'Hybrid'.padStart(8) : ''} ${V ? 'Smart'.padStart(8) : ''} ${'BM25%'.padStart(7)} ${V ? 'Smart%'.padStart(7) : ''}`)
  console.log(`  ${'─'.repeat(40)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${V ? '─'.repeat(8) : ''} ${V ? '─'.repeat(8) : ''} ${V ? '─'.repeat(8) : ''} ${'─'.repeat(7)} ${V ? '─'.repeat(7) : ''}`)

  for (const q of QUERIES) {
    const naive = naiveCost(PROJECT_ROOT, q.query, db, projectId)
    const bm25 = runBM25(db, q.query, projectId)
    const vector = V && embedder ? await runVector(db, q.query, projectId, embedder) : null
    const hybrid = V && embedder ? await runHybrid(db, q.query, projectId, embedder) : null
    const smart = V && embedder ? await runSmart(db, q.query, projectId, embedder) : null

    results.push({ query: q.query, description: q.description, naive, bm25, vector, hybrid, smart })

    const bm25Pct = naive.tokens > 0 ? ((1 - bm25.tokens / naive.tokens) * 100).toFixed(1) : '—'
    const smartPct = smart && naive.tokens > 0 ? ((1 - smart.tokens / naive.tokens) * 100).toFixed(1) : '—'

    console.log(
      `  ${q.query.padEnd(40).slice(0, 40)} ${String(naive.tokens).padStart(8)} ${String(bm25.tokens).padStart(8)} ` +
      `${vector ? String(vector.tokens).padStart(8) : ''} ${hybrid ? String(hybrid.tokens).padStart(8) : ''} ` +
      `${smart ? String(smart.tokens).padStart(8) : ''} ` +
      `${String(bm25Pct + '%').padStart(7)} ${V ? String(smartPct + '%').padStart(7) : ''}`
    )
  }

  // Summary
  const totals = {
    naive: results.reduce((s, r) => s + r.naive.tokens, 0),
    bm25: results.reduce((s, r) => s + r.bm25.tokens, 0),
    vector: results.reduce((s, r) => s + (r.vector?.tokens ?? 0), 0),
    hybrid: results.reduce((s, r) => s + (r.hybrid?.tokens ?? 0), 0),
    smart: results.reduce((s, r) => s + (r.smart?.tokens ?? 0), 0),
    bm25Time: results.reduce((s, r) => s + r.bm25.timeMs, 0),
    vectorTime: results.reduce((s, r) => s + (r.vector?.timeMs ?? 0), 0),
    hybridTime: results.reduce((s, r) => s + (r.hybrid?.timeMs ?? 0), 0),
    smartTime: results.reduce((s, r) => s + (r.smart?.timeMs ?? 0), 0),
    naiveTime: results.reduce((s, r) => s + r.naive.timeMs, 0),
    gatesFired: results.filter(r => r.bm25.gateFired).length,
    smartBm25Hits: results.filter(r => r.smart?.searchMode === 'bm25').length,
    smartVectorFallbacks: results.filter(r => r.smart?.searchMode === 'vector-fallback').length,
  }

  console.log(`  ${'─'.repeat(40)} ${'─'.repeat(8)} ${'─'.repeat(8)} ${V ? '─'.repeat(8) : ''} ${V ? '─'.repeat(8) : ''} ${V ? '─'.repeat(8) : ''} ${'─'.repeat(7)} ${V ? '─'.repeat(7) : ''}`)
  const totalBm25Pct = ((1 - totals.bm25 / totals.naive) * 100).toFixed(1)
  const totalSmartPct = totals.smart > 0 ? ((1 - totals.smart / totals.naive) * 100).toFixed(1) : '—'
  console.log(
    `  ${'TOTAL'.padEnd(40)} ${String(totals.naive).padStart(8)} ${String(totals.bm25).padStart(8)} ` +
    `${V ? String(totals.vector).padStart(8) : ''} ${V ? String(totals.hybrid).padStart(8) : ''} ` +
    `${V ? String(totals.smart).padStart(8) : ''} ` +
    `${String(totalBm25Pct + '%').padStart(7)} ${V ? String(totalSmartPct + '%').padStart(7) : ''}`
  )

  console.log(`\n${'='.repeat(90)}`)
  console.log(`  RESULTS SUMMARY`)
  console.log(`${'='.repeat(90)}`)
  console.log(``)
  console.log(`  WITHOUT CORTEX (Naive — read matching source files)`)
  console.log(`    Tokens: ${totals.naive.toLocaleString()}`)
  console.log(`    Time:   ${totals.naiveTime.toFixed(0)}ms total`)
  console.log(``)
  console.log(`  CORTEX BM25 (keyword search, FTS5 + Porter stemmer)`)
  console.log(`    Tokens: ${totals.bm25.toLocaleString()}  |  Savings: ${totalBm25Pct}%  |  Saved: ${(totals.naive - totals.bm25).toLocaleString()} tokens`)
  console.log(`    Time:   ${totals.bm25Time.toFixed(0)}ms total (${(totals.bm25Time / QUERIES.length).toFixed(1)}ms avg)`)
  console.log(`    Gates:  ${totals.gatesFired}/${QUERIES.length} queries below confidence threshold`)

  if (VECTOR_ENABLED) {
    console.log(``)
    console.log(`  CORTEX VECTOR (semantic search, nomic-embed-text-v1.5)`)
    console.log(`    Tokens: ${totals.vector.toLocaleString()}  |  Savings: ${((1 - totals.vector / totals.naive) * 100).toFixed(1)}%  |  Saved: ${(totals.naive - totals.vector).toLocaleString()} tokens`)
    console.log(`    Time:   ${totals.vectorTime.toFixed(0)}ms total (${(totals.vectorTime / QUERIES.length).toFixed(1)}ms avg)`)
    console.log(``)
    console.log(`  CORTEX HYBRID (BM25 + Vector, RRF fusion k=60)`)
    console.log(`    Tokens: ${totals.hybrid.toLocaleString()}  |  Savings: ${((1 - totals.hybrid / totals.naive) * 100).toFixed(1)}%  |  Saved: ${(totals.naive - totals.hybrid).toLocaleString()} tokens`)
    console.log(`    Time:   ${totals.hybridTime.toFixed(0)}ms total (${(totals.hybridTime / QUERIES.length).toFixed(1)}ms avg)`)
    console.log(``)
    console.log(`  CORTEX SMART (BM25 first, vector fallback when gate fires) ★ RECOMMENDED`)
    console.log(`    Tokens: ${totals.smart.toLocaleString()}  |  Savings: ${totalSmartPct}%  |  Saved: ${(totals.naive - totals.smart).toLocaleString()} tokens`)
    console.log(`    Time:   ${totals.smartTime.toFixed(0)}ms total (${(totals.smartTime / QUERIES.length).toFixed(1)}ms avg)`)
    console.log(`    Route:  ${totals.smartBm25Hits} via BM25, ${totals.smartVectorFallbacks} via vector fallback`)
  }

  // Accuracy: show top 3 results per query per mode
  console.log(`\n${'='.repeat(90)}`)
  console.log(`  ACCURACY — Top 3 results per query`)
  console.log(`${'='.repeat(90)}`)

  for (const r of results) {
    console.log(`\n  "${r.query}" — ${r.description}`)
    console.log(`    BM25   (${r.bm25.symbols} sym, ${r.bm25.timeMs.toFixed(0)}ms${r.bm25.gateFired ? ', GATE FIRED' : ''}):`)
    if (r.bm25.topResults.length > 0) {
      for (const tr of r.bm25.topResults) console.log(`      - ${tr}`)
    } else {
      console.log(`      (no results — gate fired)`)
    }

    if (r.vector) {
      console.log(`    Vector (${r.vector.symbols} sym, ${r.vector.timeMs.toFixed(0)}ms):`)
      for (const tr of r.vector.topResults) console.log(`      - ${tr}`)
    }

    if (r.hybrid) {
      console.log(`    Hybrid (${r.hybrid.symbols} sym, ${r.hybrid.timeMs.toFixed(0)}ms):`)
      for (const tr of r.hybrid.topResults) console.log(`      - ${tr}`)
    }

    if (r.smart) {
      console.log(`    Smart  (${r.smart.symbols} sym, ${r.smart.timeMs.toFixed(0)}ms, via ${r.smart.searchMode}):`)
      for (const tr of r.smart.topResults) console.log(`      - ${tr}`)
    }
  }

  console.log(`\n${'='.repeat(90)}\n`)
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`)
  process.exit(1)
})
