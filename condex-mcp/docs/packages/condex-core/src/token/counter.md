# counter.ts — Token Counter

**Path:** `packages/condex-core/src/token/counter.ts`

## What it does

Counts tokens using `js-tiktoken` with the `cl100k_base` tokenizer (same as GPT-4o). This is used to measure how many tokens an MCP response contains vs how many a naive file read would cost.

## Key functions

- **`countTokens(text)`** — Exact token count using tiktoken encoder (lazy-initialized singleton)
- **`estimateTokensFromBytes(bytes)`** — Fast estimate at ~4 chars per token (for when you only have file size)
