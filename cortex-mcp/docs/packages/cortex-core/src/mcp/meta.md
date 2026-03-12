# meta.ts — Response Metadata Builder

**Path:** `packages/cortex-core/src/mcp/meta.ts`

## What it does

Builds the `_meta` envelope attached to every MCP tool response. This metadata tells the AI agent how much it saved by using Cortex instead of reading raw files.

## What `_meta` contains

```json
{
  "timingMs": 12,
  "projectId": "urbanbarrow@a3f2c1",
  "projectName": "urbanbarrow-mono",
  "architecture": "hexagonal",
  "symbolsReturned": 5,
  "tokensInResponse": 450,
  "tokensIfNaive": 12000,
  "tokensSaved": 11550,
  "tokensSavedPercent": 96.25,
  "sessionTokensSaved": 45000,
  "allTimeTokensSaved": 1200000,
  "confidenceGateFired": false,
  "topScore": 2.45
}
```

## Key functions

- **`buildMeta(opts)`** — Calculates savings, records to SavingsTracker, returns the meta object
- **`setSavingsTracker(t)`** — Injects the tracker instance (called once at startup)
- **`countTokens(text)`** — Re-exported from token counter for convenience
