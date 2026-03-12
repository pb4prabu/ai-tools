# dispatcher.ts — Tool Call Router

**Path:** `packages/cortex-core/src/mcp/dispatcher.ts`

## What it does

Routes incoming MCP tool calls to the correct handler function. It's a simple switch statement that maps tool names to handler functions from `handlers.ts`.

## Flow

```
MCP CallToolRequest
    │
    ▼
dispatch(toolName, args, ctx)
    │
    ├── "list_projects"       → handleListProjects(ctx)
    ├── "get_project_outline" → handleGetProjectOutline(ctx, args)
    ├── "get_file_outline"    → handleGetFileOutline(ctx, args)
    ├── "search_symbols"      → handleSearchSymbols(ctx, args)
    ├── "get_symbol"          → handleGetSymbol(ctx, args)
    ├── "get_symbols"         → handleGetSymbols(ctx, args)
    ├── "search_schema"       → handleSearchSchema(ctx, args)
    ├── "get_context_for_task"→ handleGetContextForTask(ctx, args)
    ├── "index_folder"        → handleIndexFolder(ctx, args)
    ├── "invalidate_cache"    → handleInvalidateCache(ctx, args)
    └── unknown               → error response
```

## Why it exists

Keeps the routing logic separate from both the server (which handles MCP protocol) and the handlers (which contain business logic). Clean separation of concerns.
