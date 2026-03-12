# sqlite-store.ts — SQLite Schema & CRUD

**Path:** `packages/cortex-core/src/store/sqlite-store.ts`

## What it does

Manages the in-memory SQLite database — creates the schema, inserts data, and provides query functions. This is the runtime data store that all MCP handlers query against.

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `projects` | One row per indexed project (name, path, language, architecture, counts) |
| `symbols` | Every class, method, interface, field, etc. with full metadata |
| `schema_symbols` | Database tables/columns from SQL migrations |
| `config_symbols` | Configuration properties from YAML files |

### FTS5 Virtual Tables (for full-text search)

| Table | Indexed Columns | Tokenizer |
|-------|----------------|-----------|
| `symbols_fts` | `simple_name`, `qualified_name`, `signature`, `javadoc`, `annotations` | Porter stemmer |
| `schema_fts` | `table_name`, `column_name`, `data_type`, `summary` | Porter stemmer |
| `config_fts` | `key_path`, `value`, `profile`, `source_file` | Porter stemmer |

## CamelCase Splitting

Before inserting into FTS5, names are split: `CreateOrderHandler` → `Create Order Handler`. This allows searching for "Order" to find `CreateOrderHandler`.

## Key functions

| Function | Purpose |
|----------|---------|
| `createSchema(db)` | Creates all tables and FTS5 indexes |
| `insertProject(db, project)` | Insert/replace a project row |
| `insertSymbols(db, symbols)` | Batch-insert symbols (uses transaction) |
| `insertSchemaSymbols(db, schemas)` | Batch-insert schema symbols |
| `insertConfigSymbols(db, configs)` | Batch-insert config symbols |
| `getSymbolById(db, id)` | Get one symbol by ID |
| `getSymbolsByIds(db, ids)` | Get multiple symbols |
| `getSymbolsByFile(db, projectId, filePath)` | Get all symbols in a file |
| `getProjectOutline(db, projectId)` | Package-level aggregation |
| `clearProjectData(db, projectId)` | Delete all data for a project |
