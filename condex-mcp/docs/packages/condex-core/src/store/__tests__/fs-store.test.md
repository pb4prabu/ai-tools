# fs-store.test.ts — Filesystem Store Tests

**Path:** `packages/condex-core/src/store/__tests__/fs-store.test.ts`

## What it tests

10 test cases using temporary directories:
- `initCondexDir` creates correct folder structure
- Symbol file write/read round-trip
- Multiple symbol files
- Remove symbols by source file
- Meta.json write/read round-trip
- Lock file acquire/release
- Concurrent lock blocking (second acquire fails)
- `hashContent` determinism (same content → same hash)
