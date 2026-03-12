# network-guard.test.ts — Network Guard Tests

**Path:** `packages/cortex-core/src/security/__tests__/network-guard.test.ts`

## What it tests

3 test cases:
- Sandbox profile contains `deny network*` rules
- Sandbox profile allows `.cortex/` writes
- `generateLaunchCommand()` returns valid command structure
