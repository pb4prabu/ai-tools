import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { createSchema, insertProject, insertSymbols } from '../../store/sqlite-store.js'
import { IncrementalReindexer } from '../incremental-reindexer.js'
import type { Symbol } from '../../types/symbol.js'

function sym(overrides: Partial<Symbol>): Symbol {
  return {
    id: 'test@abc::src/Main.java::Main#class',
    projectId: 'test@abc',
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
    contentHash: 'abc',
    ...overrides,
  }
}

describe('IncrementalReindexer', () => {
  let db: Database.Database
  let tmpDir: string
  const projectId = 'test@abc'

  beforeEach(() => {
    db = new Database(':memory:')
    createSchema(db)
    insertProject(db, {
      projectId,
      projectName: 'test',
      projectRoot: '/tmp/test',
      toolVersion: '1.0.0',
      symbolCount: 0,
      schemaCount: 0,
      configCount: 0,
      fileHashes: {},
    })

    // Create a temp dir to simulate a project
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-test-'))
    // Create a pom.xml so language is detected as java
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>')
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createJavaFile(relPath: string, content: string) {
    const absPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content)
  }

  it('returns 0 when no parser is provided', async () => {
    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
    })
    reindexer.initializeHashes({})
    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(0)
  })

  it('returns 0 when not initialized', async () => {
    const parseFileWithRefs = vi.fn().mockReturnValue({ symbols: [], refs: [] })
    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })
    // Don't call initializeHashes
    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(0)
    expect(parseFileWithRefs).not.toHaveBeenCalled()
  })

  it('detects new files and re-indexes them (BM25)', async () => {
    const newSymbol = sym({
      id: `${projectId}::src/Order.java::Order#class`,
      filePath: 'src/Order.java',
      qualifiedName: 'com.app.Order',
      simpleName: 'Order',
      className: 'Order',
      signature: 'public class Order',
    })

    const parseFileWithRefs = vi.fn().mockReturnValue({
      symbols: [newSymbol],
      refs: [],
    })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    // Initialize with empty hashes (no files tracked yet)
    reindexer.initializeHashes({})

    // Create a new java file
    createJavaFile('src/Order.java', 'public class Order {}')

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(1) // 1 file changed
    expect(parseFileWithRefs).toHaveBeenCalledTimes(1)

    // Verify symbol was inserted into DB
    const rows = db.prepare('SELECT * FROM symbols WHERE id = ?').all(newSymbol.id)
    expect(rows).toHaveLength(1)

    // Verify FTS entry exists
    const ftsRows = db.prepare(
      "SELECT * FROM symbols_fts WHERE symbols_fts MATCH 'Order'"
    ).all()
    expect(ftsRows.length).toBeGreaterThan(0)
  })

  it('detects changed files and re-indexes them', async () => {
    // Insert initial symbol
    const initialSymbol = sym({
      id: `${projectId}::src/Order.java::Order#class`,
      filePath: 'src/Order.java',
      qualifiedName: 'com.app.Order',
      simpleName: 'Order',
      signature: 'public class Order',
    })
    insertSymbols(db, [initialSymbol])

    // Create the file with initial content
    createJavaFile('src/Order.java', 'public class Order {}')

    // Compute hash of initial content
    const crypto = require('node:crypto')
    const initialHash = crypto.createHash('sha256').update('public class Order {}').digest('hex').slice(0, 20)

    const updatedSymbol = sym({
      id: `${projectId}::src/Order.java::Order#class`,
      filePath: 'src/Order.java',
      qualifiedName: 'com.app.Order',
      simpleName: 'Order',
      signature: 'public class Order implements Serializable',
    })

    const parseFileWithRefs = vi.fn().mockReturnValue({
      symbols: [updatedSymbol],
      refs: [],
    })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    // Initialize with the hash of the initial content
    reindexer.initializeHashes({ 'src/Order.java': initialHash })

    // Modify the file
    createJavaFile('src/Order.java', 'public class Order implements Serializable {}')

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(1)
    expect(parseFileWithRefs).toHaveBeenCalledTimes(1)

    // Verify the symbol was updated
    const row = db.prepare('SELECT * FROM symbols WHERE id = ?').get(updatedSymbol.id) as any
    expect(row.signature).toBe('public class Order implements Serializable')
  })

  it('returns 0 when no files have changed', async () => {
    const content = 'public class Order {}'
    createJavaFile('src/Order.java', content)

    const crypto = require('node:crypto')
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 20)

    const parseFileWithRefs = vi.fn().mockReturnValue({ symbols: [], refs: [] })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    reindexer.initializeHashes({ 'src/Order.java': hash })

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(0)
    expect(parseFileWithRefs).not.toHaveBeenCalled()
  })

  it('handles deleted files by removing their symbols', async () => {
    // Insert initial symbol for a file
    const initialSymbol = sym({
      id: `${projectId}::src/Deleted.java::Deleted#class`,
      filePath: 'src/Deleted.java',
      qualifiedName: 'com.app.Deleted',
      simpleName: 'Deleted',
      signature: 'public class Deleted',
    })
    insertSymbols(db, [initialSymbol])

    const parseFileWithRefs = vi.fn().mockReturnValue({ symbols: [], refs: [] })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    // Initialize with hash for a file that no longer exists on disk
    reindexer.initializeHashes({ 'src/Deleted.java': 'oldhash' })

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(1) // deleted file counts as changed

    // Verify symbol was removed from DB
    const rows = db.prepare('SELECT * FROM symbols WHERE id = ?').all(initialSymbol.id)
    expect(rows).toHaveLength(0)
  })

  it('updates vector index when embedder is provided', async () => {
    const newSymbol = sym({
      id: `${projectId}::src/Vec.java::Vec#class`,
      filePath: 'src/Vec.java',
      qualifiedName: 'com.app.Vec',
      simpleName: 'Vec',
      signature: 'public class Vec',
    })

    const parseFileWithRefs = vi.fn().mockReturnValue({
      symbols: [newSymbol],
      refs: [],
    })

    // Mock embedder
    const mockEmbedding = new Float32Array(768).fill(0.1)
    const mockEmbedder = {
      dimensions: 768,
      embed: vi.fn().mockResolvedValue(mockEmbedding),
      embedBatch: vi.fn().mockResolvedValue([mockEmbedding]),
    }

    const prepareSymbolText = vi.fn().mockReturnValue('class com.app.Vec public class Vec')

    // Load sqlite-vec extension and create virtual table
    let hasVec = false
    try {
      const sqliteVec = require('sqlite-vec')
      sqliteVec.load(db)
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS symbol_vectors USING vec0(
          symbol_id TEXT PRIMARY KEY,
          embedding float[768]
        )
      `)
      hasVec = true
    } catch {
      // sqlite-vec not available in test env — skip vector assertions
    }

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
      embedder: mockEmbedder,
      prepareSymbolText,
    })

    reindexer.initializeHashes({})
    createJavaFile('src/Vec.java', 'public class Vec {}')

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(1)

    // Verify embedder was called
    expect(mockEmbedder.embedBatch).toHaveBeenCalledTimes(1)
    expect(prepareSymbolText).toHaveBeenCalledWith({
      qualifiedName: 'com.app.Vec',
      signature: 'public class Vec',
      javadoc: undefined,
      kind: 'class',
    })

    if (hasVec) {
      // Verify vector was inserted
      const vecRows = db.prepare('SELECT * FROM symbol_vectors WHERE symbol_id = ?').all(newSymbol.id)
      expect(vecRows).toHaveLength(1)
    }
  })

  it('re-indexes multiple changed files in one call', async () => {
    const sym1 = sym({
      id: `${projectId}::src/A.java::A#class`,
      filePath: 'src/A.java',
      qualifiedName: 'com.app.A',
      simpleName: 'A',
      signature: 'public class A',
    })
    const sym2 = sym({
      id: `${projectId}::src/B.java::B#class`,
      filePath: 'src/B.java',
      qualifiedName: 'com.app.B',
      simpleName: 'B',
      signature: 'public class B',
    })

    const parseFileWithRefs = vi.fn()
      .mockReturnValueOnce({ symbols: [sym1], refs: [] })
      .mockReturnValueOnce({ symbols: [sym2], refs: [] })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    reindexer.initializeHashes({})
    createJavaFile('src/A.java', 'public class A {}')
    createJavaFile('src/B.java', 'public class B {}')

    const result = await reindexer.reindexIfNeeded()
    expect(result).toBe(2)
    expect(parseFileWithRefs).toHaveBeenCalledTimes(2)

    // Both symbols should be in DB
    const rows = db.prepare('SELECT * FROM symbols WHERE project_id = ?').all(projectId)
    expect(rows).toHaveLength(2)
  })

  it('second call returns 0 after first call indexes files', async () => {
    const newSymbol = sym({
      id: `${projectId}::src/Stable.java::Stable#class`,
      filePath: 'src/Stable.java',
      qualifiedName: 'com.app.Stable',
      simpleName: 'Stable',
      signature: 'public class Stable',
    })

    const parseFileWithRefs = vi.fn().mockReturnValue({
      symbols: [newSymbol],
      refs: [],
    })

    const reindexer = new IncrementalReindexer({
      db,
      projectRoot: tmpDir,
      projectId,
      parseFileWithRefs,
    })

    reindexer.initializeHashes({})
    createJavaFile('src/Stable.java', 'public class Stable {}')

    // First call — detects the new file
    const result1 = await reindexer.reindexIfNeeded()
    expect(result1).toBe(1)

    // Second call — nothing changed since we updated the hash
    const result2 = await reindexer.reindexIfNeeded()
    expect(result2).toBe(0)
  })
})
