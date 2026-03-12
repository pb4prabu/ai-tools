import Database from 'better-sqlite3'
import { SafeFS, createSchema, loadProject, generateNamespace } from '../packages/cortex-core/src/index.js'
import { countTokens } from '../packages/cortex-core/src/token/counter.js'
import { getEmbedder, prepareSymbolText } from '../packages/cortex-core/src/embeddings/local-embed.js'
import { loadVec, insertVectors } from '../packages/cortex-core/src/retrieval/vector-search.js'

async function main() {
const PROJECT_ROOT = '/Users/praveen/PB_OWN/Urbanbarrow/urbanbarrow-mono'
const safeFs = new SafeFS(PROJECT_ROOT)
const db = new Database(':memory:')
db.pragma('journal_mode = WAL')
createSchema(db)
const projectId = generateNamespace(PROJECT_ROOT)
await loadProject(db, safeFs)

// Build vector index
console.log('Loading embedder...')
const embedder = await getEmbedder()
loadVec(db)
const allSymbols = db.prepare(
  'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
).all(projectId) as any[]

console.log(`Embedding ${allSymbols.length} symbols...`)
const batchSize = 50
for (let i = 0; i < allSymbols.length; i += batchSize) {
  const batch = allSymbols.slice(i, i + batchSize)
  const texts = batch.map((s: any) => prepareSymbolText({
    qualifiedName: s.qualified_name, signature: s.signature,
    javadoc: s.javadoc, kind: s.kind,
  }))
  const embeddings = await embedder.embedBatch(texts)
  insertVectors(db, batch.map((s: any, idx: number) => ({
    symbolId: s.id, embedding: embeddings[idx],
  })))
}

// Query with NO limit
const query = "order creation flow"
console.log(`\nQuery: "${query}"`)
const queryVec = await embedder.embed(query)
const queryBuf = Buffer.from(queryVec.buffer)

const ALL = db.prepare(`
  SELECT symbol_id AS symbolId, distance
  FROM symbol_vectors
  WHERE embedding MATCH ?
  ORDER BY distance
  LIMIT 2692
`).all(queryBuf) as any[]

const filtered = ALL.filter((r: any) => r.symbolId.startsWith(`${projectId}::`))

console.log(`Total results: ${filtered.length}`)
console.log(``)
console.log(`Distance distribution:`)
console.log(`  Top 5:     ${filtered[0]?.distance.toFixed(4)} - ${filtered[4]?.distance.toFixed(4)}`)
console.log(`  Top 10:    ${filtered[0]?.distance.toFixed(4)} - ${filtered[9]?.distance.toFixed(4)}`)
console.log(`  Top 20:    ${filtered[0]?.distance.toFixed(4)} - ${filtered[19]?.distance.toFixed(4)}`)
console.log(`  Top 50:    ${filtered[0]?.distance.toFixed(4)} - ${filtered[49]?.distance.toFixed(4)}`)
console.log(`  Top 100:   ${filtered[0]?.distance.toFixed(4)} - ${filtered[99]?.distance.toFixed(4)}`)
console.log(`  Top 500:   ${filtered[0]?.distance.toFixed(4)} - ${filtered[499]?.distance.toFixed(4)}`)
console.log(`  ALL ${filtered.length}:  ${filtered[0]?.distance.toFixed(4)} - ${filtered[filtered.length - 1]?.distance.toFixed(4)}`)

console.log(`\nToken cost at each level:`)
for (const count of [5, 10, 20, 50, 100, 200, 500, filtered.length]) {
  const slice = filtered.slice(0, Math.min(count, filtered.length))
  const enriched = slice.map((r: any) => {
    const row = db.prepare('SELECT qualified_name, signature, kind, file_path FROM symbols WHERE id = ?').get(r.symbolId) as any
    return { qualifiedName: row?.qualified_name, signature: row?.signature, kind: row?.kind, filePath: row?.file_path }
  })
  const text = JSON.stringify(enriched, null, 2)
  const tokens = countTokens(text)
  console.log(`  ${String(Math.min(count, filtered.length)).padStart(5)} results → ${String(tokens).padStart(7)} tokens  (distance: ${slice[0]?.distance.toFixed(4)} - ${slice[slice.length - 1]?.distance.toFixed(4)})`)
}

console.log(`\nNaive (read all 500 source files): ~133,735 tokens`)

// Find crossover
for (let i = 50; i <= filtered.length; i += 50) {
  const slice = filtered.slice(0, i)
  const enriched = slice.map((r: any) => {
    const row = db.prepare('SELECT qualified_name, signature, kind, file_path FROM symbols WHERE id = ?').get(r.symbolId) as any
    return { qualifiedName: row?.qualified_name, signature: row?.signature, kind: row?.kind, filePath: row?.file_path }
  })
  const tokens = countTokens(JSON.stringify(enriched, null, 2))
  if (tokens > 133735) {
    console.log(`\nCrossover: Cortex exceeds naive at ~${i} results (~${tokens} tokens)`)
    break
  }
}

// Show what top 5 and bottom 5 look like
console.log(`\n=== TOP 5 (most relevant) ===`)
for (const r of filtered.slice(0, 5)) {
  const row = db.prepare('SELECT qualified_name, kind FROM symbols WHERE id = ?').get(r.symbolId) as any
  console.log(`  ${r.distance.toFixed(4)}  ${row?.qualified_name} (${row?.kind})`)
}
console.log(`\n=== RANK 46-50 (moderately relevant) ===`)
for (const r of filtered.slice(45, 50)) {
  const row = db.prepare('SELECT qualified_name, kind FROM symbols WHERE id = ?').get(r.symbolId) as any
  console.log(`  ${r.distance.toFixed(4)}  ${row?.qualified_name} (${row?.kind})`)
}
console.log(`\n=== RANK 96-100 (weakly relevant) ===`)
for (const r of filtered.slice(95, 100)) {
  const row = db.prepare('SELECT qualified_name, kind FROM symbols WHERE id = ?').get(r.symbolId) as any
  console.log(`  ${r.distance.toFixed(4)}  ${row?.qualified_name} (${row?.kind})`)
}
console.log(`\n=== LAST 5 (least relevant — garbage) ===`)
for (const r of filtered.slice(-5)) {
  const row = db.prepare('SELECT qualified_name, kind FROM symbols WHERE id = ?').get(r.symbolId) as any
  console.log(`  ${r.distance.toFixed(4)}  ${row?.qualified_name} (${row?.kind})`)
}
}

main().catch(err => { console.error(err); process.exit(1) })
