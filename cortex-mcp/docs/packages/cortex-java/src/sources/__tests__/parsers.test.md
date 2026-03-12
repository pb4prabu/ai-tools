# parsers.test.ts — SQL & YAML Parser Tests

**Path:** `packages/cortex-java/src/sources/__tests__/parsers.test.ts`

## What it tests

9 test cases across 2 describe blocks:

### SQL Parser
- CREATE TABLE extraction with column types and nullability
- ALTER TABLE ADD COLUMN
- IF NOT EXISTS handling
- Non-DDL statements are ignored (INSERT, SELECT, etc.)

### YAML Parser
- Dot-notation flattening (`spring.datasource.url`)
- Profile detection from filename (`application-dev.yml` → `"dev"`)
- Array handling (JSON-stringified)
- Invalid YAML graceful failure (returns empty array)
