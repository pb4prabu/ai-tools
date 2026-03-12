# token.test.ts — Token Counter & Savings Tests

**Path:** `packages/condex-core/src/token/__tests__/token.test.ts`

## What it tests

7 test cases:
- Token counting accuracy (non-zero for text)
- Empty text → 0 tokens
- Longer text produces more tokens
- Byte estimation (~4 chars per token)
- Session savings tracking
- Persistence across tracker instances (reads from `.condex/savings.json`)
- Graceful handling of missing savings file
