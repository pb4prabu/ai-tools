/**
 * Vector similarity search using sqlite-vec.
 * Queries the symbol_vectors virtual table for nearest neighbors.
 */
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { Embedder } from '../embeddings/local-embed.js'

export interface VectorResult {
  symbolId: string
  distance: number
}

/**
 * Load sqlite-vec extension into the database.
 * Creates the symbol_vectors virtual table if needed.
 */
export function loadVec(db: Database.Database): void {
  const esmRequire = createRequire(import.meta.url)
  const sqliteVec = esmRequire('sqlite-vec')
  sqliteVec.load(db)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbol_vectors USING vec0(
      symbol_id TEXT PRIMARY KEY,
      embedding float[768]
    )
  `)
}

/**
 * Insert embeddings for symbols.
 */
export function insertVectors(
  db: Database.Database,
  vectors: { symbolId: string; embedding: Float32Array }[]
): void {
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO symbol_vectors (symbol_id, embedding) VALUES (?, ?)'
  )
  const insertMany = db.transaction((items: typeof vectors) => {
    for (const v of items) {
      stmt.run(v.symbolId, Buffer.from(v.embedding.buffer))
    }
  })
  insertMany(vectors)
}

/**
 * Clear vectors for a project (by symbol ID prefix).
 */
export function clearVectors(db: Database.Database, projectId: string): void {
  // symbol IDs start with projectId::
  db.prepare('DELETE FROM symbol_vectors WHERE symbol_id LIKE ?').run(`${projectId}::%`)
}

/**
 * Search for similar symbols using vector embeddings.
 * Returns all results below maxDistance threshold (no count limit).
 * Over-fetches from sqlite-vec and filters by project + distance in application layer.
 */
export async function vectorSearch(
  db: Database.Database,
  queryText: string,
  projectId: string,
  embedder: Embedder,
  maxDistance: number = 0.95
): Promise<VectorResult[]> {
  // Guard: ensure symbol_vectors table exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='symbol_vectors'"
  ).get()
  if (!tableExists) {
    throw new Error(
      'Vector search unavailable: symbol_vectors table not found. ' +
      'Ensure sqlite-vec is installed and CONDEX_SEARCH_MODE is set to vector, hybrid, or smart.'
    )
  }

  const queryVec = await embedder.embed(queryText)
  const queryBuf = Buffer.from(queryVec.buffer)

  // Fetch a large batch — sqlite-vec doesn't support WHERE on distance
  const rows = db.prepare(`
    SELECT symbol_id AS symbolId, distance
    FROM symbol_vectors
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT 500
  `).all(queryBuf) as VectorResult[]

  // Filter by project and distance threshold
  return rows
    .filter(r => r.symbolId.startsWith(`${projectId}::`) && r.distance <= maxDistance)
}
