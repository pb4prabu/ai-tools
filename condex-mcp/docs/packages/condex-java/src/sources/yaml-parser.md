# yaml-parser.ts — YAML Config Parser

**Path:** `packages/condex-java/src/sources/yaml-parser.ts`

## What it does

Parses YAML configuration files (`application.yml`, `application-{profile}.yml`) into `ConfigSymbol[]`. Flattens nested YAML into dot-notation key paths.

## How it works

1. Parse YAML using `js-yaml`
2. Flatten nested structure into dot-notation keys
3. Detect Spring profile from filename (`application-dev.yml` → `"dev"`)
4. Handle arrays by JSON-stringifying them

## Example

Input (`application-dev.yml`):
```yaml
spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/mydb
    username: devuser
server:
  port: 8080
```

Output:
```json
[
  { "keyPath": "spring.datasource.url", "value": "jdbc:postgresql://localhost:5432/mydb", "profile": "dev" },
  { "keyPath": "spring.datasource.username", "value": "devuser", "profile": "dev" },
  { "keyPath": "server.port", "value": "8080", "profile": "dev" }
]
```

## Key export

```typescript
parseYamlFile(content, projectId, sourceFile) → ConfigSymbol[]
```

## Glob pattern

The indexer finds YAML files using `**/*.{yml,yaml}` (configurable via `condex.config.json` → `sources.yaml`).
