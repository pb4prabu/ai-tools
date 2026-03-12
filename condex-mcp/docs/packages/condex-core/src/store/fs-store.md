# fs-store.ts — Filesystem Persistence

**Path:** `packages/condex-core/src/store/fs-store.ts`

## What it does

Manages the `.condex/index/` directory on disk. This is the durable store — when the MCP server restarts, it loads from these files into the in-memory SQLite database.

## Directory Structure

```
.condex/
├── index/
│   ├── meta.json                  # Project metadata (ID, language, architecture, file hashes)
│   ├── symbols/
│   │   ├── a3f2c1e9.json         # Individual symbol files (named by sha256 of symbol ID)
│   │   ├── b7d4e8f2.json
│   │   └── ...
│   ├── schema/
│   │   └── migrations.json        # All schema symbols from SQL files
│   └── config/
│       └── application.json       # All config symbols from YAML files
├── condex.config.json             # Optional project config (language, include/exclude patterns)
├── savings.json                   # Token savings tracking (session + all-time)
└── .indexing.lock                 # Lock file to prevent concurrent indexing
```

## Key functions

| Function | Purpose |
|----------|---------|
| `initCondexDir(safeFs)` | Create `.condex/index/symbols/schema/config/` dirs |
| `writeSymbolFile(safeFs, symbol)` | Write one symbol as JSON file |
| `readSymbolFiles(safeFs)` | Read all symbol JSON files |
| `removeSymbolFilesForSource(safeFs, filePath)` | Delete symbols from a specific source file |
| `writeSchemaSymbols(safeFs, schemas)` | Write `migrations.json` |
| `readSchemaSymbols(safeFs)` | Read `migrations.json` |
| `writeConfigSymbols(safeFs, configs)` | Write `application.json` |
| `readConfigSymbols(safeFs)` | Read `application.json` |
| `writeMeta(safeFs, meta)` | Write `meta.json` |
| `readMeta(safeFs)` | Read `meta.json` |
| `readCondexConfig(safeFs)` | Read `condex.config.json` |
| `acquireIndexLock(safeFs)` | Create `.indexing.lock` (5-min stale timeout) |
| `releaseIndexLock(safeFs)` | Delete `.indexing.lock` |
| `hashContent(content)` | SHA256 hash of file content (for incremental indexing) |

## Lock file

The `.indexing.lock` prevents two processes from indexing simultaneously. It includes a timestamp and is considered stale after 5 minutes.
