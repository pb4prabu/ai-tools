# Condex MCP

**Local-first code index for AI agents — token-efficient, zero-network, production-grade.**

Condex indexes your codebase into a searchable symbol database and exposes it via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Instead of AI agents reading entire source files, they query Condex for precisely the symbols they need — saving 85-92% of context tokens.

```
Without Condex:  Agent reads 12 files     → 80,501 tokens
With Condex:     Agent queries 4 symbols  →  6,588 tokens (91.8% saved)
```

---

## Table of Contents

- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
- [Architecture](#architecture)
- [Packages](#packages)
- [Setup](#setup)
- [Search Chain](#search-chain)
- [MCP Tools](#mcp-tools)
- [Parsers](#parsers)
- [Configuration](#configuration)
- [Index Directory Structure](#index-directory-structure)
- [Confidence Gate](#confidence-gate)
- [Security](#security)
- [Benchmarks](#benchmarks)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Quick Start

```bash
# 1. Clone and build
git clone <repo>
cd condex-mcp
npm install
npm run build

# 2. Download the embedding model (~100MB, one-time)
npm run download-model --workspace=packages/condex-core

# 3. Generate MCP config for your project
npx condex setup /path/to/your/project

# 4. Copy the generated config into your AI tool's MCP settings
#    (see Setup section for details per tool)
```

That's it. The MCP server auto-indexes your project on first startup and keeps the index up-to-date on every query.

---

## How It Works

### Step-by-Step Flow

```
1. AI Agent asks: "How does order creation work?"

2. Agent calls: search_symbols(query="order creation")

3. Condex MCP Server:
   a. Check for file changes since last query (incremental re-index)
   b. Run search chain: vector first, BM25 fallback
   c. Vector search → semantic match on "order creation"
   d. Return 4 symbols with signatures (312 tokens)

4. Agent calls: get_symbol(symbolId="...CreateOrderHandler...")

5. Condex MCP Server:
   a. Look up byte offset in SQLite
   b. Read exact bytes from source file
   c. Verify content hash → match
   d. Return source code (180 tokens)

6. Agent has precise context (492 tokens total)
   vs. reading 12 files naively (2847 tokens) → 82.7% savings
```

### What Happens on Startup

1. **Database** — Opens or creates `.condex/index.db` (persistent SQLite with WAL mode)
2. **Parsers** — Loads Java parser (`@condex-ai/java`) and/or multi-lang tree-sitter parser (`@condex-ai/multi-lang`)
3. **BM25 Index** — If the database has existing symbols, uses them directly. Otherwise loads from JSON index files or runs a full index from source
4. **Vector Index** — If the search chain includes `vector` or `hybrid`:
   - Loads `sqlite-vec` extension
   - Loads the embedding model from `~/.condex/models/` (downloads if not cached)
   - Builds vector embeddings for all symbols (or loads from persistent DB if already built)
5. **Incremental Reindexer** — Seeds file hash cache for query-time change detection
6. **MCP Server** — Starts stdio JSON-RPC transport, ready for tool calls

### What Happens on Every Query

Before each search, Condex scans source files for changes (via content hashing). Changed files are re-parsed, re-indexed in BM25, and re-embedded in the vector index — all before the search runs. This means the AI agent always searches against up-to-date code, with zero manual intervention.

---

## Architecture

```
AI Agent (Claude Code, OpenCode, etc.)
    │
    ▼  MCP (stdio JSON-RPC)
┌──────────────────────────────────────────┐
│  Condex MCP Server                       │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ 10 Tools   │  │ Retrieval Engine   │  │
│  │ (handlers) │──│ BM25 / Vector / RRF│  │
│  └────────────┘  └────────────────────┘  │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ SQLite     │  │ Incremental        │  │
│  │ (persistent│  │ Reindexer          │  │
│  │  WAL mode) │  │ (query-time)       │  │
│  └────────────┘  └────────────────────┘  │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ SafeFS     │  │ Network Guard      │  │
│  │ (sandbox)  │  │ (3-layer block)    │  │
│  └────────────┘  └────────────────────┘  │
└──────────────────────────────────────────┘
    │
    ▼  File system (read-only to source, write to .condex/)
┌──────────────────────────────────────────┐
│  Your Codebase                           │
│  .condex/                                │
│  ├── index.db          (persistent DB)   │
│  └── index/            (JSON files)      │
└──────────────────────────────────────────┘
```

### Dual Persistence

Condex writes to two stores during indexing:

| Store | Format | Purpose |
|-------|--------|---------|
| `.condex/index.db` | SQLite (WAL) | Fast queries — BM25 (FTS5), vector search (sqlite-vec), symbol lookup |
| `.condex/index/*.json` | JSON files | Human-readable — inspect indexed symbols, metadata, skipped files, errors |

On startup, Condex checks the SQLite database first. If it has data, it skips JSON loading entirely. If the DB is empty or missing, it loads from JSON or runs a full index from source.

---

## Packages

| Package | Purpose | Key Dependencies |
|---------|---------|-----------------|
| **@condex-ai/core** | MCP server, retrieval, storage, security | `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@huggingface/transformers` |
| **@condex-ai/java** | Spring-aware Java parser with architecture detection | `tree-sitter`, `tree-sitter-java`, `js-yaml` |
| **@condex-ai/multi-lang** | Tree-sitter parsers for 20 languages | `tree-sitter`, `tree-sitter-python`, `tree-sitter-typescript`, etc. |
| **@condex-ai/cli** | CLI for manual indexing, setup, and management | `@condex-ai/core`, `@condex-ai/java` |

---

## Setup

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9

### 1. Build from Source

```bash
git clone <repo>
cd condex-mcp
npm install
npm run build
```

### 2. Download the Embedding Model

The embedding model (`nomic-ai/nomic-embed-text-v1.5`, ~100MB, ONNX q8 quantized, 768 dimensions) is required for vector search.

```bash
# Download to default location: ~/.condex/models/
npm run download-model --workspace=packages/condex-core

# Or specify a custom cache directory
CONDEX_MODEL_CACHE_DIR=/path/to/models npm run download-model --workspace=packages/condex-core
```

**Default model cache:** `~/.condex/models/` (persists across projects and reboots).

> If you skip this step, the model downloads automatically on first MCP server startup when using vector/hybrid mode. This adds ~30-60s to the first startup.

### 3. Generate MCP Config for Your Project

```bash
npx condex setup /path/to/your/project
```

This command:
- Generates `.mcp.json` (Claude Code format) in your project root
- Generates `mcp.json` (generic MCP format) in your project root
- Updates `opencode.json` if it exists (OpenCode format)
- Checks if `sqlite-vec`, `@huggingface/transformers`, and the embedding model are available
- Reports any warnings (e.g., missing vector dependencies)

### 4. Connect to Your AI Tool

#### Claude Code

The `condex setup` command generates `.mcp.json` in your project root. Claude Code reads this file automatically.

If you prefer manual setup, add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "condex": {
      "command": "node",
      "args": ["/absolute/path/to/condex-mcp/packages/condex-core/dist/server.js"],
      "env": {
        "CONDEX_SEARCH_MODE": "vector,bm25",
        "CONDEX_BM25_MIN_SCORE": "0.3",
        "CONDEX_VECTOR_MAX_DISTANCE": "0.95"
      }
    }
  }
}
```

> **Important:** The `args` path must be absolute. Use the path printed by `condex setup`.

#### OpenCode

Add to `opencode.json` in your project root:

```json
{
  "mcp": {
    "condex": {
      "type": "local",
      "command": ["node", "/absolute/path/to/condex-mcp/packages/condex-core/dist/server.js"],
      "environment": {
        "CONDEX_SEARCH_MODE": "vector,bm25",
        "CONDEX_BM25_MIN_SCORE": "0.3",
        "CONDEX_VECTOR_MAX_DISTANCE": "0.95"
      },
      "enabled": true
    }
  }
}
```

> **Note:** There is only one `condex` MCP entry — no mode selection needed. The search chain is configured via `CONDEX_SEARCH_MODE`. If vector dependencies are unavailable, Condex automatically falls back to BM25.

### 5. Verify Setup

Start your AI tool and look for Condex startup logs in stderr:

```
[condex] Starting Condex MCP Server
[condex] Project root: /path/to/your/project
[condex] Namespace: project@abc123
[condex] Database: /path/to/your/project/.condex/index.db (new)
[condex] Java parser loaded
[condex] Multi-lang parser loaded (20 languages)
[condex] No existing index. Running full index...
[condex] Indexed: 847 symbols from 234 files in 3200ms
[condex] Search chain: [vector, bm25]
[condex] [1/3] sqlite-vec loaded, symbol_vectors table ready
[condex] [2/3] Embedder ready (768 dimensions)
[condex] [3/3] Vector index built for 847 symbols
[condex] Server ready. 10 tools available.
```

### First Run Behavior

| Scenario | What Happens |
|----------|-------------|
| No `.condex/` + parsers available | Full index from source (3-8s for ~800 files) |
| No `.condex/` + no parsers | Error: "No parser available" |
| `.condex/index.db` exists with data | Opens DB directly, skips indexing (~100ms) |
| `.condex/index.db` empty + JSON files exist | Loads from JSON into DB (~1s) |
| Vector mode, model not cached | Downloads ~100MB model, then builds embeddings (30-60s) |
| Vector mode, model cached + DB has vectors | Ready instantly |

### CLI Commands

```bash
npx condex setup [path]           # Generate MCP config files
npx condex index [path]           # Index a project (incremental)
npx condex index [path] --full    # Force full re-index
npx condex status [path]          # Show index status
npx condex invalidate [path]      # Delete index (triggers re-index on next use)
npx condex help                   # Show help
```

---

## Search Chain

Condex uses a **search chain** — a comma-separated list of search modes tried in order. The first mode that returns results wins.

### Configuration

```
CONDEX_SEARCH_MODE=vector,bm25    (default)
```

### How It Works

```
Search chain: [vector, bm25]

1. Try vector search (semantic)
   → Results found? Stop, return them.
   → No results? Continue to next mode.

2. Try BM25 search (keyword)
   → Results found? Stop, return them (marked as "bm25-fallback").
   → No results? Chain exhausted, return "no results".
```

### Available Modes

| Mode | How It Works | Speed | Best For |
|------|-------------|-------|----------|
| `bm25` | SQLite FTS5 with CamelCase splitting and Porter stemmer | 5-50ms | Exact names: `CreateOrderHandler`, `com.app.order` |
| `vector` | Semantic similarity via 768d embeddings (nomic-embed-text-v1.5) | 1-3s | Natural language: "how does payment processing work?" |
| `hybrid` | Runs both BM25 + vector in parallel, fuses with Reciprocal Rank Fusion (k=60) | 2-4s | Mixed queries — some keyword, some semantic |

### Chain Examples

| Chain | Behavior |
|-------|----------|
| `vector,bm25` | Vector first, BM25 fallback **(default, recommended)** |
| `bm25,vector` | BM25 first, vector fallback on no results |
| `bm25` | BM25 only — fastest, no model download needed |
| `vector` | Vector only, no fallback |
| `hybrid` | Always fuse both modes (runs both every time) |

### Graceful Degradation

If vector dependencies (`sqlite-vec` or the embedding model) fail to load at startup, Condex automatically removes `vector` and `hybrid` from the chain and falls back to `bm25`. The effective chain is logged:

```
[condex] Effective search chain: [bm25] (requested: [vector, bm25])
```

---

## MCP Tools

Condex exposes 10 tools via the Model Context Protocol:

### Navigation Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `list_projects` | List all indexed projects | First call — discover available projects |
| `get_project_outline` | High-level structure (packages, symbol counts) | Understand project before diving in |
| `get_file_outline` | List symbols in a file (signatures only) | Browse a file without reading it |

### Search Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `search_symbols` | Find symbols by name, description, or role | Find relevant code for a query |
| `search_schema` | Search database tables/columns | Understand data model |
| `get_context_for_task` | Assemble context for a coding task (within token budget) | Start working on a feature/bugfix |

### Retrieval Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `get_symbol` | Get full source code of one symbol | Read implementation after search |
| `get_symbols` | Batch retrieve multiple symbols | Read several implementations at once |

### Management Tools

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `index_folder` | Force full or incremental re-index | After major code changes |
| `invalidate_cache` | Clear project index | Start fresh |

### search_symbols Filters

```json
{
  "query": "order creation handler",
  "kind": "class",
  "springRole": "SERVICE",
  "hexRole": "USE_CASE_HANDLER",
  "filePattern": "order",
  "limit": 20
}
```

All filters are optional. Combine for precise results.

### Token Savings Tracking

Every tool response includes `_meta` with savings data:

```json
{
  "timingMs": 47,
  "symbolsReturned": 4,
  "tokensInResponse": 312,
  "tokensIfNaive": 2847,
  "tokensSaved": 2535,
  "tokensSavedPercent": 89,
  "sessionTokensSaved": 15420,
  "allTimeTokensSaved": 42150,
  "confidenceGateFired": false,
  "topScore": 0.847
}
```

Cumulative savings persisted in `.condex/savings.json`.

---

## Parsers

### Composite Parser

Condex uses a composite parser that routes files to the best available parser:

```
.java files  → Java parser (@condex-ai/java) — full Spring/Hex detection
20 other exts → Multi-lang parser (@condex-ai/multi-lang) — tree-sitter
All others   → Generic file parser — file-level symbol for BM25/vector searchability
```

### Java Parser (Primary)

Uses [tree-sitter](https://tree-sitter.github.io/) for AST-based symbol extraction:

- **Symbol kinds**: `class`, `interface`, `method`, `field`, `constant`, `constructor`, `enum`, `annotation_type`
- **Extracted per symbol**: signature, javadoc, annotations, byte offset/length, content hash (SHA256)
- **Qualified names**: `com.app.order.CreateOrderHandler.execute(CreateOrderRequest)`
- **Inner class support**: Nested classes, enums, and anonymous classes
- **Generics**: Full parameterized type extraction
- **Call-graph refs**: Method calls, field accesses (used for graph expansion in search)

### Spring Framework Detection

| Annotation | Spring Role |
|------------|-------------|
| `@RestController` | `REST_CONTROLLER` |
| `@Service` | `SERVICE` |
| `@Repository` | `REPOSITORY` |
| `@Component` | `COMPONENT` |
| `@Configuration` | `CONFIGURATION` |
| `@Entity` | `ENTITY` |
| `@EventListener` | `EVENT_HANDLER` |
| `@Scheduled` | `SCHEDULED` |

### Hexagonal Architecture Detection

| Role | Pattern Examples |
|------|-----------------|
| `INBOUND_PORT` | `*UseCase`, `*Port` (in `port.in` package) |
| `OUTBOUND_PORT` | `*Repository`, `*Port` (in `port.out` package) |
| `USE_CASE_HANDLER` | `*Handler`, `*Service` (in `application` package) |
| `ADAPTER` | Classes in `adapter` packages |
| `DOMAIN_ENTITY` | Classes in `domain.model` |
| `DOMAIN_EVENT` | `*Event`, `*Created`, `*Updated` |

### Multi-Language Parser

20 languages via tree-sitter (`@condex-ai/multi-lang`):

Python, TypeScript, JavaScript, JSX, TSX, Go, Rust, Kotlin, C, C++, C#, Ruby, PHP, Swift, Scala, Lua, Zig, Elixir, Haskell, Dart

### SQL & YAML Parsers

- **SQL**: Extracts table/column schemas from Flyway/Liquibase migration files
- **YAML**: Extracts configuration properties from `application.yml` / `application.properties`

### Generic File Parser

For files not matched by any language parser (`.xml`, `.md`, `.json`, `.properties`, etc.):
- Creates a single file-level symbol containing the first 1000 characters
- Ensures ALL text files are searchable via BM25 and vector search

---

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONDEX_SEARCH_MODE` | `vector,bm25` | Search priority chain (comma-separated, left = highest priority) |
| `CONDEX_BM25_MIN_SCORE` | `0.3` | Minimum BM25 relevance score (0.0-1.0). Lower = more results |
| `CONDEX_VECTOR_MAX_DISTANCE` | `0.95` | Maximum vector distance (0.0-1.0). Higher = more results |
| `CONDEX_MODEL_CACHE_DIR` | `~/.condex/models/` | Override embedding model cache location |

### Project Config (optional)

`.condex/condex.config.json`:

```json
{
  "language": "auto",
  "include": ["**/*.java"],
  "exclude": ["**/generated/**", "**/target/**"],
  "retrieval": {
    "confidenceThreshold": 0.12,
    "maxResultsPerSearch": 20,
    "defaultTokenBudget": 2000
  }
}
```

### Language Detection

When `language` is `auto` (default), Condex detects the primary language from build markers:

| Markers | Language |
|---------|----------|
| `pom.xml`, `build.gradle`, `build.gradle.kts` | Java |
| `tsconfig.json`, `package.json` | TypeScript |
| `requirements.txt`, `pyproject.toml` | Python |

The detected language determines which source file extensions to scan. The multi-lang parser handles all 20 supported languages regardless of the detected primary language.

---

## Index Directory Structure

```
.condex/
├── index.db               # Persistent SQLite database (BM25 FTS5 + symbol data + vector embeddings)
├── index.db-wal           # SQLite WAL file (auto-managed)
├── index.db-shm           # SQLite shared memory (auto-managed)
├── index/
│   ├── meta.json          # Project metadata: name, language, architecture, file hashes, symbol counts
│   ├── symbols/           # One JSON file per symbol (human-readable)
│   │   ├── a1b2c3d4.json  # Symbol file (named by SHA256 of symbol ID)
│   │   └── ...
│   ├── schema/
│   │   └── migrations.json  # Extracted SQL schema symbols
│   ├── config/
│   │   └── application.json # Extracted YAML config symbols
│   ├── index-status.json  # Pipeline status (BM25/vector success/failure/skipped)
│   ├── errors.log         # Error log (append-only, JSON entries separated by ---)
│   └── skipped.json       # Skipped files grouped by reason (binary, excluded, unchanged, etc.)
├── condex.config.json     # Optional project config
├── savings.json           # Cumulative token savings tracker
├── .indexing.lock         # Lock file (prevents concurrent indexing, auto-cleared after 5 min)
└── .gitignore             # Auto-generated: ignores *.db, *.db-shm, *.db-wal, savings.json, .indexing.lock
```

### Debugging

- **What was indexed?** Check `index/meta.json` for file hashes and symbol counts
- **Why was a file skipped?** Check `index/skipped.json` — grouped by reason (binary, excluded by pattern, unchanged, parse error)
- **What went wrong?** Check `index/errors.log` — timestamped JSON entries for all errors during indexing/startup
- **Is vector working?** Check `index/index-status.json` — shows BM25 and vector pipeline status
- **What symbols exist?** Browse `index/symbols/` — one JSON file per symbol with full metadata

---

## Confidence Gate

**Philosophy: Silence is safer than wrong context.**

The confidence gate prevents low-quality search results from being injected into AI prompts. Wrong context is worse than no context — the agent can always fall back to reading files directly.

### How It Works

```
1. Search chain executes (e.g., vector → bm25)
2. If all modes return 0 results → chain exhausted, gate fires
   → Returns: "No symbols found matching [query] (tried: vector → bm25)"
   → Agent falls back to normal file reading
3. If a mode returns results → filter by threshold
   → BM25: filter out results below CONDEX_BM25_MIN_SCORE
   → Vector: filter out results above CONDEX_VECTOR_MAX_DISTANCE
```

### When the Gate Fires

- Vague queries: "stuff" → no relevant symbols
- Typos: "creat ordeer" → no BM25 match, no semantic match
- Out-of-scope: "kubernetes deployment" → not in codebase
- Very common terms: "get" → may produce too many low-confidence matches

---

## Security

Condex is designed to be **zero-trust**: no network access (in BM25 mode), restricted filesystem, sandboxed execution.

### 3-Layer Network Block

**Layer 1 — Environment Variables** (Library-level):
```
TRANSFORMERS_OFFLINE=1         — HuggingFace offline mode
HF_HUB_DISABLE_TELEMETRY=1    — Disable telemetry
```

**Layer 2 — Node.js API Monkey-Patch** (Process-level):
Patches `net.Socket`, `tls.connect`, `http.request`, `https.request`, `globalThis.fetch`, `dgram.createSocket`. Any network call throws `NETWORK_BLOCKED`.

**Layer 3 — OS Sandbox** (Kernel-level):
- macOS: `sandbox-exec` profile denying `network-outbound`
- Linux: `unshare --net` network namespace isolation

### Network Guard by Search Chain

| Chain includes | Network Guard |
|----------------|--------------|
| Only `bm25` | **Active** — all outbound blocked |
| `vector` or `hybrid` | **Disabled** — model download may be needed on first run |

After the embedding model is cached (`~/.condex/models/`), all modes operate fully offline.

### Filesystem Guard (SafeFS)

All file operations go through `SafeFS`:
- **Read**: Only within project root
- **Write**: Only within `.condex/` directory
- Violation throws: `FS_BLOCKED: Read access denied outside project root`

---

## Benchmarks

### Running the Benchmark

```bash
# Generate sample Spring Boot monorepo (62 Java files, 4 microservices)
npx tsx benchmark/generate-sample.ts

# Run BM25-only benchmark
npx tsx benchmark/bench.ts

# Run full comparison (BM25, Vector, Hybrid)
npx tsx benchmark/bench.ts --vector

# Verbose output with per-query details
npx tsx benchmark/bench.ts --vector --verbose
```

### Results (15 developer queries)

| Mode | Tokens | Savings | Gate Fires |
|------|--------|---------|------------|
| **Naive** (no Condex) | 80,501 | 0% | — |
| **BM25** | 6,588 | **91.8%** | 2/15 queries |
| **Hybrid** (BM25+Vector+RRF) | 42,436 | 47.3% | 0/15 queries |
| **Search Chain** (`vector,bm25`) | 14,439 | **82.1%** | 0/15 queries |

### Accuracy by Query Type

| Query Type | BM25 | Vector | Hybrid |
|------------|------|--------|--------|
| Exact class/method name | Excellent | Good | Excellent |
| Package path (`com.app.order`) | Excellent | Moderate | Excellent |
| Natural language ("how does X work?") | Moderate | Good | Good |
| Architectural ("all REST controllers") | Excellent (with filters) | Moderate | Good |
| Typos / misspellings | Poor | Moderate | Moderate |
| Cross-cutting concerns | Poor | Good | Good |

### Running the Real-World Test

```bash
# Full integration test: creates temp project, indexes, tests BM25 + vector + hybrid
npx tsx packages/condex-core/src/scripts/realworld-test.ts
```

This test creates a realistic Java project in a temp directory, indexes it, and runs 19 queries across all search modes. All 19 queries must pass.

### Running Unit Tests

```bash
npm test                              # All tests (126 unit + 17 skipped)
npx vitest run --reporter=verbose     # Verbose output
```

---

## Known Limitations

### Index Staleness
- Symbol byte offsets are valid at index time. If source files change, offsets may be wrong.
- **Mitigation**: Content hash verification in `get_symbol` — warns if mismatch detected.
- **Mitigation**: Incremental reindexer detects changes on every query and re-indexes automatically.

### FTS5 Tokenization
- Porter stemmer may over-stem some terms
- CamelCase splitting is heuristic-based
- Exact phrase matching requires specific query formatting

### No Type-Aware Ranking
- BM25 searches all text fields equally (name, signature, javadoc)
- Cannot weight "class name matches" higher than "javadoc mentions"
- Vector search partially addresses this via semantic similarity

### Vector Mode
- First model download requires network access (~100MB)
- CPU-only inference (no GPU acceleration)
- Embedding all symbols adds 30-60s to first startup
- Incremental vector updates supported (changed files only)

### Language Support
- **Java**: Full support — tree-sitter AST parser, Spring annotation detection, hexagonal architecture detection, call-graph extraction
- **20 languages**: Tree-sitter parsing via `@condex-ai/multi-lang` — symbol extraction (classes, functions, methods) without framework-specific detection
- **All text files**: Generic file-level indexing — searchable via BM25 and vector, no symbol-level granularity

### Concurrency
- Lock file prevents simultaneous indexing
- Concurrent reads during indexing may return partial results
- Not a concern for single-agent use (typical MCP pattern)

---

## License

Private — all rights reserved.
