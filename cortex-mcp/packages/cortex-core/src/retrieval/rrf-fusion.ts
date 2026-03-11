/**
 * Reciprocal Rank Fusion (RRF) for combining BM25 and vector search results.
 * RRF score = Σ 1/(k + rank_i) across all result lists.
 * k = 60 (standard constant that balances top vs lower ranked results)
 */
import type { BM25Result } from './bm25.js'
import type { VectorResult } from './vector-search.js'

const RRF_K = 60

export interface FusedResult {
  symbolId: string
  rrfScore: number
  bm25Rank: number | null
  vectorRank: number | null
  bm25Score: number | null
  vectorDistance: number | null
}

/**
 * Fuse BM25 and vector search results using Reciprocal Rank Fusion.
 * Results that appear in both lists get boosted.
 */
export function rrfFusion(
  bm25Results: BM25Result[],
  vectorResults: VectorResult[],
  topK: number = 20
): FusedResult[] {
  const scoreMap = new Map<string, FusedResult>()

  // Score BM25 results
  for (let rank = 0; rank < bm25Results.length; rank++) {
    const id = bm25Results[rank].symbolId
    const existing = scoreMap.get(id) ?? {
      symbolId: id,
      rrfScore: 0,
      bm25Rank: null,
      vectorRank: null,
      bm25Score: null,
      vectorDistance: null,
    }
    existing.rrfScore += 1 / (RRF_K + rank + 1)
    existing.bm25Rank = rank + 1
    existing.bm25Score = bm25Results[rank].bm25Score
    scoreMap.set(id, existing)
  }

  // Score vector results
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const id = vectorResults[rank].symbolId
    const existing = scoreMap.get(id) ?? {
      symbolId: id,
      rrfScore: 0,
      bm25Rank: null,
      vectorRank: null,
      bm25Score: null,
      vectorDistance: null,
    }
    existing.rrfScore += 1 / (RRF_K + rank + 1)
    existing.vectorRank = rank + 1
    existing.vectorDistance = vectorResults[rank].distance
    scoreMap.set(id, existing)
  }

  // Sort by RRF score descending, take topK
  return [...scoreMap.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
}
