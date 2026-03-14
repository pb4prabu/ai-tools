# Condex MCP

**Local-first code index for AI agents — token-efficient, zero-network, production-grade.**

Condex indexes your codebase into a searchable symbol database and exposes it via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Instead of AI agents reading entire source files, they query Condex for precisely the symbols they need — saving 85-92% of context tokens.

```
Without Condex:  Agent reads 12 files     → 80,501 tokens
With Condex:     Agent queries 4 symbols  →  6,588 tokens (91.8% saved)
```

---

## Table of Contents

- [Setup](#setup)
- [Agent Instructions](#agent-instructions)
- [Benchmark Your Project](#benchmark-your-project)
- [How It Works](#how-it-works)
- [Search Chain](#search-chain)
- [MCP Tools](#mcp-tools)
- [Parsers](#parsers)
- [Configuration](#configuration)
- [Index Directory Structure](#index-directory-structure)
- [Architecture](#architecture)
- [Security](#security)
- [Tests & Benchmarks](#tests--benchmarks)
- [Known Limitations](#known-limitations)

---

## Setup

### One-Command Setup

```bash
git clone <repo> && cd condex-mcp
npm run setup
```

This installs dependencies, builds all packages, and downloads the embedding model (~145MB) to `~/.condex/models/`.

Behind a proxy: `HTTPS_PROXY=http://proxy:port npm run setup`

### Add to Your Project

**Option A** — auto-create config files (run from the condex-mcp directory):

```bash
cd /path/to/condex-mcp
npx condex setup /path/to/your/project
```

This creates `.mcp.json` (Claude Code) and `opencode.json` (OpenCode / Dayton) in your project. If either file already exists, it won't be overwritten — the command prints the condex snippet for you to manually copy into your existing config.

**Option B** — copy the sample files:

`npm run setup` generates sample config files in the condex-mcp root:

- `mcp.sample.jsonc` → copy as `.mcp.json` to your project root (Claude Code)
- `opencode.sample.jsonc` → copy as `opencode.json` to your project root (OpenCode / Dayton)

> **Note:** Remove the `//` comments after copying — plain JSON does not support comments and will fail to parse.

**Option C** — manually create the config:

**Claude Code** — create `.mcp.json` in your project root:

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

**OpenCode / Dayton** — create `opencode.json` in your project root:

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

> Replace `/absolute/path/to/condex-mcp` with the actual path printed by `npm run setup` or `npx condex setup`.

### Model Cache

The embedding model (`nomic-ai/nomic-embed-text-v1.5`, 768 dimensions, ONNX q8) is cached at `~/.condex/models/`. Override with `CONDEX_MODEL_CACHE_DIR` env var. If the model isn't pre-downloaded, the MCP server downloads it on first startup (~30-60s one-time delay).

### CLI Commands

```bash
npx condex setup [path]           # Create .mcp.json + opencode.json (warns if exists)
npx condex index [path]           # Index a project (incremental)
npx condex index [path] --full    # Force full re-index
npx condex status [path]          # Show index status
npx condex invalidate [path]      # Delete index (triggers re-index on next use)
```

### Verify MCP Connection

After setup, verify Condex is connected to your agent:

| Agent | How to verify |
|-------|---------------|
| **Claude Code** | Run `/mcp` — look for `condex` in the server list with status `connected` |
| **OpenCode / Dayton** | Run `/mcp` — look for `condex` with a green status indicator |
| **Cursor** | Open Settings → MCP → check that `condex` shows as connected |
| **Any MCP agent** | Call `list_projects` — if it returns your project, Condex is working |

If `condex` doesn't appear or shows as disconnected, check:
1. The server path in your config is correct (absolute path to `packages/condex-core/dist/server.js`)
2. You ran `npm run build` in the condex-mcp directory
3. Node.js >= 18 is installed

---

## Agent Instructions

### OpenCode / Dayton / Other MCP Agents — add to your agent instruction file

````markdown
## Condex MCP — Code Index

This project uses Condex MCP for token-efficient code navigation. Always prefer Condex tools over reading raw files.

**Tools (in order of typical use):**
1. `get_project_outline` — project structure overview
2. `search_symbols` — find symbols by query, kind, role, file pattern
3. `get_symbol` / `get_symbols` — retrieve source code by symbol ID
4. `get_file_outline` — list symbols in a specific file
5. `search_schema` — search database tables/columns
6. `get_context_for_task` — assembled context within token budget
7. `index_folder` — force re-index (rarely needed)
8. `invalidate_cache` — clear index

**Stats — print at end of conversation:**
```
📊 Condex Stats: {n} queries (bm25:{x}, vector:{y}) | hits: {h}/{n} ({pct}%) | used: ~{t1} tok | w/o Condex: ~{t2} tok | saved: ~{t3} ({pct2}%)
```
Track `_meta.tokensInResponse`, `_meta.tokensIfNaive`, `_meta.symbolsReturned`, and `_meta.searchMode` from each Condex tool response.
````

### Understanding the stats line

```
📊 Condex Stats: 12 queries (bm25:6, vector:6) | hits: 8/12 (67%) | used: ~2,800 tok | w/o Condex: ~8,100 tok | saved: ~5,300 (65%)
```

| Field | Source | Meaning |
|-------|--------|---------|
| `queries` | Count of Condex tool calls | Total search/retrieval calls made |
| `bm25:x, vector:y` | `_meta.searchMode` | Breakdown by search mode |
| `hits` | Calls where `_meta.symbolsReturned > 0` | How often Condex found relevant results |
| `used` | Sum of `_meta.tokensInResponse` | Actual tokens consumed via Condex |
| `w/o Condex` | Sum of `_meta.tokensIfNaive` | Tokens if agent had read full files instead |
| `saved` | `tokensIfNaive - tokensInResponse` | Token savings from using Condex |

---

## Benchmark Your Project

Want to measure how much Condex saves on **your** codebase? Give [`BENCHMARK_TEST_PLAN.md`](./BENCHMARK_TEST_PLAN.md) to your AI agent — it contains a step-by-step test plan the agent can follow to benchmark Condex MCP efficiency and report token savings.

```
You: @agent please run through BENCHMARK_TEST_PLAN.md
```

The agent will execute a series of Condex queries against your project and produce a stats summary at the end.

---

## How It Works

### End-to-End Flow

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

### Startup Sequence

1. Opens or creates `.condex/index.db` (persistent SQLite, WAL mode)
2. Loads parsers — Java (`@condex-ai/java`) and/or multi-lang tree-sitter (`@condex-ai/multi-lang`)
3. Checks DB for existing symbols → uses them directly, or loads from JSON, or runs full index
4. If search chain includes `vector`/`hybrid`: loads `sqlite-vec`, loads embedding model, builds/loads vector index
5. Seeds incremental reindexer with file hashes for query-time change detection
6. Starts MCP stdio transport

### Query-Time Reindexing

Before each search, Condex scans source files for changes (via content hashing). Changed files are re-parsed and re-indexed in both BM25 and vector — the AI agent always searches against up-to-date code.

---

## Search Chain

A comma-separated list of search modes tried in order. First mode that returns results wins.

```
CONDEX_SEARCH_MODE=vector,bm25    (default)
```

### Modes

| Mode | How It Works | Speed | Best For |
|------|-------------|-------|----------|
| `bm25` | SQLite FTS5 with CamelCase splitting + Porter stemmer | 5-50ms | Exact names: `CreateOrderHandler`, `com.app.order` |
| `vector` | Semantic similarity via 768d embeddings | 1-3s | Natural language: "how does payment processing work?" |
| `hybrid` | BM25 + vector in parallel, fused with RRF (k=60) | 2-4s | Mixed keyword + semantic queries |

### Chain Examples

| Chain | Behavior |
|-------|----------|
| `vector,bm25` | Vector first, BM25 fallback **(default)** |
| `bm25,vector` | BM25 first, vector fallback on no results |
| `bm25` | BM25 only — fastest, no model needed |
| `vector` | Vector only, no fallback |
| `hybrid` | Always fuse both modes |

### Graceful Degradation

If `sqlite-vec` or the embedding model fails to load, Condex automatically removes `vector`/`hybrid` from the chain and falls back to `bm25`.

---

## MCP Tools

10 tools via the Model Context Protocol:

### Navigation

| Tool | Purpose |
|------|---------|
| `list_projects` | List all indexed projects |
| `get_project_outline` | High-level structure (packages, symbol counts) |
| `get_file_outline` | List symbols in a file (signatures only) |

### Search

| Tool | Purpose |
|------|---------|
| `search_symbols` | Find symbols by name, description, or role |
| `search_schema` | Search database tables/columns |
| `get_context_for_task` | Assemble context within a token budget |

### Retrieval

| Tool | Purpose |
|------|---------|
| `get_symbol` | Get full source code of one symbol |
| `get_symbols` | Batch retrieve multiple symbols |

### Management

| Tool | Purpose |
|------|---------|
| `index_folder` | Force full or incremental re-index |
| `invalidate_cache` | Clear project index |

### search_symbols Filters

```json
{
  "query": "order creation handler",
  "kind": "class",
  "springRole": "SERVICE",
  "hexRole": "USE_CASE_HANDLER",
  "filePattern": "order"
}
```

All filters optional. Every response includes `_meta` with token savings data and cumulative stats (persisted in `.condex/savings.json`).

---

## Parsers

### Composite Parser Routing

```
.java files  → Java parser (@condex-ai/java) — Spring/Hex detection, call-graph
20 other exts → Multi-lang parser (@condex-ai/multi-lang) — tree-sitter AST
All others   → Generic file parser — file-level symbol for BM25/vector search
```

### Java Parser

- **Symbol kinds**: class, interface, method, field, constant, constructor, enum, annotation_type
- **Extracted**: signature, javadoc, annotations, byte offset/length, content hash, call-graph refs
- **Spring roles**: REST_CONTROLLER, SERVICE, REPOSITORY, COMPONENT, CONFIGURATION, ENTITY, EVENT_HANDLER, SCHEDULED
- **Hex roles**: INBOUND_PORT, OUTBOUND_PORT, USE_CASE_HANDLER, ADAPTER, DOMAIN_ENTITY, DOMAIN_EVENT
- **Architecture auto-detection**: hexagonal, layered, MVC

### Multi-Language (20 languages)

Python, TypeScript, JavaScript, JSX, TSX, Go, Rust, Kotlin, C, C++, C#, Ruby, PHP, Swift, Scala, Lua, Zig, Elixir, Haskell, Dart

### SQL & YAML

- **SQL**: table/column schemas from Flyway/Liquibase migrations
- **YAML**: config properties from `application.yml`/`.properties`

---

## Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONDEX_SEARCH_MODE` | `vector,bm25` | Search priority chain (comma-separated) |
| `CONDEX_BM25_MIN_SCORE` | `0.3` | Minimum BM25 score (0.0-1.0) |
| `CONDEX_VECTOR_MAX_DISTANCE` | `0.95` | Maximum vector distance (0.0-1.0) |
| `CONDEX_MODEL_CACHE_DIR` | `~/.condex/models/` | Embedding model cache location |

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

Language auto-detection: `pom.xml`/`build.gradle` → Java, `tsconfig.json` → TypeScript, `requirements.txt` → Python.

---

## Index Directory Structure

```
.condex/
├── index.db               # Persistent SQLite (BM25 FTS5 + vectors + symbols)
├── index/
│   ├── meta.json          # Project metadata, file hashes, symbol counts
│   ├── symbols/           # One JSON per symbol (human-readable)
│   ├── schema/migrations.json
│   ├── config/application.json
│   ├── index-status.json  # BM25/vector pipeline status
│   ├── errors.log         # Timestamped error log (append-only)
│   └── skipped.json       # Skipped files grouped by reason
├── condex.config.json     # Optional project config
├── savings.json           # Cumulative token savings
└── .gitignore             # Auto-generated (ignores DB files, lock, savings)
```

**Debugging**: `errors.log` for errors, `skipped.json` for why files were excluded, `index-status.json` for pipeline health, `meta.json` for what's indexed.

---

## Architecture

```
AI Agent (Claude Code, OpenCode / Dayton, etc.)
                  │
                  ▼  
          MCP (stdio JSON-RPC)
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
                    ▼  
File system (read-only to source, write to .condex/)
┌──────────────────────────────────────────┐
│  Your Codebase + .condex/                │
└──────────────────────────────────────────┘
```

### Packages

| Package | Purpose |
|---------|---------|
| **@condex-ai/core** | MCP server, retrieval, storage, security |
| **@condex-ai/java** | Spring-aware Java parser + architecture detection |
| **@condex-ai/multi-lang** | Tree-sitter parsers for 20 languages |
| **@condex-ai/cli** | CLI for indexing, setup, management |

### Dual Persistence

| Store | Purpose |
|-------|---------|
| `.condex/index.db` (SQLite WAL) | Fast queries — BM25, vector search, symbol lookup |
| `.condex/index/*.json` (JSON) | Human-readable — inspect symbols, metadata, errors |

SQLite is checked first on startup. JSON is only loaded if the DB is empty.

---

## Security

**Zero-trust design**: no network access (BM25 mode), restricted filesystem, sandboxed execution.

### Network Guard

- **BM25-only chain**: All outbound blocked (env vars + Node.js monkey-patch + OS sandbox)
- **Vector/hybrid chain**: Network allowed for model download only; fully offline after model is cached

### Filesystem Guard (SafeFS)

- **Read**: Only within project root
- **Write**: Only within `.condex/`

### Confidence Gate

Silence is safer than wrong context. If the search chain exhausts all modes with no results, Condex returns a "no results" message instead of low-quality matches. The agent can fall back to reading files directly.

---

## Tests & Benchmarks

```bash
npm test                                                       # 126 unit tests
npx vitest run --reporter=verbose                              # Verbose output
npx tsx packages/condex-core/src/scripts/realworld-test.ts     # 19 integration tests (BM25 + vector + hybrid)
npx tsx benchmark/generate-sample.ts && npx tsx benchmark/bench.ts --vector  # Benchmark (15 queries, 4 modes)
```

### Benchmark Results (15 developer queries)

| Mode | Tokens | Savings |
|------|--------|---------|
| Naive (no Condex) | 80,501 | 0% |
| BM25 | 6,588 | **91.8%** |
| Hybrid (RRF) | 42,436 | 47.3% |
| Search Chain (`vector,bm25`) | 14,439 | **82.1%** |

> **Note:** These results are from preliminary analysis on a single codebase and should be treated as a starting point, not a definitive claim. Real-world benefits will become clearer as more projects adopt Condex. In particular, context drift (whether symbol-level retrieval consistently gives agents the *right* context vs. full-file reads) has not been validated at scale yet. We're sharing these early numbers for feedback — if you have observations or results to share, please open an issue.

---

## Known Limitations

- **FTS5 tokenization**: Porter stemmer may over-stem; CamelCase splitting is heuristic-based
- **No type-aware ranking**: BM25 searches all fields equally (name, signature, javadoc)
- **Vector mode**: CPU-only inference, ~30-60s first startup for embedding, ~100MB model download
- **Java**: Full support (Spring, Hex, call-graph). Other 20 languages: symbol extraction only, no framework detection
- **Generic files**: File-level indexing only (no symbol granularity for unknown formats)
- **Concurrency**: Lock file prevents simultaneous indexing; single-agent use is the typical MCP pattern

