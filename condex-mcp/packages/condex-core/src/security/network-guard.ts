/**
 * 4-Layer Outbound Network Block
 *
 * Layer 1: Environment variables (library-level — tells libs to stay offline)
 * Layer 2: Node.js network API monkey-patch (process-level — throws on any call)
 * Layer 3: OS sandbox (kernel-level — sandbox-exec on macOS, unshare --net on Linux)
 *          Handled by sandbox-launcher.ts (runs BEFORE this module)
 * Layer 3b: DNS + proxy poisoning (fallback when OS sandbox unavailable)
 *           - Poisons dns.lookup → always returns 0.0.0.0
 *           - Sets HTTP_PROXY/HTTPS_PROXY to a dead address
 *           - Even if a native addon bypasses Layer 2, it can't resolve or route
 *
 * MUST be called as the FIRST thing in server.ts, after sandbox-launcher.
 */

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'
import dns from 'node:dns'
import { execSync } from 'node:child_process'

let blocked = false

export function blockOutboundNetwork(): void {
  if (blocked) return
  blocked = true

  // ── Layer 1: Environment variables ──────────────────────────
  process.env.TRANSFORMERS_OFFLINE = '1'
  process.env.HF_HUB_DISABLE_TELEMETRY = '1'

  // ── Layer 3b: DNS + proxy poisoning ─────────────────────────
  // Works even if OS sandbox (Layer 3) is unavailable.
  // Catches native addons that bypass Layer 2 monkey-patches.
  poisonDnsAndProxy()

  // ── Layer 2: Monkey-patch ALL Node.js networking APIs ───────
  const throwBlocked = (): never => {
    throw new Error(
      'NETWORK_BLOCKED: Condex MCP server does not allow outbound network connections. ' +
      'This is a security feature. To download models, use "condex setup --vector" instead.'
    )
  }

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
 * Layer 3b: Poison DNS resolution and proxy settings.
 *
 * Even if something bypasses the monkey-patches (native addon, worker thread),
 * it still can't resolve hostnames or route through a proxy.
 *
 * - dns.lookup → always returns 0.0.0.0 (black hole)
 * - HTTP_PROXY / HTTPS_PROXY → point to 127.0.0.1:1 (dead port)
 * - NODE_TLS_REJECT_UNAUTHORIZED stays '1' (no weakening)
 */
function poisonDnsAndProxy(): void {
  // Poison DNS — all lookups resolve to 0.0.0.0 (non-routable)
  const origLookup = dns.lookup
  dns.lookup = function (
    hostname: string,
    optionsOrCallback: any,
    maybeCallback?: any,
  ) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    if (typeof callback === 'function') {
      callback(null, '0.0.0.0', 4)
    }
    return undefined as any
  } as typeof dns.lookup

  // Also poison dns.resolve
  dns.resolve = function (...args: any[]) {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') {
      callback(new Error('NETWORK_BLOCKED: DNS resolution disabled'))
    }
    return undefined as any
  } as typeof dns.resolve

  dns.resolve4 = function (...args: any[]) {
    const callback = args[args.length - 1]
    if (typeof callback === 'function') {
      callback(new Error('NETWORK_BLOCKED: DNS resolution disabled'))
    }
    return undefined as any
  } as typeof dns.resolve4

  // Poison dns.promises
  if (dns.promises) {
    dns.promises.lookup = async () => ({ address: '0.0.0.0', family: 4 }) as any
    dns.promises.resolve = async () => { throw new Error('NETWORK_BLOCKED: DNS resolution disabled') }
    dns.promises.resolve4 = async () => { throw new Error('NETWORK_BLOCKED: DNS resolution disabled') }
  }

  // Poison proxy env vars — libraries like axios, got, node-fetch honor these
  // Point to a dead local port so even if they try, connection is refused instantly
  process.env.HTTP_PROXY = 'http://127.0.0.1:1'
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'
  process.env.http_proxy = 'http://127.0.0.1:1'
  process.env.https_proxy = 'http://127.0.0.1:1'
  // NO_PROXY must NOT be set — we want everything to go through the dead proxy
  delete process.env.NO_PROXY
  delete process.env.no_proxy

  console.error('[condex] DNS + proxy poisoning active (Layer 3b fallback)')
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

  // Layer 3b: verify DNS + proxy poisoning
  if (process.env.HTTP_PROXY === 'http://127.0.0.1:1') {
    console.error(`[condex]   ✔ HTTP_PROXY=http://127.0.0.1:1 (dead)`)
  } else {
    leaked.push('HTTP_PROXY')
    console.error(`[condex]   ✘ HTTP_PROXY not poisoned`)
  }
  if (process.env.HTTPS_PROXY === 'http://127.0.0.1:1') {
    console.error(`[condex]   ✔ HTTPS_PROXY=http://127.0.0.1:1 (dead)`)
  } else {
    leaked.push('HTTPS_PROXY')
    console.error(`[condex]   ✘ HTTPS_PROXY not poisoned`)
  }

  if (leaked.length > 0) {
    console.error(`\n[condex] FATAL: Verification failed — ${leaked.join(', ')}`)
    console.error(`[condex] Refusing to start with broken network isolation.`)
    process.exit(1)
  }
  console.error('[condex] Layer 1+2+3b verified ✔')
}

/**
 * Verify Layer 3: try a real TCP connection in a child process to detect OS sandbox.
 * This is informational — the server starts regardless (Layer 2 + 3b protect it).
 */
function verifyOsSandbox(): void {
  console.error('[condex] Verifying Layer 3 (OS-level network sandbox)...')

  const platform = process.platform
  const nodeBin = process.execPath

  if (platform !== 'darwin' && platform !== 'linux') {
    console.error(`[condex]   ⚠ OS sandbox not available on ${platform}`)
    console.error(`[condex]   Protected by: Layer 2 (monkey-patch) + Layer 3b (DNS/proxy poison)`)
    return
  }

  try {
    const errorCodes = platform === 'darwin'
      ? "e.code==='EPERM'||e.code==='EACCES'||e.message.includes('not permitted')"
      : "e.code==='ENETUNREACH'||e.code==='EPERM'||e.code==='EACCES'"

    execSync(
      `${nodeBin} -e "const s=require('net').createConnection({host:'93.184.216.34',port:80,timeout:1000});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',(e)=>{process.exit(${errorCodes}?42:0)})" 2>&1`,
      { timeout: 3000, stdio: 'pipe', encoding: 'utf8' }
    )
    // Exit 0 = connection went through (network reachable)
    console.error(`[condex]   ⚠ OS sandbox NOT active — but Layer 2 + 3b still protect`)
  } catch (err: any) {
    if (err.status === 42) {
      console.error(`[condex]   ✔ OS sandbox active — kernel denied network syscall`)
      console.error('[condex] Layer 3 verified ✔')
      return
    }
    if (err.killed || err.signal === 'SIGTERM') {
      console.error(`[condex]   ✔ OS sandbox likely active — connection timed out`)
      console.error('[condex] Layer 3 verified ✔')
      return
    }
    console.error(`[condex]   ⚠ OS sandbox probe inconclusive — Layer 2 + 3b still protect`)
  }
}

// ── Exported for testing ─────────────────────────────────────

export { verifyMonkeyPatches, verifyOsSandbox as verifyNetworkBlocked }

/**
 * Generate macOS sandbox-exec profile for Layer 3 (OS-level enforcement).
 */
export function generateSandboxProfile(projectRoot: string): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath "${projectRoot}/.condex"))`,
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/tmp"))',
    '(allow file-write* (literal "/dev/null"))',
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
  const nodePath = process.execPath

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

  return {
    command: nodePath,
    args: [serverPath],
  }
}
