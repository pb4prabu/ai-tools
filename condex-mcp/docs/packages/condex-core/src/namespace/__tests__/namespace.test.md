# namespace.test.ts — Namespace Generation Tests

**Path:** `packages/condex-core/src/namespace/__tests__/namespace.test.ts`

## What it tests

6 test cases:
- Determinism (same path → same result)
- Uniqueness (different paths → different results)
- Folder-name prefix (namespace starts with folder name)
- Parent/child distinction (different directories are different)
- Trailing slash normalization
- Same folder name in different locations produces different namespaces
