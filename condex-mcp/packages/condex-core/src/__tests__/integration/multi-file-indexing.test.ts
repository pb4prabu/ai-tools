/**
 * Integration test for multi-file-type indexing — full real-world pipeline.
 *
 * This test:
 *   1. Creates a temp project with Java, XML, properties, MD, YAML, SQL files
 *   2. Runs the full indexer (Java parser + generic file parser)
 *   3. Verifies BM25 search across all file types
 *   4. Downloads the real embedding model (~100MB, one-time)
 *   5. Loads sqlite-vec, builds vector index, tests vector + hybrid search
 *   6. Cleans up temp index and model directory
 *
 * Run with: CONDEX_INTEGRATION=1 npm run test:integration --workspace=packages/condex-core
 *
 * NOT run by default in `npm test` — only when CONDEX_INTEGRATION=1 is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { createSchema } from '../../store/sqlite-store.js'
import { searchBM25 } from '../../retrieval/bm25.js'
import { indexProject } from '../../indexer/indexer.js'
import { parseGenericFile, isBinaryExtension } from '../../indexer/generic-file-parser.js'
import { SafeFS } from '../../security/fs-guard.js'
import { generateNamespace } from '../../namespace/namespace.js'
import type { Embedder } from '../../embeddings/local-embed.js'

const SKIP = !process.env.CONDEX_INTEGRATION

// ── Fixture files for the fake project ──────────────────────

const JAVA_MAIN = `
package com.example.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Main entry point for the Item Grouper application.
 * Handles startup and configuration loading.
 */
@SpringBootApplication
public class ItemGrouperApplication {

    public static void main(String[] args) {
        SpringApplication.run(ItemGrouperApplication.class, args);
    }
}
`

const JAVA_SERVICE = `
package com.example.app.service;

import org.springframework.stereotype.Service;
import com.example.app.repository.ItemRepository;
import com.example.app.model.Item;
import java.util.List;

/**
 * Business logic for grouping items by category and priority.
 */
@Service
public class ItemGroupingService {

    private final ItemRepository itemRepository;

    public ItemGroupingService(ItemRepository itemRepository) {
        this.itemRepository = itemRepository;
    }

    public List<Item> findByCategory(String category) {
        return itemRepository.findByCategory(category);
    }

    public void groupItems(List<Item> items) {
        // Grouping logic
    }
}
`

const JAVA_REPO = `
package com.example.app.repository;

import org.springframework.data.jpa.repository.JpaRepository;
import com.example.app.model.Item;
import java.util.List;

/**
 * Repository interface for Item persistence operations.
 */
public interface ItemRepository extends JpaRepository<Item, Long> {
    List<Item> findByCategory(String category);
    List<Item> findByPriority(int priority);
}
`

// Deep nested Java file — proves indexing works at any depth
const JAVA_DEEP = `
package com.example.app.core.domain.model.entity.base;

/**
 * Abstract base entity with audit fields.
 */
public abstract class AuditableEntity {
    private String createdBy;
    private String updatedBy;

    public String getCreatedBy() { return createdBy; }
    public String getUpdatedBy() { return updatedBy; }
}
`

const POM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.example</groupId>
    <artifactId>item-grouper</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
    </parent>
    <dependencies>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
        </dependency>
        <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-data-jpa</artifactId>
        </dependency>
    </dependencies>
</project>
`

const APP_PROPERTIES = `
# Database Configuration
spring.datasource.url=jdbc:postgresql://localhost:5432/itemgrouper
spring.datasource.username=admin
spring.datasource.password=secret123
spring.jpa.hibernate.ddl-auto=validate

# Server Configuration
server.port=8080
server.servlet.context-path=/api

# Logging
logging.level.com.example=DEBUG
logging.level.org.springframework.data=INFO
`

const README_MD = `# Item Grouper Application

A Spring Boot microservice for grouping items by category and priority.

## Architecture

- **Service Layer**: ItemGroupingService handles business logic
- **Repository Layer**: ItemRepository provides JPA data access
- **REST API**: Exposes endpoints for item management

## Running

\`\`\`bash
./mvnw spring-boot:run
\`\`\`

## Configuration

See application.properties for database and server settings.
`

const SCHEMA_SQL = `
CREATE TABLE items (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(100),
    priority INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE item_groups (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    group_name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`

const APP_YAML = `
spring:
  profiles:
    active: dev
  datasource:
    url: jdbc:h2:mem:testdb
    driver-class-name: org.h2.Driver
  jpa:
    show-sql: true
    hibernate:
      ddl-auto: create-drop
server:
  port: 8081
`

const DOCKER_COMPOSE = `
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: itemgrouper
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: secret123
    ports:
      - "5432:5432"
  app:
    build: .
    ports:
      - "8080:8080"
    depends_on:
      - postgres
`

// ── Test Suite ──────────────────────────────────────────────

describe.skipIf(SKIP)('Multi-file-type indexing integration', () => {
  let db: Database.Database
  let tmpDir: string
  let projectId: string
  let embedder: Embedder | null = null
  let tmpModelDir: string
  let hasVec = false

  beforeAll(async () => {
    // Create temp project with deep nesting
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-integration-'))
    tmpModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-model-'))

    const files: Record<string, string> = {
      'pom.xml': POM_XML,
      'README.md': README_MD,
      'docker-compose.yml': DOCKER_COMPOSE,
      'src/main/java/com/example/app/ItemGrouperApplication.java': JAVA_MAIN,
      'src/main/java/com/example/app/service/ItemGroupingService.java': JAVA_SERVICE,
      'src/main/java/com/example/app/repository/ItemRepository.java': JAVA_REPO,
      // Deep nested file — 8 levels under src/
      'src/main/java/com/example/app/core/domain/model/entity/base/AuditableEntity.java': JAVA_DEEP,
      'src/main/resources/application.properties': APP_PROPERTIES,
      'src/main/resources/application.yml': APP_YAML,
      'src/main/resources/db/migration/V1__init.sql': SCHEMA_SQL,
    }

    for (const [relPath, content] of Object.entries(files)) {
      const absPath = path.join(tmpDir, relPath)
      fs.mkdirSync(path.dirname(absPath), { recursive: true })
      fs.writeFileSync(absPath, content)
    }

    // Binary files that should be skipped
    fs.writeFileSync(path.join(tmpDir, 'app.jar'), Buffer.alloc(100))
    fs.mkdirSync(path.join(tmpDir, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'assets/logo.png'), Buffer.alloc(50))

    // Setup DB
    db = new Database(':memory:')
    db.pragma('journal_mode = WAL')
    createSchema(db)
    projectId = generateNamespace(tmpDir)

    // Load Java parser
    let javaParsers: any = null
    try {
      const esmRequire = createRequire(import.meta.url)
      const javaPkg = esmRequire('@condex-ai/java')
      javaParsers = {
        parseFileWithRefs: javaPkg.parseJavaFileWithRefs,
        detectArch: javaPkg.detectArchitecture,
        parseSql: javaPkg.parseSqlFile,
        parseYaml: javaPkg.parseYamlFile,
      }
      console.error('[integration] Java parser loaded')
    } catch {
      console.error('[integration] Java parser not available — Java-specific tests will be limited')
    }

    // Run full index
    const safeFs = new SafeFS(tmpDir)
    const result = await indexProject(db, safeFs, {
      full: true,
      ...javaParsers,
    })
    console.error(`[integration] Indexed: ${result.filesProcessed} files, ${result.symbolCount} symbols`)

    // ── Load sqlite-vec ──
    try {
      const esmRequire = createRequire(import.meta.url)
      const sqliteVec = esmRequire('sqlite-vec')
      sqliteVec.load(db)
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS symbol_vectors USING vec0(
        symbol_id TEXT PRIMARY KEY, embedding float[768]
      )`)
      hasVec = true
      console.error('[integration] sqlite-vec loaded')
    } catch (err: any) {
      console.error(`[integration] sqlite-vec not available: ${err.message} — vector tests will fail`)
    }

    // ── Download real embedding model and build vector index ──
    process.env.CONDEX_MODEL_CACHE_DIR = tmpModelDir
    try {
      const { getEmbedder, prepareSymbolText } = await import('../../embeddings/local-embed.js')
      console.error(`[integration] Downloading embedding model to ${tmpModelDir}...`)
      embedder = await getEmbedder()
      console.error(`[integration] Embedder ready (${embedder.dimensions} dimensions)`)

      if (hasVec) {
        // Build vector index for all symbols
        const { insertVectors } = await import('../../retrieval/vector-search.js')
        const allSymbols = db.prepare(
          'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
        ).all(projectId) as any[]

        const batchSize = 50
        for (let i = 0; i < allSymbols.length; i += batchSize) {
          const batch = allSymbols.slice(i, i + batchSize)
          const texts = batch.map((s: any) => prepareSymbolText({
            qualifiedName: s.qualified_name,
            signature: s.signature,
            javadoc: s.javadoc,
            kind: s.kind,
          }))
          const embeddings = await embedder.embedBatch(texts)
          const vectors = batch.map((s: any, idx: number) => ({
            symbolId: s.id,
            embedding: embeddings[idx],
          }))
          insertVectors(db, vectors)
        }
        console.error(`[integration] Vector index built for ${allSymbols.length} symbols`)
      }
    } catch (err: any) {
      console.error(`[integration] Embedder/model download failed: ${err.message}`)
      console.error(`[integration] Vector search tests will fail. Ensure internet access for model download.`)
    }
  }, 300_000) // 5 min timeout — model download can be slow

  afterAll(async () => {
    db?.close()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (tmpModelDir) fs.rmSync(tmpModelDir, { recursive: true, force: true })
    try {
      const { resetEmbedder } = await import('../../embeddings/local-embed.js')
      resetEmbedder()
    } catch { /* ignore */ }
  })

  // ── Generic file parser unit tests ──

  it('parseGenericFile creates file symbols from text files', () => {
    const sym = parseGenericFile(POM_XML, { projectId: 'test', filePath: 'pom.xml' })
    expect(sym).not.toBeNull()
    expect(sym!.kind).toBe('file')
    expect(sym!.simpleName).toBe('pom.xml')
    expect(sym!.signature).toContain('maven')
  })

  it('parseGenericFile returns null for binary files', () => {
    const sym = parseGenericFile('content', { projectId: 'test', filePath: 'app.jar' })
    expect(sym).toBeNull()
  })

  it('parseGenericFile returns null for empty content', () => {
    const sym = parseGenericFile('', { projectId: 'test', filePath: 'empty.txt' })
    expect(sym).toBeNull()
  })

  it('isBinaryExtension identifies binary files', () => {
    expect(isBinaryExtension('foo.jar')).toBe(true)
    expect(isBinaryExtension('foo.class')).toBe(true)
    expect(isBinaryExtension('foo.png')).toBe(true)
    expect(isBinaryExtension('foo.lock')).toBe(true)
    expect(isBinaryExtension('foo.java')).toBe(false)
    expect(isBinaryExtension('foo.xml')).toBe(false)
    expect(isBinaryExtension('foo.md')).toBe(false)
    expect(isBinaryExtension('foo.properties')).toBe(false)
  })

  // ── Full indexer tests ──

  it('indexes both language and supplemental files', () => {
    const allSymbols = db.prepare(
      'SELECT * FROM symbols WHERE project_id = ?'
    ).all(projectId) as any[]
    expect(allSymbols.length).toBeGreaterThan(0)

    const kinds = new Set(allSymbols.map((s: any) => s.kind))
    expect(kinds.has('file')).toBe(true)
    console.error(`[integration] Total symbols: ${allSymbols.length}, kinds: ${[...kinds].join(', ')}`)
  })

  it('indexes supplemental files as file-kind symbols', () => {
    const fileSymbols = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND kind = 'file'"
    ).all(projectId) as any[]
    expect(fileSymbols.length).toBeGreaterThanOrEqual(3)

    const filePaths = fileSymbols.map((s: any) => s.file_path)
    console.error(`[integration] File symbols: ${filePaths.join(', ')}`)

    expect(filePaths.some((f: string) => f.endsWith('.xml'))).toBe(true)
    expect(filePaths.some((f: string) => f.endsWith('.md'))).toBe(true)
    expect(filePaths.some((f: string) => f.endsWith('.properties'))).toBe(true)
  })

  it('does NOT index binary files', () => {
    const binarySymbols = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND (file_path LIKE '%.jar' OR file_path LIKE '%.png')"
    ).all(projectId) as any[]
    expect(binarySymbols).toHaveLength(0)
  })

  it('indexes deeply nested Java files', () => {
    // AuditableEntity.java is 8 directories deep under src/
    const deepSymbols = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND file_path LIKE '%AuditableEntity%'"
    ).all(projectId) as any[]
    expect(deepSymbols.length).toBeGreaterThan(0)
    console.error(`[integration] Deep nested symbols: ${deepSymbols.length}`)
  })

  it('indexes Java files with tree-sitter parser (if available)', () => {
    const javaSymbols = db.prepare(
      "SELECT * FROM symbols WHERE project_id = ? AND kind != 'file' AND file_path LIKE '%.java'"
    ).all(projectId) as any[]
    console.error(`[integration] Java parser symbols: ${javaSymbols.length}`)
    if (javaSymbols.length > 0) {
      const kinds = new Set(javaSymbols.map((s: any) => s.kind))
      expect(kinds.has('class') || kinds.has('interface')).toBe(true)
    }
  })

  // ── BM25 search across file types ──

  it('BM25 finds content in properties files', () => {
    const results = searchBM25(db, 'postgresql datasource', projectId, undefined, 0.01)
    expect(results.length).toBeGreaterThan(0)
    const hasPropertiesFile = results.some(r => r.filePath.endsWith('.properties'))
    expect(hasPropertiesFile).toBe(true)
  })

  it('BM25 finds content in README markdown', () => {
    const results = searchBM25(db, 'Spring Boot microservice grouping', projectId, undefined, 0.01)
    expect(results.length).toBeGreaterThan(0)
    const hasMd = results.some(r => r.filePath.endsWith('.md'))
    expect(hasMd).toBe(true)
  })

  it('BM25 finds content in XML files', () => {
    const results = searchBM25(db, 'springframework boot starter', projectId, undefined, 0.01)
    expect(results.length).toBeGreaterThan(0)
    const hasXml = results.some(r => r.filePath.endsWith('.xml'))
    expect(hasXml).toBe(true)
  })

  it('BM25 finds content in docker-compose YAML', () => {
    const results = searchBM25(db, 'postgres docker', projectId, undefined, 0.01)
    expect(results.length).toBeGreaterThan(0)
  })

  // ── Vector search tests (real model, real embeddings) ──

  it('vector search finds semantically similar content across file types', async () => {
    expect(hasVec).toBe(true)
    expect(embedder).not.toBeNull()

    const { vectorSearch } = await import('../../retrieval/vector-search.js')
    const results = await vectorSearch(db, 'database configuration settings', projectId, embedder!)
    expect(results.length).toBeGreaterThan(0)
    console.error(`[integration] Vector "database config" → ${results.length} results: ${results.slice(0, 3).map(r => r.symbolId.split('::').pop()).join(', ')}`)
  })

  it('vector search finds Java classes by semantic description', async () => {
    expect(embedder).not.toBeNull()

    const { vectorSearch } = await import('../../retrieval/vector-search.js')
    const results = await vectorSearch(db, 'item grouping business logic service', projectId, embedder!)
    expect(results.length).toBeGreaterThan(0)
    console.error(`[integration] Vector "business logic" → ${results.length} results`)
  })

  it('hybrid search (RRF) combines BM25 and vector results', async () => {
    expect(embedder).not.toBeNull()

    const { vectorSearch } = await import('../../retrieval/vector-search.js')
    const { rrfFusion } = await import('../../retrieval/rrf-fusion.js')

    const bm25Results = searchBM25(db, 'item repository', projectId, undefined, 0.01)
    const vecResults = await vectorSearch(db, 'data access layer for items', projectId, embedder!)

    const fused = rrfFusion(bm25Results, vecResults)
    expect(fused.length).toBeGreaterThan(0)
    console.error(`[integration] Hybrid RRF: BM25=${bm25Results.length}, Vec=${vecResults.length}, Fused=${fused.length}`)
  })

  it('vector search returns results for non-Java files too', async () => {
    expect(embedder).not.toBeNull()

    const { vectorSearch } = await import('../../retrieval/vector-search.js')
    const results = await vectorSearch(db, 'docker container deployment postgres', projectId, embedder!)
    expect(results.length).toBeGreaterThan(0)
    // At least one result should be from a non-Java file
    const nonJava = results.find(r => !r.symbolId.includes('.java'))
    expect(nonJava).toBeDefined()
    console.error(`[integration] Vector non-Java results: ${results.filter(r => !r.symbolId.includes('.java')).length}/${results.length}`)
  })
})
