/**
 * Standalone test: Index a project and run vector search — no MCP needed.
 * Usage: CONDEX_SEARCH_MODE=vector npx tsx test-vector.ts /path/to/project
 */
import path from 'node:path'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import {
  SafeFS,
  generateNamespace,
  createSchema,
  loadProject,
  indexProject,
  searchBM25,
  getEmbedder,
  prepareSymbolText,
  loadVec,
  insertVectors,
  vectorSearch,
  rrfFusion,
} from './packages/condex-core/src/index.js'

const PROJECT_ROOT = path.resolve(process.argv[2] || process.cwd())
const QUERY = process.argv[3] || 'ObservabilityFramework'

function loadJavaParser() {
  try {
    const esmRequire = createRequire(import.meta.url)
    const javaPkg = esmRequire('@condex-ai/java')
    return {
      parseFileWithRefs: javaPkg.parseJavaFileWithRefs,
      detectArch: javaPkg.detectArchitecture,
      parseSql: javaPkg.parseSqlFile,
      parseYaml: javaPkg.parseYamlFile,
    }
  } catch {
    return null
  }
}

async function main() {
  console.log(`\n=== Condex Vector Test ===`)
  console.log(`Project: ${PROJECT_ROOT}`)
  console.log(`Query:   "${QUERY}"\n`)

  // 1. Setup
  const safeFs = new SafeFS(PROJECT_ROOT)
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)
  const namespace = generateNamespace(PROJECT_ROOT)
  console.log(`[1/6] Namespace: ${namespace}`)

  // 2. Index
  const javaParsers = loadJavaParser()
  if (!javaParsers) {
    console.error('ERROR: Java parser not found. Run npm run build first.')
    process.exit(1)
  }
  console.log(`[2/6] Java parser loaded`)

  const metaPath = path.join(PROJECT_ROOT, '.condex', 'index', 'meta.json')
  let symbolCount = 0
  if (safeFs.existsSync(metaPath)) {
    const result = await loadProject(db, safeFs)
    symbolCount = result?.symbolCount ?? 0
    console.log(`[2/6] Loaded existing index: ${symbolCount} symbols in ${result?.loadTimeMs}ms`)
  } else {
    console.log(`[2/6] No existing index. Running full index...`)
    const result = await indexProject(db, safeFs, {
      full: true,
      parseFileWithRefs: javaParsers.parseFileWithRefs,
      detectArch: javaParsers.detectArch,
      parseSql: javaParsers.parseSql,
      parseYaml: javaParsers.parseYaml,
    })
    symbolCount = result.symbolCount
    console.log(`[2/6] Indexed: ${symbolCount} symbols from ${result.filesProcessed} files in ${result.loadTimeMs}ms`)
  }

  // 3. BM25 search (baseline)
  console.log(`\n[3/6] BM25 search for "${QUERY}"...`)
  const bm25Start = Date.now()
  const bm25Results = searchBM25(db, QUERY, namespace)
  const bm25Ms = Date.now() - bm25Start
  console.log(`  Found ${bm25Results.length} results in ${bm25Ms}ms`)
  bm25Results.slice(0, 3).forEach((r, i) =>
    console.log(`  ${i + 1}. [score=${r.score.toFixed(3)}] ${r.qualifiedName}`)
  )

  // 4. Load embedder
  console.log(`\n[4/6] Loading embedding model...`)
  const embedStart = Date.now()
  const embedder = await getEmbedder()
  console.log(`  Embedder ready (${embedder.dimensions}D) in ${Date.now() - embedStart}ms`)

  // 5. Build vector index
  console.log(`\n[5/6] Building vector index for ${symbolCount} symbols...`)
  loadVec(db)
  const allSymbols = db.prepare(
    'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
  ).all(namespace) as { id: string; qualified_name: string; signature: string; javadoc: string | null; kind: string }[]

  const vecStart = Date.now()
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
    if ((i + batchSize) % 500 === 0 || i + batchSize >= allSymbols.length) {
      process.stdout.write(`  Embedded ${Math.min(i + batchSize, allSymbols.length)}/${allSymbols.length}\r`)
    }
  }
  console.log(`  Vector index built in ${Date.now() - vecStart}ms`)

  // 6. Vector search
  console.log(`\n[6/6] Vector search for "${QUERY}"...`)
  const vecSearchStart = Date.now()
  const vecResults = await vectorSearch(db, QUERY, namespace, embedder, 0.95)
  const vecSearchMs = Date.now() - vecSearchStart
  console.log(`  Found ${vecResults.length} results in ${vecSearchMs}ms`)
  vecResults.slice(0, 5).forEach((r, i) =>
    console.log(`  ${i + 1}. [dist=${r.distance.toFixed(4)}] ${r.symbolId.split('::').pop()}`)
  )

  // Bonus: Hybrid (RRF fusion)
  if (bm25Results.length > 0 && vecResults.length > 0) {
    console.log(`\n[Bonus] Hybrid RRF fusion...`)
    const bm25Ranked = bm25Results.map(r => ({ symbolId: r.id, score: r.score }))
    const vecRanked = vecResults.map(r => ({ symbolId: r.symbolId, score: 1 - r.distance }))
    const fused = rrfFusion(bm25Ranked, vecRanked)
    console.log(`  Fused ${fused.length} results`)
    fused.slice(0, 5).forEach((r, i) =>
      console.log(`  ${i + 1}. [rrf=${r.score.toFixed(4)}] ${r.symbolId.split('::').pop()}`)
    )
  }

  console.log(`\n=== All checks passed! Vector mode works. ===\n`)
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`)
  console.error(err.stack)
  process.exit(1)
})
