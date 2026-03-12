# types/ — All TypeScript Interfaces

**Path:** `packages/condex-core/src/types/`

## Files in this directory

### index.ts
Barrel re-export for all type modules.

### symbol.ts
Core `Symbol` interface (34 fields) — the fundamental data unit. Every class, method, interface, field etc. is represented as a Symbol.

Key types:
- `Symbol` — id, projectId, filePath, qualifiedName, simpleName, kind, signature, javadoc, annotations, springRole, hexRole, byteOffset, byteLength, contentHash, etc.
- `SymbolKind` — `'class' | 'interface' | 'method' | 'constructor' | 'field' | 'constant' | 'enum' | 'annotation_type'`
- `SpringRole` — `'REST_CONTROLLER' | 'SERVICE' | 'REPOSITORY' | 'ENTITY' | 'CONFIGURATION' | ...`
- `HexRole` — `'USE_CASE_HANDLER' | 'INBOUND_PORT' | 'OUTBOUND_PORT' | 'ADAPTER' | 'DOMAIN_ENTITY' | ...`
- `buildSymbolId(projectId, filePath, qualifiedName, kind)` — format: `projectId::filePath::qualifiedName#kind`

### schema.ts
- `SchemaSymbol` — Database table/column info extracted from SQL migrations
- `ConfigSymbol` — Key-value config properties extracted from YAML files

### config.ts
- `CondexConfig` — Project config from `condex.config.json` (language, include/exclude globs, retrieval settings)
- `DEFAULT_CONFIG` — Sensible defaults for all settings
- `ProjectMeta` — Persisted to `meta.json` (project identity, architecture, timestamps, file hashes)

### meta.ts
- `CondexMeta` — The `_meta` envelope in every MCP response (timing, token counts, savings, gate status)

### parser.ts
- `CoreParser` — Interface for pluggable parsers (`parseFile`, `parseSqlFile`, `parseYamlFile`, `detectArchitecture`)
- `ProjectProfile` — Architecture detection result
- `ArchitectureType` — `'hexagonal' | 'layered' | 'mvc' | 'unknown'`

### retrieval.ts
- `BM25Result`, `VectorResult`, `FusedResult`, `GateResult`
- `SearchFilters` — kind, springRole, hexRole, filePattern
