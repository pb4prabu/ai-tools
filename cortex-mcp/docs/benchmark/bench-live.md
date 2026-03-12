# bench-live.ts — Live Benchmark

**Path:** `benchmark/bench-live.ts`

## What it does

Runs all 5 search modes against a real project directory and produces a detailed comparison report.

## Modes benchmarked

| Mode | What it measures |
|------|-----------------|
| **Naive** | Token cost of reading full source files (no MCP) |
| **BM25** | FTS5 keyword search with confidence gate |
| **Vector** | Semantic embedding similarity search |
| **Hybrid** | BM25 + Vector combined with RRF fusion |
| **Smart** | BM25 first, vector fallback when gate fires |

## Usage

```bash
# BM25 only (fast, no model download)
npx tsx benchmark/bench-live.ts /path/to/project

# All 5 modes (downloads ~100MB embedding model on first run)
npx tsx benchmark/bench-live.ts /path/to/project --vector
```

## Test Queries

15 Spring Boot-tailored queries:
- "REST controller endpoint API"
- "authentication login security"
- "repository interface persistence"
- "order creation flow"
- "payment processing billing"
- etc.

## Output

1. **Token comparison table** — per-query tokens for each mode
2. **Summary** — total tokens, savings %, time, gate fire count
3. **Accuracy** — top 3 results per query per mode

## Example results (urbanbarrow-mono)

| Mode | Tokens | Savings | Coverage |
|------|--------|---------|----------|
| Naive | 64,115 | — | 15/15 |
| BM25 | 3,346 | 94.8% | 3/15 |
| Vector | 50,098 | 21.9% | 15/15 |
| Hybrid | 55,416 | 13.6% | 15/15 |
| Smart | 43,509 | 32.1% | 15/15 |
