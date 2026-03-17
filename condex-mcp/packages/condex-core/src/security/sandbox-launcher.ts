/**
 * Self-sandboxing: if the server is not already running inside an OS-level
 * network sandbox, re-exec itself inside one.
 *
 * macOS: sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' node server.js
 * Linux: unshare --net node server.js
 *
 * If sandbox-exec / unshare fails (e.g. enterprise MDM blocking it),
 * falls back gracefully — Layer 1+2 + DNS/proxy poisoning still protect.
 *
 * A sentinel env var (CONDEX_SANDBOXED=1) prevents infinite re-exec loops.
 * Set CONDEX_NO_SANDBOX=1 to skip (e.g. for debugging).
 *
 * Returns true if this is the parent (caller should stop and wait).
 * Returns false if this is the sandboxed child, sandbox was skipped, or sandbox failed.
 */

import { spawn, spawnSync } from 'node:child_process'

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
    // Test if sandbox-exec actually works on this machine
    if (canUseSandboxExec()) {
      launchSandboxedChild('sandbox-exec', [
        '-p', '(version 1)(allow default)(deny network-outbound)',
        process.execPath, ...process.argv.slice(1),
      ])
      return true
    }
    console.error(`[condex] ⚠ sandbox-exec not available (enterprise MDM or SIP restriction)`)
    console.error(`[condex] ⚠ Falling back to Layer 1+2 + DNS/proxy poisoning`)
    return false
  }

  if (platform === 'linux') {
    if (canUseUnshare()) {
      launchSandboxedChild('unshare', [
        '--net',
        process.execPath, ...process.argv.slice(1),
      ])
      return true
    }
    console.error(`[condex] ⚠ unshare --net not available (needs root or CAP_SYS_ADMIN)`)
    console.error(`[condex] ⚠ Falling back to Layer 1+2 + DNS/proxy poisoning`)
    return false
  }

  console.error(`[condex] ⚠ OS sandbox not available on ${platform} — relying on Layer 1+2 + DNS/proxy poisoning`)
  return false
}

/**
 * Probe whether sandbox-exec works on this machine.
 * Enterprise MDM (Jamf, Kandji, etc.) can block sandbox profiles.
 */
function canUseSandboxExec(): boolean {
  try {
    const result = spawnSync('sandbox-exec', [
      '-p', '(version 1)(allow default)',
      process.execPath, '-e', 'process.exit(0)',
    ], { timeout: 3000, stdio: 'pipe' })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Probe whether unshare --net works (needs root or user namespace support).
 */
function canUseUnshare(): boolean {
  try {
    const result = spawnSync('unshare', [
      '--net',
      process.execPath, '-e', 'process.exit(0)',
    ], { timeout: 3000, stdio: 'pipe' })
    return result.status === 0
  } catch {
    return false
  }
}

function launchSandboxedChild(command: string, args: string[]): void {
  console.error(`[condex] Re-launching inside OS sandbox: ${command}`)

  const child = spawn(command, args, {
    stdio: 'inherit',
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

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig))
  }
}
