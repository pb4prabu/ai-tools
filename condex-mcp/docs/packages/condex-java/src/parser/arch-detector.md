# arch-detector.ts — Architecture Detector

**Path:** `packages/condex-java/src/parser/arch-detector.ts`

## What it does

Detects the project's architecture style by analyzing file path patterns. Scores three architectures and returns the highest-scoring one with a confidence level.

## Architectures detected

### Hexagonal (Ports & Adapters)
Signals: `/application/`, `/domain/`, `/infrastructure/`, `Port.java`, `Adapter.java`, `UseCase.java`, `/port/in/`, `/port/out/`, `/adapter/in/`, `/adapter/out/`

### Layered
Signals: `/service/`, `/repository/`, `/controller/`, `/dao/`, `/dto/`

### MVC
Signals: `/model/`, `/view/`, `/controllers/`

## Scoring

Each signal has a weight. The architecture with the highest total score wins. Confidence is the ratio between the winning score and the runner-up.

## Key export

```typescript
detectArchitecture(filePaths: string[]) → {
  architecture: string    // 'hexagonal' | 'layered' | 'mvc' | 'unknown'
  confidence: number      // 0.0 - 1.0
  signals: string[]       // Which patterns matched
}
```

## Why it matters

Architecture detection enables hex role tagging. When a project is detected as hexagonal, symbols get tagged as `USE_CASE_HANDLER`, `INBOUND_PORT`, `ADAPTER`, `DOMAIN_ENTITY`, etc. — making search more precise.
