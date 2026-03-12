import { describe, it, expect } from 'vitest'
import { SafeFS } from '../fs-guard.js'

describe('SafeFS', () => {
  const safeFs = new SafeFS('/home/user/myapp')

  describe('assertReadAllowed', () => {
    it('allows reads within project root', () => {
      expect(() => safeFs.assertReadAllowed('/home/user/myapp/src/main.java')).not.toThrow()
    })

    it('allows reading project root itself', () => {
      expect(() => safeFs.assertReadAllowed('/home/user/myapp')).not.toThrow()
    })

    it('blocks reads outside project root', () => {
      expect(() => safeFs.assertReadAllowed('/home/user/.ssh/id_rsa')).toThrow('FS_BLOCKED')
    })

    it('blocks reads to parent directory', () => {
      expect(() => safeFs.assertReadAllowed('/home/user')).toThrow('FS_BLOCKED')
    })

    it('blocks path traversal attacks', () => {
      expect(() => safeFs.assertReadAllowed('/home/user/myapp/../.ssh/id_rsa')).toThrow('FS_BLOCKED')
    })
  })

  describe('assertWriteAllowed', () => {
    it('allows writes within .condex/', () => {
      expect(() => safeFs.assertWriteAllowed('/home/user/myapp/.condex/index/symbols/test.json')).not.toThrow()
    })

    it('blocks writes to project source files', () => {
      expect(() => safeFs.assertWriteAllowed('/home/user/myapp/src/main.java')).toThrow('FS_BLOCKED')
    })

    it('blocks writes outside project', () => {
      expect(() => safeFs.assertWriteAllowed('/tmp/evil.sh')).toThrow('FS_BLOCKED')
    })
  })

  describe('getters', () => {
    it('returns correct project root', () => {
      expect(safeFs.getProjectRoot()).toBe('/home/user/myapp')
    })

    it('returns correct condex dir', () => {
      expect(safeFs.getCondexDir()).toBe('/home/user/myapp/.condex')
    })

    it('returns correct index dir', () => {
      expect(safeFs.getIndexDir()).toBe('/home/user/myapp/.condex/index')
    })
  })
})
