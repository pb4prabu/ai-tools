# sqlite-store.test.ts — SQLite Store Tests

**Path:** `packages/condex-core/src/store/__tests__/sqlite-store.test.ts`

## What it tests

10 test cases:
- CRUD: insert and retrieve single/batch symbols
- Retrieve symbols by file path
- FTS5 search: CamelCase-split names, javadoc content, package names
- Project outline aggregation (symbols grouped by package)
- `clearProjectData` removes all rows for a project
