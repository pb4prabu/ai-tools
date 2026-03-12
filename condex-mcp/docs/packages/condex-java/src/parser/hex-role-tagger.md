# hex-role-tagger.ts — Hexagonal Architecture Role Tagger

**Path:** `packages/condex-java/src/parser/hex-role-tagger.ts`

## What it does

Assigns hexagonal architecture roles to symbols based on naming conventions and file paths. Only active when the project's detected architecture is `hexagonal`.

## Role Assignment Rules

| Pattern | Hex Role |
|---------|----------|
| `*Port` suffix or `/port/in/` path | `INBOUND_PORT` |
| `*Port` suffix or `/port/out/` path | `OUTBOUND_PORT` |
| `*Adapter` suffix or `/adapter/` path | `ADAPTER` |
| `*UseCase`, `*Handler`, `*Command` in `/application/` | `USE_CASE_HANDLER` |
| Classes in `/domain/` path | `DOMAIN_ENTITY` |
| `*Event` in `/domain/` | `DOMAIN_EVENT` |
| `*Command` in `/domain/` | `DOMAIN_COMMAND` |
| `*ValueObject`, `*VO` in `/domain/` | `VALUE_OBJECT` |

## Key export

```typescript
assignHexRole(qualifiedName, filePath, profile) → HexRole | undefined
```

## Why it matters

In a hexagonal architecture project, you can search with `hexRole: 'USE_CASE_HANDLER'` to find all use cases, or `hexRole: 'ADAPTER'` to find all adapters. This is more precise than keyword search.
