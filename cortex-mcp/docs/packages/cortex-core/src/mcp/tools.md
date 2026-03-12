# tools.ts — MCP Tool Definitions

**Path:** `packages/cortex-core/src/mcp/tools.ts`

## What it does

Defines the JSON schemas for all 10 MCP tools that Cortex exposes to AI agents. This is pure data — no logic. Each tool definition has a name, description, and JSON Schema for its input parameters.

## Tools Defined

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `list_projects` | List all indexed projects | none |
| `get_project_outline` | Package-level overview of a project | `projectId?` |
| `get_file_outline` | List symbols in a specific file | `filePath`, `projectId?` |
| `search_symbols` | Search for classes/methods/fields by keyword | `query`, `kind?`, `springRole?`, `hexRole?`, `filePattern?`, `limit?` |
| `get_symbol` | Get full source code of one symbol | `symbolId` |
| `get_symbols` | Get source code of multiple symbols | `symbolIds[]` |
| `search_schema` | Search database tables/columns | `query`, `projectId?` |
| `get_context_for_task` | Auto-assemble relevant context for a coding task | `task`, `tokenBudget?`, `projectId?` |
| `index_folder` | Trigger re-indexing | `full?` |
| `invalidate_cache` | Clear in-memory cache | `projectId?` |

## Why it's separate

Tool definitions are static data that the MCP protocol needs in a specific format. Keeping them separate from handler logic makes both easier to maintain and test.
