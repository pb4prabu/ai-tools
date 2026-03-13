# sql-parser.ts — SQL Migration Parser

**Path:** `packages/condex-java/src/sources/sql-parser.ts`

## What it does

Parses SQL migration files (Flyway/Liquibase style) to extract database schema information as `SchemaSymbol[]`.

## What it extracts

| Statement | Extracts |
|-----------|----------|
| `CREATE TABLE` | Table name, all columns with types and nullability |
| `CREATE TABLE IF NOT EXISTS` | Same as above |
| `ALTER TABLE ADD COLUMN` | New column with type and nullability |

## Example

Input SQL:
```sql
CREATE TABLE orders (
    id BIGINT NOT NULL,
    customer_id BIGINT NOT NULL,
    status VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Output:
```json
[
  { "tableName": "orders", "columnName": "id", "dataType": "BIGINT", "nullable": false },
  { "tableName": "orders", "columnName": "customer_id", "dataType": "BIGINT", "nullable": false },
  { "tableName": "orders", "columnName": "status", "dataType": "VARCHAR(50)", "nullable": true },
  { "tableName": "orders", "columnName": "created_at", "dataType": "TIMESTAMP", "nullable": false }
]
```

## Key export

```typescript
parseSqlFile(content, projectId, sourceFile) → SchemaSymbol[]
```

## Glob pattern

The indexer finds SQL files using `**/*.sql` (configurable via `condex.config.json` → `sources.sql`).
