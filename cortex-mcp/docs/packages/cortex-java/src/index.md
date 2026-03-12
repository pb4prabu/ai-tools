# index.ts — Java Package Barrel Export

**Path:** `packages/cortex-java/src/index.ts`

## What it does

Re-exports all public APIs from the `@cortex-ai/java` package:

- `parseJavaFile` — Parse Java source into Symbol[]
- `assignSpringRole` — Map Spring annotations to roles
- `assignHexRole` — Map hexagonal architecture roles
- `detectArchitecture` — Detect project architecture from file paths
- `parseSqlFile` — Parse SQL migrations into SchemaSymbol[]
- `parseYamlFile` — Parse YAML configs into ConfigSymbol[]
