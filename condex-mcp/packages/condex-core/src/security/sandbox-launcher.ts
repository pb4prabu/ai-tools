/**
 * Self-sandboxing: if the server is not already running inside an OS-level
 * network sandbox, re-exec itself inside one.
 *
 * macOS: sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' node server.js
 * Linux: unshare --net node server.js
 *
 * The re-exec inherits stdin/stdout/stderr so MCP stdio transport works.
 * A sentinel env var (CONDEX_SANDBOXED=1) prevents infinite re-exec loops.
 *
 * Set CONDEX_NO_SANDBOX=1 to skip (e.g. for debugging).
 *
 * Returns true if this is the parent (caller should stop and wait).
 * Returns false if this is the sandboxed child or sandbox was skipped.
 */

import { spawn } from 'node:child_process'

const SENTINEL = 'CONDEX_SANDBOXED'

export function ensureOsSandbox(): boolean {
  // Already sandboxed (re-exec'd child) — continue normally
  if (process.env[SENTINEL] === '1') {
    console.error(`[condex] OS sandbox active (${process.platform === 'darwin' ? 'sandbox-exec' : 'unshare --net'})`)
    return false
  }

  // Opt-out escape hatch for debugging
  if (process.env.CONDEX_NO_SANDBOX === '1') {
    console.error(`[condex] ⚠ OS sandbox SKIPPED (CONDEX_NO_SANDBOX=1)`)
    return false
  }

  const platform = process.platform

  if (platform === 'darwin') {
    launchSandboxedChild('sandbox-exec', [
      '-p', '(version 1)(allow default)(deny network-outbound)',
      process.execPath, ...process.argv.slice(1),
    ])
    return true // parent — stop here
  }

  if (platform === 'linux') {
    launchSandboxedChild('unshare', [
      '--net',
      process.execPath, ...process.argv.slice(1),
    ])
    return true // parent — stop here
  }

  console.error(`[condex] ⚠ OS sandbox not available on ${platform} — relying on Layer 1+2 only`)
  return false
}

function launchSandboxedChild(command: string, args: string[]): void {
  console.error(`[condex] Re-launching inside OS sandbox: ${command}`)

  const child = spawn(command, args, {
    stdio: 'inherit', // pass through stdin/stdout/stderr for MCP transport
    env: { ...process.env, [SENTINEL]: '1' },
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[condex] FATAL: Failed to launch OS sandbox: ${err.message}`)
    if (err.code === 'ENOENT') {
      console.error(`[condex]   '${command}' not found. Install it or set CONDEX_NO_SANDBOX=1 to skip.`)
    }
    process.exit(1)
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 1)
    }
  })

  // Forward signals to the sandboxed child
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig))
  }
}
