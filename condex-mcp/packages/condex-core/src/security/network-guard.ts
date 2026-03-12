/**
 * 3-Layer Outbound Network Block
 *
 * Layer 1: Environment variables (library-level)
 * Layer 2: Node.js network API monkey-patch (process-level)
 * Layer 3: OS sandbox via sandbox-exec / unshare --net (documented in MCP config)
 *
 * MUST be called as the FIRST thing in server.ts, before any other imports.
 * Only affects THIS process — all other apps on the machine are unaffected.
 */

import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import dgram from 'node:dgram'

let blocked = false

export function blockOutboundNetwork(): void {
  if (blocked) return
  blocked = true

  // Layer 1: Environment variables
  process.env.TRANSFORMERS_OFFLINE = '1'
  process.env.HF_HUB_DISABLE_TELEMETRY = '1'

  const throwBlocked = (): never => {
    throw new Error(
      'NETWORK_BLOCKED: Condex MCP server does not allow outbound network connections. ' +
      'This is a security feature. To download models, use "condex setup --vector" instead.'
    )
  }

  // Layer 2: Monkey-patch ALL Node.js networking APIs

  // TCP
  const origConnect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (..._args: unknown[]) {
    // Allow connections to stdio (fd-based), block everything else
    throwBlocked()
  } as typeof net.Socket.prototype.connect

  // TLS/SSL
  const origTlsConnect = tls.connect
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
}

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

  if (platform === 'darwin') {
    const profile = generateSandboxProfile(projectRoot)
    return {
      command: 'sandbox-exec',
      args: ['-p', profile, 'node', serverPath],
    }
  }

  if (platform === 'linux') {
    return {
      command: 'unshare',
      args: ['--net', 'node', serverPath],
    }
  }

  // Fallback: no OS-level sandbox, rely on Layer 1 + 2
  return {
    command: 'node',
    args: [serverPath],
  }
}
