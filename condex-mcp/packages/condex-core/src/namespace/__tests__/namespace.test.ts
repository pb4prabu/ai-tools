import { describe, it, expect } from 'vitest'
import { generateNamespace } from '../namespace.js'

describe('generateNamespace', () => {
  it('produces deterministic output for same path', () => {
    const ns1 = generateNamespace('/home/user/myapp')
    const ns2 = generateNamespace('/home/user/myapp')
    expect(ns1).toBe(ns2)
  })

  it('produces different output for different paths', () => {
    const ns1 = generateNamespace('/home/user/myapp')
    const ns2 = generateNamespace('/home/user/otherapp')
    expect(ns1).not.toBe(ns2)
  })

  it('uses folder name as prefix', () => {
    const ns = generateNamespace('/home/user/myapp')
    expect(ns).toMatch(/^myapp@[a-f0-9]{6}$/)
  })

  it('parent and child produce different namespaces', () => {
    const parent = generateNamespace('/home/user/myapp')
    const child = generateNamespace('/home/user/myapp/backend')
    expect(parent).not.toBe(child)
    expect(parent).toMatch(/^myapp@/)
    expect(child).toMatch(/^backend@/)
  })

  it('handles paths with trailing slash', () => {
    const ns1 = generateNamespace('/home/user/myapp')
    const ns2 = generateNamespace('/home/user/myapp/')
    // path.resolve strips trailing slash, so these should be equal
    expect(ns1).toBe(ns2)
  })

  it('same-named folders in different locations produce different namespaces', () => {
    const ns1 = generateNamespace('/home/alice/myapp')
    const ns2 = generateNamespace('/home/bob/myapp')
    // Same name prefix but different hash
    expect(ns1.split('@')[0]).toBe(ns2.split('@')[0])
    expect(ns1.split('@')[1]).not.toBe(ns2.split('@')[1])
  })
})
