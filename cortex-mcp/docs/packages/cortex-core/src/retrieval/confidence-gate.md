# confidence-gate.ts — Result Quality Filter

**Path:** `packages/cortex-core/src/retrieval/confidence-gate.ts`

## What it does

Silences low-quality BM25 results. If the best result's score is below a threshold, it returns nothing instead of returning garbage.

The philosophy: **silence is safer than wrong context.** Feeding an AI agent irrelevant code is worse than feeding it nothing.

## How it works

```
BM25 results come in
    │
    ▼
Top score >= threshold (0.12)?
    │
  ┌─┴──┐
  Yes   No
  │     │
  ▼     ▼
Filter  Return { passed: false }
out     with reason:
weak    - NO_RESULTS (empty)
results - LOW_CONFIDENCE (score too low)
  │
  ▼
Return { passed: true, results: [...] }
```

## Threshold

Default: `0.12`. This was tuned experimentally:
- Exact symbol name matches score 2.0+
- Partial matches score 0.5-1.5
- Weak/irrelevant matches score < 0.12

## When the gate fires

In benchmarks against urbanbarrow-mono, the gate fires on **12 out of 15 natural language queries** like:
- "authentication login security" — no keyword overlap with `AuthController`
- "order creation flow" — no keyword overlap with `OrderController.createOrder`

This is why smart mode exists — to fall back to vector search when the gate fires.

## Key export

```typescript
applyConfidenceGate(results, threshold?) → GateResult
```
