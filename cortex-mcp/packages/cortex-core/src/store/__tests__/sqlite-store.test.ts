import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  createSchema,
  insertProject,
  insertSymbols,
  getSymbolById,
  getSymbolsByIds,
  getSymbolsByFile,
  getProjectOutline,
  clearProjectData,
} from '../sqlite-store.js'
import type { Symbol } from '../../types/symbol.js'
import type { ProjectMeta } from '../../types/config.js'

function makeSymbol(overrides: Partial<Symbol> = {}): Symbol {
  return {
    id: 'test@abc::src/Main.java::com.app.Main#class',
    projectId: 'test@abc',
    filePath: 'src/Main.java',
    qualifiedName: 'com.app.Main',
    simpleName: 'Main',
    className: 'Main',
    packageName: 'com.app',
    kind: 'class',
    signature: 'public class Main',
    javadoc: 'The main entry point',
    annotations: ['@SpringBootApplication'],
    springRole: 'CONFIGURATION',
    hexRole: 'NONE',
    implementedInterfaces: [],
    parameterTypes: [],
    throwsTypes: [],
    byteOffset: 0,
    byteLength: 200,
    contentHash: 'abc123',
    ...overrides,
  }
}

const testMeta: ProjectMeta = {
  projectId: 'test@abc',
  projectName: 'test',
  projectRoot: '/tmp/test',
  toolVersion: '1.0.0',
  symbolCount: 0,
  schemaCount: 0,
  configCount: 0,
  fileHashes: {},
}

describe('sqlite-store', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    createSchema(db)
    insertProject(db, testMeta)
  })

  describe('CRUD', () => {
    it('inserts and retrieves a symbol', () => {
      const sym = makeSymbol()
      insertSymbols(db, [sym])

      const loaded = getSymbolById(db, sym.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(sym.id)
      expect(loaded!.qualifiedName).toBe('com.app.Main')
      expect(loaded!.signature).toBe('public class Main')
      expect(loaded!.annotations).toEqual(['@SpringBootApplication'])
      expect(loaded!.springRole).toBe('CONFIGURATION')
    })

    it('returns null for missing symbol', () => {
      const loaded = getSymbolById(db, 'nonexistent')
      expect(loaded).toBeNull()
    })

    it('batch retrieves symbols by ids', () => {
      insertSymbols(db, [
        makeSymbol({ id: 'sym1', simpleName: 'A' }),
        makeSymbol({ id: 'sym2', simpleName: 'B' }),
        makeSymbol({ id: 'sym3', simpleName: 'C' }),
      ])

      const loaded = getSymbolsByIds(db, ['sym1', 'sym3'])
      expect(loaded).toHaveLength(2)
    })

    it('retrieves symbols by file', () => {
      insertSymbols(db, [
        makeSymbol({ id: 's1', filePath: 'src/A.java' }),
        makeSymbol({ id: 's2', filePath: 'src/A.java' }),
        makeSymbol({ id: 's3', filePath: 'src/B.java' }),
      ])

      const inA = getSymbolsByFile(db, 'test@abc', 'src/A.java')
      expect(inA).toHaveLength(2)

      const inB = getSymbolsByFile(db, 'test@abc', 'src/B.java')
      expect(inB).toHaveLength(1)
    })
  })

  describe('FTS5', () => {
    it('finds symbols by simple name (CamelCase-split)', () => {
      insertSymbols(db, [
        makeSymbol({ id: 's1', simpleName: 'OrderHandler', signature: 'public class OrderHandler' }),
        makeSymbol({ id: 's2', simpleName: 'UserService', signature: 'public class UserService' }),
      ])

      // FTS5 stores CamelCase-split text: "Order Handler"
      const results = db.prepare(`
        SELECT id FROM symbols_fts WHERE symbols_fts MATCH 'Order Handler'
      `).all() as any[]

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('s1')
    })

    it('finds symbols by javadoc content', () => {
      insertSymbols(db, [
        makeSymbol({ id: 's1', javadoc: 'Handles order creation and validation' }),
        makeSymbol({ id: 's2', javadoc: 'Manages user authentication' }),
      ])

      const results = db.prepare(`
        SELECT id FROM symbols_fts WHERE symbols_fts MATCH 'order creation'
      `).all() as any[]

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('s1')
    })

    it('finds symbols by package name', () => {
      insertSymbols(db, [
        makeSymbol({ id: 's1', packageName: 'com.app.order.application' }),
        makeSymbol({ id: 's2', packageName: 'com.app.user.domain' }),
      ])

      const results = db.prepare(`
        SELECT id FROM symbols_fts WHERE symbols_fts MATCH 'order application'
      `).all() as any[]

      expect(results).toHaveLength(1)
      expect(results[0].id).toBe('s1')
    })
  })

  describe('project outline', () => {
    it('aggregates symbols by package and kind', () => {
      insertSymbols(db, [
        makeSymbol({ id: 's1', packageName: 'com.app.order', kind: 'class' }),
        makeSymbol({ id: 's2', packageName: 'com.app.order', kind: 'method' }),
        makeSymbol({ id: 's3', packageName: 'com.app.user', kind: 'class' }),
      ])

      // Update project symbol count
      db.prepare('UPDATE projects SET symbol_count = 3 WHERE id = ?').run('test@abc')

      const outline = getProjectOutline(db, 'test@abc')
      expect(outline).not.toBeNull()
      expect(outline!.totalSymbols).toBe(3)
      expect(outline!.packages).toHaveLength(2)
      expect(outline!.kindCounts).toHaveLength(2)
    })
  })

  describe('clearProjectData', () => {
    it('removes all data for a project', () => {
      insertSymbols(db, [makeSymbol()])
      clearProjectData(db, 'test@abc')

      const sym = getSymbolById(db, 'test@abc::src/Main.java::com.app.Main#class')
      expect(sym).toBeNull()

      const outline = getProjectOutline(db, 'test@abc')
      expect(outline).toBeNull()
    })
  })
})
