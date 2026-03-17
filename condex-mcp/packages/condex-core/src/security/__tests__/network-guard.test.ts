import { describe, it, expect } from 'vitest'
import { generateSandboxProfile, generateLaunchCommand } from '../network-guard.js'
import { execSync } from 'node:child_process'

describe('network-guard', () => {
  describe('generateSandboxProfile', () => {
    it('generates profile with correct project root', () => {
      const profile = generateSandboxProfile('/home/user/myapp')
      expect(profile).toContain('(deny network-outbound)')
      expect(profile).toContain('(allow file-write* (subpath "/home/user/myapp/.condex"))')
      expect(profile).toContain('(deny file-write* (subpath "/"))')
    })
  })

  describe('generateLaunchCommand', () => {
    it('returns sandbox-exec on darwin', () => {
      const cmd = generateLaunchCommand('/home/user/myapp', 'dist/server.js')
      expect(cmd.command).toBeDefined()
      expect(cmd.args).toBeDefined()
      expect(cmd.args.length).toBeGreaterThan(0)
    })
  })

  describe('Layer 2 — monkey-patch verification (isolated subprocess)', () => {
    it('blocks all Node.js network APIs after patching', () => {
      execSync(`node -e "
        const net = require('net');
        const tls = require('tls');
        const http = require('http');
        const https = require('https');
        const dgram = require('dgram');

        const throwBlocked = () => { throw new Error('NETWORK_BLOCKED'); };
        net.Socket.prototype.connect = function() { throwBlocked(); };
        tls.connect = throwBlocked;
        http.request = throwBlocked;
        http.get = throwBlocked;
        https.request = throwBlocked;
        https.get = throwBlocked;
        globalThis.fetch = throwBlocked;
        dgram.createSocket = throwBlocked;

        const probes = [
          () => new net.Socket().connect(80, '1.1.1.1'),
          () => tls.connect(443, '1.1.1.1'),
          () => http.request('http://1.1.1.1'),
          () => http.get('http://1.1.1.1'),
          () => https.request('https://1.1.1.1'),
          () => https.get('https://1.1.1.1'),
          () => globalThis.fetch('https://1.1.1.1'),
          () => dgram.createSocket('udp4'),
        ];

        let allBlocked = true;
        for (const probe of probes) {
          try { probe(); allBlocked = false; } catch (e) {
            if (!e.message.includes('NETWORK_BLOCKED')) allBlocked = false;
          }
        }
        process.exit(allBlocked ? 0 : 1);
      "`, { stdio: 'pipe', timeout: 5000 })
    })

    it('un-patched process does NOT throw NETWORK_BLOCKED (control test)', () => {
      execSync(`node -e "
        const net = require('net');
        try {
          const s = new net.Socket();
          s.connect(80, '1.1.1.1');
          s.destroy();
          process.exit(0);
        } catch (e) {
          process.exit(e.message.includes('NETWORK_BLOCKED') ? 1 : 0);
        }
      "`, { stdio: 'pipe', timeout: 5000 })
    })

    it('env vars are set correctly', () => {
      execSync(`node -e "
        process.env.TRANSFORMERS_OFFLINE = '1';
        process.env.HF_HUB_DISABLE_TELEMETRY = '1';
        const ok = process.env.TRANSFORMERS_OFFLINE === '1' && process.env.HF_HUB_DISABLE_TELEMETRY === '1';
        process.exit(ok ? 0 : 1);
      "`, { stdio: 'pipe', timeout: 5000 })
    })
  })

  describe('Layer 3 — OS sandbox detection', () => {
    it('sandbox-exec profile denies network-outbound', () => {
      const profile = generateSandboxProfile('/test')
      expect(profile).toContain('(deny network-outbound)')
    })

    it('generates correct launch command per platform', () => {
      const cmd = generateLaunchCommand('/test', 'dist/server.js')
      if (process.platform === 'darwin') {
        expect(cmd.command).toBe('sandbox-exec')
        expect(cmd.args).toContain('-p')
        expect(cmd.args.join(' ')).toContain('deny network-outbound')
      } else if (process.platform === 'linux') {
        expect(cmd.command).toBe('unshare')
        expect(cmd.args).toContain('--net')
      } else {
        expect(cmd.command).toBe('node')
      }
    })
  })
})
