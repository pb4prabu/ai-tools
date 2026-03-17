/**
 * Self-sandboxing: if the server is not already running inside an OS-level
 * network sandbox, re-exec itself inside one.
 *
 * macOS: sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' node server.js
 * Linux: unshare --net node server.js
 *
 * The re-exec preserves stdin/stdout/stderr so MCP stdio transport works.
 * A sentinel env var (CONDEX_SANDBOXED=1) prevents infinite re-exec loops.
 *
 * Set CONDEX_NO_SANDBOX=1 to skip (e.g. for debugging).
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const SENTINEL = 'CONDEX_SANDBOXED'

export function ensureOsSandbox(): void {
  // Already sandboxed (re-exec'd child) — continue normally
  if (process.env[SENTINEL] === '1') {
    console.error(`[condex] OS sandbox active (${process.platform === 'darwin' ? 'sandbox-exec' : 'unshare --net'})`)
    return
  }

  // Opt-out escape hatch for debugging
  if (process.env.CONDEX_NO_SANDBOX === '1') {
    console.error(`[condex] ⚠ OS sandbox SKIPPED (CONDEX_NO_SANDBOX=1)`)
    return
  }

  const platform = process.platform

  if (platform === 'darwin') {
    reExecWithSandbox('sandbox-exec', [
      '-p', '(version 1)(allow default)(deny network-outbound)',
      process.execPath, ...process.argv.slice(1),
    ])
  } else if (platform === 'linux') {
    reExecWithSandbox('unshare', [
      '--net',
      process.execPath, ...process.argv.slice(1),
    ])
  } else {
    console.error(`[condex] ⚠ OS sandbox not available on ${platform} — relying on Layer 1+2 only`)
  }
}

function reExecWithSandbox(command: string, args: string[]): never {
  console.error(`[condex] Re-launching inside OS sandbox: ${command}`)

  const result = spawnSync(command, args, {
    stdio: 'inherit', // pass through stdin/stdout/stderr for MCP transport
    env: { ...process.env, [SENTINEL]: '1' },
  })

  // The sandboxed child has exited — propagate its exit code
  if (result.error) {
    console.error(`[condex] FATAL: Failed to launch OS sandbox: ${result.error.message}`)
    if ((result.error as any).code === 'ENOENT') {
      console.error(`[condex]   '${command}' not found. Install it or set CONDEX_NO_SANDBOX=1 to skip.`)
    }
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}
