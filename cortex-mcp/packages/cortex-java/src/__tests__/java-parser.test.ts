import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseJavaFile } from '../parser/java-parser.js'
import { assignSpringRole } from '../parser/spring-tagger.js'
import { detectArchitecture, type ProjectProfile } from '../parser/arch-detector.js'
import { assignHexRole } from '../parser/hex-role-tagger.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')

describe('Java parser', () => {
  const orderServiceContent = fs.readFileSync(
    path.join(FIXTURES, 'OrderService.java'),
    'utf-8'
  )
  const orderRepoContent = fs.readFileSync(
    path.join(FIXTURES, 'OrderRepository.java'),
    'utf-8'
  )

  describe('parseJavaFile', () => {
    it('extracts class declaration', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const classSymbol = symbols.find(s => s.kind === 'class' && s.simpleName === 'OrderService')
      expect(classSymbol).toBeDefined()
      expect(classSymbol!.qualifiedName).toBe('com.app.order.application.OrderService')
      expect(classSymbol!.packageName).toBe('com.app.order.application')
      expect(classSymbol!.signature).toContain('class OrderService')
      expect(classSymbol!.implementedInterfaces).toContain('CreateOrderUseCase')
    })

    it('extracts javadoc', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const classSymbol = symbols.find(s => s.simpleName === 'OrderService' && s.kind === 'class')
      expect(classSymbol!.javadoc).toContain('order creation')
    })

    it('extracts methods', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const methods = symbols.filter(s => s.kind === 'method')
      const methodNames = methods.map(m => m.simpleName)
      expect(methodNames).toContain('createOrder')
      expect(methodNames).toContain('getOrderById')
      expect(methodNames).toContain('validateItems')
    })

    it('extracts method parameters', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const createOrder = symbols.find(s => s.simpleName === 'createOrder')
      expect(createOrder).toBeDefined()
      expect(createOrder!.parameterTypes.length).toBeGreaterThan(0)
    })

    it('extracts constructors', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const constructors = symbols.filter(s => s.kind === 'constructor')
      expect(constructors.length).toBeGreaterThan(0)
    })

    it('extracts fields and constants', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const fields = symbols.filter(s => s.kind === 'field' || s.kind === 'constant')
      expect(fields.length).toBeGreaterThan(0)

      const constant = fields.find(s => s.simpleName === 'ORDER_PREFIX')
      expect(constant).toBeDefined()
      expect(constant!.kind).toBe('constant')
    })

    it('extracts inner enums', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const enums = symbols.filter(s => s.kind === 'enum')
      expect(enums.length).toBe(1)
      expect(enums[0].simpleName).toBe('OrderStatus')
    })

    it('extracts interface declarations', () => {
      const symbols = parseJavaFile(orderRepoContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderRepository.java',
      })

      const iface = symbols.find(s => s.kind === 'interface')
      expect(iface).toBeDefined()
      expect(iface!.simpleName).toBe('OrderRepository')
      expect(iface!.qualifiedName).toBe('com.app.order.domain.OrderRepository')
    })

    it('extracts interface methods', () => {
      const symbols = parseJavaFile(orderRepoContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderRepository.java',
      })

      const methods = symbols.filter(s => s.kind === 'method')
      expect(methods.length).toBe(3)
      const names = methods.map(m => m.simpleName)
      expect(names).toContain('save')
      expect(names).toContain('findById')
      expect(names).toContain('deleteById')
    })

    it('assigns Spring roles from annotations', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const classSymbol = symbols.find(s => s.simpleName === 'OrderService' && s.kind === 'class')
      expect(classSymbol!.springRole).toBe('SERVICE')
    })

    it('generates unique symbol IDs', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      const ids = symbols.map(s => s.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })

    it('sets byte offsets and hashes', () => {
      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/order/OrderService.java',
      })

      for (const s of symbols) {
        expect(s.byteOffset).toBeGreaterThanOrEqual(0)
        expect(s.byteLength).toBeGreaterThan(0)
        expect(s.contentHash).toHaveLength(12)
      }
    })

    it('handles hex role tagging with profile', () => {
      const profile: ProjectProfile = {
        architecture: 'hexagonal',
        confidence: 0.8,
        signals: [],
      }

      const symbols = parseJavaFile(orderServiceContent, {
        projectId: 'test@abc',
        filePath: 'src/main/java/com/app/order/application/OrderService.java',
        profile,
      })

      const classSymbol = symbols.find(s => s.simpleName === 'OrderService' && s.kind === 'class')
      // OrderService is in /application/ path, matches USE_CASE_HANDLER for Handler suffix
      // but simpleName is OrderService (no Handler suffix), so hex role depends on path
      expect(classSymbol!.hexRole).toBeDefined()
    })
  })
})

describe('Spring tagger', () => {
  it('maps @Service', () => {
    expect(assignSpringRole(['@Service'])).toBe('SERVICE')
  })

  it('maps @RestController', () => {
    expect(assignSpringRole(['@RestController'])).toBe('REST_CONTROLLER')
  })

  it('maps @Repository', () => {
    expect(assignSpringRole(['@Repository'])).toBe('REPOSITORY')
  })

  it('maps @Configuration', () => {
    expect(assignSpringRole(['@Configuration'])).toBe('CONFIGURATION')
  })

  it('maps @SpringBootApplication', () => {
    expect(assignSpringRole(['@SpringBootApplication'])).toBe('CONFIGURATION')
  })

  it('returns NONE for no annotations', () => {
    expect(assignSpringRole([])).toBe('NONE')
  })

  it('handles annotations with parameters', () => {
    expect(assignSpringRole(['@Service("orderService")'])).toBe('SERVICE')
  })
})

describe('Architecture detector', () => {
  it('detects hexagonal architecture', () => {
    const result = detectArchitecture([
      'src/main/java/com/app/order/application/CreateOrderHandler.java',
      'src/main/java/com/app/order/domain/Order.java',
      'src/main/java/com/app/order/domain/OrderRepositoryPort.java',
      'src/main/java/com/app/order/infrastructure/OrderRepositoryAdapter.java',
    ])
    expect(result.architecture).toBe('hexagonal')
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('detects layered architecture', () => {
    const result = detectArchitecture([
      'src/main/java/com/app/controller/OrderController.java',
      'src/main/java/com/app/service/OrderService.java',
      'src/main/java/com/app/repository/OrderRepository.java',
    ])
    expect(result.architecture).toBe('layered')
  })

  it('returns unknown for ambiguous structure', () => {
    const result = detectArchitecture([
      'src/main/java/com/app/Main.java',
      'src/main/java/com/app/Utils.java',
    ])
    expect(result.architecture).toBe('unknown')
  })
})

describe('Hex role tagger', () => {
  const hexProfile: ProjectProfile = {
    architecture: 'hexagonal',
    confidence: 0.8,
    signals: [],
  }

  it('tags ports', () => {
    expect(assignHexRole('com.app.OrderPort', 'src/domain/OrderPort.java', hexProfile)).toBe('INBOUND_PORT')
  })

  it('tags outbound ports in infrastructure', () => {
    expect(assignHexRole('com.app.OrderPort', 'src/infrastructure/OrderPort.java', hexProfile)).toBe('OUTBOUND_PORT')
  })

  it('tags adapters', () => {
    expect(assignHexRole('com.app.OrderAdapter', 'src/adapters/OrderAdapter.java', hexProfile)).toBe('ADAPTER')
  })

  it('tags use case handlers', () => {
    expect(assignHexRole('com.app.CreateOrderHandler', 'src/application/CreateOrderHandler.java', hexProfile)).toBe('USE_CASE_HANDLER')
  })

  it('tags domain entities', () => {
    expect(assignHexRole('com.app.Order', 'src/domain/Order.java', hexProfile)).toBe('DOMAIN_ENTITY')
  })

  it('tags domain events', () => {
    expect(assignHexRole('com.app.OrderCreatedEvent', 'src/domain/OrderCreatedEvent.java', hexProfile)).toBe('DOMAIN_EVENT')
  })

  it('returns NONE for non-hexagonal', () => {
    const layered: ProjectProfile = { architecture: 'layered', confidence: 0.7, signals: [] }
    expect(assignHexRole('com.app.OrderPort', 'src/OrderPort.java', layered)).toBe('NONE')
  })
})
