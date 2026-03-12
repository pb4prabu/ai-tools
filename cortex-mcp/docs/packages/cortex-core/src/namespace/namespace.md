# namespace.ts — Project ID Generation

**Path:** `packages/cortex-core/src/namespace/namespace.ts`

## What it does

Generates deterministic, unique project identifiers from absolute paths.

## Format

```
projectName@sha256(absolutePath)[0:6]
```

## Examples

```
/home/user/urbanbarrow-mono  →  urbanbarrow-mono@a3f2c1
/home/user/my-other-project  →  my-other-project@7b9e42
```

## Properties

- **Deterministic:** Same path always produces the same namespace
- **Unique:** Different paths produce different namespaces (hash collision is extremely unlikely with 6 hex chars = 16M possibilities)
- **Human-readable:** Starts with the folder name
- **Trailing-slash safe:** `/foo/bar` and `/foo/bar/` produce the same namespace

## Key exports

- `generateNamespace(rootPath)` — Returns the namespace string
- `getProjectRoot()` — Returns `process.cwd()`
