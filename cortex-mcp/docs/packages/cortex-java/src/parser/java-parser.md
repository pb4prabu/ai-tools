# java-parser.ts — Java AST Parser (tree-sitter)

**Path:** `packages/cortex-java/src/parser/java-parser.ts`

## What it does

Parses Java source files into `Symbol[]` using `tree-sitter` and `tree-sitter-java`. This is the most complex file in the Java package — it walks the full AST and extracts everything needed for code intelligence.

## What it extracts per symbol

| Field | Source |
|-------|--------|
| `qualifiedName` | Package + class hierarchy + name |
| `simpleName` | Just the name |
| `kind` | class, interface, enum, method, constructor, field, constant, annotation_type |
| `signature` | Everything before `{` (e.g., `public Order createOrder(OrderRequest req)`) |
| `javadoc` | Cleaned from `/** */` block comments above the symbol |
| `annotations` | All `@Annotation` strings |
| `parameterTypes` | Method/constructor parameter types |
| `returnType` | Method return type |
| `throwsTypes` | Checked exceptions |
| `implementedInterfaces` | From `implements` clause |
| `superclass` | From `extends` clause |
| `byteOffset` / `byteLength` | Exact position in file (for `get_symbol` to read source) |
| `contentHash` | SHA256 of the source code (for change detection) |
| `springRole` | From `@RestController`, `@Service`, etc. |
| `hexRole` | From file path patterns (adapters, ports, domain) |

## How it walks the AST

```
Java file
  → tree-sitter parse → AST
    → Walk top-level declarations
      → For each class/interface/enum:
        → Extract class-level symbol
        → Walk class body:
          → Extract methods, constructors, fields, constants
          → Handle inner/nested classes recursively
```

## Key export

```typescript
parseJavaFile(content, { projectId, filePath, profile? }) → Symbol[]
```

A single Java file typically produces 10-50 symbols (1 class + its methods + fields).
