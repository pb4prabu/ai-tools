# vector-search.ts — Vector Similarity Search

**Path:** `packages/condex-core/src/retrieval/vector-search.ts`

## What it does

Performs semantic similarity search using vector embeddings stored in SQLite via the `sqlite-vec` extension. Unlike BM25 which matches keywords, vector search understands meaning — "authentication login" can find `AuthController.tenantUserLogin`.

## How it works

1. **Embed the query** — Convert query text to a 768-dimensional vector using the HuggingFace model
2. **Nearest-neighbor search** — Query the `symbol_vectors` virtual table for closest vectors
3. **Filter by project** — Join with `symbols` table to filter by `project_id`
4. **Return results** — Sorted by distance (lower = more similar)

## sqlite-vec

Uses the `sqlite-vec` extension which adds vector operations to SQLite:
- Virtual table `symbol_vectors` stores 768-dim float32 vectors
- Queries use `vec_distance_cosine()` for similarity measurement
- All vectors live in-memory (part of the SQLite in-memory database)

## Key functions

| Function | Purpose |
|----------|---------|
| `loadVec(db)` | Loads the sqlite-vec extension into the database |
| `insertVectors(db, vectors)` | Batch-insert symbol embeddings |
| `clearVectors(db, projectId)` | Remove vectors for a project |
| `vectorSearch(db, query, projectId, embedder, topK?)` | Run similarity search |

## Performance note

Over-fetches 3x the requested `topK` because filtering by `project_id` happens after the vector search (sqlite-vec doesn't support WHERE clauses on the virtual table directly).
