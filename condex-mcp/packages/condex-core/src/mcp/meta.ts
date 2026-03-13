import type { CondexMeta } from '../types/meta.js'
import { countTokens } from '../token/counter.js'
import type { SavingsTracker } from '../token/savings.js'

/** Optional savings tracker — set by server after init */
let tracker: SavingsTracker | null = null

export function setSavingsTracker(t: SavingsTracker): void {
  tracker = t
}

export function buildMeta(opts: {
  startMs: number
  projectId: string
  projectName: string
  architecture: string | null
  symbolsReturned: number
  tokensInResponse: number
  tokensIfNaive: number
  confidenceGateFired: boolean
  topScore: number
}): CondexMeta {
  const timingMs = Date.now() - opts.startMs
  const tokensSaved = Math.max(0, opts.tokensIfNaive - opts.tokensInResponse)

  if (tracker) {
    tracker.trackSaving(tokensSaved)
  }

  return {
    timingMs,
    projectId: opts.projectId,
    projectName: opts.projectName,
    architecture: opts.architecture ?? 'unknown',
    symbolsReturned: opts.symbolsReturned,
    tokensInResponse: opts.tokensInResponse,
    tokensIfNaive: opts.tokensIfNaive,
    tokensSaved,
    tokensSavedPercent: opts.tokensIfNaive > 0
      ? Math.round((tokensSaved / opts.tokensIfNaive) * 100)
      : 0,
    sessionTokensSaved: tracker?.getSessionTokensSaved() ?? tokensSaved,
    allTimeTokensSaved: tracker?.getAllTimeTokensSaved() ?? 0,
    confidenceGateFired: opts.confidenceGateFired,
    topScore: opts.topScore,
  }
}

/**
 * Count tokens accurately using js-tiktoken.
 */
export { countTokens }
