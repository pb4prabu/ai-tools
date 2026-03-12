import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SafeFS } from '../../security/fs-guard.js'
import {
  initCondexDir,
  writeSymbolFile,
  readSymbolFiles,
  removeSymbolFilesForSource,
  writeMeta,
  readMeta,
  acquireIndexLock,
  releaseIndexLock,
  hashContent,
} from '../fs-store.js'
import type { Symbol } from '../../types/symbol.js'
import type { ProjectMeta } from '../../types/config.js'

function makeTestSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    id: 'test@abc123::src/Main.java::com.app.Main#class',
    projectId: 'test@abc123',
    filePath: 'src/Main.java',
    qualifiedName: 'com.app.Main',
    simpleName: 'Main',
    className: 'Main',
    packageName: 'com.app',
    kind: 'class',
    signature: 'public class Main',
    annotations: [],
    implementedInterfaces: [],
    parameterTypes: [],
    throwsTypes: [],
    byteOffset: 0,
    byteLength: 100,
    contentHash: 'abc123',
    ...overrides,
  }
}

describe('fs-store', () => {
  let tmpDir: string
  let safeFs: SafeFS

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-test-'))
    safeFs = new SafeFS(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('initCondexDir', () => {
    it('creates .condex directory structure', async () => {
      await initCondexDir(safeFs)
      expect(fs.existsSync(path.join(tmpDir, '.condex', 'index', 'symbols'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, '.condex', 'index', 'schema'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, '.condex', 'index', 'config'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, '.condex', '.gitignore'))).toBe(true)
    })
  })

  describe('symbol files', () => {
    beforeEach(async () => {
      await initCondexDir(safeFs)
    })

    it('write and read round-trip', async () => {
      const symbol = makeTestSymbol()
      await writeSymbolFile(safeFs, symbol)

      const symbols = await readSymbolFiles(safeFs)
      expect(symbols).toHaveLength(1)
      expect(symbols[0].id).toBe(symbol.id)
      expect(symbols[0].qualifiedName).toBe('com.app.Main')
    })

    it('handles multiple symbols', async () => {
      await writeSymbolFile(safeFs, makeTestSymbol({ id: 'sym1', simpleName: 'A' }))
      await writeSymbolFile(safeFs, makeTestSymbol({ id: 'sym2', simpleName: 'B' }))
      await writeSymbolFile(safeFs, makeTestSymbol({ id: 'sym3', simpleName: 'C' }))

      const symbols = await readSymbolFiles(safeFs)
      expect(symbols).toHaveLength(3)
    })

    it('removes symbols by source file', async () => {
      await writeSymbolFile(safeFs, makeTestSymbol({
        id: 'sym1',
        filePath: 'src/A.java',
      }))
      await writeSymbolFile(safeFs, makeTestSymbol({
        id: 'sym2',
        filePath: 'src/A.java',
      }))
      await writeSymbolFile(safeFs, makeTestSymbol({
        id: 'sym3',
        filePath: 'src/B.java',
      }))

      const removed = await removeSymbolFilesForSource(safeFs, 'src/A.java')
      expect(removed).toBe(2)

      const remaining = await readSymbolFiles(safeFs)
      expect(remaining).toHaveLength(1)
      expect(remaining[0].filePath).toBe('src/B.java')
    })
  })

  describe('meta', () => {
    beforeEach(async () => {
      await initCondexDir(safeFs)
    })

    it('write and read round-trip', async () => {
      const meta: ProjectMeta = {
        projectId: 'test@abc123',
        projectName: 'test',
        projectRoot: tmpDir,
        toolVersion: '1.0.0',
        symbolCount: 42,
        schemaCount: 5,
        configCount: 10,
        fileHashes: { 'src/Main.java': 'deadbeef' },
      }

      await writeMeta(safeFs, meta)
      const loaded = await readMeta(safeFs)

      expect(loaded).not.toBeNull()
      expect(loaded!.projectId).toBe('test@abc123')
      expect(loaded!.symbolCount).toBe(42)
      expect(loaded!.fileHashes['src/Main.java']).toBe('deadbeef')
    })

    it('returns null when no meta exists', async () => {
      const meta = await readMeta(safeFs)
      expect(meta).toBeNull()
    })
  })

  describe('lockfile', () => {
    beforeEach(async () => {
      await initCondexDir(safeFs)
    })

    it('acquires and releases lock', async () => {
      const acquired = await acquireIndexLock(safeFs)
      expect(acquired).toBe(true)

      await releaseIndexLock(safeFs)
      // Can acquire again after release
      const reacquired = await acquireIndexLock(safeFs)
      expect(reacquired).toBe(true)
      await releaseIndexLock(safeFs)
    })

    it('blocks concurrent lock', async () => {
      const first = await acquireIndexLock(safeFs)
      expect(first).toBe(true)

      const second = await acquireIndexLock(safeFs)
      expect(second).toBe(false)

      await releaseIndexLock(safeFs)
    })
  })

  describe('hashContent', () => {
    it('produces deterministic hash', () => {
      const h1 = hashContent('hello world')
      const h2 = hashContent('hello world')
      expect(h1).toBe(h2)
    })

    it('produces different hash for different content', () => {
      const h1 = hashContent('hello')
      const h2 = hashContent('world')
      expect(h1).not.toBe(h2)
    })
  })
})
