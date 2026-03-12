# network-guard.test.ts — Network Guard Tests

**Path:** `packages/condex-core/src/security/__tests__/network-guard.test.ts`

## What it tests

3 test cases:
- Sandbox profile contains `deny network*` rules
- Sandbox profile allows `.condex/` writes
- `generateLaunchCommand()` returns valid command structure
