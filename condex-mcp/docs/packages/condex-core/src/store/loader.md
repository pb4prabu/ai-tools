# loader.ts — Index Loader (Disk → SQLite)

**Path:** `packages/condex-core/src/store/loader.ts`

## What it does

Loads a project's pre-built index from `.condex/index/` files on disk into the in-memory SQLite database. This is the bridge between the durable filesystem store and the fast in-memory query engine.

## Load flow

```
.condex/index/meta.json           → Read project metadata
.condex/index/symbols/*.json      → Read all symbol files
.condex/index/schema/migrations.json → Read schema symbols
.condex/index/config/application.json → Read config symbols
           │
           ▼
    insertProject(db, ...)
    insertSymbols(db, ...)
    insertSchemaSymbols(db, ...)
    insertConfigSymbols(db, ...)
           │
           ▼
    SQLite ready for queries
```

## Key export

```typescript
loadProject(db, safeFs) → LoadResult | null
```

Returns `null` if no `meta.json` exists. Otherwise returns:
- `symbolCount`, `schemaCount`, `configCount`
- `architecture`
- `loadTimeMs`
