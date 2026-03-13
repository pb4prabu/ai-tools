#!/usr/bin/env npx tsx
/**
 * Diagnostic script — run this on your office laptop to find the exact failure.
 * Usage: npx tsx test-diagnose.ts
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import Database from 'better-sqlite3'

async function main() {
  console.log(`\n=== Condex Vector Diagnostic ===\n`)
  console.log(`Platform: ${os.platform()}-${os.arch()}`)
  console.log(`Node:     ${process.version}`)
  console.log(`CWD:      ${process.cwd()}`)

  // Step 1: Check better-sqlite3
  console.log(`\n[1/4] better-sqlite3...`)
  try {
    const db = new Database(':memory:')
    db.exec('SELECT 1')
    console.log(`  OK`)
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`)
    process.exit(1)
  }

  // Step 2: Check sqlite-vec native binary
  console.log(`[2/4] sqlite-vec native binary...`)
  try {
    const esmRequire = createRequire(import.meta.url)
    const sqliteVec = esmRequire('sqlite-vec')
    console.log(`  OK — module loaded`)

    const db = new Database(':memory:')
    sqliteVec.load(db)
    // Use the same schema as production: symbol_id TEXT PRIMARY KEY + 768-dim float
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS test_vec USING vec0(symbol_id TEXT PRIMARY KEY, embedding float[4])`)
    const embed4 = Buffer.from(new Float32Array([1.0, 0.5, 0.5, 0.5]).buffer)
    db.prepare('INSERT INTO test_vec (symbol_id, embedding) VALUES (?, ?)').run('test::id1', embed4)
    const rows = db.prepare(`SELECT symbol_id, distance FROM test_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 1`).all(embed4) as any[]
    console.log(`  OK — vec0 table works (${rows.length} row matched, distance=${rows[0]?.distance})`)
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`)
    console.error(`  This means sqlite-vec native binary is missing for ${os.platform()}-${os.arch()}`)
    console.error(`  Fix: run "npm install" in the condex-mcp directory on THIS machine`)
    process.exit(1)
  }

  // Step 3: Check embedding model
  console.log(`[3/4] Embedding model...`)
  try {
    const { getEmbedder, getCacheDir, ensureModelDownloaded } = await import('./packages/condex-core/src/embeddings/local-embed.js')
    const cacheDir = getCacheDir()
    console.log(`  Cache dir: ${cacheDir}`)
    await ensureModelDownloaded()
    const embedder = await getEmbedder()
    const vec = await embedder.embed('test query')
    console.log(`  OK — ${embedder.dimensions}D, test embed length=${vec.length}`)
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`)
    console.error(`  The ONNX model may not be downloaded. Run: npm run download-model --workspace=packages/condex-core`)
    process.exit(1)
  }

  // Step 4: Full vector pipeline
  console.log(`[4/4] Full vector pipeline (embed + insert + search)...`)
  try {
    const esmRequire = createRequire(import.meta.url)
    const sqliteVec = esmRequire('sqlite-vec')
    const db = new Database(':memory:')
    sqliteVec.load(db)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS symbol_vectors USING vec0(symbol_id TEXT PRIMARY KEY, embedding float[768])`)

    const { getEmbedder } = await import('./packages/condex-core/src/embeddings/local-embed.js')
    const embedder = await getEmbedder()

    // Insert a test vector
    const testVec = await embedder.embed('OrderController createOrder')
    const buf = Buffer.from(testVec.buffer)
    db.prepare('INSERT INTO symbol_vectors (symbol_id, embedding) VALUES (?, ?)').run('test::sym1', buf)

    // Search
    const queryVec = await embedder.embed('create order')
    const queryBuf = Buffer.from(queryVec.buffer)
    const results = db.prepare(`SELECT symbol_id, distance FROM symbol_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 5`).all(queryBuf) as any[]
    console.log(`  OK — inserted 1 vector, search returned ${results.length} result(s), distance=${results[0]?.distance?.toFixed(4)}`)
  } catch (e: any) {
    console.error(`  FAIL: ${e.message}`)
    console.error(e.stack)
    process.exit(1)
  }

  console.log(`\n=== ALL CHECKS PASSED — Vector mode should work fine ===\n`)
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
