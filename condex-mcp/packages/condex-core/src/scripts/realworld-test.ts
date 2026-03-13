#!/usr/bin/env npx tsx
/**
 * Real-world integration test for Condex indexing pipeline.
 *
 * Creates a realistic multi-language project with 6+ levels of nesting,
 * diverse file types, indexes everything, downloads the real embedding model,
 * runs BM25 + vector + hybrid searches, and prints a full stats report.
 *
 * Usage:
 *   npx tsx src/scripts/realworld-test.ts
 *   # or via wrapper:
 *   bash realtest.sh
 *
 * NOT part of normal build/test. Must be invoked explicitly.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { createSchema } from '../store/sqlite-store.js'
import { searchBM25 } from '../retrieval/bm25.js'
import { indexProject } from '../indexer/indexer.js'
import { SafeFS } from '../security/fs-guard.js'
import { generateNamespace } from '../namespace/namespace.js'
import { loadVec, insertVectors, vectorSearch } from '../retrieval/vector-search.js'
import { rrfFusion } from '../retrieval/rrf-fusion.js'
import { getEmbedder, prepareSymbolText, resetEmbedder } from '../embeddings/local-embed.js'
import type { Embedder } from '../embeddings/local-embed.js'

// ── Colors for terminal ──
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', B = '\x1b[34m', C = '\x1b[36m', DIM = '\x1b[2m', BOLD = '\x1b[1m', RST = '\x1b[0m'

function header(msg: string) { console.log(`\n${BOLD}${B}═══ ${msg} ═══${RST}`) }
function ok(msg: string) { console.log(`  ${G}✓${RST} ${msg}`) }
function fail(msg: string) { console.log(`  ${R}✗${RST} ${msg}`) }
function info(msg: string) { console.log(`  ${DIM}${msg}${RST}`) }
function stat(label: string, value: string | number) { console.log(`  ${C}${label}:${RST} ${BOLD}${value}${RST}`) }

// ── Fixture project files ────────────────────────────────────

const FILES: Record<string, string> = {
  // Level 0 — root
  'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
    <modelVersion>4.0.0</modelVersion>
    <groupId>com.urbanbarrow</groupId>
    <artifactId>order-service</artifactId>
    <version>2.1.0</version>
    <parent>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-parent</artifactId>
        <version>3.2.0</version>
    </parent>
    <dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-security</artifactId></dependency>
        <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>
        <dependency><groupId>io.jsonwebtoken</groupId><artifactId>jjwt</artifactId><version>0.12.3</version></dependency>
    </dependencies>
</project>`,

  'README.md': `# Order Service
A Spring Boot microservice for managing customer orders in the UrbanBarrow platform.

## Architecture
Hexagonal architecture with clear separation of concerns:
- **Domain Layer**: Core business logic and entities
- **Application Layer**: Use cases and port interfaces
- **Infrastructure Layer**: Adapters for REST, JPA, messaging

## Key Features
- Order creation and lifecycle management
- Inventory reservation via event-driven messaging
- JWT-based authentication and role-based access control
- PostgreSQL persistence with Flyway migrations

## Running
\`\`\`bash
./mvnw spring-boot:run -Dspring-boot.run.profiles=dev
\`\`\``,

  'Dockerfile': `FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY target/order-service-*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]`,

  'docker-compose.yml': `version: '3.8'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: orders
      POSTGRES_USER: orderadmin
      POSTGRES_PASSWORD: s3cret
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  order-service:
    build: .
    ports: ["8080:8080"]
    depends_on: [postgres, redis]
    environment:
      SPRING_DATASOURCE_URL: jdbc:postgresql://postgres:5432/orders
volumes:
  pgdata:`,

  '.gitignore': `target/
*.class
*.jar
.idea/
*.iml
.condex/`,

  // Level 1-2 — config
  'src/main/resources/application.properties': `# Server
server.port=8080
server.servlet.context-path=/api/v1

# Database
spring.datasource.url=jdbc:postgresql://localhost:5432/orders
spring.datasource.username=orderadmin
spring.datasource.password=s3cret
spring.jpa.hibernate.ddl-auto=validate
spring.jpa.show-sql=false
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect

# Security
jwt.secret=mySecretKeyForJWTTokenGeneration2024
jwt.expiration=86400000

# Flyway
spring.flyway.enabled=true
spring.flyway.locations=classpath:db/migration

# Logging
logging.level.com.urbanbarrow=DEBUG
logging.level.org.springframework.security=INFO`,

  'src/main/resources/application-dev.yml': `spring:
  datasource:
    url: jdbc:h2:mem:testdb
    driver-class-name: org.h2.Driver
  jpa:
    show-sql: true
    hibernate:
      ddl-auto: create-drop
  flyway:
    enabled: false
logging:
  level:
    com.urbanbarrow: TRACE`,

  'src/main/resources/application-prod.yml': `spring:
  datasource:
    url: \${DATABASE_URL}
    hikari:
      maximum-pool-size: 20
      minimum-idle: 5
  jpa:
    show-sql: false
  security:
    require-ssl: true
management:
  endpoints:
    web:
      exposure:
        include: health,metrics,prometheus`,

  // Level 3-4 — SQL migrations
  'src/main/resources/db/migration/V1__create_orders.sql': `CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    tier VARCHAR(50) DEFAULT 'STANDARD',
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    total_amount DECIMAL(12,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'USD',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,
    product_name VARCHAR(255) NOT NULL,
    quantity INT NOT NULL CHECK (quantity > 0),
    unit_price DECIMAL(12,2) NOT NULL,
    subtotal DECIMAL(12,2) GENERATED ALWAYS AS (quantity * unit_price) STORED
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_order_items_order ON order_items(order_id);`,

  'src/main/resources/db/migration/V2__add_shipping.sql': `CREATE TABLE shipping_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id),
    street VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    zip_code VARCHAR(20),
    country VARCHAR(100) NOT NULL DEFAULT 'US'
);

ALTER TABLE orders ADD COLUMN shipping_address_id UUID REFERENCES shipping_addresses(id);
ALTER TABLE orders ADD COLUMN estimated_delivery DATE;`,

  // Level 3-6 — Java domain layer (deep nesting)
  'src/main/java/com/urbanbarrow/order/OrderServiceApplication.java': `package com.urbanbarrow.order;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Main entry point for the Order Service.
 * Bootstraps Spring Boot with auto-configuration.
 */
@SpringBootApplication
public class OrderServiceApplication {
    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}`,

  'src/main/java/com/urbanbarrow/order/domain/model/Order.java': `package com.urbanbarrow.order.domain.model;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Core domain entity representing a customer order.
 * Contains business rules for order lifecycle management.
 */
public class Order {
    private UUID id;
    private UUID customerId;
    private OrderStatus status;
    private BigDecimal totalAmount;
    private String currency;
    private List<OrderItem> items;
    private String notes;
    private Instant createdAt;
    private Instant updatedAt;

    public Order(UUID customerId, List<OrderItem> items) {
        this.id = UUID.randomUUID();
        this.customerId = customerId;
        this.items = items;
        this.status = OrderStatus.PENDING;
        this.totalAmount = calculateTotal();
        this.currency = "USD";
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    public void confirm() {
        if (this.status != OrderStatus.PENDING) {
            throw new IllegalStateException("Only pending orders can be confirmed");
        }
        this.status = OrderStatus.CONFIRMED;
        this.updatedAt = Instant.now();
    }

    public void ship() {
        if (this.status != OrderStatus.CONFIRMED) {
            throw new IllegalStateException("Only confirmed orders can be shipped");
        }
        this.status = OrderStatus.SHIPPED;
        this.updatedAt = Instant.now();
    }

    public void cancel(String reason) {
        if (this.status == OrderStatus.SHIPPED || this.status == OrderStatus.DELIVERED) {
            throw new IllegalStateException("Cannot cancel shipped or delivered orders");
        }
        this.status = OrderStatus.CANCELLED;
        this.notes = reason;
        this.updatedAt = Instant.now();
    }

    private BigDecimal calculateTotal() {
        return items.stream()
            .map(OrderItem::getSubtotal)
            .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    public UUID getId() { return id; }
    public UUID getCustomerId() { return customerId; }
    public OrderStatus getStatus() { return status; }
    public BigDecimal getTotalAmount() { return totalAmount; }
    public List<OrderItem> getItems() { return items; }
}`,

  'src/main/java/com/urbanbarrow/order/domain/model/OrderItem.java': `package com.urbanbarrow.order.domain.model;

import java.math.BigDecimal;
import java.util.UUID;

/**
 * Value object representing a single line item in an order.
 */
public class OrderItem {
    private UUID productId;
    private String productName;
    private int quantity;
    private BigDecimal unitPrice;

    public OrderItem(UUID productId, String productName, int quantity, BigDecimal unitPrice) {
        if (quantity <= 0) throw new IllegalArgumentException("Quantity must be positive");
        if (unitPrice.compareTo(BigDecimal.ZERO) < 0) throw new IllegalArgumentException("Price cannot be negative");
        this.productId = productId;
        this.productName = productName;
        this.quantity = quantity;
        this.unitPrice = unitPrice;
    }

    public BigDecimal getSubtotal() {
        return unitPrice.multiply(BigDecimal.valueOf(quantity));
    }

    public UUID getProductId() { return productId; }
    public String getProductName() { return productName; }
    public int getQuantity() { return quantity; }
    public BigDecimal getUnitPrice() { return unitPrice; }
}`,

  'src/main/java/com/urbanbarrow/order/domain/model/OrderStatus.java': `package com.urbanbarrow.order.domain.model;

/**
 * Enum representing the lifecycle states of an order.
 */
public enum OrderStatus {
    PENDING,
    CONFIRMED,
    SHIPPED,
    DELIVERED,
    CANCELLED
}`,

  // Level 5-6 — ports (interfaces)
  'src/main/java/com/urbanbarrow/order/domain/port/in/CreateOrderUseCase.java': `package com.urbanbarrow.order.domain.port.in;

import com.urbanbarrow.order.domain.model.Order;
import java.util.UUID;
import java.util.List;

/**
 * Inbound port for creating new orders.
 * Implemented by the application service layer.
 */
public interface CreateOrderUseCase {
    Order createOrder(UUID customerId, List<CreateOrderCommand.ItemRequest> items);
}`,

  'src/main/java/com/urbanbarrow/order/domain/port/in/CreateOrderCommand.java': `package com.urbanbarrow.order.domain.port.in;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * Command object for order creation request.
 */
public record CreateOrderCommand(
    UUID customerId,
    List<ItemRequest> items
) {
    public record ItemRequest(
        UUID productId,
        String productName,
        int quantity,
        BigDecimal unitPrice
    ) {}
}`,

  'src/main/java/com/urbanbarrow/order/domain/port/out/OrderRepository.java': `package com.urbanbarrow.order.domain.port.out;

import com.urbanbarrow.order.domain.model.Order;
import java.util.Optional;
import java.util.UUID;
import java.util.List;

/**
 * Outbound port for order persistence.
 * Implemented by JPA adapter in infrastructure layer.
 */
public interface OrderRepository {
    Order save(Order order);
    Optional<Order> findById(UUID id);
    List<Order> findByCustomerId(UUID customerId);
    void deleteById(UUID id);
}`,

  'src/main/java/com/urbanbarrow/order/domain/port/out/InventoryPort.java': `package com.urbanbarrow.order.domain.port.out;

import java.util.UUID;

/**
 * Outbound port for inventory reservation.
 * Implemented by messaging adapter (Kafka/RabbitMQ).
 */
public interface InventoryPort {
    boolean reserveStock(UUID productId, int quantity);
    void releaseStock(UUID productId, int quantity);
}`,

  // Level 5-6 — application service
  'src/main/java/com/urbanbarrow/order/application/service/OrderService.java': `package com.urbanbarrow.order.application.service;

import com.urbanbarrow.order.domain.model.Order;
import com.urbanbarrow.order.domain.model.OrderItem;
import com.urbanbarrow.order.domain.port.in.CreateOrderUseCase;
import com.urbanbarrow.order.domain.port.in.CreateOrderCommand;
import com.urbanbarrow.order.domain.port.out.OrderRepository;
import com.urbanbarrow.order.domain.port.out.InventoryPort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Application service implementing order use cases.
 * Orchestrates domain objects and infrastructure ports.
 */
@Service
@Transactional
public class OrderService implements CreateOrderUseCase {

    private final OrderRepository orderRepository;
    private final InventoryPort inventoryPort;

    public OrderService(OrderRepository orderRepository, InventoryPort inventoryPort) {
        this.orderRepository = orderRepository;
        this.inventoryPort = inventoryPort;
    }

    @Override
    public Order createOrder(UUID customerId, List<CreateOrderCommand.ItemRequest> items) {
        List<OrderItem> orderItems = items.stream()
            .map(i -> new OrderItem(i.productId(), i.productName(), i.quantity(), i.unitPrice()))
            .collect(Collectors.toList());

        // Reserve inventory for each item
        for (var item : orderItems) {
            boolean reserved = inventoryPort.reserveStock(item.getProductId(), item.getQuantity());
            if (!reserved) {
                throw new IllegalStateException("Insufficient stock for: " + item.getProductName());
            }
        }

        Order order = new Order(customerId, orderItems);
        return orderRepository.save(order);
    }
}`,

  // Level 5-6 — REST adapter
  'src/main/java/com/urbanbarrow/order/adapter/in/rest/OrderController.java': `package com.urbanbarrow.order.adapter.in.rest;

import com.urbanbarrow.order.domain.model.Order;
import com.urbanbarrow.order.domain.port.in.CreateOrderUseCase;
import com.urbanbarrow.order.domain.port.in.CreateOrderCommand;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import java.net.URI;

/**
 * REST controller for order management endpoints.
 * Adapts HTTP requests to domain use cases.
 */
@RestController
@RequestMapping("/orders")
public class OrderController {

    private final CreateOrderUseCase createOrderUseCase;

    public OrderController(CreateOrderUseCase createOrderUseCase) {
        this.createOrderUseCase = createOrderUseCase;
    }

    @PostMapping
    public ResponseEntity<Order> createOrder(@RequestBody CreateOrderCommand command) {
        Order order = createOrderUseCase.createOrder(command.customerId(), command.items());
        return ResponseEntity.created(URI.create("/orders/" + order.getId())).body(order);
    }
}`,

  // Level 5-6 — JPA adapter
  'src/main/java/com/urbanbarrow/order/adapter/out/persistence/JpaOrderRepository.java': `package com.urbanbarrow.order.adapter.out.persistence;

import com.urbanbarrow.order.domain.model.Order;
import com.urbanbarrow.order.domain.port.out.OrderRepository;
import org.springframework.stereotype.Repository;
import java.util.*;

/**
 * JPA implementation of the OrderRepository port.
 * Bridges domain model to relational persistence.
 */
@Repository
public class JpaOrderRepository implements OrderRepository {

    private final Map<UUID, Order> store = new HashMap<>();

    @Override
    public Order save(Order order) {
        store.put(order.getId(), order);
        return order;
    }

    @Override
    public Optional<Order> findById(UUID id) {
        return Optional.ofNullable(store.get(id));
    }

    @Override
    public List<Order> findByCustomerId(UUID customerId) {
        return store.values().stream()
            .filter(o -> o.getCustomerId().equals(customerId))
            .toList();
    }

    @Override
    public void deleteById(UUID id) {
        store.remove(id);
    }
}`,

  // Level 5-6 — Security config
  'src/main/java/com/urbanbarrow/order/adapter/in/rest/SecurityConfig.java': `package com.urbanbarrow.order.adapter.in.rest;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Security configuration for JWT authentication.
 */
@Configuration
public class SecurityConfig {

    @Bean
    public String jwtSecret() {
        return System.getenv("JWT_SECRET");
    }
}`,

  // Level 4 — test (a .json fixture)
  'src/test/resources/fixtures/create-order-request.json': `{
  "customerId": "550e8400-e29b-41d4-a716-446655440000",
  "items": [
    {
      "productId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "productName": "Wireless Mouse",
      "quantity": 2,
      "unitPrice": 29.99
    },
    {
      "productId": "8a9e6679-7425-40de-944b-e07fc1f90ae8",
      "productName": "USB-C Hub",
      "quantity": 1,
      "unitPrice": 49.99
    }
  ]
}`,

  // Misc project files
  'Makefile': `
.PHONY: build test run clean

build:
\tmvn clean package -DskipTests

test:
\tmvn test

run:
\tmvn spring-boot:run

clean:
\tmvn clean
\trm -rf target/
`,

  'renovate.json': `{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:base"],
  "packageRules": [
    { "matchUpdateTypes": ["minor", "patch"], "automerge": true }
  ]
}`,
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const startMs = Date.now()
  console.log(`${BOLD}${B}`)
  console.log(`  ┌──────────────────────────────────────────────┐`)
  console.log(`  │   Condex Real-World Integration Test         │`)
  console.log(`  │   BM25 + Vector + Hybrid — Full Pipeline     │`)
  console.log(`  └──────────────────────────────────────────────┘${RST}`)

  // ── 1. Create temp project ──
  header('1. Creating test project')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-realtest-'))
  const tmpModelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'condex-model-'))
  process.env.CONDEX_MODEL_CACHE_DIR = tmpModelDir

  let fileCount = 0
  let maxDepth = 0
  const extCounts: Record<string, number> = {}
  const depthCounts: Record<number, number> = {}

  for (const [relPath, content] of Object.entries(FILES)) {
    const absPath = path.join(tmpDir, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content)
    fileCount++

    const depth = relPath.split('/').length - 1
    maxDepth = Math.max(maxDepth, depth)
    depthCounts[depth] = (depthCounts[depth] ?? 0) + 1

    const ext = path.extname(relPath) || path.basename(relPath)
    extCounts[ext] = (extCounts[ext] ?? 0) + 1
  }

  // Add some binary files that should be skipped
  fs.mkdirSync(path.join(tmpDir, 'target'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'target/order-service-2.1.0.jar'), Buffer.alloc(200))

  stat('Project dir', tmpDir)
  stat('Total files', fileCount)
  stat('Max depth', `${maxDepth} levels`)
  console.log()
  info('Files by depth:')
  for (const [depth, count] of Object.entries(depthCounts).sort((a, b) => +a[0] - +b[0])) {
    info(`  Level ${depth}: ${count} files`)
  }
  console.log()
  info('Files by type:')
  for (const [ext, count] of Object.entries(extCounts).sort((a, b) => b[1] - a[1])) {
    info(`  ${ext}: ${count}`)
  }

  // ── 2. Index project ──
  header('2. Indexing project')
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  createSchema(db)
  const projectId = generateNamespace(tmpDir)

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
    ok('Java tree-sitter parser loaded')
  } catch {
    fail('Java parser not available')
  }

  const safeFs = new SafeFS(tmpDir)
  const indexResult = await indexProject(db, safeFs, { full: true, ...javaParsers })

  stat('Files processed', indexResult.filesProcessed)
  stat('Files skipped', indexResult.filesSkipped)
  stat('Symbols indexed', indexResult.symbolCount)
  stat('Architecture', indexResult.architecture ?? 'not detected')
  stat('Index time', `${indexResult.loadTimeMs}ms`)

  // Detailed symbol stats
  const kindRows = db.prepare(
    "SELECT kind, COUNT(*) as cnt FROM symbols WHERE project_id = ? GROUP BY kind ORDER BY cnt DESC"
  ).all(projectId) as { kind: string; cnt: number }[]

  console.log()
  info('Symbols by kind:')
  for (const row of kindRows) {
    info(`  ${row.kind}: ${row.cnt}`)
  }

  // File-kind symbols detail
  const fileSymbols = db.prepare(
    "SELECT file_path FROM symbols WHERE project_id = ? AND kind = 'file' ORDER BY file_path"
  ).all(projectId) as { file_path: string }[]

  console.log()
  info(`Generic file symbols (${fileSymbols.length}):`)
  for (const s of fileSymbols) {
    const depth = s.file_path.split('/').length - 1
    info(`  L${depth} ${s.file_path}`)
  }

  // Java-parsed symbols (non-file)
  const javaSymbols = db.prepare(
    "SELECT kind, qualified_name, file_path FROM symbols WHERE project_id = ? AND kind != 'file' ORDER BY file_path, kind"
  ).all(projectId) as { kind: string; qualified_name: string; file_path: string }[]

  console.log()
  info(`Java-parsed symbols (${javaSymbols.length}):`)
  let lastFile = ''
  for (const s of javaSymbols) {
    if (s.file_path !== lastFile) {
      lastFile = s.file_path
      const depth = s.file_path.split('/').length - 1
      info(`  L${depth} ${s.file_path}`)
    }
    info(`    [${s.kind}] ${s.qualified_name}`)
  }

  // Schema + config
  const schemaCount = (db.prepare("SELECT COUNT(*) as cnt FROM schema_symbols WHERE project_id = ?").get(projectId) as any).cnt
  const configCount = (db.prepare("SELECT COUNT(*) as cnt FROM config_symbols WHERE project_id = ?").get(projectId) as any).cnt
  console.log()
  stat('Schema symbols (SQL)', schemaCount)
  stat('Config symbols (YAML)', configCount)

  // ── 3. BM25 Search ──
  header('3. BM25 Search Tests')

  const bm25Queries = [
    { query: 'OrderService createOrder', desc: 'Java class + method' },
    { query: 'postgresql datasource', desc: 'Properties config' },
    { query: 'hexagonal domain port', desc: 'Architecture / README' },
    { query: 'shipping address', desc: 'SQL migration' },
    { query: 'docker postgres redis', desc: 'Docker compose' },
    { query: 'JWT authentication security', desc: 'Security config' },
    { query: 'inventory reservation stock', desc: 'Domain port' },
    { query: 'Flyway migration', desc: 'Properties / README' },
  ]

  let bm25Pass = 0
  let bm25Fail = 0

  for (const { query, desc } of bm25Queries) {
    const results = searchBM25(db, query, projectId, undefined, 0.01)
    if (results.length > 0) {
      bm25Pass++
      ok(`"${query}" → ${results.length} results [${desc}]`)
      for (const r of results.slice(0, 3)) {
        info(`    ${r.kind.padEnd(12)} ${r.filePath} (score: ${r.bm25Score.toFixed(3)})`)
      }
    } else {
      bm25Fail++
      fail(`"${query}" → 0 results [${desc}]`)
    }
  }

  console.log()
  stat('BM25 queries', `${bm25Pass} passed, ${bm25Fail} failed out of ${bm25Queries.length}`)

  // ── 4. Load sqlite-vec ──
  header('4. Loading sqlite-vec')
  try {
    loadVec(db)
    ok('sqlite-vec extension loaded')
  } catch (err: any) {
    fail(`sqlite-vec failed: ${err.message}`)
    cleanup(db, tmpDir, tmpModelDir)
    process.exit(1)
  }

  // ── 5. Download model + build vector index ──
  header('5. Downloading embedding model')
  stat('Model cache', tmpModelDir)
  let embedder: Embedder
  try {
    const dlStart = Date.now()
    embedder = await getEmbedder()
    const dlMs = Date.now() - dlStart
    ok(`Model ready (${embedder.dimensions} dimensions, ${dlMs}ms)`)
  } catch (err: any) {
    fail(`Model download failed: ${err.message}`)
    cleanup(db, tmpDir, tmpModelDir)
    process.exit(1)
  }

  header('6. Building vector index')
  const allSymbols = db.prepare(
    'SELECT id, qualified_name, signature, javadoc, kind FROM symbols WHERE project_id = ?'
  ).all(projectId) as any[]

  const embedStart = Date.now()
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
  const embedMs = Date.now() - embedStart
  stat('Symbols embedded', allSymbols.length)
  stat('Embedding time', `${embedMs}ms`)
  stat('Avg per symbol', `${(embedMs / allSymbols.length).toFixed(1)}ms`)

  // ── 7. Vector search ──
  header('7. Vector Search Tests')

  const vecQueries = [
    { query: 'order lifecycle management confirmation shipping', desc: 'Domain logic' },
    { query: 'database connection configuration settings', desc: 'Config files' },
    { query: 'REST API endpoint controller HTTP', desc: 'REST adapter' },
    { query: 'persistence data access repository JPA', desc: 'JPA adapter' },
    { query: 'container deployment infrastructure', desc: 'Docker/infra' },
    { query: 'security authentication token', desc: 'Security' },
    { query: 'inventory stock reservation messaging', desc: 'Port interface' },
    { query: 'business rule validation domain entity', desc: 'Domain model' },
  ]

  let vecPass = 0
  let vecFail = 0

  for (const { query, desc } of vecQueries) {
    const results = await vectorSearch(db, query, projectId, embedder)
    if (results.length > 0) {
      vecPass++
      ok(`"${query}" → ${results.length} results [${desc}]`)
      for (const r of results.slice(0, 3)) {
        const symId = r.symbolId.split('::').pop() ?? r.symbolId
        info(`    dist=${r.distance.toFixed(4)}  ${symId}`)
      }
    } else {
      vecFail++
      fail(`"${query}" → 0 results [${desc}]`)
    }
  }

  console.log()
  stat('Vector queries', `${vecPass} passed, ${vecFail} failed out of ${vecQueries.length}`)

  // ── 8. Hybrid RRF ──
  header('8. Hybrid Search (RRF Fusion) Tests')

  const hybridQueries = [
    { bm25q: 'OrderService', vecq: 'order business logic use case', desc: 'Service layer' },
    { bm25q: 'postgresql datasource', vecq: 'database connection configuration', desc: 'Database config' },
    { bm25q: 'OrderRepository', vecq: 'data persistence storage layer', desc: 'Repository' },
  ]

  let hybridPass = 0

  for (const { bm25q, vecq, desc } of hybridQueries) {
    const bm25Results = searchBM25(db, bm25q, projectId, undefined, 0.01)
    const vecResults = await vectorSearch(db, vecq, projectId, embedder)
    const fused = rrfFusion(bm25Results, vecResults)

    if (fused.length > 0) {
      hybridPass++
      ok(`BM25="${bm25q}" + Vec="${vecq}" → ${fused.length} fused results [${desc}]`)
      info(`    BM25: ${bm25Results.length}, Vector: ${vecResults.length}, Fused: ${fused.length}`)
      for (const f of fused.slice(0, 3)) {
        const symId = f.symbolId.split('::').pop() ?? f.symbolId
        info(`    rrf=${f.rrfScore.toFixed(4)}  bm25Rank=${f.bm25Rank ?? '-'}  vecRank=${f.vectorRank ?? '-'}  ${symId}`)
      }
    } else {
      fail(`Hybrid search returned 0 results [${desc}]`)
    }
  }

  console.log()
  stat('Hybrid queries', `${hybridPass} passed out of ${hybridQueries.length}`)

  // ── Final report ──
  header('FINAL REPORT')
  const totalMs = Date.now() - startMs
  const totalSymbols = allSymbols.length
  const totalQueries = bm25Queries.length + vecQueries.length + hybridQueries.length
  const totalPass = bm25Pass + vecPass + hybridPass
  const totalFail = bm25Fail + vecFail + (hybridQueries.length - hybridPass)

  stat('Project files', `${fileCount} files, ${maxDepth} levels deep`)
  stat('File types', Object.keys(extCounts).join(', '))
  stat('Total symbols', `${totalSymbols} (${kindRows.map(r => `${r.cnt} ${r.kind}`).join(', ')})`)
  stat('Schema symbols', schemaCount)
  stat('Config symbols', configCount)
  stat('Search queries', `${totalQueries} total (${bm25Queries.length} BM25, ${vecQueries.length} vector, ${hybridQueries.length} hybrid)`)

  if (totalFail === 0) {
    console.log(`\n  ${G}${BOLD}ALL ${totalPass}/${totalQueries} QUERIES PASSED${RST}`)
  } else {
    console.log(`\n  ${Y}${BOLD}${totalPass}/${totalQueries} PASSED, ${totalFail} FAILED${RST}`)
  }
  stat('Total time', `${(totalMs / 1000).toFixed(1)}s`)

  // ── Cleanup ──
  cleanup(db, tmpDir, tmpModelDir)

  if (totalFail > 0) process.exit(1)
  process.exit(0)
}

function cleanup(db: Database.Database, tmpDir: string, tmpModelDir: string) {
  header('Cleanup')
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  ok(`Removed temp project: ${tmpDir}`)
  fs.rmSync(tmpModelDir, { recursive: true, force: true })
  ok(`Removed temp model cache: ${tmpModelDir}`)
  resetEmbedder()
}

main().catch(err => {
  console.error(`\n${R}FATAL: ${err.message}${RST}`)
  console.error(err.stack)
  process.exit(1)
})
