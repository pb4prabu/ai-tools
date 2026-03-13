import { describe, it, expect } from 'vitest'
import { parseSqlFile } from '../sql-parser.js'
import { parseYamlFile } from '../yaml-parser.js'

describe('SQL parser', () => {
  it('extracts CREATE TABLE', () => {
    const sql = `
      CREATE TABLE orders (
        id BIGINT NOT NULL,
        customer_id BIGINT NOT NULL,
        total DECIMAL(10,2),
        status VARCHAR(50) NOT NULL,
        created_at TIMESTAMP NOT NULL
      );
    `
    const symbols = parseSqlFile(sql, 'test@abc', 'V1__create_orders.sql')

    const table = symbols.find(s => s.id.includes('#table'))
    expect(table).toBeDefined()
    expect(table!.tableName).toBe('orders')

    const columns = symbols.filter(s => s.id.includes('#column'))
    expect(columns.length).toBe(5)

    const idCol = columns.find(s => s.columnName === 'id')
    expect(idCol!.dataType).toBe('BIGINT')
    expect(idCol!.nullable).toBe(false)

    const totalCol = columns.find(s => s.columnName === 'total')
    expect(totalCol!.nullable).toBe(true)
  })

  it('extracts ALTER TABLE ADD COLUMN', () => {
    const sql = `ALTER TABLE orders ADD COLUMN notes TEXT;`
    const symbols = parseSqlFile(sql, 'test@abc', 'V2__add_notes.sql')

    expect(symbols).toHaveLength(1)
    expect(symbols[0].tableName).toBe('orders')
    expect(symbols[0].columnName).toBe('notes')
    expect(symbols[0].dataType).toBe('TEXT')
  })

  it('handles CREATE TABLE IF NOT EXISTS', () => {
    const sql = `CREATE TABLE IF NOT EXISTS users (id BIGINT NOT NULL);`
    const symbols = parseSqlFile(sql, 'test@abc', 'V1__users.sql')
    expect(symbols.length).toBeGreaterThan(0)
    expect(symbols[0].tableName).toBe('users')
  })

  it('returns empty for non-DDL SQL', () => {
    const sql = `INSERT INTO orders VALUES (1, 2, 99.99, 'PENDING', NOW());`
    const symbols = parseSqlFile(sql, 'test@abc', 'data.sql')
    expect(symbols).toHaveLength(0)
  })
})

describe('YAML parser', () => {
  it('flattens to dot-notation keys', () => {
    const yaml = `
server:
  port: 8080
spring:
  datasource:
    url: jdbc:postgresql://localhost/mydb
    username: admin
`
    const symbols = parseYamlFile(yaml, 'test@abc', 'application.yml')

    expect(symbols.length).toBe(3)

    const port = symbols.find(s => s.keyPath === 'server.port')
    expect(port!.value).toBe('8080')

    const url = symbols.find(s => s.keyPath === 'spring.datasource.url')
    expect(url!.value).toContain('postgresql')
  })

  it('detects profile from filename', () => {
    const yaml = `server:\n  port: 9090\n`
    const symbols = parseYamlFile(yaml, 'test@abc', 'application-dev.yml')

    expect(symbols[0].profile).toBe('dev')
  })

  it('has no profile for base config', () => {
    const yaml = `server:\n  port: 8080\n`
    const symbols = parseYamlFile(yaml, 'test@abc', 'application.yml')

    expect(symbols[0].profile).toBeUndefined()
  })

  it('handles arrays', () => {
    const yaml = `
spring:
  profiles:
    active: [dev, local]
`
    const symbols = parseYamlFile(yaml, 'test@abc', 'application.yml')
    const active = symbols.find(s => s.keyPath === 'spring.profiles.active')
    expect(active).toBeDefined()
  })

  it('returns empty for invalid YAML', () => {
    const symbols = parseYamlFile('{{invalid', 'test@abc', 'bad.yml')
    expect(symbols).toHaveLength(0)
  })
})
