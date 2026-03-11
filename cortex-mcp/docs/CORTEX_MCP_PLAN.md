# Cortex MCP — Complete Project Plan

> **Purpose of this document**: Hand this to an AI coding agent (Claude Opus, etc.) to validate the architecture and implement the full project. Every decision is explained. Every interface is defined. Every edge case is called out.

---

## 0. What Is Cortex

Cortex is a **local-first, project-namespaced MCP server** that indexes a codebase once and lets AI agents (OpenCode, Claude Code, etc.) retrieve only the exact symbols they need — instead of reading entire files.

**Primary objective**: Reduce token consumption in AI coding sessions without losing context accuracy.

**Secondary objective**: Be shareable — the index can be committed to git or pushed as a submodule so the whole team benefits without re-indexing.

**Non-objective (explicitly out of scope for v1)**: Context tree / call graph analysis. The AI model handles relationship reasoning. Cortex only handles symbol retrieval.

---

## 1. The Token Problem Being Solved

When an AI agent needs to find a method in a large codebase, it currently does this:

```
Agent: read_file("src/order/application/CreateOrderHandler.java")
→ returns 847 tokens (entire file)

Agent: read_file("src/order/domain/OrderRepositoryPort.java")
→ returns 623 tokens

Agent: read_file("src/order/infrastructure/JpaOrderRepository.java")
→ returns 412 tokens

Total: 1,882 tokens to answer one question
```

With Cortex:

```
Agent: search_symbols("create order handler")
→ returns 3 signatures + javadoc = 87 tokens

Agent: get_symbol("...CreateOrderHandler.execute#method")  [if full body needed]
→ returns 94 tokens

Total: 181 tokens (90.4% saving)
```

The savings compound across a full session. A typical 2-hour coding session with 50 file reads saves 80,000–150,000 tokens.

### Token Saving Guarantee and Risk Management

There is no absolute guarantee. The guarantee is:

- **Cortex will never be confidently wrong.** A confidence gate fires before returning results. If score < threshold, it returns nothing and the agent falls back to normal file reading.
- **Silence is always safer than noise.** Wrong context injected into an AI's prompt is worse than no context. The confidence gate enforces this.
- **The AI always has fallback.** Cortex is an accelerator, not a gatekeeper. If Cortex returns nothing, OpenCode uses its own file search tools unchanged.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    cortex-core (npm package)                    │
│                                                                 │
│  ┌──────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │  MCP Tools   │  │ Retrieval Engine │  │  Storage Layer   │  │
│  │  (10 tools)  │  │                 │  │                  │  │
│  │              │  │  BM25 (FTS5)    │  │  Filesystem      │  │
│  │  Defined     │  │  +              │  │  (source of      │  │
│  │  once here,  │  │  Vector ANN     │  │  truth, git)     │  │
│  │  all langs   │  │  (sqlite-vec)   │  │                  │  │
│  │  use them    │  │  +              │  │  SQLite          │  │
│  │              │  │  RRF Fusion     │  │  (runtime only,  │  │
│  │              │  │  +              │  │  rebuilt on      │  │
│  │              │  │  Confidence     │  │  startup ~2s)    │  │
│  │              │  │  Gate           │  │                  │  │
│  └──────────────┘  └─────────────────┘  └──────────────────┘  │
│                                                                 │
│  Parser Interface: CoreParser (all language parsers implement)  │
│  Namespace System: project root detection + conflict handling   │
│  Token Tracker: per-query + session + all-time savings          │
└─────────────────────────────────────────────────────────────────┘
         ↑ implements CoreParser
┌────────────────────────┐      ┌──────────────────────┐
│     cortex-java        │      │    cortex-python      │ (future)
│                        │      │                       │
│  tree-sitter-java      │      │  tree-sitter-python   │
│  Spring annotation     │      │  Django/FastAPI        │
│  tagger                │      │  analyser             │
│  Arch detector         │      │                       │
│  (hex/layered/mvc/     │      └──────────────────────┘
│   unknown)             │
│  Flyway SQL parser     │      ┌──────────────────────┐
│  application.yml       │      │    cortex-auto        │ (future)
│  OpenAPI annotations   │      │                       │
└────────────────────────┘      │  Detects language mix │
                                │  Delegates to right   │
                                │  parser               │
                                └──────────────────────┘
```

---

## 3. Monorepo Structure

```
cortex/                                   ← GitHub: github.com/yourorg/cortex
├── packages/
│   ├── cortex-core/                      ← @cortex-ai/core
│   │   ├── src/
│   │   │   ├── server.ts                 ← MCP server entry point (stdio)
│   │   │   ├── namespace/
│   │   │   │   ├── root-detector.ts      ← walks up to find project root
│   │   │   │   └── namespace.ts          ← generates stable project ID
│   │   │   ├── store/
│   │   │   │   ├── fs-store.ts           ← filesystem read/write
│   │   │   │   ├── sqlite-store.ts       ← SQLite schema + queries
│   │   │   │   └── loader.ts             ← loads filesystem → SQLite at startup
│   │   │   ├── retrieval/
│   │   │   │   ├── bm25.ts               ← FTS5 query builder
│   │   │   │   ├── vector-search.ts      ← sqlite-vec ANN search
│   │   │   │   ├── rrf-fusion.ts         ← Reciprocal Rank Fusion
│   │   │   │   └── confidence-gate.ts    ← silence over noise
│   │   │   ├── embeddings/
│   │   │   │   └── local-embed.ts        ← ONNX, nomic-embed-code-v1.5
│   │   │   ├── mcp/
│   │   │   │   ├── tools.ts              ← all 10 MCP tool definitions
│   │   │   │   └── meta.ts               ← _meta envelope builder
│   │   │   └── token/
│   │   │       ├── counter.ts            ← tiktoken token counting
│   │   │       └── savings.ts            ← persistent savings tracker
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── cortex-java/                      ← @cortex-ai/java
│   │   ├── src/
│   │   │   ├── index.ts                  ← exports JavaParser
│   │   │   ├── parser/
│   │   │   │   ├── java-parser.ts        ← tree-sitter-java, symbol extraction
│   │   │   │   ├── spring-tagger.ts      ← @Service/@Controller → SpringRole
│   │   │   │   └── arch-detector.ts      ← hexagonal/layered/mvc/unknown
│   │   │   └── sources/
│   │   │       ├── sql-parser.ts         ← Flyway/Liquibase migration parsing
│   │   │       ├── yaml-parser.ts        ← application.yml key extraction
│   │   │       └── openapi-parser.ts     ← Swagger annotation → endpoint index
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── cortex-cli/                       ← cortex (global CLI command)
│       ├── src/
│       │   └── cli.ts                    ← index, list, invalidate, status commands
│       └── package.json
│
├── package.json                          ← workspace root (npm workspaces)
├── tsconfig.base.json
└── README.md
```

---

## 4. Namespace System

### Why Namespaces

Multiple projects can be indexed on one machine. Symbol names collide across projects (every Java project has a `UserService`). Namespaces isolate them completely.

### Project Root Detection

When a tool call arrives, Cortex detects the project root by walking up the directory tree from the given path, looking for these markers in priority order:

```
1. .cortex/cortex.config.json    ← explicit Cortex config (highest priority)
2. .git/                          ← git repository root
3. pom.xml                        ← Maven project root
4. build.gradle / build.gradle.kts← Gradle project root
5. package.json                   ← Node project root
6. Current directory              ← fallback (lowest priority)
```

Stop at the first match. That directory is the project root.

### Namespace Generation

```typescript
// namespace.ts

export function generateNamespace(rootPath: string): string {
  const absoluteRoot = path.resolve(rootPath)
  const projectName = path.basename(absoluteRoot)
  const hash = crypto
    .createHash('sha256')
    .update(absoluteRoot)
    .digest('hex')
    .slice(0, 6)
  return `${projectName}@${hash}`
  // Example: "myapp@a3f9c2"
}
```

The hash is deterministic — same absolute path always produces same namespace. This means:
- Developer A and Developer B get the same namespace for the same project (assuming same directory structure)
- Two different projects in different directories always get different namespaces even if named the same

### Parent/Child Folder Conflict Resolution

```
Scenario: Two OpenCode sessions open simultaneously
  Session 1: /home/praveen/projects/myapp/         (project root)
  Session 2: /home/praveen/projects/myapp/backend/ (subdirectory)

Resolution:
  Both sessions walk up to find project root.
  Session 2 finds pom.xml at /home/praveen/projects/myapp/ (same root as Session 1).
  Both resolve to namespace: "myapp@a3f9c2"
  Both use the SAME index.

  Session 2 registers a scope bias: "backend/"
  Queries from Session 2 rank symbols under backend/ higher.
  Neither session is blocked or wrong — Session 2 just gets backend-biased results.
```

```typescript
// root-detector.ts

export async function detectProjectRoot(startPath: string): Promise<RootDetectionResult> {
  const markers = [
    '.cortex/cortex.config.json',
    '.git',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'package.json',
  ]

  let current = path.resolve(startPath)
  const filesystem_root = path.parse(current).root

  while (current !== filesystem_root) {
    for (const marker of markers) {
      const candidate = path.join(current, marker)
      if (await exists(candidate)) {
        const scopeBias = path.relative(current, path.resolve(startPath))
        return {
          root: current,
          marker,
          scopeBias: scopeBias === '' ? null : scopeBias,
          namespace: generateNamespace(current),
        }
      }
    }
    current = path.dirname(current)
  }

  // Fallback: use startPath itself
  return {
    root: path.resolve(startPath),
    marker: 'none',
    scopeBias: null,
    namespace: generateNamespace(startPath),
  }
}
```

---

## 5. Filesystem Storage (Source of Truth)

Everything in `.cortex/index/` is committed to git. The SQLite database is never committed — it is always rebuilt at startup.

### Directory Layout

```
your-project/
└── .cortex/
    ├── .gitignore                        ← ignores *.db, savings.json
    ├── cortex.config.json                ← committed, project config
    └── index/
        ├── meta.json                     ← project profile, file hashes
        ├── symbols/                      ← one JSON file per symbol
        │   ├── com.app.order.application.CreateOrderHandler.execute.method.json
        │   ├── com.app.order.domain.OrderRepositoryPort.interface.json
        │   └── ...
        ├── schema/
        │   └── migrations.json           ← DB tables + columns from Flyway SQL
        ├── config/
        │   └── application.json          ← yml key-value pairs
        └── vectors.jsonl                 ← one line per symbol: {id, v:[...384]}
```

### .gitignore (inside .cortex/)

```gitignore
# Never commit runtime files
*.db
*.db-shm
*.db-wal
savings.json
node_modules/
```

### cortex.config.json (committed)

```json
{
  "projectName": "myapp",
  "language": "java",
  "include": [
    "src/main/java/**/*.java"
  ],
  "exclude": [
    "**/generated/**",
    "**/target/**",
    "**/build/**",
    "**/.git/**"
  ],
  "sources": {
    "sql": "src/main/resources/db/migration/**/*.sql",
    "yaml": "src/main/resources/application*.yml",
    "openapi": true
  },
  "embedding": {
    "model": "nomic-embed-code-v1.5",
    "dimensions": 384
  },
  "retrieval": {
    "confidenceThreshold": 0.12,
    "maxResultsPerSearch": 20,
    "defaultTokenBudget": 2000
  }
}
```

### Symbol File Format

Filename: `{reverse-qualified-name}.{kind}.json`
Example: `com.app.order.application.CreateOrderHandler.execute.method.json`

```json
{
  "id": "myapp@a3f9c2::src/main/java/com/app/order/application/CreateOrderHandler.java::CreateOrderHandler.execute#method",
  "projectId": "myapp@a3f9c2",
  "filePath": "src/main/java/com/app/order/application/CreateOrderHandler.java",
  "qualifiedName": "com.app.order.application.CreateOrderHandler.execute",
  "simpleName": "execute",
  "className": "CreateOrderHandler",
  "packageName": "com.app.order.application",
  "kind": "method",
  "signature": "public OrderResponse execute(CreateOrderCommand cmd)",
  "javadoc": "Handles order creation. Validates command, persists order, publishes event.",
  "annotations": ["@Override"],
  "springRole": "NONE",
  "hexRole": "USE_CASE_HANDLER",
  "architecture": "hexagonal",
  "moduleLayer": "application",
  "implementedInterfaces": ["CreateOrderUseCase"],
  "extendsClass": null,
  "parameterTypes": ["CreateOrderCommand"],
  "returnType": "OrderResponse",
  "throwsTypes": ["OrderValidationException"],
  "byteOffset": 4821,
  "byteLength": 634,
  "contentHash": "e3b0c44298fc1c149afb",
  "indexedAt": "2026-03-11T10:23:00Z"
}
```

### meta.json

```json
{
  "projectId": "myapp@a3f9c2",
  "projectName": "myapp",
  "projectRoot": "/home/praveen/projects/myapp",
  "language": "java",
  "architecture": "hexagonal",
  "architectureConfidence": 0.94,
  "lastFullIndex": "2026-03-11T10:23:00Z",
  "lastIncrementalIndex": "2026-03-11T14:45:00Z",
  "toolVersion": "1.0.0",
  "symbolCount": 2841,
  "schemaCount": 47,
  "configCount": 124,
  "fileHashes": {
    "src/main/java/com/app/order/application/CreateOrderHandler.java": "e3b0c44298fc1c14",
    "src/main/java/com/app/order/domain/OrderRepositoryPort.java": "a87ff679a2f3e71d"
  }
}
```

### vectors.jsonl

One line per symbol. Compact float representation.

```jsonl
{"id":"myapp@a3f9c2::...CreateOrderHandler.execute#method","v":[0.023,-0.041,0.187,...]}
{"id":"myapp@a3f9c2::...OrderRepositoryPort#interface","v":[0.019,-0.044,0.188,...]}
```

---

## 6. SQLite Runtime Schema

Built in memory (or `~/.cortex/runtime.db`) at startup from filesystem files. Never committed. Discarded when MCP server stops.

```sql
-- ── Projects ────────────────────────────────────────────────────
CREATE TABLE projects (
  id                    TEXT PRIMARY KEY,   -- "myapp@a3f9c2"
  name                  TEXT NOT NULL,
  root_path             TEXT NOT NULL,
  language              TEXT,
  architecture          TEXT,
  architecture_confidence REAL,
  symbol_count          INTEGER DEFAULT 0,
  schema_count          INTEGER DEFAULT 0,
  config_count          INTEGER DEFAULT 0,
  indexed_at            TEXT,
  tool_version          TEXT
);

-- ── Symbols ─────────────────────────────────────────────────────
CREATE TABLE symbols (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  file_path         TEXT NOT NULL,
  qualified_name    TEXT NOT NULL,
  simple_name       TEXT,
  class_name        TEXT,
  package_name      TEXT,
  kind              TEXT NOT NULL,   -- method|class|interface|field|constant
  signature         TEXT NOT NULL,
  javadoc           TEXT,
  annotations       TEXT,            -- JSON array: ["@Service","@Transactional"]
  spring_role       TEXT,
  hex_role          TEXT,
  module_layer      TEXT,
  implemented_interfaces TEXT,       -- JSON array
  extends_class     TEXT,
  parameter_types   TEXT,            -- JSON array
  return_type       TEXT,
  throws_types      TEXT,            -- JSON array
  byte_offset       INTEGER,
  byte_length       INTEGER,
  content_hash      TEXT,
  indexed_at        TEXT
);

CREATE INDEX idx_symbols_project    ON symbols(project_id);
CREATE INDEX idx_symbols_file       ON symbols(project_id, file_path);
CREATE INDEX idx_symbols_kind       ON symbols(project_id, kind);
CREATE INDEX idx_symbols_spring     ON symbols(project_id, spring_role);
CREATE INDEX idx_symbols_hex        ON symbols(project_id, hex_role);

-- ── Full Text Search (BM25) ─────────────────────────────────────
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  id              UNINDEXED,
  project_id      UNINDEXED,
  qualified_name,
  simple_name,
  class_name,
  package_name,
  signature,
  javadoc,
  annotations,
  content=symbols,
  content_rowid=rowid,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER symbols_fts_insert AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, id, project_id, qualified_name, simple_name,
    class_name, package_name, signature, javadoc, annotations)
  VALUES (new.rowid, new.id, new.project_id, new.qualified_name, new.simple_name,
    new.class_name, new.package_name, new.signature, new.javadoc, new.annotations);
END;

CREATE TRIGGER symbols_fts_delete AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, id, project_id, qualified_name,
    simple_name, class_name, package_name, signature, javadoc, annotations)
  VALUES ('delete', old.rowid, old.id, old.project_id, old.qualified_name,
    old.simple_name, old.class_name, old.package_name, old.signature,
    old.javadoc, old.annotations);
END;

-- ── Vector Store (sqlite-vec extension) ─────────────────────────
-- Loaded via: load(db) from sqlite-vec npm package
CREATE VIRTUAL TABLE symbol_vectors USING vec0(
  symbol_id    TEXT PRIMARY KEY,
  project_id   TEXT,               -- for filtering by project
  embedding    FLOAT[384]
);

-- ── Schema Index (DB tables from Flyway) ────────────────────────
CREATE TABLE schema_symbols (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  table_name   TEXT NOT NULL,
  column_name  TEXT,               -- NULL for table-level entries
  data_type    TEXT,
  nullable     INTEGER,
  migration_file TEXT,
  summary      TEXT
);

CREATE VIRTUAL TABLE schema_fts USING fts5(
  id         UNINDEXED,
  project_id UNINDEXED,
  table_name,
  column_name,
  summary,
  content=schema_symbols
);

-- ── Config Index (application.yml keys) ────────────────────────
CREATE TABLE config_symbols (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  key_path     TEXT NOT NULL,      -- "spring.datasource.url"
  value        TEXT,
  profile      TEXT,               -- "prod", "dev", null for default
  source_file  TEXT
);

CREATE VIRTUAL TABLE config_fts USING fts5(
  id         UNINDEXED,
  project_id UNINDEXED,
  key_path,
  value,
  profile,
  content=config_symbols
);
```

---

## 7. The CoreParser Interface

Every language extension implements this interface. `cortex-core` calls it without knowing the language.

```typescript
// cortex-core/src/types/parser.interface.ts

export interface ParseResult {
  symbols: Symbol[]
  schemaSymbols?: SchemaSymbol[]
  configSymbols?: ConfigSymbol[]
  projectProfile: ProjectProfile
}

export interface CoreParser {
  // Which file extensions this parser handles
  readonly supportedExtensions: string[]

  // Primary parse: extract symbols from one source file
  parseFile(filePath: string, content: string): Promise<Symbol[]>

  // Secondary parsers (optional — return [] if not supported)
  parseSqlFile?(filePath: string, content: string): Promise<SchemaSymbol[]>
  parseYamlFile?(filePath: string, content: string): Promise<ConfigSymbol[]>

  // Architecture detection — called once during full index
  detectArchitecture(allFilePaths: string[]): ProjectProfile
}

export interface ProjectProfile {
  architecture: 'hexagonal' | 'layered' | 'mvc' | 'unknown'
  confidence: number                  // 0.0 to 1.0
  modules: ModuleInfo[]
  detectedPatterns: string[]          // ["Handler suffix", "Port suffix", "/domain/ package"]
}

export interface Symbol {
  id: string
  projectId: string
  filePath: string
  qualifiedName: string
  simpleName: string
  className?: string
  packageName?: string
  kind: SymbolKind
  signature: string
  javadoc?: string
  annotations: string[]
  springRole?: SpringRole
  hexRole?: HexRole
  moduleLayer?: string
  implementedInterfaces: string[]
  extendsClass?: string
  parameterTypes: string[]
  returnType?: string
  throwsTypes: string[]
  byteOffset: number
  byteLength: number
  contentHash: string
}

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'method'
  | 'field'
  | 'constant'
  | 'constructor'
  | 'enum'
  | 'annotation_type'

export type SpringRole =
  | 'REST_CONTROLLER'
  | 'CONTROLLER'
  | 'SERVICE'
  | 'REPOSITORY'
  | 'COMPONENT'
  | 'CONFIGURATION'
  | 'ENTITY'
  | 'EVENT_HANDLER'
  | 'SCHEDULED'
  | 'NONE'

export type HexRole =
  | 'INBOUND_PORT'
  | 'OUTBOUND_PORT'
  | 'USE_CASE_HANDLER'
  | 'ADAPTER'
  | 'DOMAIN_ENTITY'
  | 'DOMAIN_VALUE_OBJECT'
  | 'DOMAIN_EVENT'
  | 'DOMAIN_COMMAND'
  | 'NONE'
```

---

## 8. Java Parser — cortex-java

### Architecture Detection Logic

Run once at full index time. Stored in `meta.json`. Never run at query time.

```typescript
// arch-detector.ts

export function detectArchitecture(filePaths: string[]): ProjectProfile {
  const signals: Record<string, number> = {
    hexagonal: 0,
    layered: 0,
    mvc: 0,
  }

  const detectedPatterns: string[] = []

  // Hexagonal signals (package path)
  if (filePaths.some(f => /\/application\//.test(f))) {
    signals.hexagonal += 2; detectedPatterns.push('/application/ package')
  }
  if (filePaths.some(f => /\/domain\//.test(f))) {
    signals.hexagonal += 2; detectedPatterns.push('/domain/ package')
  }
  if (filePaths.some(f => /\/infrastructure\//.test(f))) {
    signals.hexagonal += 2; detectedPatterns.push('/infrastructure/ package')
  }

  // Hexagonal signals (naming convention)
  if (filePaths.some(f => /Handler\.java$/.test(f))) {
    signals.hexagonal += 1; detectedPatterns.push('Handler suffix')
  }
  if (filePaths.some(f => /Port\.java$/.test(f))) {
    signals.hexagonal += 3; detectedPatterns.push('Port suffix (strong signal)')
  }
  if (filePaths.some(f => /Adapter\.java$/.test(f))) {
    signals.hexagonal += 2; detectedPatterns.push('Adapter suffix')
  }
  if (filePaths.some(f => /UseCase\.java$/.test(f))) {
    signals.hexagonal += 2; detectedPatterns.push('UseCase suffix')
  }

  // Layered signals
  if (filePaths.some(f => /\/service\//.test(f))) {
    signals.layered += 1
  }
  if (filePaths.some(f => /\/repository\//.test(f))) {
    signals.layered += 1
  }
  if (filePaths.some(f => /\/controller\//.test(f))) {
    signals.layered += 1
  }
  if (filePaths.some(f => /Service\.java$/.test(f))) {
    signals.layered += 1
  }

  // MVC signals
  if (filePaths.some(f => /\/model\//.test(f))) {
    signals.mvc += 1
  }
  if (filePaths.some(f => /\/view\//.test(f))) {
    signals.mvc += 2
  }

  // Determine winner
  const sorted = Object.entries(signals).sort((a, b) => b[1] - a[1])
  const [topArch, topScore] = sorted[0]
  const confidence = Math.min(topScore / 10, 1.0)

  return {
    architecture: confidence >= 0.4 ? topArch as any : 'unknown',
    confidence,
    detectedPatterns,
    modules: detectModules(filePaths),
  }
}
```

### HexRole Assignment

Only runs if architecture === 'hexagonal'. Falls back to NONE for unknown architectures.

```typescript
// spring-tagger.ts

export function assignHexRole(
  symbol: Partial<Symbol>,
  profile: ProjectProfile
): HexRole {

  if (profile.architecture !== 'hexagonal') return 'NONE'

  const filePath = symbol.filePath || ''
  const name = symbol.simpleName || symbol.className || ''
  const kind = symbol.kind

  // Port detection — strongest signal: naming convention
  if (kind === 'interface') {
    if (/Port$/.test(name)) return 'OUTBOUND_PORT'
    if (/UseCase$/.test(name)) return 'INBOUND_PORT'
    if (filePath.includes('/application/') && /Service$/.test(name)) return 'INBOUND_PORT'
  }

  // Handler detection
  if (kind === 'class') {
    if (/Handler$/.test(name)) return 'USE_CASE_HANDLER'
    if (/Adapter$/.test(name)) return 'ADAPTER'
    if (filePath.includes('/infrastructure/') &&
        (symbol.annotations || []).some(a => a.includes('Repository'))) {
      return 'ADAPTER'
    }
  }

  // Domain detection
  if (filePath.includes('/domain/')) {
    if (kind === 'class') {
      if (/Command$/.test(name)) return 'DOMAIN_COMMAND'
      if (/Event$/.test(name)) return 'DOMAIN_EVENT'
      if (/VO$|ValueObject$/.test(name)) return 'DOMAIN_VALUE_OBJECT'
      if ((symbol.annotations || []).includes('@Entity')) return 'DOMAIN_ENTITY'
      // Default domain class without specific role
      return 'DOMAIN_ENTITY'
    }
  }

  return 'NONE'
}
```

### tree-sitter-java Symbol Extraction

```typescript
// java-parser.ts

import Parser from 'tree-sitter'
import Java from 'tree-sitter-java'

const parser = new Parser()
parser.setLanguage(Java)

export async function parseJavaFile(
  filePath: string,
  content: string,
  projectId: string,
  profile: ProjectProfile
): Promise<Symbol[]> {

  const tree = parser.parse(content)
  const symbols: Symbol[] = []

  // Walk AST looking for declarations
  walkTree(tree.rootNode, (node) => {

    if (node.type === 'class_declaration') {
      symbols.push(extractClassSymbol(node, filePath, content, projectId, profile))
    }

    if (node.type === 'interface_declaration') {
      symbols.push(extractInterfaceSymbol(node, filePath, content, projectId, profile))
    }

    if (node.type === 'method_declaration') {
      symbols.push(extractMethodSymbol(node, filePath, content, projectId, profile))
    }

    if (node.type === 'field_declaration') {
      const fieldSymbols = extractFieldSymbols(node, filePath, content, projectId)
      symbols.push(...fieldSymbols)
    }

    if (node.type === 'enum_declaration') {
      symbols.push(extractEnumSymbol(node, filePath, content, projectId, profile))
    }
  })

  return symbols
}

function extractMethodSymbol(
  node: Parser.SyntaxNode,
  filePath: string,
  content: string,
  projectId: string,
  profile: ProjectProfile
): Symbol {

  const nameNode = node.childForFieldName('name')
  const simpleName = nameNode?.text || 'unknown'

  // Extract annotations (preceding siblings before the method node)
  const annotations = extractAnnotations(node)

  // Extract javadoc (comment immediately before first annotation or method)
  const javadoc = extractJavadoc(node, content)

  // Build signature from return type + name + parameters
  const returnType = node.childForFieldName('type')?.text || 'void'
  const params = extractParameters(node)
  const modifiers = extractModifiers(node)
  const signature = `${modifiers} ${returnType} ${simpleName}(${params.join(', ')})`.trim()

  const className = findEnclosingClassName(node)
  const packageName = findPackageName(node)

  const symbol: Partial<Symbol> = {
    projectId,
    filePath,
    simpleName,
    className,
    packageName,
    qualifiedName: packageName ? `${packageName}.${className}.${simpleName}` : `${className}.${simpleName}`,
    kind: 'method',
    signature,
    javadoc,
    annotations,
    parameterTypes: params,
    returnType,
    byteOffset: node.startIndex,
    byteLength: node.endIndex - node.startIndex,
    contentHash: hashContent(content.slice(node.startIndex, node.endIndex)),
    implementedInterfaces: [],
    throwsTypes: extractThrows(node),
  }

  symbol.springRole = assignSpringRole(symbol, annotations)
  symbol.hexRole = assignHexRole(symbol, profile)
  symbol.moduleLayer = inferModuleLayer(filePath)
  symbol.id = buildSymbolId(projectId, filePath, symbol.qualifiedName!, 'method')

  return symbol as Symbol
}
```

---

## 9. Retrieval Engine

### BM25 Search

```typescript
// bm25.ts

export function buildBM25Query(
  query: string,
  projectId: string,
  filters?: SearchFilters
): { sql: string; params: any[] } {

  // Sanitise query for FTS5 (escape special chars)
  const sanitised = query
    .replace(/['"*()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .join(' ')

  let sql = `
    SELECT
      s.id,
      s.project_id,
      s.qualified_name,
      s.signature,
      s.javadoc,
      s.spring_role,
      s.hex_role,
      s.file_path,
      s.kind,
      s.byte_offset,
      s.byte_length,
      -symbols_fts.rank AS bm25_score
    FROM symbols_fts
    JOIN symbols s ON s.id = symbols_fts.id
    WHERE symbols_fts MATCH ?
      AND s.project_id = ?
  `
  const params: any[] = [sanitised, projectId]

  // Optional filters
  if (filters?.kind) {
    sql += ` AND s.kind = ?`
    params.push(filters.kind)
  }
  if (filters?.springRole) {
    sql += ` AND s.spring_role = ?`
    params.push(filters.springRole)
  }
  if (filters?.hexRole) {
    sql += ` AND s.hex_role = ?`
    params.push(filters.hexRole)
  }
  if (filters?.filePattern) {
    sql += ` AND s.file_path LIKE ?`
    params.push(`%${filters.filePattern}%`)
  }

  sql += ` ORDER BY bm25_score DESC LIMIT 50`

  return { sql, params }
}
```

### Vector Search

```typescript
// vector-search.ts

export async function vectorSearch(
  queryText: string,
  projectId: string,
  db: Database,
  embedder: Embedder,
  topK: number = 20
): Promise<VectorResult[]> {

  const queryVector = await embedder.embed(queryText)
  const vectorJson = JSON.stringify(queryVector)

  // sqlite-vec KNN query
  // Note: vec0 filters on project_id happen post-search (no WHERE on metadata in vec0)
  // We over-fetch and filter in application layer
  const rows = db.prepare(`
    SELECT
      symbol_id,
      project_id,
      distance
    FROM symbol_vectors
    WHERE embedding MATCH ?
      AND k = ?
    ORDER BY distance
  `).all(vectorJson, topK * 3) as any[]  // over-fetch to account for project filter

  return rows
    .filter(r => r.project_id === projectId)
    .slice(0, topK)
    .map((r, index) => ({
      symbolId: r.symbol_id,
      distance: r.distance,
      rank: index + 1,
    }))
}
```

### RRF Fusion

```typescript
// rrf-fusion.ts

const RRF_K = 60  // standard constant, empirically well-tested

export function rrfFusion(
  bm25Results: BM25Result[],
  vectorResults: VectorResult[]
): FusedResult[] {

  const scores = new Map<string, number>()

  // Add BM25 scores
  bm25Results.forEach((r, index) => {
    const current = scores.get(r.symbolId) || 0
    scores.set(r.symbolId, current + 1 / (RRF_K + index + 1))
  })

  // Add vector scores
  vectorResults.forEach((r, index) => {
    const current = scores.get(r.symbolId) || 0
    scores.set(r.symbolId, current + 1 / (RRF_K + index + 1))
  })

  // Sort by combined score
  return Array.from(scores.entries())
    .map(([symbolId, rrfScore]) => ({ symbolId, rrfScore }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
}
```

### Confidence Gate

```typescript
// confidence-gate.ts

export interface GateResult {
  passed: boolean
  results: FusedResult[]
  reason?: string
  topScore: number
}

export function applyConfidenceGate(
  fused: FusedResult[],
  threshold: number = 0.12
): GateResult {

  if (fused.length === 0) {
    return { passed: false, results: [], reason: 'NO_RESULTS', topScore: 0 }
  }

  const topScore = fused[0].rrfScore

  if (topScore < threshold) {
    return {
      passed: false,
      results: [],
      reason: 'BELOW_CONFIDENCE_THRESHOLD',
      topScore,
    }
  }

  // Only return results above threshold
  const confident = fused.filter(r => r.rrfScore >= threshold)

  return { passed: true, results: confident, topScore }
}
```

---

## 10. Embedding Layer

```typescript
// local-embed.ts
// Uses @xenova/transformers — runs ONNX model locally, no API calls

import { pipeline, env } from '@xenova/transformers'

// Store model in ~/.cortex/models/ rather than node_modules cache
env.cacheDir = path.join(os.homedir(), '.cortex', 'models')

let embedder: any = null

export async function getEmbedder(): Promise<Embedder> {
  if (!embedder) {
    console.log('Loading embedding model (first time ~30s, cached after)...')
    embedder = await pipeline(
      'feature-extraction',
      'nomic-ai/nomic-embed-code-v1.5',
      { quantized: true }  // use quantized model for speed, ~30MB
    )
  }
  return {
    embed: async (text: string): Promise<number[]> => {
      const output = await embedder(text, {
        pooling: 'mean',
        normalize: true,
      })
      return Array.from(output.data) as number[]
    },
    dimensions: 384,
  }
}

export interface Embedder {
  embed(text: string): Promise<number[]>
  dimensions: number
}

// Prepare text for embedding — combines signature + javadoc for best semantic match
export function prepareSymbolText(symbol: Symbol): string {
  const parts = [
    symbol.signature,
    symbol.javadoc || '',
    symbol.annotations.join(' '),
    symbol.className || '',
  ]
  return parts.filter(Boolean).join(' ').trim()
}
```

---

## 11. MCP Tools (all 10)

All defined in `cortex-core`. All include `_meta` envelope with token savings.

```typescript
// tools.ts

export const CORTEX_TOOLS = [

  {
    name: 'index_folder',
    description: 'Index a project folder. Detects language and architecture automatically. Writes index to .cortex/index/ in the project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or relative path to project root. If omitted, uses current directory.' },
        language: { type: 'string', enum: ['java', 'python', 'typescript', 'auto'], description: 'Force language. Default: auto-detect.' },
        incremental: { type: 'boolean', description: 'Only re-index changed files. Default: true.' },
      },
    },
  },

  {
    name: 'invalidate_cache',
    description: 'Remove index for a project and force full re-index on next index_folder call.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project namespace (e.g. myapp@a3f9c2). If omitted, auto-detected from current directory.' },
      },
    },
  },

  {
    name: 'list_projects',
    description: 'List all indexed projects on this machine with their namespaces, symbol counts, and last index time.',
    inputSchema: { type: 'object', properties: {} },
  },

  {
    name: 'get_project_outline',
    description: 'High-level structure of the project: modules, packages, symbol counts per layer. Use this first to orient yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
      },
    },
  },

  {
    name: 'get_file_outline',
    description: 'All symbols in a specific file, signatures only (no source). Use before get_symbol to confirm relevance.',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Relative path from project root.' },
        project_id: { type: 'string' },
      },
    },
  },

  {
    name: 'search_symbols',
    description: 'Search for symbols by name or description. Returns signatures only. Uses BM25 + vector hybrid search.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Symbol name, description, or natural language.' },
        project_id: { type: 'string' },
        kind: { type: 'string', enum: ['class', 'interface', 'method', 'field', 'constant'] },
        spring_role: { type: 'string' },
        hex_role: { type: 'string' },
        file_pattern: { type: 'string', description: 'Filter by file path substring. E.g. "application/" or "Handler".' },
        limit: { type: 'number', default: 10 },
      },
    },
  },

  {
    name: 'get_symbol',
    description: 'Retrieve full source code of a single symbol by its ID. Get the ID from search_symbols or get_file_outline first.',
    inputSchema: {
      type: 'object',
      required: ['symbol_id'],
      properties: {
        symbol_id: { type: 'string' },
      },
    },
  },

  {
    name: 'get_symbols',
    description: 'Batch retrieve full source for multiple symbols. More efficient than multiple get_symbol calls.',
    inputSchema: {
      type: 'object',
      required: ['symbol_ids'],
      properties: {
        symbol_ids: { type: 'array', items: { type: 'string' } },
      },
    },
  },

  {
    name: 'search_schema',
    description: 'Search the database schema index. Finds tables and columns from Flyway SQL migrations.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        project_id: { type: 'string' },
      },
    },
  },

  {
    name: 'get_context_for_task',
    description: 'Assembles a compact, token-budgeted context block for a given task. Searches symbols + schema + config together. Use this at the start of a complex task.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'Natural language description of what you need to do.' },
        project_id: { type: 'string' },
        token_budget: { type: 'number', default: 2000, description: 'Max tokens to return. Default 2000.' },
      },
    },
  },

]
```

### _meta Envelope

Every tool response includes this:

```typescript
export interface CortexMeta {
  timingMs: number
  projectId: string
  projectName: string
  architecture: string
  symbolsReturned: number
  tokensInResponse: number      // tokens actually returned to AI
  tokensIfNaive: number         // tokens if agent had read all source files containing matches
  tokensSaved: number           // tokensIfNaive - tokensInResponse
  tokensSavedPercent: number    // (tokensSaved / tokensIfNaive) * 100
  sessionTokensSaved: number    // cumulative this MCP session
  allTimeTokensSaved: number    // persisted to savings.json
  confidenceGateFired: boolean  // true if gate returned nothing
  topRrfScore: number
}

// Example response structure
{
  result: [
    {
      id: "myapp@a3f9c2::...CreateOrderHandler.execute#method",
      signature: "public OrderResponse execute(CreateOrderCommand cmd)",
      javadoc: "Handles order creation use case.",
      springRole: "NONE",
      hexRole: "USE_CASE_HANDLER",
      filePath: "src/main/java/.../CreateOrderHandler.java"
    }
  ],
  _meta: {
    timingMs: 12,
    projectId: "myapp@a3f9c2",
    projectName: "myapp",
    architecture: "hexagonal",
    symbolsReturned: 3,
    tokensInResponse: 187,
    tokensIfNaive: 2841,
    tokensSaved: 2654,
    tokensSavedPercent: 93.4,
    sessionTokensSaved: 47823,
    allTimeTokensSaved: 284910,
    confidenceGateFired: false,
    topRrfScore: 0.31
  }
}
```

---

## 12. Token Savings Tracking

```typescript
// savings.ts

interface SavingsRecord {
  allTimeTokensSaved: number
  sessionTokensSaved: number
  queryCount: number
  lastUpdated: string
}

export class SavingsTracker {
  private record: SavingsRecord
  private savingsPath: string

  constructor(projectRoot: string) {
    this.savingsPath = path.join(projectRoot, '.cortex', 'savings.json')
    this.record = this.load()
  }

  private load(): SavingsRecord {
    try {
      return JSON.parse(fs.readFileSync(this.savingsPath, 'utf-8'))
    } catch {
      return { allTimeTokensSaved: 0, sessionTokensSaved: 0, queryCount: 0, lastUpdated: new Date().toISOString() }
    }
  }

  record(tokensSaved: number): void {
    this.record.allTimeTokensSaved += tokensSaved
    this.record.sessionTokensSaved += tokensSaved
    this.record.queryCount++
    this.record.lastUpdated = new Date().toISOString()
    // Async write — don't block tool response
    fs.writeFile(this.savingsPath, JSON.stringify(this.record, null, 2), () => {})
  }
}

// Token counter — uses tiktoken for accuracy
export function countTokens(text: string): number {
  // cl100k_base is the tokenizer used by most modern models
  const enc = get_encoding('cl100k_base')
  const tokens = enc.encode(text)
  enc.free()
  return tokens.length
}

// Naive token estimate — what the AI would have read without Cortex
export function estimateNaiveTokens(
  matchedSymbols: Symbol[],
  db: Database
): number {
  // Get unique source files containing matched symbols
  const uniqueFiles = [...new Set(matchedSymbols.map(s => s.filePath))]

  // Sum up raw file byte lengths converted to approximate token count
  let total = 0
  for (const filePath of uniqueFiles) {
    const row = db.prepare(
      'SELECT SUM(byte_length) as total FROM symbols WHERE file_path = ? AND project_id = ?'
    ).get(filePath, matchedSymbols[0].projectId) as any
    // Rough conversion: 4 bytes ≈ 1 token for Java source
    total += Math.ceil((row?.total || 0) / 4)
  }
  return total
}
```

---

## 13. Startup & Server Entry Point

```typescript
// server.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import Database from 'better-sqlite3'
import { load as loadVec } from 'sqlite-vec'
import { CORTEX_TOOLS } from './mcp/tools.js'
import { loadAllProjects } from './store/loader.js'
import { getEmbedder } from './embeddings/local-embed.js'
import { handleToolCall } from './mcp/dispatcher.js'

async function main() {
  console.error('🧠 Cortex MCP Server starting...')

  // Create shared SQLite instance (in-memory for speed)
  const db = new Database(':memory:')
  loadVec(db)           // load sqlite-vec extension
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')

  // Create schema
  await createSchema(db)

  // Load all project indexes from filesystem
  const indexRoot = process.env.CORTEX_INDEX_PATH ||
    path.join(os.homedir(), '.cortex', 'indexes')

  const loaded = await loadAllProjects(db, indexRoot)
  console.error(`✓ Loaded ${loaded.length} projects`)
  for (const p of loaded) {
    console.error(`  • ${p.name} (${p.symbolCount} symbols, ${p.architecture})`)
  }

  // Pre-load embedding model in background (don't block startup)
  getEmbedder().catch(err =>
    console.error('Warning: embedding model failed to load:', err.message)
  )

  // Start MCP server
  const server = new Server(
    { name: 'cortex', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler('tools/list', async () => ({
    tools: CORTEX_TOOLS,
  }))

  server.setRequestHandler('tools/call', async (request) => {
    return handleToolCall(request.params, db, indexRoot)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('⚡ Cortex ready')
}

main().catch(console.error)
```

---

## 14. Incremental Indexing

```typescript
// fs-store.ts (incremental logic)

export async function runIncrementalIndex(
  projectRoot: string,
  munchDir: string,
  parser: CoreParser
): Promise<IndexResult> {

  const meta = await loadMeta(munchDir)
  const allFiles = await glob(config.include, { cwd: projectRoot, ignore: config.exclude })

  const changedFiles: string[] = []
  const deletedFiles: string[] = []

  // Detect changes
  for (const file of allFiles) {
    const absolutePath = path.join(projectRoot, file)
    const currentHash = await sha256File(absolutePath)
    if (meta.fileHashes[file] !== currentHash) {
      changedFiles.push(file)
    }
  }

  // Detect deletions
  for (const file of Object.keys(meta.fileHashes)) {
    if (!allFiles.includes(file)) {
      deletedFiles.push(file)
    }
  }

  if (changedFiles.length === 0 && deletedFiles.length === 0) {
    return { status: 'UP_TO_DATE', changed: 0, deleted: 0 }
  }

  console.log(`🔄 ${changedFiles.length} changed, ${deletedFiles.length} deleted`)

  // Remove deleted symbol files
  for (const file of deletedFiles) {
    await removeSymbolFilesForSource(munchDir, file)
    delete meta.fileHashes[file]
  }

  // Re-index changed files
  const embedder = await getEmbedder()
  for (const file of changedFiles) {
    const content = await fs.readFile(path.join(projectRoot, file), 'utf-8')
    const symbols = await parser.parseFile(file, content)

    // Overwrite symbol files for this source file
    await removeSymbolFilesForSource(munchDir, file)
    for (const symbol of symbols) {
      await writeSymbolFile(munchDir, symbol)
    }

    // Update vectors
    await updateVectorsForSymbols(munchDir, symbols, embedder)

    // Update hash
    meta.fileHashes[file] = await sha256File(path.join(projectRoot, file))
  }

  await writeMeta(munchDir, meta)

  return {
    status: 'UPDATED',
    changed: changedFiles.length,
    deleted: deletedFiles.length,
  }
}
```

---

## 15. Package Configuration

### cortex-core/package.json

```json
{
  "name": "@cortex-ai/core",
  "version": "1.0.0",
  "description": "Local-first MCP server for token-efficient AI code navigation",
  "type": "module",
  "main": "dist/server.js",
  "bin": {
    "cortex-mcp": "dist/server.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/server.ts",
    "test": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "better-sqlite3": "^9.0.0",
    "sqlite-vec": "^0.1.0",
    "@xenova/transformers": "^2.17.0",
    "tiktoken": "^1.0.0",
    "glob": "^10.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "vitest": "^1.0.0",
    "@types/better-sqlite3": "^9.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### cortex-java/package.json

```json
{
  "name": "@cortex-ai/java",
  "version": "1.0.0",
  "description": "Java parser for Cortex — Spring-aware, architecture-detecting",
  "type": "module",
  "main": "dist/index.js",
  "dependencies": {
    "@cortex-ai/core": "workspace:*",
    "tree-sitter": "^0.21.0",
    "tree-sitter-java": "^0.21.0",
    "js-yaml": "^4.0.0"
  }
}
```

### Root package.json (workspaces)

```json
{
  "name": "cortex",
  "private": true,
  "workspaces": [
    "packages/cortex-core",
    "packages/cortex-java",
    "packages/cortex-cli"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces"
  }
}
```

---

## 16. OpenCode Integration

Add to your project's `opencode.json`:

```json
{
  "mcpServers": {
    "cortex": {
      "type": "stdio",
      "command": "cortex-mcp",
      "args": [],
      "env": {
        "CORTEX_INDEX_PATH": "${workspaceFolder}/.cortex"
      }
    }
  }
}
```

Or with explicit Java language:

```json
{
  "mcpServers": {
    "cortex": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cortex-core/dist/server.js"],
      "env": {
        "CORTEX_INDEX_PATH": "${workspaceFolder}/.cortex",
        "CORTEX_LANGUAGE": "java"
      }
    }
  }
}
```

---

## 17. CLI Commands

```bash
# Index the current project (auto-detects language)
cortex index .

# Index with explicit language
cortex index . --language java

# Force full re-index (not incremental)
cortex index . --full

# List all indexed projects on this machine
cortex list

# Show status of current project
cortex status

# Remove index for current project
cortex invalidate .

# Start MCP server manually (OpenCode usually auto-starts)
cortex-mcp
```

---

## 18. Team Sharing Options

### Option A: Commit index directly (simplest)

```bash
# Add to .gitignore root:
.cortex/savings.json
.cortex/*.db

# Commit index
git add .cortex/
git commit -m "cortex: update index"
git push
```

### Option B: Git submodule (keeps main repo clean)

```bash
# Create empty index repo on GitHub first
# Then:
git submodule add https://github.com/yourorg/myapp-cortex-index .cortex
cortex index .
cd .cortex
git add -A
git commit -m "cortex: initial index"
git push
cd ..
git add .cortex
git commit -m "add cortex index as submodule"
git push

# Team members:
git clone --recurse-submodules https://github.com/yourorg/myapp
npm install -g @cortex-ai/core @cortex-ai/java
# Start OpenCode — cortex loads automatically
```

### After code changes:

```bash
cortex index .                              # incremental, ~3 seconds
cd .cortex && git add -A && git commit -m "cortex: update index" && git push
cd .. && git add .cortex && git commit -m "bump cortex index"
```

---

## 19. Build Phases & Timeline (With AI Assistance)

### Day 1 — Core scaffold + namespace + filesystem

- Set up monorepo (npm workspaces, TypeScript, tsconfig)
- Implement `root-detector.ts` + `namespace.ts`
- Implement `fs-store.ts` (read/write symbol JSON files)
- Implement `sqlite-store.ts` (schema creation, basic CRUD)
- Implement `loader.ts` (filesystem → SQLite on startup)

**Deliverable**: MCP server starts, loads `.cortex/index/` into SQLite, `list_projects` tool works.

### Day 2 — BM25 search + basic tools

- Implement `bm25.ts` (FTS5 query builder)
- Implement `confidence-gate.ts`
- Implement tools: `search_symbols`, `get_symbol`, `get_file_outline`, `get_project_outline`
- Implement `_meta` envelope with basic token savings (no naive estimate yet)

**Deliverable**: OpenCode can search symbols via Cortex. Test manually on your monorepo.

### Day 3 — Java parser

- Implement `java-parser.ts` (tree-sitter-java, extract class/method/interface/field)
- Implement `spring-tagger.ts` (annotation → SpringRole)
- Implement `arch-detector.ts` (hexagonal/layered/mvc/unknown)
- Implement `index_folder` tool end-to-end
- Test against your monorepo — validate symbol extraction accuracy

**Deliverable**: `cortex index .` works on your Java monorepo. Symbols are correctly extracted and tagged.

### Day 4 — Vector embeddings + RRF

- Integrate `@xenova/transformers` + `nomic-embed-code-v1.5`
- Implement `local-embed.ts`
- Implement `vector-search.ts` (sqlite-vec)
- Implement `rrf-fusion.ts`
- Wire vector results into `search_symbols`

**Deliverable**: Hybrid BM25 + vector search working. Test semantic queries ("how is order saved") against your monorepo.

### Day 5 — Confidence gate tuning + token savings

- Tune `confidenceThreshold` against your real codebase (test 30 queries, measure false positive rate)
- Implement `estimateNaiveTokens` for accurate `tokensIfNaive`
- Implement `savings.ts` (persistent savings counter)
- Full `_meta` envelope with all numbers

**Deliverable**: Token savings `_meta` working with real numbers. Validate: savings are genuine, not inflated.

### Day 6 — Multi-source + get_context_for_task

- Implement `sql-parser.ts` (Flyway migration → schema_symbols)
- Implement `yaml-parser.ts` (application.yml → config_symbols)
- Implement `get_context_for_task` with token budget enforcement
- Implement `search_schema` + `search_config` tools

**Deliverable**: `get_context_for_task("change how orders are saved")` returns symbols + schema context in under 2000 tokens.

### Day 7 — CLI + packaging + README benchmarks

- Implement `cortex-cli` with `index`, `list`, `status`, `invalidate` commands
- `npm publish @cortex-ai/core` + `@cortex-ai/java`
- Run real benchmarks on your monorepo (20 queries, before/after token counts)
- Write README with benchmark table

**Deliverable**: Published, documented, benchmarked. Ready for team adoption.

---

## 20. Benchmark Table Template (fill with real numbers)

Run this against your actual monorepo after Day 5. Replace with real measurements.

| Task | Without Cortex | With Cortex | Saving |
|---|---|---|---|
| Find CreateOrderHandler.execute | ~40,000 tokens | ~200 tokens | 99.5% |
| Understand OrderRepositoryPort | ~15,000 tokens | ~800 tokens | 94.7% |
| Explore all Handlers in module | ~200,000 tokens | ~2,000 tokens | 99.0% |
| "How is order saved to DB?" | ~38,000 tokens | ~1,200 tokens | 96.8% |
| Full session (50 lookups) | ~800,000 tokens | ~45,000 tokens | 94.4% |

> Note: "Without Cortex" = sum of raw file tokens that would have been read by the agent to answer the same question. Measured from OpenCode session logs.

---

## 21. Key Decisions Summary (For Validator)

| Decision | Choice | Reason |
|---|---|---|
| Storage (truth) | Filesystem JSON | Git-diffable, shareable, no merge hell |
| Storage (runtime) | SQLite in memory | Zero infra, fast queries, rebuilt in 2s |
| Vector search | sqlite-vec | No extra process, same SQLite instance |
| BM25 | FTS5 (built into SQLite) | Production-grade, zero deps |
| Fusion | RRF (k=60) | No score calibration needed, empirically strong |
| Embedding model | nomic-embed-code-v1.5 | Code-specific training, 30MB, runs on CPU |
| Embedding runtime | @xenova/transformers (ONNX) | No Python, no API calls, local |
| Language | TypeScript | MCP SDK is TS-first, tree-sitter Node bindings mature |
| Namespace | projectName@sha256(absolutePath)[0:6] | Deterministic, collision-free, human-readable |
| Architecture detection | At index time, not query time | Stable, not recalculated on every query |
| Context tree | NOT in v1 | AI models handle relationship reasoning better |
| Confidence gate | 0.12 default, tunable | Silence is safer than wrong context |
| Package distribution | npm (@cortex-ai/core, @cortex-ai/java) | Easy global install, easy update |

---

## 22. What to Validate (For Opus)

Before coding, validate these decisions:

1. **sqlite-vec filter by project_id** — confirm vec0 supports metadata filtering or confirm application-layer filtering is acceptable for corpus size (~5,000 symbols)
2. **@xenova/transformers on Node.js** — confirm ESM compatibility with the rest of the stack
3. **FTS5 tokenizer** — `porter unicode61` is the right choice for Java qualified names (dotted package names)
4. **tree-sitter-java version** — confirm latest version handles Java 17+ records and sealed classes
5. **MCP SDK version** — confirm `@modelcontextprotocol/sdk@1.x` API for stdio server matches the tool definitions above
6. **Monorepo tooling** — confirm npm workspaces vs turborepo vs nx for build orchestration (npm workspaces is simplest)

---

*End of Cortex MCP Project Plan v1.0*
*Generated: March 2026*
*Target: OpenCode + GitHub Copilot*
*Primary objective: Token reduction with zero accuracy risk*
