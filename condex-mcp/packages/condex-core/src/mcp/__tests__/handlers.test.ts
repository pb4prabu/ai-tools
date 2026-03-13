import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createSchema, insertProject, insertSymbols } from '../../store/sqlite-store.js'
import { SafeFS } from '../../security/fs-guard.js'
import type { HandlerContext } from '../handlers.js'
import {
  handleListProjects,
  handleGetProjectOutline,
  handleGetFileOutline,
  handleSearchSymbols,
  handleSearchSchema,
  handleGetContextForTask,
} from '../handlers.js'
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

describe('MCP handlers', () => {
  let db: Database.Database
  let ctx: HandlerContext

  beforeEach(() => {
    db = new Database(':memory:')
    createSchema(db)
    insertProject(db, {
      projectId: 'test@abc',
      projectName: 'test',
      projectRoot: '/tmp/test',
      toolVersion: '1.0.0',
      symbolCount: 3,
      schemaCount: 0,
      configCount: 0,
      fileHashes: {},
    })

    insertSymbols(db, [
      sym({
        id: 's1',
        simpleName: 'CreateOrderHandler',
        className: 'CreateOrderHandler',
        qualifiedName: 'com.app.order.CreateOrderHandler',
        packageName: 'com.app.order',
        signature: 'public class CreateOrderHandler implements CreateOrderUseCase',
        javadoc: 'Handles order creation and validation',
        springRole: 'SERVICE',
        hexRole: 'USE_CASE_HANDLER',
        filePath: 'src/order/CreateOrderHandler.java',
      }),
      sym({
        id: 's2',
        simpleName: 'OrderRepository',
        className: 'OrderRepository',
        qualifiedName: 'com.app.order.OrderRepository',
        packageName: 'com.app.order',
        kind: 'interface',
        signature: 'public interface OrderRepository',
        javadoc: 'Repository for persisting orders',
        hexRole: 'OUTBOUND_PORT',
        filePath: 'src/order/OrderRepository.java',
      }),
      sym({
        id: 's3',
        simpleName: 'UserService',
        className: 'UserService',
        qualifiedName: 'com.app.user.UserService',
        packageName: 'com.app.user',
        signature: 'public class UserService',
        javadoc: 'Manages user authentication',
        springRole: 'SERVICE',
        filePath: 'src/user/UserService.java',
      }),
    ])

    ctx = {
      db,
      safeFs: new SafeFS('/tmp/test'),
      projectId: 'test@abc',
      projectName: 'test',
      architecture: 'hexagonal',
      searchMode: 'bm25',
      embedder: null,
      thresholds: {
        bm25MinScore: 0.3,
        vectorMaxDistance: 0.95,
        smartBm25MinScore: 0.5,
        smartVectorMaxDistance: 0.90,
      },
    }
  })

  describe('list_projects', () => {
    it('returns project list', async () => {
      const result = await handleListProjects(ctx)
      const data = JSON.parse(result.content[0].text)
      expect(data).toHaveLength(1)
      expect(data[0].projectId).toBe('test@abc')
      expect(data[0].name).toBe('test')
    })

    it('includes _meta', async () => {
      const result = await handleListProjects(ctx)
      expect(result._meta).toBeDefined()
      expect((result._meta as any).projectId).toBe('test@abc')
    })
  })

  describe('get_project_outline', () => {
    it('returns project outline', async () => {
      // Update symbol count
      db.prepare('UPDATE projects SET symbol_count = 3 WHERE id = ?').run('test@abc')

      const result = await handleGetProjectOutline(ctx, {})
      const data = JSON.parse(result.content[0].text)
      expect(data.totalSymbols).toBe(3)
      expect(data.packages).toHaveLength(2)
    })

    it('returns error for missing project', async () => {
      const result = await handleGetProjectOutline(ctx, { projectId: 'nope' })
      expect(result.content[0].text).toContain('No project found')
    })
  })

  describe('get_file_outline', () => {
    it('returns symbols in a file', async () => {
      const result = await handleGetFileOutline(ctx, {
        filePath: 'src/order/CreateOrderHandler.java',
      })
      const data = JSON.parse(result.content[0].text)
      expect(data).toHaveLength(1)
      expect(data[0].simpleName).toBe('CreateOrderHandler')
      expect(data[0].signature).toContain('CreateOrderHandler')
    })

    it('returns message for empty file', async () => {
      const result = await handleGetFileOutline(ctx, { filePath: 'nonexistent.java' })
      expect(result.content[0].text).toContain('No symbols found')
    })
  })

  describe('search_symbols', () => {
    it('finds symbols by query', async () => {
      const result = await handleSearchSymbols(ctx, { query: 'CreateOrderHandler' })
      const data = JSON.parse(result.content[0].text)
      expect(data.length).toBeGreaterThan(0)
      expect(data[0].qualifiedName).toContain('Order')
    })

    it('filters by kind', async () => {
      const result = await handleSearchSymbols(ctx, {
        query: 'OrderRepository persisting',
        kind: 'interface',
      })
      const data = JSON.parse(result.content[0].text)
      expect(data).toHaveLength(1)
      expect(data[0].kind).toBe('interface')
    })

    it('returns no results message for no matches', async () => {
      const result = await handleSearchSymbols(ctx, { query: 'xyznonexistent' })
      expect(result.content[0].text).toContain('No symbols found')
      // With score-threshold approach, confidenceGateFired is false for BM25 mode
      expect((result._meta as any).confidenceGateFired).toBe(false)
    })

    it('includes _meta with token savings', async () => {
      const result = await handleSearchSymbols(ctx, { query: 'order creation' })
      const meta = result._meta as any
      expect(meta).toBeDefined()
      expect(meta.symbolsReturned).toBeGreaterThan(0)
      expect(meta.timingMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('get_context_for_task', () => {
    it('assembles context within token budget', async () => {
      const result = await handleGetContextForTask(ctx, {
        task: 'add validation to order creation',
        tokenBudget: 2000,
      })
      const data = JSON.parse(result.content[0].text)
      expect(data.symbols).toBeDefined()
      expect(data.tokensUsed).toBeLessThanOrEqual(2000)
    })

    it('returns empty symbols when gate fires', async () => {
      const result = await handleGetContextForTask(ctx, {
        task: 'xyznonexistent',
      })
      const data = JSON.parse(result.content[0].text)
      expect(data.confidenceGateFired).toBe(true)
      expect(data.symbols).toHaveLength(0)
    })
  })

  describe('search_schema', () => {
    it('returns empty for no schema data', async () => {
      const result = await handleSearchSchema(ctx, { query: 'orders' })
      expect(result.content[0].text).toContain('No schema matches')
    })
  })
})
