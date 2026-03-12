# cli.ts — Condex CLI Tool

**Path:** `packages/condex-cli/src/cli.ts`

## What it does

Command-line interface for manual project indexing, status checks, and cache invalidation. This is for running outside of MCP — directly from the terminal.

## Commands

### `condex index [path] [--full]`
Index a project directory. Loads the Java parser from `@condex-ai/java`, runs `indexProject()`, and prints results.
- Default path: current directory
- `--full`: Force full re-index (skip incremental hash check)

### `condex status [path]`
Show the current index status by reading `meta.json`:
- Project name, ID, root path
- Language, architecture
- Symbol/schema/config counts
- Last full and incremental index timestamps
- Files tracked

### `condex invalidate [path]`
Delete the `.condex/index/` directory to force a full re-index on next use.

### `condex help`
Print usage information.

## Installation

```bash
# From the condex-mcp monorepo
npm run build
node packages/condex-cli/dist/cli.js index /path/to/project

# Or link globally
cd packages/condex-cli && npm link
condex index .
```

## Dependencies

- `@condex-ai/core` — SafeFS, createSchema, loadProject, indexProject, etc.
- `@condex-ai/java` — Java parser (loaded dynamically via `createRequire`)
- `better-sqlite3` — In-memory SQLite database
