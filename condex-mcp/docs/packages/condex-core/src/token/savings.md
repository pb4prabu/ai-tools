# savings.ts — Token Savings Tracker

**Path:** `packages/condex-core/src/token/savings.ts`

## What it does

Tracks token savings across MCP queries — both within the current session and across all sessions (persisted to disk).

## Storage

Saves to `.condex/savings.json`:

```json
{
  "allTimeTokensSaved": 1200000,
  "allTimeQueries": 5400
}
```

## API

| Method | Returns |
|--------|---------|
| `trackSaving(tokensSaved, tokensIfNaive)` | Records one query's savings |
| `getSessionTokensSaved()` | Tokens saved in current session |
| `getSessionQueries()` | Queries in current session |
| `getAllTimeTokensSaved()` | Cumulative all-time savings |
| `getAllTimeQueries()` | Cumulative all-time queries |

## Used by

`meta.ts` calls `trackSaving()` every time a handler builds its `_meta` response, so every MCP tool call automatically tracks its savings.
