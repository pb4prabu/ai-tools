# network-guard.ts — Outbound Network Block

**Path:** `packages/cortex-core/src/security/network-guard.ts`

## What it does

Blocks all outbound network access from the MCP server process. This ensures code never leaves the machine — critical for enterprise/private codebases.

## 3-Layer Defense

### Layer 1: Environment Variables
Sets `TRANSFORMERS_OFFLINE=1` to prevent HuggingFace from downloading models.

### Layer 2: Node.js Monkey-Patching
Replaces all networking APIs with functions that throw `NETWORK_BLOCKED`:
- `net.connect`, `net.createConnection`
- `tls.connect`
- `http.request`, `http.get`
- `https.request`, `https.get`
- `globalThis.fetch`
- `dgram.createSocket`

### Layer 3: OS-Level Sandbox (generated, not applied)
Generates commands for OS-level enforcement:
- **macOS:** `sandbox-exec` profile with `(deny network*)`
- **Linux:** `unshare --net` namespace isolation

Layer 3 profiles are generated but not auto-applied — they're meant to be used by the deployment wrapper.

## When it's active

| Search Mode | Network Guard |
|-------------|---------------|
| `bm25` | **Active** — no network needed |
| `vector` | Disabled — needs model download |
| `hybrid` | Disabled — needs model download |
| `smart` | Disabled — needs model download |

## Key exports

- `blockOutboundNetwork()` — Applies layers 1 + 2
- `generateSandboxProfile(projectRoot)` — Returns macOS sandbox profile string
- `generateLaunchCommand(projectRoot, serverPath)` — Returns OS-appropriate launch command
