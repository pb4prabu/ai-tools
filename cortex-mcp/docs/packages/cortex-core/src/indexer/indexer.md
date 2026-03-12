# indexer.ts — Project Indexing Pipeline

**Path:** `packages/cortex-core/src/indexer/indexer.ts`

## What it does

Orchestrates the full indexing pipeline — scans a project, parses source files, writes symbols to disk, and loads them into SQLite. This is the engine that builds the `.cortex/index/` directory.

## Indexing Flow

```
1. Read cortex.config.json (optional)
2. Create .cortex/index/ directories
3. Acquire .indexing.lock
4. Read existing meta.json (for incremental indexing)
5. Detect language (Java/TypeScript/Python from project markers)
6. Find source files (glob patterns based on language)
7. Detect architecture (hexagonal/layered/mvc)
8. For each source file:
   a. Read content
   b. Hash content (SHA256)
   c. Skip if hash unchanged (incremental)
   d. Parse with pluggable ParseFileFn
   e. Collect symbols
9. Write symbol files to .cortex/index/symbols/
10. Parse SQL files → SchemaSymbol[]
11. Parse YAML files → ConfigSymbol[]
12. Write schema + config files
13. Write meta.json (with file hashes for next incremental)
14. Load everything into SQLite
15. Release lock
```

## Incremental Indexing

On re-index, the indexer compares SHA256 hashes of each file against the hashes stored in `meta.json`. Only changed files are re-parsed. This makes re-indexing fast after small edits.

## Language Detection

Auto-detects from project markers:

| Marker File | Language |
|-------------|----------|
| `pom.xml`, `build.gradle`, `build.gradle.kts` | Java |
| `package.json`, `tsconfig.json` | TypeScript |
| `requirements.txt`, `pyproject.toml` | Python |

## Pluggable Parsers

The indexer doesn't parse files itself — it delegates to pluggable functions:

| Type | Signature | Provider |
|------|-----------|----------|
| `ParseFileFn` | `(content, opts) → Symbol[]` | `@cortex-ai/java` |
| `DetectArchFn` | `(filePaths) → { architecture, confidence }` | `@cortex-ai/java` |
| `ParseSqlFn` | `(content, projectId, sourceFile) → SchemaSymbol[]` | `@cortex-ai/java` |
| `ParseYamlFn` | `(content, projectId, sourceFile) → ConfigSymbol[]` | `@cortex-ai/java` |

## Key export

```typescript
indexProject(db, safeFs, opts?) → IndexResult
```

Returns: `projectId`, `symbolCount`, `filesProcessed`, `filesSkipped`, `loadTimeMs`, `incremental`
