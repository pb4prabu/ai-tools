# fs-guard.test.ts — SafeFS Tests

**Path:** `packages/cortex-core/src/security/__tests__/fs-guard.test.ts`

## What it tests

8 test cases validating the filesystem security boundary:
- Read access within project root (allowed)
- Read access outside project root (blocked)
- Path traversal attacks (blocked)
- Write access restricted to `.cortex/` only
- Write outside `.cortex/` (blocked)
- Getter methods (`getProjectRoot`, `getIndexDir`)
