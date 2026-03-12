# generate-sample.ts — Sample Monorepo Generator

**Path:** `benchmark/generate-sample.ts`

## What it does

Generates a realistic Spring Boot microservices monorepo for benchmarking purposes. Creates ~80-100 Java files across 4 services with realistic code structure.

## Generated Structure

```
sample-monorepo/
├── shared-lib/
│   └── src/main/java/com/example/shared/
│       ├── events/         # Domain events (OrderCreatedEvent, etc.)
│       ├── exceptions/     # Custom exception classes
│       └── dto/            # Shared DTOs
├── order-service/
│   └── src/main/java/com/example/order/
│       ├── domain/         # Order entity, enums
│       ├── application/    # Use cases, command handlers
│       ├── adapter/in/     # REST controllers
│       ├── adapter/out/    # Repository implementations
│       └── port/           # Inbound/outbound ports
├── user-service/           # Similar structure
├── notification-service/   # Kafka listeners, email/SMS
├── inventory-service/      # Stock management
└── migrations/
    └── *.sql              # SQL migration files
```

## Generated code includes

- Spring annotations (`@RestController`, `@Service`, `@Repository`, `@Entity`)
- Hexagonal architecture (ports, adapters, use cases)
- Javadoc comments
- Kafka event listeners
- Spring Security config
- SQL CREATE TABLE statements
- Realistic domain logic (order creation, payment, notifications)

## Usage

Not run directly — imported by `bench.ts` as part of the benchmark setup.
