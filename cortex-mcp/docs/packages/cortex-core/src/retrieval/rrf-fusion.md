# rrf-fusion.ts — Reciprocal Rank Fusion

**Path:** `packages/cortex-core/src/retrieval/rrf-fusion.ts`

## What it does

Combines BM25 and vector search results into a single ranked list using Reciprocal Rank Fusion (RRF). Used by the `hybrid` search mode.

## How RRF works

Each result gets a score based on its rank position in each list:

```
RRF_score = 1/(k + bm25_rank) + 1/(k + vector_rank)
```

Where `k = 60` (standard constant that dampens the influence of high ranks).

## Example

| Symbol | BM25 Rank | Vector Rank | RRF Score |
|--------|-----------|-------------|-----------|
| OrderController | 1 | 3 | 1/61 + 1/63 = 0.0323 |
| OrderService | 2 | 1 | 1/62 + 1/61 = 0.0325 |
| UserController | — | 2 | 0 + 1/62 = 0.0161 |

Symbols appearing in **both** lists get boosted because they score from both sides.

## Key export

```typescript
rrfFusion(bm25Results, vectorResults, topK?) → FusedResult[]
```

Each `FusedResult` includes `bm25Rank`, `vectorRank`, and `rrfScore` so you can see how each result was ranked.
