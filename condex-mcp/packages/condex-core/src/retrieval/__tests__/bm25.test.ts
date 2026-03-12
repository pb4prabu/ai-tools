import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSchema, insertProject, insertSymbols } from '../../store/sqlite-store.js'
import { searchBM25 } from '../bm25.js'
import { applyConfidenceGate } from '../confidence-gate.js'
import type { Symbol } from '../../types/symbol.js'
import type { ProjectMeta } from '../../types/config.js'

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

describe('BM25 search', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createSchema(db)
    insertProject(db, {
      projectId: 'test@abc',
      projectName: 'test',
      projectRoot: '/tmp/test',
      toolVersion: '1.0.0',
      symbolCount: 0,
      schemaCount: 0,
      configCount: 0,
      fileHashes: {},
    })

    insertSymbols(db, [
      sym({
        id: 's1',
        simpleName: 'CreateOrderHandler',
        className: 'CreateOrderHandler',
        qualifiedName: 'com.app.order.application.CreateOrderHandler',
        packageName: 'com.app.order.application',
        signature: 'public class CreateOrderHandler implements CreateOrderUseCase',
        javadoc: 'Handles order creation and validation',
        springRole: 'SERVICE',
        hexRole: 'USE_CASE_HANDLER',
      }),
      sym({
        id: 's2',
        simpleName: 'OrderRepositoryPort',
        className: 'OrderRepositoryPort',
        qualifiedName: 'com.app.order.domain.OrderRepositoryPort',
        packageName: 'com.app.order.domain',
        kind: 'interface',
        signature: 'public interface OrderRepositoryPort',
        javadoc: 'Port for persisting orders to database',
        hexRole: 'OUTBOUND_PORT',
      }),
      sym({
        id: 's3',
        simpleName: 'UserService',
        className: 'UserService',
        qualifiedName: 'com.app.user.UserService',
        packageName: 'com.app.user',
        signature: 'public class UserService',
        javadoc: 'Manages user authentication and profiles',
        springRole: 'SERVICE',
      }),
    ])
  })

  it('finds by simple name', () => {
    const results = searchBM25(db, 'CreateOrderHandler', 'test@abc')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbolId).toBe('s1')
  })

  it('finds by partial name', () => {
    const results = searchBM25(db, 'order handler', 'test@abc')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbolId).toBe('s1')
  })

  it('finds by javadoc content', () => {
    const results = searchBM25(db, 'persisting orders database', 'test@abc')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbolId).toBe('s2')
  })

  it('finds by dotted qualified name', () => {
    const results = searchBM25(db, 'com.app.order.application', 'test@abc')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].symbolId).toBe('s1')
  })

  it('filters by kind', () => {
    // Use minScore=0 because single-word "order" has very low BM25 in a small corpus
    const results = searchBM25(db, 'order', 'test@abc', { kind: 'interface' }, 0)
    expect(results.length).toBe(1)
    expect(results[0].symbolId).toBe('s2')
  })

  it('filters by springRole', () => {
    const results = searchBM25(db, 'service', 'test@abc', { springRole: 'SERVICE' })
    expect(results.length).toBeGreaterThan(0)
    results.forEach(r => expect(r.springRole).toBe('SERVICE'))
  })

  it('returns empty for no match', () => {
    const results = searchBM25(db, 'xyznonexistent', 'test@abc')
    expect(results).toHaveLength(0)
  })

  it('returns empty for wrong project', () => {
    const results = searchBM25(db, 'CreateOrderHandler', 'wrong@project')
    expect(results).toHaveLength(0)
  })
})

describe('confidence gate', () => {
  it('passes when top score above threshold', () => {
    const results = [
      { symbolId: 's1', bm25Score: 0.5 } as any,
      { symbolId: 's2', bm25Score: 0.3 } as any,
      { symbolId: 's3', bm25Score: 0.05 } as any,
    ]
    const gate = applyConfidenceGate(results, 0.12)
    expect(gate.passed).toBe(true)
    expect(gate.results).toHaveLength(2) // s3 filtered out
    expect(gate.topScore).toBe(0.5)
  })

  it('fails when top score below threshold', () => {
    const results = [
      { symbolId: 's1', bm25Score: 0.05 } as any,
    ]
    const gate = applyConfidenceGate(results, 0.12)
    expect(gate.passed).toBe(false)
    expect(gate.results).toHaveLength(0)
    expect(gate.reason).toBe('BELOW_CONFIDENCE_THRESHOLD')
  })

  it('fails on empty results', () => {
    const gate = applyConfidenceGate([], 0.12)
    expect(gate.passed).toBe(false)
    expect(gate.reason).toBe('NO_RESULTS')
  })
})
