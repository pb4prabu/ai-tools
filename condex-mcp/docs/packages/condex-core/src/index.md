# index.ts — Public API Barrel Export

**Path:** `packages/condex-core/src/index.ts`

## What it does

This is the single public entry point for the `@condex-ai/core` package. It re-exports everything that external consumers (like `@condex-ai/cli` or `@condex-ai/java`) need to import.

It does NOT contain any logic — it's purely a barrel file that aggregates exports from all internal modules.

## What it exports

| Category | Exports |
|----------|---------|
| **Types** | `Symbol`, `SymbolKind`, `SpringRole`, `HexRole`, `SchemaSymbol`, `ConfigSymbol`, `CondexConfig`, `ProjectMeta`, `CondexMeta`, `BM25Result`, etc. |
| **Security** | `SafeFS` class |
| **Namespace** | `generateNamespace()`, `getProjectRoot()` |
| **SQLite Store** | `createSchema()`, `insertProject()`, `insertSymbols()`, `getSymbolById()`, etc. |
| **FS Store** | `initCondexDir()`, `writeSymbolFile()`, `readMeta()`, `writeMeta()`, etc. |
| **Indexer** | `indexProject()`, `ParseFileFn`, `DetectArchFn`, `ParseSqlFn`, `ParseYamlFn` |
| **Retrieval** | `searchBM25()`, `applyConfidenceGate()`, `vectorSearch()`, `rrfFusion()` |
| **Token** | `countTokens()`, `SavingsTracker` |
| **Embeddings** | `getEmbedder()`, `prepareSymbolText()` |
| **Loader** | `loadProject()` |

## Why it matters

Without this file, every consumer would need to import from deep internal paths like `@condex-ai/core/dist/store/sqlite-store.js`. This barrel export gives a clean public API surface.
