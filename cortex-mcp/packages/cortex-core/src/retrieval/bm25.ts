import type Database from 'better-sqlite3'
import type { SearchFilters } from '../types/retrieval.js'

export interface BM25Result {
  symbolId: string
  projectId: string
  qualifiedName: string
  signature: string
  javadoc: string | null
  springRole: string | null
  hexRole: string | null
  filePath: string
  kind: string
  byteOffset: number
  byteLength: number
  bm25Score: number
}

/**
 * Sanitize query for FTS5.
 * - Strips special chars that break FTS5 syntax
 * - Splits on whitespace
 * - Filters short tokens
 * - Handles dotted Java names (com.app.order → com app order)
 */
function sanitizeQuery(query: string): string {
  return query
    // Split CamelCase: orderHandler → order Handler
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split runs of uppercase: XMLParser → XML Parser
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Replace dots with spaces (Java qualified names)
    .replace(/\./g, ' ')
    // Remove FTS5 special chars
    .replace(/['"*(){}[\]^~\\:!@#$%&+=|<>,;?/]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .join(' ')
}

/**
 * Build a BM25 search query against the FTS5 index.
 */
export function searchBM25(
  db: Database.Database,
  query: string,
  projectId: string,
  filters?: SearchFilters,
  limit: number = 20
): BM25Result[] {
  const sanitised = sanitizeQuery(query)
  if (!sanitised) return []

  let sql = `
    SELECT
      s.id AS symbolId,
      s.project_id AS projectId,
      s.qualified_name AS qualifiedName,
      s.signature,
      s.javadoc,
      s.spring_role AS springRole,
      s.hex_role AS hexRole,
      s.file_path AS filePath,
      s.kind,
      s.byte_offset AS byteOffset,
      s.byte_length AS byteLength,
      -symbols_fts.rank AS bm25Score
    FROM symbols_fts
    JOIN symbols s ON s.id = symbols_fts.id
    WHERE symbols_fts MATCH ?
      AND s.project_id = ?
  `
  const params: unknown[] = [sanitised, projectId]

  if (filters?.kind) {
    sql += ' AND s.kind = ?'
    params.push(filters.kind)
  }
  if (filters?.springRole) {
    sql += ' AND s.spring_role = ?'
    params.push(filters.springRole)
  }
  if (filters?.hexRole) {
    sql += ' AND s.hex_role = ?'
    params.push(filters.hexRole)
  }
  if (filters?.filePattern) {
    sql += ' AND s.file_path LIKE ?'
    params.push(`%${filters.filePattern}%`)
  }

  sql += ' ORDER BY bm25Score DESC LIMIT ?'
  params.push(limit)

  try {
    return db.prepare(sql).all(...params) as BM25Result[]
  } catch {
    // FTS5 can throw on certain query patterns — return empty
    return []
  }
}
