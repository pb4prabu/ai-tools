/**
 * Shared vector embedding helper.
 * Eliminates duplicated batch-embed-insert loops across server.ts and incremental-reindexer.ts.
 */
import type Database from 'better-sqlite3'
import type { Embedder } from '../embeddings/local-embed.js'
import { insertVectors, clearVectors } from './vector-search.js'
import type { PrepareSymbolTextFn } from '../indexer/shared.js'

export type { PrepareSymbolTextFn }

export interface SymbolRow {
  id: string
  qualified_name: string
  signature: string
  javadoc: string | null
  kind: string
}

const BATCH_SIZE = 50

/**
 * Embed all symbols and insert into vector index.
 * Optionally clears existing vectors for the project first.
 */
export async function buildVectorIndex(
  db: Database.Database,
  projectId: string,
  embedder: Embedder,
  prepareSymbolText: PrepareSymbolTextFn,
  opts?: { clear?: boolean },
): Promise<number> {
  const allSymbols = db.prepare(
    'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?',
  ).all(projectId) as SymbolRow[]

  if (allSymbols.length === 0) return 0

  if (opts?.clear) {
    clearVectors(db, projectId)
  }

  for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
    const batch = allSymbols.slice(i, i + BATCH_SIZE)
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

  return allSymbols.length
}
