# cli.ts — Cortex CLI Tool

**Path:** `packages/cortex-cli/src/cli.ts`

## What it does

Command-line interface for manual project indexing, status checks, and cache invalidation. This is for running outside of MCP — directly from the terminal.

## Commands

### `cortex index [path] [--full]`
Index a project directory. Loads the Java parser from `@cortex-ai/java`, runs `indexProject()`, and prints results.
- Default path: current directory
- `--full`: Force full re-index (skip incremental hash check)

### `cortex status [path]`
Show the current index status by reading `meta.json`:
- Project name, ID, root path
- Language, architecture
- Symbol/schema/config counts
- Last full and incremental index timestamps
- Files tracked

### `cortex invalidate [path]`
Delete the `.cortex/index/` directory to force a full re-index on next use.

### `cortex help`
Print usage information.

## Installation

```bash
# From the cortex-mcp monorepo
npm run build
node packages/cortex-cli/dist/cli.js index /path/to/project

# Or link globally
cd packages/cortex-cli && npm link
cortex index .
```

## Dependencies

- `@cortex-ai/core` — SafeFS, createSchema, loadProject, indexProject, etc.
- `@cortex-ai/java` — Java parser (loaded dynamically via `createRequire`)
- `better-sqlite3` — In-memory SQLite database
