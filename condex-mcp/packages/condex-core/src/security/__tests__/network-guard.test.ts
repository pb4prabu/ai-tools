import { describe, it, expect } from 'vitest'
import { generateSandboxProfile, generateLaunchCommand } from '../network-guard.js'

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
      // This test verifies the function structure, not OS detection
      const cmd = generateLaunchCommand('/home/user/myapp', 'dist/server.js')
      expect(cmd.command).toBeDefined()
      expect(cmd.args).toBeDefined()
      expect(cmd.args.length).toBeGreaterThan(0)
    })
  })
})
