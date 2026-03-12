import type { SymbolKind, SpringRole, HexRole } from './symbol.js'

export interface BM25Result {
  symbolId: string
  bm25Score: number
  rank: number
}

export interface VectorResult {
  symbolId: string
  distance: number
  rank: number
}

export interface FusedResult {
  symbolId: string
  rrfScore: number
}

export interface GateResult {
  passed: boolean
  results: FusedResult[]
  reason?: 'NO_RESULTS' | 'BELOW_CONFIDENCE_THRESHOLD'
  topScore: number
}

export interface SearchFilters {
  kind?: SymbolKind
  springRole?: SpringRole
  hexRole?: HexRole
  filePattern?: string
}

export interface SearchOptions {
  query: string
  projectId: string
  filters?: SearchFilters
  limit?: number
}
