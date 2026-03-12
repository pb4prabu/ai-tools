# Cortex MCP — Documentation

This folder mirrors the source code structure of cortex-mcp. Each `.md` file explains what the corresponding source file does.

## Project Structure

```
cortex-mcp/
├── package.json                    # Monorepo root (npm workspaces)
├── tsconfig.base.json              # Shared TypeScript config
├── README.md                       # Project README
├── benchmark/
│   ├── bench-live.ts               # Live benchmark against real projects
│   ├── bench.ts                    # Benchmark against generated sample
│   └── generate-sample.ts          # Generates fake Spring Boot monorepo
└── packages/
    ├── cortex-core/                # MCP server, retrieval, storage, types
    │   └── src/
    │       ├── index.ts            # Public API barrel export
    │       ├── server.ts           # MCP server entry point
    │       ├── mcp/                # MCP protocol layer
    │       ├── retrieval/          # Search engines (BM25, vector, hybrid, smart)
    │       ├── embeddings/         # Local embedding model
    │       ├── security/           # Filesystem + network guards
    │       ├── namespace/          # Project ID generation
    │       ├── store/              # SQLite + filesystem persistence
    │       ├── token/              # Token counting + savings tracking
    │       ├── indexer/            # Project indexing pipeline
    │       └── types/              # All TypeScript interfaces
    ├── cortex-java/                # Java parser (tree-sitter based)
    │   └── src/
    │       ├── parser/             # AST parsing, Spring/Hex tagging, arch detection
    │       └── sources/            # SQL + YAML parsers
    └── cortex-cli/                 # CLI tool (cortex index/status/invalidate)
        └── src/
            └── cli.ts
```

## Packages

| Package | Purpose |
|---------|---------|
| `@cortex-ai/core` | MCP server, retrieval engine, SQLite storage, filesystem persistence, security |
| `@cortex-ai/java` | Java file parser (tree-sitter), Spring annotation tagger, hex role tagger, SQL/YAML parsers |
| `@cortex-ai/cli` | CLI for manual indexing, status checks, cache invalidation |

## Search Modes

| Mode | Strategy | Token Savings | Coverage |
|------|----------|--------------|----------|
| `bm25` | FTS5 keyword search + confidence gate | ~95% | Low (gate fires on NL queries) |
| `vector` | Semantic embedding similarity | ~22% | High (always finds results) |
| `hybrid` | BM25 + Vector with RRF fusion | ~14% | High |
| `smart` | BM25 first, vector fallback on gate fire | ~32% | High — **Recommended** |
