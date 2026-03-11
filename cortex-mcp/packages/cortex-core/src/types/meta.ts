/**
 * _meta envelope included in every tool response.
 * Shows token savings and query performance.
 */
export interface CortexMeta {
  timingMs: number
  projectId: string
  projectName: string
  architecture: string
  symbolsReturned: number
  tokensInResponse: number // tokens actually returned to AI
  tokensIfNaive: number // tokens if agent had read all source files
  tokensSaved: number // tokensIfNaive - tokensInResponse
  tokensSavedPercent: number // (tokensSaved / tokensIfNaive) * 100
  sessionTokensSaved: number // cumulative this MCP session
  allTimeTokensSaved: number // persisted to savings.json
  confidenceGateFired: boolean // true if gate returned nothing
  topScore: number // top BM25 or RRF score
}
