# bench.ts — Sample Project Benchmark

**Path:** `benchmark/bench.ts`

## What it does

Runs benchmarks against a generated sample Spring Boot monorepo (from `generate-sample.ts`). Unlike `bench-live.ts` which needs a real project, this creates its own test data.

## Flow

1. Generate sample project (~80-100 Java files) in a temp directory
2. Index the sample project in-memory
3. Run 15 queries across naive, BM25, hybrid, and smart modes
4. Print formatted results table and summary

## Usage

```bash
# BM25 only
npx tsx benchmark/bench.ts

# With vector search
npx tsx benchmark/bench.ts --vector

# Verbose (show per-query details)
npx tsx benchmark/bench.ts --verbose
```

## When to use this vs bench-live

- **bench.ts** — Quick, self-contained. Good for development and CI. Uses generated data.
- **bench-live.ts** — Real-world accuracy. Tests against your actual codebase. Better for evaluating search quality.
