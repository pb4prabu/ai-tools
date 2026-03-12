# Condex MCP

**Local-first MCP server for token-efficient AI code navigation.**

Condex indexes your codebase into a searchable symbol database and exposes it via the [Model Context Protocol](https://modelcontextprotocol.io). Instead of AI agents reading entire source files, they query Condex for precisely the symbols they need — saving 85-92% of context tokens.

```
Without Condex:  Agent reads 12 files     → 80,501 tokens
With Condex:     Agent queries 4 symbols  →  6,588 tokens (91.8% saved)
```

---

## Table of Contents

- [Architecture](#architecture)
- [Packages](#packages)
- [Parsers](#parsers)
- [Search Modes](#search-modes)
- [MCP Tools](#mcp-tools)
- [Confidence Gate](#confidence-gate)
- [Security](#security)
- [Benchmarks](#benchmarks)
- [Configuration](#configuration)
- [Setup](#setup)
- [Known Limitations](#known-limitations)

---

## Architecture

```
AI Agent (Claude, Gemini, etc.)
    │
    ▼  MCP (stdio JSON-RPC)
┌──────────────────────────────────────────┐
│  Condex MCP Server                       │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ 10 Tools   │  │ Retrieval Engine   │  │
│  │ (handlers) │──│ BM25 / Vector / RRF│  │
│  └────────────┘  └────────────────────┘  │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ SQLite     │  │ Confidence Gate    │  │
│  │ (in-memory)│  │ (threshold: 0.12) │  │
│  └────────────┘  └────────────────────┘  │
│  ┌────────────┐  ┌────────────────────┐  │
│  │ SafeFS     │  │ Network Guard      │  │
│  │ (sandbox)  │  │ (3-layer block)    │  │
│  └────────────┘  └────────────────────┘  │
└──────────────────────────────────────────┘
    │
    ▼  File system (read-only)
┌──────────────────────────────────────────┐
│  Your Codebase                           │
│  .condex/index/  (persistent index)      │
└──────────────────────────────────────────┘
```

---

## Packages

This is a monorepo with three packages:

| Package | Purpose | Key Dependencies |
|---------|---------|-----------------|
| **@condex-ai/core** | MCP server, retrieval, storage, security | `@modelcontextprotocol/sdk`, `better-sqlite3`, `sqlite-vec`, `@huggingface/transformers` |
| **@condex-ai/java** | Spring-aware Java parser with architecture detection | `tree-sitter`, `tree-sitter-java`, `js-yaml` |
| **@condex-ai/cli** | CLI for manual indexing and management | `@condex-ai/core`, `@condex-ai/java` |

---

## Parsers

### Java Parser (Primary)

Uses [tree-sitter](https://tree-sitter.github.io/) for AST-based symbol extraction:

- **Symbol kinds**: `class`, `interface`, `method`, `field`, `constant`, `constructor`, `enum`, `annotation_type`
- **Extracted per symbol**: signature, javadoc, annotations, byte offset/length, content hash (SHA256)
- **Qualified names**: `com.app.order.CreateOrderHandler.execute(CreateOrderRequest)`
- **Inner class support**: Nested classes, enums, and anonymous classes
- **Generics**: Full parameterized type extraction

### Spring Framework Detection

Recognizes annotations and assigns roles:

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

Assigns architectural roles based on package/class patterns:

| Role | Pattern Examples |
|------|-----------------|
| `INBOUND_PORT` | `*UseCase`, `*Port` (in `port.in` package) |
| `OUTBOUND_PORT` | `*Repository`, `*Port` (in `port.out` package) |
| `USE_CASE_HANDLER` | `*Handler`, `*Service` (in `application` package) |
| `ADAPTER` | Classes in `adapter` packages |
| `DOMAIN_ENTITY` | Classes in `domain.model` |
| `DOMAIN_EVENT` | `*Event`, `*Created`, `*Updated` |

### Architecture Auto-Detection

Scans directory structure and class patterns to detect:
- **Hexagonal** (ports & adapters)
- **Layered** (controller/service/repository)
- **MVC** (model/view/controller)

### SQL & YAML Parsers

- **SQL**: Extracts table/column schemas from Flyway/Liquibase migration files
- **YAML**: Extracts configuration properties from `application.yml` / `application.properties`

---

## Search Modes

Controlled by `CONDEX_SEARCH_MODE` environment variable:

### BM25 (default)

```
CONDEX_SEARCH_MODE=bm25
```

- **Algorithm**: SQLite FTS5 with Porter stemmer
- **CamelCase splitting**: `CreateOrderHandler` → `create order handler`
- **Dot notation**: `com.app.order` → `com app order`
- **Latency**: 5-50ms
- **Model download**: None required
- **Token savings**: ~91.8%
- **Confidence gate**: Active (threshold 0.12)

Best for: Keyword searches, class/method names, known identifiers.

### Vector

```
CONDEX_SEARCH_MODE=vector
```

- **Model**: `nomic-ai/nomic-embed-text-v1.5` (768 dimensions, ONNX, q8 quantized)
- **Storage**: `sqlite-vec` virtual table
- **Latency**: 1-3s per query (embedding computation)
- **First run**: Downloads ~100MB model to `~/.condex/models/`
- **Startup**: Embeds all symbols into vector index (adds 30-60s)
- **Token savings**: ~47.3% (returns more context)

Best for: Natural language queries, semantic search ("how does payment work?").

### Hybrid (BM25 + Vector + RRF Fusion)

```
CONDEX_SEARCH_MODE=hybrid
```

- **Algorithm**: Reciprocal Rank Fusion (RRF) with k=60
- **Process**: Runs BM25 and vector in parallel, fuses results
- **Boost**: Symbols appearing in both result sets get higher scores
- **Latency**: 2-4s per query
- **Token savings**: ~82.1% (smart mode from benchmark)

Best for: Mixed queries — some keyword, some semantic.

**RRF Formula:**

```
score(symbol) = Σ 1/(k + rank_i) across all result lists
where k = 60
```

Symbols found by both BM25 and vector get scores from both lists summed, boosting them to the top.

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

---

## Confidence Gate

**Philosophy: Silence is safer than wrong context.**

The confidence gate prevents low-quality search results from being injected into AI prompts. Wrong context is worse than no context — the agent can always fall back to reading files directly.

### How It Works

```
1. BM25 search returns ranked results with scores
2. If top score < threshold (0.12) → GATE FIRES
   → Returns: "Results below confidence threshold. Try a more specific query."
   → Agent falls back to normal file reading
3. If top score >= threshold → GATE PASSES
   → Filter out individual results below threshold
   → Return confident results only
```

### Configuration

Default threshold: `0.12`

Override in `.condex/condex.config.json`:
```json
{
  "retrieval": {
    "confidenceThreshold": 0.15
  }
}
```

### When the Gate Fires

- Vague queries: "stuff" → gate fires (no relevant symbols)
- Typos: "creat ordeer" → gate fires (no FTS5 match)
- Out-of-scope: "kubernetes deployment" → gate fires (not in codebase)
- Very common terms: "get" → gate may fire (too many low-confidence matches)

### Gate Behavior by Search Mode

| Mode | Gate Behavior |
|------|--------------|
| BM25 | Active — fires on low BM25 scores |
| Vector | Not applied — vector always returns nearest neighbors |
| Hybrid | BM25 gate on BM25 component; vector results always included |

---

## Security

Condex is designed to be **zero-trust**: no network access, restricted filesystem, sandboxed execution.

### 3-Layer Network Block

#### Layer 1: Environment Variables (Library-level)
```
TRANSFORMERS_OFFLINE=1          — HuggingFace offline mode
HF_HUB_DISABLE_TELEMETRY=1     — Disable telemetry
```

#### Layer 2: Node.js API Monkey-Patch (Process-level)
Patches ALL networking APIs before any code runs:
- `net.Socket.prototype.connect`
- `tls.connect`
- `http.request` / `http.get`
- `https.request` / `https.get`
- `globalThis.fetch`
- `dgram.createSocket`

Any network call throws: `NETWORK_BLOCKED: Condex MCP server does not allow outbound network connections.`

#### Layer 3: OS Sandbox (Kernel-level)
- **macOS**: `sandbox-exec` profile denying `network-outbound`
- **Linux**: `unshare --net` network namespace isolation

### Network Guard by Search Mode

| Mode | Network Guard |
|------|--------------|
| BM25 | **Active** — all outbound blocked |
| Vector | **Disabled** — model download may be needed on first run |
| Hybrid | **Disabled** — same as vector |

After the embedding model is cached locally (`~/.condex/models/`), vector/hybrid modes operate fully offline.

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

# Run full 4-way comparison (BM25, Vector, Hybrid, Smart)
npx tsx benchmark/bench.ts --vector

# Verbose output with per-query details
npx tsx benchmark/bench.ts --vector --verbose
```

### Sample Monorepo

Generated at `benchmark/sample-mono/` — a realistic Spring Boot microservices project:

| Service | Domain | Files |
|---------|--------|-------|
| `order-service` | Order management | ~15 Java files |
| `user-service` | User authentication | ~15 Java files |
| `payment-service` | Payment processing | ~15 Java files |
| `notification-service` | Email/SMS notifications | ~15 Java files |

Includes: domain entities, ports/interfaces, application services, REST controllers, Kafka listeners, infrastructure adapters, SQL migrations, YAML configs.

### Benchmark Results

15 realistic developer queries tested across 4 modes:

| Mode | Tokens | Savings | Gate Fires |
|------|--------|---------|------------|
| **Naive** (no Condex) | 80,501 | 0% | — |
| **BM25** | 6,588 | **91.8%** | 2/15 queries |
| **Hybrid** (BM25+Vector) | 42,436 | 47.3% | 0/15 queries |
| **Smart** (BM25, vector fallback) | 14,439 | **82.1%** | 0/15 queries |

### Results Breakdown

#### BM25 (91.8% savings)
- Best for keyword/identifier queries
- Gate fires on 2/15 vague natural language queries
- Fastest response time (~5-50ms)
- **Recommended for most use cases**

#### Hybrid (47.3% savings)
- Always returns results (no gate)
- Higher token count because vector adds more context
- Better recall for semantic queries
- Slower startup (model download + embedding)

#### Smart Mode (82.1% savings)
- BM25 first, vector fallback only when confidence gate fires
- Best balance of savings + coverage
- Gate fires on 6/15 natural language queries → triggers vector fallback
- **Recommended for mixed query patterns**

### Accuracy Comparison

| Query Type | BM25 Accuracy | Vector Accuracy | Hybrid Accuracy |
|------------|--------------|-----------------|-----------------|
| Exact class/method name | **Excellent** | Good | Excellent |
| Package path (`com.app.order`) | **Excellent** | Moderate | Excellent |
| Natural language ("how does X work?") | Moderate | **Good** | **Good** |
| Architectural ("all REST controllers") | **Excellent** (with filters) | Moderate | Good |
| Typos / misspellings | Poor | **Moderate** | Moderate |
| Cross-cutting concerns | Poor | **Good** | Good |

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

## Configuration

### Environment Variables

| Variable | Values | Default | Purpose |
|----------|--------|---------|---------|
| `CONDEX_SEARCH_MODE` | `bm25` / `vector` / `hybrid` | `bm25` | Search algorithm |

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

### OpenCode Integration

`opencode.json` (in project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "condex-bm25": {
      "type": "local",
      "command": ["node", "/path/to/condex-mcp/packages/condex-core/dist/server.js"],
      "environment": { "CONDEX_SEARCH_MODE": "bm25" },
      "enabled": true
    },
    "condex-vector": {
      "type": "local",
      "command": ["node", "/path/to/condex-mcp/packages/condex-core/dist/server.js"],
      "environment": { "CONDEX_SEARCH_MODE": "vector" },
      "enabled": false
    },
    "condex-hybrid": {
      "type": "local",
      "command": ["node", "/path/to/condex-mcp/packages/condex-core/dist/server.js"],
      "environment": { "CONDEX_SEARCH_MODE": "hybrid" },
      "enabled": false
    }
  }
}
```

### Claude Code Integration

In `~/.claude.json` under `projects.<path>.mcpServers`:

```json
{
  "condex-mcp": {
    "type": "stdio",
    "command": "node",
    "args": ["/path/to/condex-mcp/packages/condex-core/dist/server.js"]
  }
}
```

### Index Directory Structure

```
.condex/
├── index/
│   ├── meta.json          # Project metadata + file hashes
│   └── *.json             # Symbol files (one per symbol)
├── condex.config.json     # Optional project config
├── savings.json           # Token savings tracker
└── .indexing.lock          # Lock file (during indexing)
```

---

## Setup

### Prerequisites

- Node.js >= 18
- npm >= 9

### Build

```bash
git clone <repo>
cd condex-mcp
npm install
npm run build
```

### Run Tests

```bash
npm test                    # All 108 tests
npx vitest run --reporter=verbose  # Verbose output
```

### Start Server (standalone)

```bash
cd /path/to/your/project
node /path/to/condex-mcp/packages/condex-core/dist/server.js
```

The server:
1. Detects project root from `process.cwd()`
2. Loads existing index from `.condex/index/` (or runs full index if Java parser available)
3. Starts MCP stdio transport
4. Logs to stderr (visible in AI agent diagnostics)

### First Run Behavior

| Scenario | Behavior |
|----------|----------|
| No `.condex/index/` + Java parser available | Full index (3-8s for ~800 files) |
| No `.condex/index/` + no Java parser | Error: "No parser available and no existing index" |
| `.condex/index/` exists | Load from disk (~1s for ~2700 symbols) |
| Vector/Hybrid mode, first run | Downloads embedding model (~100MB) + builds vector index |

---

## Known Limitations

### Index Staleness
- Symbol byte offsets are valid at index time only
- If source files change after indexing, offsets may be wrong
- **Mitigation**: Content hash verification in `get_symbol` — warns if mismatch detected
- **Fix**: Run `index_folder` to re-index after major changes

### FTS5 Tokenization
- Porter stemmer may over-stem some terms
- Exact phrase matching requires specific query formatting
- CamelCase splitting is heuristic-based

### No Type-Aware Ranking
- BM25 searches all text fields equally (name, signature, javadoc)
- Cannot weight "class name matches" higher than "javadoc mentions"
- Vector search partially addresses this via semantic similarity

### Hexagonal Role Detection
- Pattern-matching heuristic, not architectural validation
- Accuracy: ~75-85% on projects following naming conventions
- Can be fooled by misleading class/package names

### No Inheritance Traversal
- Does not follow `extends`/`implements` chains
- Parent class methods not included when querying a subclass
- Reasoning about relationships left to the AI agent

### Spring Detection Scope
- Core Spring Framework annotations only
- No custom stereotype detection
- No Spring Boot auto-configuration awareness

### Static Confidence Threshold
- Threshold (0.12) is not adaptive
- No learning from user corrections
- May need manual tuning per project via config

### Concurrency
- Lock file prevents simultaneous indexing
- Concurrent reads during indexing may return partial results
- Not a concern for single-agent use (typical MCP pattern)

### Vector Mode Limitations
- First model download requires network access (~100MB)
- CPU-only inference (no GPU acceleration)
- Embedding all symbols adds 30-60s to startup
- No incremental vector updates — full rebuild on re-index

### Language Support
- **Java**: Full support (tree-sitter parser, Spring/Hex detection)
- **TypeScript/Python**: Planned, not yet implemented
- **SQL**: Schema extraction from migrations only
- **YAML**: Configuration extraction only

---

## How It Works: End-to-End Flow

```
1. AI Agent asks: "How does order creation work?"

2. Agent calls: search_symbols(query="order creation")

3. Condex MCP:
   a. Sanitize query → "order creation"
   b. FTS5 search → [CreateOrderHandler (0.85), OrderService (0.72), ...]
   c. Confidence gate → passes (0.85 > 0.12)
   d. Return 4 symbols with signatures (312 tokens)

4. Agent calls: get_symbol(symbolId="...CreateOrderHandler...")

5. Condex MCP:
   a. Look up byte offset in SQLite
   b. Read 847 bytes from source file
   c. Verify content hash → match
   d. Return source code (180 tokens)

6. Agent now has precise context (492 tokens total)
   vs. reading 12 files naively (2847 tokens)
   → 82.7% savings
```

---

## License

Private — all rights reserved.
