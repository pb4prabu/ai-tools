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
const SANDBOX_FAILED = 'CONDEX_SANDBOX_FAILED'

export function ensureOsSandbox(): boolean {
  // Already sandboxed (re-exec'd child) — continue normally
  if (process.env[SENTINEL] === '1') {
    console.error(`[condex] OS sandbox active (${process.platform === 'darwin' ? 'sandbox-exec' : 'unshare --net'})`)
    return false
  }

  // Sandbox was attempted but failed — parent is re-launching us without sandbox
  if (process.env[SANDBOX_FAILED] === '1') {
    console.error(`[condex] ⚠ OS sandbox failed — running with Layer 1+2 + DNS/proxy poisoning only`)
    return false
  }

  // Opt-out escape hatch for debugging
  if (process.env.CONDEX_NO_SANDBOX === '1') {
    console.error(`[condex] ⚠ OS sandbox SKIPPED (CONDEX_NO_SANDBOX=1)`)
    return false
  }

  const platform = process.platform

  if (platform === 'darwin') {
    if (canUseSandboxExec()) {
      return launchSandboxedChild('sandbox-exec', [
        '-p', '(version 1)(allow default)(deny network-outbound)',
        process.execPath, ...process.argv.slice(1),
      ])
    }
    console.error(`[condex] ⚠ sandbox-exec not available (enterprise MDM or SIP restriction)`)
    console.error(`[condex] ⚠ Falling back to Layer 1+2 + DNS/proxy poisoning`)
    return false
  }

  if (platform === 'linux') {
    if (canUseUnshare()) {
      return launchSandboxedChild('unshare', [
        '--net',
        process.execPath, ...process.argv.slice(1),
      ])
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
 * Tests with the EXACT deny-network profile we'll actually use.
 * Enterprise MDM (Jamf, Kandji, etc.) can block sandbox profiles.
 */
function canUseSandboxExec(): boolean {
  try {
    const result = spawnSync('sandbox-exec', [
      '-p', '(version 1)(allow default)(deny network-outbound)',
      process.execPath, '-e', 'process.exit(0)',
    ], { timeout: 5000, stdio: 'pipe' })
    return result.status === 0 && !result.error
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
    ], { timeout: 5000, stdio: 'pipe' })
    return result.status === 0 && !result.error
  } catch {
    return false
  }
}

/**
 * Launch the server inside an OS sandbox. If the sandboxed child fails
 * within the first 2 seconds (sandbox rejected), fall back to running
 * without sandbox by re-launching with CONDEX_SANDBOX_FAILED=1.
 *
 * Returns true if this is the parent (caller should stop and wait).
 */
function launchSandboxedChild(command: string, args: string[]): boolean {
  console.error(`[condex] Re-launching inside OS sandbox: ${command}`)

  const startTime = Date.now()
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, [SENTINEL]: '1' },
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[condex] ⚠ OS sandbox launch failed: ${err.message}`)
    launchWithoutSandbox()
  })

  child.on('exit', (code, signal) => {
    const elapsed = Date.now() - startTime

    // If child died within 2 seconds with non-zero exit, sandbox likely rejected it
    if (code !== 0 && !signal && elapsed < 2000) {
      console.error(`[condex] ⚠ OS sandbox child exited with code ${code} after ${elapsed}ms — sandbox may have been rejected`)
      launchWithoutSandbox()
      return
    }

    // Normal exit — propagate
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 1)
    }
  })

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig))
  }

  return true
}

/**
 * Re-launch the server WITHOUT the OS sandbox.
 * Sets CONDEX_SANDBOX_FAILED=1 so the child knows to skip sandbox and continue.
 */
function launchWithoutSandbox(): void {
  console.error(`[condex] ⚠ Falling back — re-launching without OS sandbox`)
  console.error(`[condex] ⚠ Layer 1+2 + DNS/proxy poisoning will still protect`)

  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, [SANDBOX_FAILED]: '1' },
  })

  child.on('error', (err) => {
    console.error(`[condex] FATAL: Failed to re-launch server: ${err.message}`)
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
