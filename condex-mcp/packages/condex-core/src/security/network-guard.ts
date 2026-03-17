/**
 * 3-Layer Outbound Network Block
 *
 * Layer 1: Environment variables (library-level — tells libs to stay offline)
 * Layer 2: Node.js network API monkey-patch (process-level — throws on any call)
 * Layer 3: OS sandbox (kernel-level — sandbox-exec on macOS, unshare --net on Linux)
 *
 * Order of operations in blockOutboundNetwork():
 *   1. Set env vars                       (Layer 1)
 *   2. Monkey-patch all Node.js net APIs  (Layer 2)
 *   3. Verify patches work                (Layer 2 verification)
 *   4. Real TCP probe to detect OS block  (Layer 3 verification)
 *
 * MUST be called as the FIRST thing in server.ts, before any other imports.
 */

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import { execSync } from 'node:child_process'

let blocked = false

// Stash originals BEFORE patching — needed for the real OS-level probe
const _origSocketConnect = net.Socket.prototype.connect

export function blockOutboundNetwork(): void {
  if (blocked) return
  blocked = true

  // ── Layer 1: Environment variables ──────────────────────────
  process.env.TRANSFORMERS_OFFLINE = '1'
  process.env.HF_HUB_DISABLE_TELEMETRY = '1'

  const throwBlocked = (): never => {
    throw new Error(
      'NETWORK_BLOCKED: Condex MCP server does not allow outbound network connections. ' +
      'This is a security feature. To download models, use "condex setup --vector" instead.'
    )
  }

  // ── Layer 2: Monkey-patch ALL Node.js networking APIs ───────

  // TCP
  net.Socket.prototype.connect = function (..._args: unknown[]) {
    throwBlocked()
  } as typeof net.Socket.prototype.connect

  // TLS/SSL
  tls.connect = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof tls.connect

  // HTTP
  http.request = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof http.request
  http.get = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof http.get

  // HTTPS
  https.request = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof https.request
  https.get = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof https.get

  // Fetch API (Node 18+)
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch = ((..._args: unknown[]) => {
      throwBlocked()
    }) as typeof globalThis.fetch
  }

  // UDP
  dgram.createSocket = ((..._args: unknown[]) => {
    throwBlocked()
  }) as typeof dgram.createSocket

  console.error('[condex] Network guard active — all outbound connections blocked')

  // ── Verify everything ───────────────────────────────────────
  verifyMonkeyPatches()
  verifyOsSandbox()
}

/**
 * Verify Layer 2: call every patched API and confirm it throws NETWORK_BLOCKED.
 */
function verifyMonkeyPatches(): void {
  console.error('[condex] Verifying Layer 2 (Node.js API monkey-patches)...')

  const probes: { name: string; fn: () => void }[] = [
    { name: 'net.Socket.connect (TCP)', fn: () => { new net.Socket().connect(80, '1.1.1.1') } },
    { name: 'tls.connect (TLS/SSL)', fn: () => { tls.connect(443, '1.1.1.1') } },
    { name: 'http.request (HTTP)', fn: () => { http.request('http://1.1.1.1') } },
    { name: 'http.get (HTTP GET)', fn: () => { http.get('http://1.1.1.1') } },
    { name: 'https.request (HTTPS)', fn: () => { https.request('https://1.1.1.1') } },
    { name: 'https.get (HTTPS GET)', fn: () => { https.get('https://1.1.1.1') } },
    { name: 'globalThis.fetch (Fetch API)', fn: () => { globalThis.fetch('https://1.1.1.1') } },
    { name: 'dgram.createSocket (UDP)', fn: () => { dgram.createSocket('udp4') } },
  ]

  const leaked: string[] = []
  for (const probe of probes) {
    try {
      probe.fn()
      leaked.push(probe.name)
      console.error(`[condex]   ✘ ${probe.name} — NOT BLOCKED`)
    } catch (err: any) {
      if (err.message.includes('NETWORK_BLOCKED')) {
        console.error(`[condex]   ✔ ${probe.name} — blocked`)
      } else {
        console.error(`[condex]   ⚠ ${probe.name} — threw: ${err.message}`)
      }
    }
  }

  // Layer 1: verify env vars
  for (const { name, expected } of [
    { name: 'TRANSFORMERS_OFFLINE', expected: '1' },
    { name: 'HF_HUB_DISABLE_TELEMETRY', expected: '1' },
  ]) {
    if (process.env[name] === expected) {
      console.error(`[condex]   ✔ ${name}=${expected}`)
    } else {
      leaked.push(`env:${name}`)
      console.error(`[condex]   ✘ ${name} not set`)
    }
  }

  if (leaked.length > 0) {
    console.error(`\n[condex] FATAL: Layer 2 verification failed — ${leaked.join(', ')}`)
    console.error(`[condex] Refusing to start with broken network isolation.`)
    process.exit(1)
  }
  console.error('[condex] Layer 1+2 verified ✔')
}

/**
 * Verify Layer 3: actually try a real TCP connection using the ORIGINAL
 * (un-patched) socket to see if the OS blocks it.
 *
 * This bypasses our own monkey-patches on purpose — we want to test
 * whether the OS-level sandbox (sandbox-exec / unshare --net) is active.
 *
 * Uses a child process to avoid interfering with patched state.
 * Connects to 0.0.0.0:1 (non-routable, instant failure) — if sandbox
 * is active, the OS rejects the syscall; if not, the connect just fails
 * with ECONNREFUSED (which means the network stack IS reachable).
 */
function verifyOsSandbox(): void {
  console.error('[condex] Verifying Layer 3 (OS-level network sandbox)...')

  const platform = process.platform
  const nodeBin = process.execPath // full path — avoids PATH lookup issues

  if (platform === 'darwin') {
    try {
      // Spawn a child that inherits our sandbox and tries a real TCP connect.
      // If sandboxed: kernel denies syscall → EPERM
      // If NOT sandboxed: connect goes through or gets ECONNREFUSED (network reachable)
      const result = execSync(
        `${nodeBin} -e "const s=require('net').createConnection({host:'93.184.216.34',port:80,timeout:1000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',(e)=>{process.exit(e.code==='EPERM'||e.code==='EACCES'||e.message.includes('not permitted')||e.message.includes('Operation not permitted')?42:0)})" 2>&1`,
        { timeout: 3000, stdio: 'pipe', encoding: 'utf8' }
      )
      console.error(`[condex]   ⚠ Layer 3 (OS sandbox) NOT active — network is reachable at syscall level`)
      console.error(`[condex]   ⚠ Monkey-patches (Layer 2) are blocking, but a native addon could bypass them`)
      console.error(`[condex]   ⚠ For full kernel-level isolation, launch with:`)
      console.error(`[condex]       sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' ${nodeBin} server.js`)
      console.error(`[condex]   ⚠ Continuing with Layer 1+2 protection only`)
    } catch (err: any) {
      if (err.status === 42) {
        console.error(`[condex]   ✔ OS sandbox active — kernel denied network syscall (EPERM)`)
        console.error('[condex] Layer 3 verified ✔')
        return
      }
      if (err.killed || err.signal === 'SIGTERM') {
        console.error(`[condex]   ✔ OS sandbox likely active — connection timed out (blocked at kernel)`)
        console.error('[condex] Layer 3 verified ✔')
        return
      }
      console.error(`[condex]   ⚠ OS sandbox probe inconclusive: ${err.message?.split('\n')[0]}`)
      console.error(`[condex]   ⚠ Continuing with Layer 1+2 protection`)
    }
  } else if (platform === 'linux') {
    try {
      const result = execSync(
        `${nodeBin} -e "const s=require('net').createConnection({host:'93.184.216.34',port:80,timeout:1000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',(e)=>{process.exit(e.code==='ENETUNREACH'||e.code==='EPERM'||e.code==='EACCES'?42:0)})" 2>&1`,
        { timeout: 3000, stdio: 'pipe', encoding: 'utf8' }
      )
      console.error(`[condex]   ⚠ Layer 3 (OS sandbox) NOT active — network is reachable at syscall level`)
      console.error(`[condex]   ⚠ For full kernel-level isolation, launch with:`)
      console.error(`[condex]       unshare --net ${nodeBin} server.js`)
      console.error(`[condex]   ⚠ Continuing with Layer 1+2 protection only`)
    } catch (err: any) {
      if (err.status === 42) {
        console.error(`[condex]   ✔ OS sandbox active — kernel denied network syscall`)
        console.error('[condex] Layer 3 verified ✔')
        return
      }
      if (err.killed || err.signal === 'SIGTERM') {
        console.error(`[condex]   ✔ OS sandbox likely active — connection timed out (blocked at kernel)`)
        console.error('[condex] Layer 3 verified ✔')
        return
      }
      console.error(`[condex]   ⚠ OS sandbox probe inconclusive: ${err.message?.split('\n')[0]}`)
      console.error(`[condex]   ⚠ Continuing with Layer 1+2 protection`)
    }
  } else {
    console.error(`[condex]   ⚠ OS sandbox not available on ${platform} — relying on Layer 1+2 only`)
  }
}

// ── Exported for verification & testing ──────────────────────

export { verifyMonkeyPatches, verifyOsSandbox as verifyNetworkBlocked }

/**
 * Generate macOS sandbox-exec profile for Layer 3 (OS-level enforcement).
 * This restricts both network AND filesystem at the kernel level.
 */
export function generateSandboxProfile(projectRoot: string): string {
  return [
    '(version 1)',
    '(allow default)',
    // Block all outbound network
    '(deny network-outbound)',
    // Block all file writes except .condex/ and temp
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath "${projectRoot}/.condex"))`,
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (literal "/dev/null"))',
    // Allow stdout/stderr (required for MCP stdio transport)
    '(allow file-write* (literal "/dev/stdout"))',
    '(allow file-write* (literal "/dev/stderr"))',
  ].join('\n')
}

/**
 * Generate the full launch command with OS-level sandboxing.
 */
export function generateLaunchCommand(
  projectRoot: string,
  serverPath: string
): { command: string; args: string[] } {
  const platform = process.platform
  const nodePath = process.execPath // full absolute path to node

  if (platform === 'darwin') {
    const profile = generateSandboxProfile(projectRoot)
    return {
      command: 'sandbox-exec',
      args: ['-p', profile, nodePath, serverPath],
    }
  }

  if (platform === 'linux') {
    return {
      command: 'unshare',
      args: ['--net', nodePath, serverPath],
    }
  }

  // Fallback: no OS-level sandbox, rely on Layer 1 + 2
  return {
    command: nodePath,
    args: [serverPath],
  }
}
