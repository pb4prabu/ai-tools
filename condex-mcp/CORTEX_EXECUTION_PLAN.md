# Condex MCP — Execution Plan & Status Tracker

> This is the working execution plan. Each phase is broken into atomic tasks.
> Status: `[ ]` pending | `[~]` in progress | `[x]` done | `[!]` blocked

---

## Gaps & Improvements Found in Original Plan

### Critical Fixes

1. **`@xenova/transformers` is deprecated** → replaced by `@huggingface/transformers` (Transformers.js v3). Must use v3 API.

2. **MCP SDK handler registration** — Plan uses `server.setRequestHandler('tools/list', ...)` but SDK uses `server.setRequestHandler(ListToolsRequestSchema, ...)`. Must use schema-based registration.

3. **`nomic-embed-code-v1.5` doesn't exist** — The actual model is `nomic-ai/nomic-embed-text-v1.5` (works well for code too). Or consider `Xenova/all-MiniLM-L6-v2` as a lighter fallback (384 dims, well-tested).

4. **Index path inconsistency** — `server.ts` loads from `~/.condex/indexes/` but the filesystem layout stores in `{project}/.condex/index/`. Resolution: indexes live INSIDE the project at `.condex/index/`. The server discovers projects by receiving paths via tool calls. No central `~/.condex/indexes/` directory.

**DESIGN SIMPLIFICATION (user decision):**
- **Project root = `process.cwd()`**. When OpenCode/Claude Code starts Condex as a child process, CWD is inherited. That's the project root. No config, no env vars, no arguments needed.
- **No root-detector walking.** CWD is the root. Period.
- Parent and child are completely separate projects with separate namespaces.
- When scanning files for indexing, **skip any `.condex/` subdirectories** — a child project's index is invisible to the parent.
- No scope bias, no marker priority walking, no parent/child conflict resolution needed.

**ZERO-CONFIG INTEGRATION (user decision):**
- **One-time setup**: Add Condex to OpenCode/Claude Code global MCP config (not per-project).
- **Every session**: User opens OpenCode in any folder → Condex auto-starts, auto-indexes, tools ready.
- **No per-project config required**. `.condex/condex.config.json` is optional (for overrides like `vectorSearch: true`, custom include/exclude globs). Without it, Condex auto-detects language and uses sensible defaults.
- OpenCode MCP config (do once):
  ```json
  {
    "mcpServers": {
      "condex": {
        "type": "stdio",
        "command": "condex-mcp"
      }
    }
  }
  ```

**AUTO-INDEX ON STARTUP + ON QUERY (user decision):**
- **On MCP server startup**: Condex immediately indexes from CWD so tools are ready before the AI's first query.
  1. `.condex/index/meta.json` exists? → incremental index (~50ms if nothing changed)
  2. No `.condex/` at all? → full index from scratch (~3-8s), creates `.condex/`
- **On every tool call**: Runs quick incremental check before answering (~50ms overhead). Picks up code changes automatically.
- `index_folder` tool still exists for force re-index, but it's rarely needed.
- The AI model NEVER needs to think about indexing — it just calls `search_symbols` and gets results.

**VECTOR SEARCH IS OPT-IN VIA CONFIG FLAG (user decision):**
- Default: BM25 only (FTS5). Zero downloads, 100% local, works out of the box.
- If `condex.config.json` has `"vectorSearch": true` → enable hybrid BM25 + vector search.
- When enabled: downloads `nomic-ai/nomic-embed-text-v1.5` (~30MB) on first use, cached at `~/.condex/models/`. All inference is local (ONNX on CPU). No data ever leaves the machine.
- Config in `.condex/condex.config.json`:
  ```json
  {
    "vectorSearch": false,  // default: BM25 only
    ...
  }
  ```
- When `vectorSearch: true`:
  - `index_folder` also generates embeddings → writes `vectors.jsonl`
  - `search_symbols` runs BM25 + vector in parallel → fuses with RRF
  - `sqlite-vec` loaded as SQLite extension
- When `vectorSearch: false` (default):
  - No model download, no vectors.jsonl, no sqlite-vec, no RRF
  - Pure BM25 search (~85-90% token savings, still excellent for code)

5. **`SavingsTracker` naming collision** — Class has both `this.record` (data) and `record()` (method). Rename method to `trackSaving()`.

6. **Missing tool: `search_config`** — Referenced in Day 6 timeline but not in the 10 tool definitions. Either add it as tool #11 or fold it into `get_context_for_task`. Decision: fold into `get_context_for_task` for v1. Keep 10 tools.

7. **`get_symbol` byte offset staleness** — Tool reads source file using stored byte offsets. If source changes after indexing, offsets are wrong. Fix: verify `contentHash` of the byte range against stored hash. If mismatch, return a warning + full method via fallback line-based extraction.

### Design Improvements

8. **Symbol file naming** — Fully qualified Java names as filenames can exceed 260-char Windows path limits. Fix: use sha256(symbolId).json instead. Store symbolId inside the JSON.

9. **No concurrency control** — Two simultaneous `index_folder` calls can corrupt the index. Fix: use a simple lockfile (`.condex/.indexing.lock`) with PID + timestamp. Stale lock (>5 min) auto-clears.

10. **No file watching** — Not needed. Auto-incremental-index on every query handles this. Changed files detected via hash comparison.

11. **Error handling** — tree-sitter can fail on malformed Java. Wrap per-file parsing in try/catch, log warning, continue. Never let one bad file kill the index.

12. **`vectors.jsonl` not needed for v1** — Vector search deferred to v2. Remove vectors.jsonl from filesystem layout.

13. **FTS5 tokenizer and Java qualified names** — `porter unicode61` splits on dots, so `com.app.order.CreateOrderHandler` becomes `com`, `app`, `order`, `createorderhandl` (porter-stemmed). This is actually GOOD — lets you search for partial package paths. But exact qualified name search needs quoting. Add a helper to detect and quote dotted names in queries.

14. **tree-sitter choice** — Stick with native `tree-sitter` (not `web-tree-sitter`). Native is significantly faster for Node.js. The plan's choice is correct.

15. **`tiktoken` package** — The npm package is `tiktoken` (from OpenAI) or `js-tiktoken`. Both work. Use `js-tiktoken` — pure JS, no WASM, lighter. Good enough for estimation.

### Scope Decision

16. **Start with TypeScript parser alongside Java** — We're writing the tool in TypeScript, so we can dogfood it immediately. Add a minimal TS parser in Phase 4b. This lets us test against Condex's own codebase.

17. **100% local — zero external API calls, zero network calls at runtime** — no telemetry, no cloud anything. Every byte stays on the machine.

18. **3-LAYER OUTBOUND NETWORK BLOCK (user decision — security guarantee):**
    Only the Condex MCP server process is blocked. All other processes on the machine are unaffected.

    **Layer 1 — Environment Variables (library-level):**
    - `TRANSFORMERS_OFFLINE=1` — forces `@huggingface/transformers` into offline mode, no network attempts
    - `HF_HUB_DISABLE_TELEMETRY=1` — disables HuggingFace analytics/telemetry
    - Set programmatically in `server.ts` before any imports

    **Layer 2 — Node.js Network Kill (process-level, in-code):**
    - Monkey-patches ALL networking APIs: `net.Socket.connect`, `tls.connect`, `http.request`, `https.request`, `http.get`, `https.get`, `globalThis.fetch`, `dgram.createSocket`
    - Called as FIRST thing in `server.ts`, before any other code runs
    - Every npm package (including transitive deps) goes through these APIs — no JS-level escape possible

    **Layer 3 — OS Sandbox (process-level, kernel-enforced):**
    - MCP config launches server via `sandbox-exec` (macOS) or `unshare --net` (Linux)
    - Blocks outbound network at the OS kernel level for THIS process only
    - Even native C++ addons (like ONNX Runtime) cannot bypass this
    - All other apps, MCP servers, browser, terminal — completely unaffected
    - MCP config example:
      ```json
      {
        "mcpServers": {
          "condex": {
            "type": "stdio",
            "command": "sandbox-exec",
            "args": ["-p", "(version 1)(allow default)(deny network-outbound)", "node", "dist/server.js"]
          }
        }
      }
      ```

    **Model download is separate:**
    - `condex setup --vector` CLI command downloads model (runs WITHOUT sandbox, network allowed)
    - MCP server never downloads anything — if model missing, throws error: "Run `condex setup --vector` first"

    **Summary:** 3 independent layers. Even if one fails, the others catch it. The MCP server process physically cannot make outbound connections.

19. **FILESYSTEM ACCESS RESTRICTED TO PROJECT ROOT ONLY (user decision — security guarantee):**
    The MCP server can ONLY access the project folder it's working on. Nothing else on the machine.

    **Layer 1 — Application-level SafeFS guard (in-code):**
    - All filesystem operations in Condex go through `SafeFS` wrapper
    - `SafeFS` validates every path is within `projectRoot` (reads) or `projectRoot/.condex` (writes)
    - Any access outside project root → throws `Error('FS_BLOCKED: Access denied outside project root')`
    - This catches all our code + any code path we control

    **Layer 2 — sandbox-exec filesystem restrictions (OS-level, macOS):**
    - Extend the sandbox profile to restrict file-write to ONLY `{projectRoot}/.condex/` + system temp
    - Combined with network block in one profile:
      ```
      (version 1)
      (allow default)
      (deny network-outbound)
      (deny file-write* (subpath "/"))
      (allow file-write* (subpath "{projectRoot}/.condex"))
      (allow file-write* (subpath "/private/tmp"))
      (allow file-write* (literal "/dev/null"))
      ```
    - Even native C++ addons cannot write outside the project

    **Layer 3 — Node.js --experimental-permission (optional, strictest reads):**
    - Restricts even READ access to only specified paths:
      ```bash
      node --experimental-permission \
           --allow-fs-read="${PROJECT_ROOT}" \
           --allow-fs-write="${PROJECT_ROOT}/.condex" \
           --allow-fs-read="${HOME}/.condex/models" \
           dist/server.js
      ```
    - Node.js requires its own runtime paths — the launcher script auto-detects and adds them
    - This is the strictest option but may need path tuning per system

    **MCP config (simple — CWD is inherited automatically):**
    ```json
    {
      "mcpServers": {
        "condex": {
          "type": "stdio",
          "command": "condex-mcp"
        }
      }
    }
    ```
    The `condex-mcp` launcher script:
    1. Reads `process.cwd()` as project root
    2. Sets env vars (Layer 1: TRANSFORMERS_OFFLINE, HF_HUB_DISABLE_TELEMETRY)
    3. Applies `blockOutboundNetwork()` (Layer 2: Node.js network kill)
    4. Initializes `SafeFS` with CWD as root (Layer 1: filesystem guard)
    5. On macOS: wraps with `sandbox-exec` (Layer 3: OS-level network + fs block)
    6. Starts MCP server

    **What CAN be accessed:**
    - ✅ `{projectRoot}/**` — read source files for parsing
    - ✅ `{projectRoot}/.condex/**` — read/write index
    - ✅ `~/.condex/models/` — read cached embedding model (vector mode only)
    - ✅ Node.js runtime paths — required for process to run

    **What CANNOT be accessed:**
    - ❌ Any other folder on the machine
    - ❌ Home directory (except ~/.condex/models/)
    - ❌ SSH keys, .env files, credentials, other projects
    - ❌ System files, other users' data
    - ❌ Any network endpoint

---

## Phase 0: Project Scaffold
**Goal**: Monorepo boots, TypeScript compiles, tests run.

- [ ] 0.1 — `git init` in Dev-Tools, create root `package.json` with npm workspaces
- [ ] 0.2 — Create `tsconfig.base.json` (target ES2022, module NodeNext, strict)
- [ ] 0.3 — Create `packages/condex-core/` with `package.json`, `tsconfig.json`, `src/` dir
- [ ] 0.4 — Create `packages/condex-java/` with `package.json`, `tsconfig.json`, `src/` dir
- [ ] 0.5 — Create `packages/condex-cli/` with `package.json`, `tsconfig.json`, `src/` dir
- [ ] 0.6 — Install shared dev deps: `typescript`, `tsx`, `vitest` at root
- [ ] 0.7 — Verify: `npm run build` compiles all packages, `npm test` runs (empty test passes)
- [ ] 0.8 — Create `.gitignore` (node_modules, dist, *.db, .condex/*.db, savings.json)
- [ ] 0.9 — Implement `condex-core/src/security/network-guard.ts`
  - **Layer 1**: Set `process.env.TRANSFORMERS_OFFLINE = '1'` and `process.env.HF_HUB_DISABLE_TELEMETRY = '1'`
  - **Layer 2**: `blockOutboundNetwork()` — monkey-patches ALL Node.js networking APIs:
    - `net.Socket.prototype.connect` (all TCP)
    - `tls.connect` (all TLS/SSL)
    - `http.request`, `http.get` (all HTTP)
    - `https.request`, `https.get` (all HTTPS)
    - `globalThis.fetch` (Fetch API)
    - `dgram.createSocket` (UDP)
    - All patched to throw `Error('NETWORK_BLOCKED: Condex does not allow outbound connections')`
  - Called as FIRST thing in server.ts, before any other import
  - Only affects THIS process — all other apps on machine are unaffected
- [ ] 0.10 — Implement `condex-core/src/security/fs-guard.ts`
  - `SafeFS` class wrapping `node:fs` operations
  - Constructor takes `projectRoot` — all operations validated against this root
  - `assertPathAllowed(targetPath)` — resolves to absolute, checks starts with projectRoot
  - `safeReadFile(path)`, `safeWriteFile(path, data)`, `safeReaddir(path)`, `safeStat(path)`
  - Writes restricted to `{projectRoot}/.condex/` only
  - Reads restricted to `{projectRoot}/` only
  - Any violation throws `Error('FS_BLOCKED: Access denied outside project root')`
  - All file operations in Condex use SafeFS instead of raw `fs` module
- [ ] 0.11 — Implement `condex-core/src/security/sandbox-profile.ts`
  - `generateSandboxProfile(projectRoot)` — generates macOS sandbox-exec profile string
  - Combines network block + filesystem write restrictions
  - `generateLaunchCommand(projectRoot)` — returns full sandbox-exec + node command
- [ ] 0.12 — Implement `condex-mcp` launcher script (bin entry)
  - Uses `process.cwd()` as project root (inherited from OpenCode/Claude Code)
  - On macOS: wraps with `sandbox-exec` profile (network + fs restrictions for CWD)
  - On Linux: wraps with `unshare --net` (network restriction)
  - Falls back to Node.js-only guards if sandbox tools not available
- [ ] 0.13 — Copy original plan to `docs/CONDEX_MCP_PLAN.md` for reference
- [ ] 0.10 — Copy original plan to `docs/CONDEX_MCP_PLAN.md` for reference

**Deliverable**: Clean monorepo, builds, tests run.

---

## Phase 1: Types & Interfaces
**Goal**: All shared types defined. No implementation yet.

- [ ] 1.1 — Create `condex-core/src/types/symbol.ts` — Symbol, SymbolKind, SpringRole, HexRole types
- [ ] 1.2 — Create `condex-core/src/types/parser.ts` — CoreParser interface, ParseResult, ProjectProfile
- [ ] 1.3 — Create `condex-core/src/types/schema.ts` — SchemaSymbol, ConfigSymbol types
- [ ] 1.4 — Create `condex-core/src/types/retrieval.ts` — BM25Result, VectorResult, FusedResult, GateResult, SearchFilters
- [ ] 1.5 — Create `condex-core/src/types/config.ts` — CondexConfig type (no RootDetectionResult needed — path IS root)
- [ ] 1.6 — Create `condex-core/src/types/meta.ts` — CondexMeta response envelope type
- [ ] 1.7 — Create `condex-core/src/types/index.ts` — barrel export all types
- [ ] 1.8 — Write basic type tests (vitest type-checking)

**Deliverable**: All interfaces defined, importable from `@condex-ai/core`.

---

## Phase 2: Namespace System
**Goal**: Given a folder path, generate a stable, unique namespace. No walking up — the given path IS the root.

- [ ] 2.1 — Implement `condex-core/src/namespace/namespace.ts`
  - `generateNamespace(rootPath)` → `projectName@sha256(absolutePath)[0:6]`
  - `getProjectRoot()` → returns `process.cwd()` resolved to absolute path. That's the root. No args needed.
- [ ] 2.2 — Tests: namespace determinism (same path → same namespace), uniqueness (different paths → different namespaces), parent vs child paths produce different namespaces

**Deliverable**: `generateNamespace('/path/to/myapp')` → `myapp@a3f9c2`. Simple, deterministic, no ambiguity.

---

## Phase 3: Filesystem Store
**Goal**: Read/write `.condex/index/` directory structure.

- [ ] 3.1 — Implement `condex-core/src/store/fs-store.ts`
  - Uses `SafeFS` for ALL file operations — never uses raw `fs` module
  - `initCondexDir(projectRoot)` — creates `.condex/index/symbols/`, `.condex/index/schema/`, `.condex/index/config/`, `.condex/.gitignore`
  - All file scanning functions **always exclude `.condex/` directories** — child project indexes are invisible to parent
  - `writeSymbolFile(indexDir, symbol)` — writes sha256(id).json
  - `readSymbolFiles(indexDir)` → Symbol[]
  - `removeSymbolFilesForSource(indexDir, sourceFilePath)` — deletes symbols from a given source file
  - `writeMeta(indexDir, meta)` / `readMeta(indexDir)`
  - `writeCondexConfig(projectRoot, config)` / `readCondexConfig(projectRoot)`
- [ ] 3.2 — Implement lockfile mechanism
  - `acquireIndexLock(projectRoot)` — creates `.condex/.indexing.lock` with PID + timestamp
  - `releaseIndexLock(projectRoot)`
  - Stale lock (>5 min) auto-clears
- [ ] 3.3 — Tests: write/read round-trip, concurrent lock detection

**Deliverable**: Can persist and reload full index from filesystem.

---

## Phase 4: SQLite Store + Loader
**Goal**: Create SQLite schema, load filesystem data into it.

- [ ] 4.1 — Install deps: `better-sqlite3`, `@types/better-sqlite3`
- [ ] 4.2 — Implement `condex-core/src/store/sqlite-store.ts`
  - `createSchema(db)` — all tables (projects, symbols, symbols_fts, schema_symbols, schema_fts, config_symbols, config_fts) + indexes + FTS triggers
  - `insertProject(db, project)`
  - `insertSymbols(db, symbols)` — bulk insert in transaction
  - `insertSchemaSymbols(db, schemas)`
  - `insertConfigSymbols(db, configs)`
  - `getSymbolById(db, id)` → Symbol
  - `getSymbolsByIds(db, ids)` → Symbol[]
  - `getSymbolsByFile(db, projectId, filePath)` → Symbol[]
  - `getProjectOutline(db, projectId)` → outline data
- [ ] 4.3 — Implement `condex-core/src/store/loader.ts`
  - `loadProject(db, projectRoot)` — reads .condex/index/, inserts into SQLite
  - `loadProjectFromDir(db, condexDir)` — lower-level loader
- [ ] 4.4 — Tests: schema creation, CRUD, FTS works, loader round-trip

**Deliverable**: `loadProject(db, '/path/to/project')` loads all data into SQLite.

---

## Phase 5: BM25 Search + Confidence Gate
**Goal**: Text search works end-to-end.

- [ ] 5.1 — Implement `condex-core/src/retrieval/bm25.ts`
  - `buildBM25Query(query, projectId, filters?)` → { sql, params }
  - Handle dotted names (detect and quote for exact match)
  - Sanitize FTS5 special chars
- [ ] 5.2 — Implement `condex-core/src/retrieval/confidence-gate.ts`
  - `applyConfidenceGate(fused, threshold)` → GateResult
- [ ] 5.3 — Tests: BM25 queries against test data, confidence gate behavior

**Deliverable**: BM25 search returns ranked results, gate filters low-confidence.

---

## Phase 6: MCP Server Shell + Basic Tools
**Goal**: Server starts via stdio, responds to tool/list and tool/call.

- [ ] 6.1 — Install MCP SDK: `@modelcontextprotocol/sdk`
- [ ] 6.2 — Implement `condex-core/src/server.ts`
  - **Line 1**: `import { blockOutboundNetwork } from './security/network-guard.js'`
  - **Line 2**: `blockOutboundNetwork()` — BEFORE any other imports or code
  - **Line 3**: `projectRoot = process.cwd()` — CWD inherited from OpenCode/Claude Code
  - **Line 4**: Initialize `SafeFS(projectRoot)` — all file ops restricted to project root
  - Create Server with stdio transport
  - Register `ListToolsRequestSchema` handler → return all tool definitions
  - Register `CallToolRequestSchema` handler → dispatch to tool handlers
  - **On startup (before accepting tool calls):**
    1. Auto-detect language from file extensions in CWD
    2. Run index: `.condex/` exists → incremental | missing → full index
    3. Load index into in-memory SQLite
    4. Log: "Condex ready: {symbolCount} symbols, {architecture}, indexed in {ms}ms"
- [ ] 6.3 — Implement `condex-core/src/mcp/tools.ts` — all 10 tool definitions (schema only)
- [ ] 6.4 — Implement `condex-core/src/mcp/dispatcher.ts` — routes tool name to handler function
- [ ] 6.5 — Implement `condex-core/src/mcp/meta.ts` — `buildMeta()` helper for _meta envelope
- [ ] 6.6 — Implement auto-index middleware
  - Before any query tool runs, call `ensureIndex(projectRoot, db)`
  - `ensureIndex` checks `.condex/index/meta.json`:
    - Exists → run incremental (compare hashes, re-parse changed files only)
    - Missing → run full index, create `.condex/`
  - Cache loaded projects in memory — don't reload unchanged projects
- [ ] 6.7 — Implement tool handlers (BM25 only):
  - `list_projects` — query projects table
  - `get_project_outline` — aggregate symbols by package/kind
  - `get_file_outline` — list symbols in a file (signatures only)
  - `search_symbols` — BM25 search + confidence gate
  - `get_symbol` — read source file at byte offset, verify contentHash
  - `get_symbols` — batch version of get_symbol
  - `index_folder` — explicit force re-index (rarely needed, auto-index handles normal use)
  - `invalidate_cache` — delete .condex/index/ for project
- [ ] 6.8 — Tests: server startup, tool listing, basic search against fixture data
- [ ] 6.9 — Manual test: configure in Claude Code / OpenCode MCP config, verify tools appear

**Deliverable**: Working MCP server with BM25-only search. Tools usable from an AI agent.

---

## Phase 7: Java Parser (condex-java)
**Goal**: Parse Java files, extract symbols with Spring/hex annotations.

- [ ] 7.1 — Install deps: `tree-sitter`, `tree-sitter-java`, `js-yaml`
- [ ] 7.2 — Implement `condex-java/src/parser/java-parser.ts`
  - `parseJavaFile(filePath, content, projectId, profile)` → Symbol[]
  - Extract: class, interface, method, field, enum, constructor, annotation_type
  - Extract: javadoc (comment before declaration)
  - Extract: annotations, modifiers, parameters, return type, throws
  - Build qualified name from package + class + method
  - Error handling: try/catch per file, log + skip on failure
- [ ] 7.3 — Implement `condex-java/src/parser/spring-tagger.ts`
  - `assignSpringRole(symbol, annotations)` → SpringRole
  - Map: @RestController, @Controller, @Service, @Repository, @Component, @Configuration, @Entity, @EventListener, @Scheduled
- [ ] 7.4 — Implement `condex-java/src/parser/arch-detector.ts`
  - `detectArchitecture(filePaths)` → ProjectProfile
  - Hexagonal signals: /application/, /domain/, /infrastructure/, Handler/Port/Adapter/UseCase suffixes
  - Layered signals: /service/, /repository/, /controller/
  - MVC signals: /model/, /view/
- [ ] 7.5 — Implement `condex-java/src/parser/hex-role-tagger.ts`
  - `assignHexRole(symbol, profile)` → HexRole
  - Only active when architecture === 'hexagonal'
- [ ] 7.6 — Implement `condex-java/src/index.ts` — export JavaParser implementing CoreParser
- [ ] 7.7 — Implement `index_folder` tool handler in condex-core
  - The given path IS the project root — no walking up
  - Detect language from config or file extensions
  - Load appropriate parser (condex-java for .java files)
  - Parse all files matching include globs, **always exclude `**/.condex/**`** (hardcoded, non-overridable)
  - Write symbol files to .condex/index/symbols/
  - Write meta.json
  - Detect architecture
  - Support incremental mode (compare fileHashes)
- [ ] 7.8 — Tests: parse sample Java files, verify symbol extraction accuracy
- [ ] 7.9 — Tests: Spring role tagging, architecture detection, hex role assignment
- [ ] 7.10 — Integration test: `index_folder` on a sample Java project fixture

**Deliverable**: `condex index .` works on a Java project. Symbols correctly extracted + tagged.

---

## Phase 8: Token Tracking + _meta Envelope
**Goal**: Every tool response includes accurate token savings data.

- [ ] 8.1 — Install dep: `js-tiktoken`
- [ ] 8.2 — Implement `condex-core/src/token/counter.ts`
  - `countTokens(text)` using cl100k_base tokenizer
- [ ] 8.3 — Implement `condex-core/src/token/savings.ts`
  - `SavingsTracker` class (renamed method: `trackSaving()`)
  - Persist to `.condex/savings.json`
  - `estimateNaiveTokens(matchedSymbols, db)` — sum byte_length of unique source files / 4
- [ ] 8.4 — Wire _meta into all tool responses
  - timingMs, tokensInResponse, tokensIfNaive, tokensSaved, percentages
  - Session + all-time cumulative counters
- [ ] 8.5 — Tests: token counting, naive estimate, savings tracking

**Deliverable**: Every tool response has _meta with real token savings.

---

## Phase 9: Vector Search — Opt-in (`vectorSearch: true`)
**Goal**: When config flag is enabled, add hybrid BM25 + vector search. All local, no external APIs.

- [ ] 9.1 — Install deps as **optional peer dependencies**: `@huggingface/transformers`, `sqlite-vec`
- [ ] 9.2 — Implement `condex-core/src/embeddings/local-embed.ts`
  - Use `@huggingface/transformers` v3 API (pipeline, feature-extraction)
  - Model: `nomic-ai/nomic-embed-text-v1.5` (quantized, ~30MB, cached at `~/.condex/models/`)
  - All inference local — ONNX on CPU, zero network calls (network is blocked at process level)
  - `prepareSymbolText(symbol)` — concatenate signature + javadoc + annotations
  - `getEmbedder()` → singleton Embedder { embed(text), dimensions: 384 }
  - Guard: if model not downloaded → throw error: "Run `condex setup --vector` first"
  - Guard: if deps not installed or config flag false → skip gracefully
- [ ] 9.3 — Add vector generation to `index_folder` (conditional on `vectorSearch: true`)
  - After parsing symbols, generate embeddings → write `vectors.jsonl`
  - Skip entirely when flag is false
- [ ] 9.4 — Add sqlite-vec setup to SQLite store (conditional)
  - `loadVec(db)` only when vector search enabled
  - Create `symbol_vectors` virtual table
  - Load vectors.jsonl into sqlite-vec on project load
- [ ] 9.5 — Implement `condex-core/src/retrieval/vector-search.ts`
  - `vectorSearch(queryText, projectId, db, embedder, topK)` → VectorResult[]
  - Over-fetch 3x and filter by projectId in application layer
- [ ] 9.6 — Implement `condex-core/src/retrieval/rrf-fusion.ts`
  - `rrfFusion(bm25Results, vectorResults)` → FusedResult[]
  - RRF_K = 60
- [ ] 9.7 — Wire into `search_symbols` conditionally
  - Config `vectorSearch: true` → run BM25 + vector in parallel, fuse with RRF
  - Config `vectorSearch: false` → BM25 only (existing behavior unchanged)
- [ ] 9.8 — Tests: vector search, RRF fusion, config flag toggling

**Deliverable**: `"vectorSearch": true` in config → hybrid search. `false` → BM25 only. Both paths tested.

---

## Phase 10: Multi-Source Parsers + get_context_for_task
**Goal**: SQL migrations and YAML config indexed. Task-oriented context assembly.

- [ ] 10.1 — Implement `condex-java/src/sources/sql-parser.ts`
  - Parse Flyway/Liquibase SQL files
  - Extract CREATE TABLE, ALTER TABLE → SchemaSymbol[]
  - Handle column names, types, constraints
- [ ] 10.2 — Implement `condex-java/src/sources/yaml-parser.ts`
  - Parse application.yml / application-{profile}.yml
  - Flatten to dot-notation key paths → ConfigSymbol[]
  - Track profile association
- [ ] 10.3 — Wire SQL + YAML parsing into `index_folder` tool
- [ ] 10.4 — Implement `search_schema` tool handler
  - FTS5 search on schema_fts table
- [ ] 10.5 — Implement `get_context_for_task` tool handler
  - Accept natural language task description
  - Search symbols + schema + config simultaneously
  - Apply token budget (default 2000)
  - Assemble compact context block: signatures, relevant schema, config keys
  - Return within budget, prioritize by BM25 score (or RRF if vector enabled)
- [ ] 10.6 — Tests: SQL parsing, YAML parsing, context assembly within token budget

**Deliverable**: `get_context_for_task("change how orders are saved")` returns symbols + schema in <2000 tokens.

---

## Phase 11: CLI (condex-cli)
**Goal**: Global CLI for manual index management.

- [ ] 11.1 — Implement `condex-cli/src/cli.ts`
  - `condex index [path]` — triggers index_folder (auto-detect language, incremental default)
  - `condex index [path] --full` — force full re-index
  - `condex index [path] --language java`
  - `condex list` — list all indexed projects (scan home dir for .condex/)
  - `condex status` — current project index stats
  - `condex invalidate [path]` — remove index
  - `condex setup --vector` — downloads embedding model to `~/.condex/models/` (ONLY command with network access, does NOT call blockOutboundNetwork)
- [ ] 11.2 — Add shebang + bin entry in package.json
- [ ] 11.3 — Tests: CLI argument parsing, command routing

**Deliverable**: `condex index .` works from terminal.

---

## Phase 12: Integration Testing + Polish
**Goal**: End-to-end tested, edge cases handled.

- [ ] 12.1 — Create test fixtures: sample Java project with Spring Boot structure
- [ ] 12.2 — End-to-end test: index → search → get_symbol → verify source matches
- [ ] 12.3 — Edge case: empty project, no Java files
- [ ] 12.4 — Edge case: malformed Java file (tree-sitter partial parse)
- [ ] 12.5 — Edge case: very long class names (verify sha256 filename works)
- [ ] 12.6 — Edge case: concurrent index attempts (lockfile works)
- [ ] 12.7 — Edge case: stale byte offsets (source changed, contentHash mismatch)
- [ ] 12.8 — Edge case: `vectorSearch: true` vs `false` — both paths work correctly
- [ ] 12.9 — Security test: verify network guard blocks outbound HTTP/TCP/fetch calls
- [ ] 12.10 — Security test: verify SafeFS blocks reads/writes outside project root
- [ ] 12.11 — Security test: verify sandbox-exec profile works (macOS)
- [ ] 12.12 — Performance test: index 1000+ file project, measure time
- [ ] 12.13 — MCP integration test: configure in Claude Code, run real queries

**Deliverable**: Robust, tested, ready for real use.

---

## Phase 13: Documentation + Benchmarks
**Goal**: README with real benchmarks.

- [ ] 13.1 — Run benchmark: 20 queries on a real Java project, measure token savings
- [ ] 13.2 — Fill in benchmark table with real numbers (BM25 only + hybrid with vector)
- [ ] 13.3 — Write README.md with setup, config (including `vectorSearch` flag), benchmark results
- [ ] 13.4 — Document MCP config for Claude Code, OpenCode, Cursor

**Deliverable**: Published, documented, benchmarked.

---

## Dependency Graph

```
Phase 0 (Scaffold)
  └── Phase 1 (Types)
       └── Phase 2 (Namespace — trivial, just hash)
            └── Phase 3 (FS Store)
                 └── Phase 4 (SQLite + Loader)
                      ├── Phase 5 (BM25 + Confidence Gate)
                      │    └── Phase 6 (MCP Server + Auto-Index + Tools)
                      │         └── Phase 7 (Java Parser + index_folder)
                      │              └── Phase 8 (Token Tracking + _meta)
                      │                   └── Phase 9 (Vector Search — opt-in via config flag)
                      │                        └── Phase 10 (Multi-Source + Context)
                      │                             └── Phase 11 (CLI)
                      │                                  └── Phase 12 (Integration Tests)
                      │                                       └── Phase 13 (Docs + Benchmarks)
                      └── (Phase 4 & 5 can be developed in parallel)

Note: After Phase 8, core is fully working (BM25 search + token savings).
      Phase 9 adds opt-in vector search. Phases 10+ are enhancements.
```

## Isolation Rules (Final)

```
Rule 1: Project root = process.cwd() (inherited from OpenCode/Claude Code). No config needed.
Rule 2: Index lives at {projectRoot}/.condex/index/
Rule 3: Namespace = folderName@sha256(absolutePath)[0:6]
Rule 4: When scanning files, ALWAYS skip **/.condex/** (hardcoded)
Rule 5: Parent project never sees child's .condex/ — they are invisible to each other
Rule 6: Auto-index on startup + incremental on every query
Rule 7: One-time global MCP config — works in any folder automatically
```

---

## Technology Stack (Validated)

| Component | Package | Version | Notes |
|---|---|---|---|
| MCP SDK | `@modelcontextprotocol/sdk` | ^1.x | Use schema-based handlers |
| SQLite | `better-sqlite3` | ^11.x | Native, fast |
| FTS5 | Built into SQLite | - | porter unicode61 tokenizer |
| Tree-sitter | `tree-sitter` + `tree-sitter-java` | ^0.22.x | Native bindings (faster than WASM) |
| Token counting | `js-tiktoken` | ^1.x | Pure JS, no WASM |
| YAML parsing | `js-yaml` | ^4.x | For application.yml |
| Glob | `glob` | ^10.x | File discovery |
| TypeScript | `typescript` | ^5.x | ESM, strict |
| Test framework | `vitest` | ^2.x | Fast, ESM-native |
| Dev runner | `tsx` | ^4.x | TypeScript execution |

### Opt-in (enabled via `"vectorSearch": true` in config)
| Vector search | `sqlite-vec` | ^0.1.x | Local SQLite extension |
| Embeddings | `@huggingface/transformers` | ^3.x | One-time model download, then 100% local |
| Embedding model | `nomic-ai/nomic-embed-text-v1.5` | - | 384 dims, quantized, ~30MB, ONNX on CPU |

---

## Current Status

**Last updated**: 2026-03-11
**Current phase**: Phase 11 (CLI implemented)
**Completed phases**: 0-8, 10-11 (Phase 9 Vector Search deferred — opt-in feature, can be added later)
**Tests**: 108 passing across 10 test files, 0 failures
**Next action**: Phase 12 (Integration Testing) → Phase 13 (Documentation)
**Total phases**: 14 (0-13), ~65 tasks
**Default**: BM25 search, 100% local, zero downloads, auto-index on query
**Opt-in**: `"vectorSearch": true` → hybrid BM25 + vector (one-time 30MB model download, then local)

### What's Built
- **condex-core**: Security guards, namespace, FS store, SQLite store + FTS5, BM25 search, confidence gate, indexer, MCP server (10 tools), token tracking, savings persistence
- **condex-java**: Tree-sitter Java parser, Spring role tagger, architecture detector (hex/layered/MVC), hex role tagger, SQL migration parser, YAML config parser
- **condex-cli**: `condex index`, `condex status`, `condex invalidate` commands

---

*This plan is the source of truth for implementation progress. Update status markers as work proceeds.*
