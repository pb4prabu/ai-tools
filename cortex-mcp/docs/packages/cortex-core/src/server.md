# server.ts — MCP Server Entry Point

**Path:** `packages/cortex-core/src/server.ts`

## What it does

This is the main executable that starts the Cortex MCP server. It's what gets launched when an AI agent (like Claude Code or OpenCode) spawns the MCP process.

## Startup Flow

```
1. Block outbound network (BM25 mode only)
2. Initialize SafeFS (restrict file access to project root)
3. Create in-memory SQLite database + schema
4. Generate project namespace (deterministic ID)
5. Load Java parser (optional, from @cortex-ai/java)
6. Auto-index:
   - If .cortex/index/meta.json exists → load existing index
   - If no index but parser available → run full index
7. If search mode is vector/hybrid/smart:
   - Load HuggingFace embedding model (~100MB first run)
   - Build vector index for all symbols
8. Initialize savings tracker
9. Create MCP server with stdio transport
10. Register tool handlers (list_tools + call_tool)
11. Start listening
```

## Key Decisions

- **Network guard is conditional:** BM25 mode blocks all outbound network. Vector/hybrid/smart modes need network for model download.
- **In-memory SQLite:** The database lives entirely in RAM. Fast, but lost when the process exits. The `.cortex/index/` on disk is the durable store.
- **Auto-index on startup:** If no index exists and a parser is available, it indexes immediately. Otherwise it loads the pre-built index from disk.

## Environment Variables

| Variable | Values | Default | Effect |
|----------|--------|---------|--------|
| `CORTEX_SEARCH_MODE` | `bm25`, `vector`, `hybrid`, `smart` | `bm25` | Controls which search strategy is used |

## How tools are dispatched

The server registers two MCP handlers:
- `ListToolsRequestSchema` → returns the 10 tool definitions from `tools.ts`
- `CallToolRequestSchema` → routes to `dispatcher.ts`, except `index_folder` which is handled inline (needs access to the Java parser)
