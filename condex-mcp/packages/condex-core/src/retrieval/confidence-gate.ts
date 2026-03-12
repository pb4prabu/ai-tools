import type { BM25Result } from './bm25.js'

export interface GateResult {
  passed: boolean
  results: BM25Result[]
  reason?: 'NO_RESULTS' | 'BELOW_CONFIDENCE_THRESHOLD'
  topScore: number
}

/**
 * Confidence gate: silence is safer than wrong context.
 *
 * If the top BM25 score is below threshold, return nothing.
 * The AI agent falls back to normal file reading — no harm done.
 * Wrong context injected into a prompt is worse than no context.
 */
export function applyConfidenceGate(
  results: BM25Result[],
  threshold: number = 0.12
): GateResult {
  if (results.length === 0) {
    return { passed: false, results: [], reason: 'NO_RESULTS', topScore: 0 }
  }

  const topScore = results[0].bm25Score

  if (topScore < threshold) {
    return {
      passed: false,
      results: [],
      reason: 'BELOW_CONFIDENCE_THRESHOLD',
      topScore,
    }
  }

  // Return only results above threshold
  const confident = results.filter(r => r.bm25Score >= threshold)

  return { passed: true, results: confident, topScore }
}
