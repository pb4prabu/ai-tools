# fs-guard.ts — Filesystem Access Guard

**Path:** `packages/condex-core/src/security/fs-guard.ts`

## What it does

The `SafeFS` class restricts all file operations to prevent the MCP server from accessing files outside the project:

- **Reads:** Allowed anywhere within the project root
- **Writes:** Only allowed inside `.condex/` directory
- **Path traversal:** Blocked (e.g., `../../etc/passwd` throws `FS_BLOCKED`)

## Why it exists

An MCP server runs with the same permissions as the AI agent that spawned it. Without `SafeFS`, a bug or malicious prompt could read sensitive files (SSH keys, credentials) or write to system directories.

## API

| Method | Read/Write | Restriction |
|--------|-----------|-------------|
| `readFile(path)` | Read | Must be within project root |
| `readFileSync(path)` | Read | Must be within project root |
| `readdir(path)` | Read | Must be within project root |
| `stat(path)` | Read | Must be within project root |
| `existsSync(path)` | Read | Must be within project root |
| `writeFile(path, data)` | Write | Must be within `.condex/` |
| `mkdir(path)` | Write | Must be within `.condex/` |
| `rm(path)` | Write | Must be within `.condex/` |

## Path validation

```typescript
const safeFs = new SafeFS('/home/user/my-project')

safeFs.readFile('/home/user/my-project/src/App.java')  // OK
safeFs.readFile('/home/user/.ssh/id_rsa')               // THROWS FS_BLOCKED
safeFs.readFile('/home/user/my-project/../../etc/passwd')// THROWS FS_BLOCKED
safeFs.writeFile('/home/user/my-project/.condex/data')   // OK
safeFs.writeFile('/home/user/my-project/src/hack.java')  // THROWS FS_BLOCKED
```
