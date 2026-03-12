# handlers.ts — MCP Tool Handlers (Core Business Logic)

**Path:** `packages/cortex-core/src/mcp/handlers.ts`

## What it does

Contains the actual business logic for all 10 MCP tools. This is the most important file in the project — it's where queries hit the database, search results are assembled, and token savings are calculated.

## HandlerContext

Every handler receives a shared context object:

```typescript
interface HandlerContext {
  db: Database.Database       // In-memory SQLite
  safeFs: SafeFS              // Filesystem access guard
  projectId: string           // Current project namespace
  projectName: string         // Folder name
  architecture: string | null // Detected architecture (hexagonal/layered/mvc)
  searchMode: SearchMode      // 'bm25' | 'vector' | 'hybrid' | 'smart'
  embedder: Embedder | null   // HuggingFace embedding model (null for BM25-only)
}
```

## Search Modes (in `handleSearchSymbols`)

This is the most complex handler. It branches based on `ctx.searchMode`:

### BM25
1. Run FTS5 keyword search
2. Apply confidence gate (threshold 0.12)
3. If gate fires → return "no confident results" message
4. If gate passes → return ranked symbols

### Vector
1. Embed the query text using HuggingFace model
2. Run nearest-neighbor search in sqlite-vec
3. Return top-K symbols by cosine similarity

### Hybrid
1. Run both BM25 (2x limit) and Vector (2x limit)
2. Combine with Reciprocal Rank Fusion (k=60)
3. Return top-K fused results

### Smart (Recommended)
1. Try BM25 first
2. If confidence gate passes → return BM25 results (cheap path)
3. If gate fires → fall back to vector search
4. Best of both: BM25 efficiency when it works, vector coverage when it doesn't

## Other Handlers

| Handler | What it does |
|---------|-------------|
| `handleListProjects` | Lists all projects in SQLite |
| `handleGetProjectOutline` | Returns package-level aggregation (classes per package) |
| `handleGetFileOutline` | Lists all symbols in a file (kind, name, signature) |
| `handleGetSymbol` | Reads source code at byte offset, verifies content hash |
| `handleGetSymbols` | Batch version of get_symbol |
| `handleSearchSchema` | FTS5 search on schema_symbols table |
| `handleGetContextForTask` | Runs search_symbols, then assembles results within a token budget |
| `handleIndexFolder` | Stub (actual indexing handled in server.ts) |
| `handleInvalidateCache` | Clears project data from SQLite |

## Every response includes `_meta`

Each handler attaches metadata via `buildMeta()`:
- `timingMs` — how long the handler took
- `tokensInResponse` — tokens in the returned JSON
- `tokensIfNaive` — estimated tokens if reading whole source files
- `tokensSaved` / `tokensSavedPercent` — the savings
- `confidenceGateFired` — whether BM25 gate blocked results
