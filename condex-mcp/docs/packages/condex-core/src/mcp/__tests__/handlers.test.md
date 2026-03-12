# handlers.test.ts — MCP Handler Tests

**Path:** `packages/condex-core/src/mcp/__tests__/handlers.test.ts`

## What it tests

Unit tests for all MCP tool handlers using Vitest. Sets up an in-memory SQLite database with 3 test symbols (`CreateOrderHandler`, `OrderRepository`, `UserService`), then verifies each handler produces correct results.

## Test cases

- **list_projects** — Returns project list with correct metadata
- **get_project_outline** — Aggregates symbols by package
- **get_file_outline** — Returns symbols for a specific file path
- **search_symbols** — BM25 search finds symbols by name, respects `kind` filter
- **search_symbols gate** — Returns "below threshold" message for garbage queries
- **get_context_for_task** — Assembles context within token budget
- **search_schema** — FTS5 search on schema symbols
- **_meta** — Every response includes timing, token savings, and gate status
