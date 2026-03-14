import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SafeFS } from '../security/fs-guard.js'
import { searchBM25, type BM25Result } from '../retrieval/bm25.js'
import { applyConfidenceGate } from '../retrieval/confidence-gate.js'
import { vectorSearch, type VectorResult } from '../retrieval/vector-search.js'
import { rrfFusion } from '../retrieval/rrf-fusion.js'
import type { Embedder } from '../embeddings/local-embed.js'
import {
  getSymbolById,
  getSymbolsByIds,
  getSymbolsByFile,
  getProjectOutline,
  getRelatedSymbolIds,
  clearProjectData,
} from '../store/sqlite-store.js'
import { buildMeta, countTokens } from './meta.js'
import type { IncrementalReindexer } from '../indexer/incremental-reindexer.js'

export type SearchMode = 'bm25' | 'vector' | 'hybrid' | 'smart'

export interface SearchThresholds {
  bm25MinScore: number
  vectorMaxDistance: number
  smartBm25MinScore: number
  smartVectorMaxDistance: number
}

export interface HandlerContext {
  db: Database.Database
  safeFs: SafeFS
  projectId: string
  projectName: string
  architecture: string | null
  searchMode: SearchMode
  embedder: Embedder | null
  thresholds: SearchThresholds
  reindexer?: IncrementalReindexer | null
}

type ToolResult = {
  content: { type: 'text'; text: string }[]
  _meta?: Record<string, unknown>
}

function textResult(text: string, meta?: Record<string, unknown>): ToolResult {
  const result: ToolResult = {
    content: [{ type: 'text', text }],
  }
  if (meta) result._meta = meta
  return result
}

function estimateTokens(text: string): number {
  return countTokens(text)
}

// ── list_projects ─────────────────────────────────────────

export async function handleListProjects(ctx: HandlerContext): Promise<ToolResult> {
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }
  const startMs = Date.now()
  const rows = ctx.db.prepare('SELECT * FROM projects').all() as any[]

  const projects = rows.map(r => ({
    projectId: r.id,
    name: r.name,
    rootPath: r.root_path,
    language: r.language,
    architecture: r.architecture,
    symbolCount: r.symbol_count,
    schemaCount: r.schema_count,
    configCount: r.config_count,
    indexedAt: r.indexed_at,
  }))

  const text = JSON.stringify(projects, null, 2)
  const meta = buildMeta({
    startMs,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: 0,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: 0,
    confidenceGateFired: false,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── get_project_outline ───────────────────────────────────

export async function handleGetProjectOutline(
  ctx: HandlerContext,
  args: { projectId?: string }
): Promise<ToolResult> {
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }
  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId
  const outline = getProjectOutline(ctx.db, pid)

  if (!outline) {
    return textResult(`No project found with ID: ${pid}`)
  }

  const text = JSON.stringify(outline, null, 2)
  const meta = buildMeta({
    startMs,
    projectId: pid,
    projectName: outline.projectName,
    architecture: outline.architecture,
    symbolsReturned: 0,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: estimateTokens(text) * 10, // outline is ~10x cheaper than reading all files
    confidenceGateFired: false,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── get_file_outline ──────────────────────────────────────

export async function handleGetFileOutline(
  ctx: HandlerContext,
  args: { filePath: string; projectId?: string }
): Promise<ToolResult> {
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }
  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId
  const symbols = getSymbolsByFile(ctx.db, pid, args.filePath)

  if (symbols.length === 0) {
    return textResult(`No symbols found in file: ${args.filePath}`)
  }

  const outline = symbols.map(s => ({
    id: s.id,
    kind: s.kind,
    simpleName: s.simpleName,
    signature: s.signature,
    springRole: s.springRole,
    hexRole: s.hexRole,
    byteOffset: s.byteOffset,
    byteLength: s.byteLength,
  }))

  const text = JSON.stringify(outline, null, 2)

  // Estimate naive cost: reading the entire file
  const fullFilePath = path.join(ctx.safeFs.getProjectRoot(), args.filePath)
  let naiveTokens = estimateTokens(text) * 5
  try {
    const stat = fs.statSync(fullFilePath)
    naiveTokens = Math.ceil(stat.size / 4)
  } catch { /* file might not exist */ }

  const meta = buildMeta({
    startMs,
    projectId: pid,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: symbols.length,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: naiveTokens,
    confidenceGateFired: false,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── search_symbols ────────────────────────────────────────

interface SearchResult {
  symbolId: string
  qualifiedName: string
  signature: string
  kind: string
  filePath: string
  springRole?: string
  hexRole?: string
  score: number
  searchMode: string
  expanded?: boolean  // true if added via call-graph expansion
}

function bm25ResultToSearchResult(r: BM25Result, mode: string): SearchResult {
  return {
    symbolId: r.symbolId, qualifiedName: r.qualifiedName, signature: r.signature,
    kind: r.kind, filePath: r.filePath, springRole: r.springRole ?? undefined,
    hexRole: r.hexRole ?? undefined,
    score: Math.round(r.bm25Score * 1000) / 1000, searchMode: mode,
  }
}

function vectorResultToSearchResult(v: VectorResult, db: Database.Database, mode: string): SearchResult {
  const sym = getSymbolById(db, v.symbolId)
  return {
    symbolId: v.symbolId,
    qualifiedName: sym?.qualifiedName ?? v.symbolId,
    signature: sym?.signature ?? '',
    kind: sym?.kind ?? '',
    filePath: sym?.filePath ?? '',
    springRole: sym?.springRole ?? undefined,
    hexRole: sym?.hexRole ?? undefined,
    score: Math.round((1 - v.distance) * 1000) / 1000,
    searchMode: mode,
  }
}

/**
 * Expand search results with call-graph related symbols.
 * Adds callers/callees that weren't already in the result set.
 */
function expandWithCallGraph(
  db: Database.Database,
  results: SearchResult[],
  projectId: string
): SearchResult[] {
  const existingIds = new Set(results.map(r => r.symbolId))
  const allIds = getRelatedSymbolIds(db, [...existingIds], projectId)
  const newIds = allIds.filter(id => !existingIds.has(id))

  if (newIds.length === 0) return results

  const newSymbols = getSymbolsByIds(db, newIds)
  const expanded: SearchResult[] = newSymbols.map(s => ({
    symbolId: s.id,
    qualifiedName: s.qualifiedName,
    signature: s.signature,
    kind: s.kind,
    filePath: s.filePath,
    springRole: s.springRole ?? undefined,
    hexRole: s.hexRole ?? undefined,
    score: 0, // no search score — added via graph
    searchMode: 'graph-expansion',
    expanded: true,
  }))

  return [...results, ...expanded]
}

export async function handleSearchSymbols(
  ctx: HandlerContext,
  args: {
    query: string
    projectId?: string
    kind?: string
    springRole?: string
    hexRole?: string
    filePattern?: string
  }
): Promise<ToolResult> {
  // Incremental re-index: detect and re-parse changed files before searching
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }

  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId
  const { thresholds } = ctx

  const filters = {
    kind: args.kind as any,
    springRole: args.springRole as any,
    hexRole: args.hexRole as any,
    filePattern: args.filePattern,
  }

  let results: SearchResult[]
  let gateFired = false
  let topScore = 0

  if (ctx.searchMode === 'bm25') {
    // ── BM25 only — score threshold, no count limit ──
    const rawResults = searchBM25(ctx.db, args.query, pid, filters, thresholds.bm25MinScore)
    topScore = rawResults[0]?.bm25Score ?? 0

    if (rawResults.length === 0) {
      const reason = `No symbols found matching "${args.query}"`
      const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: false, topScore: 0 })
      return textResult(reason, meta as unknown as Record<string, unknown>)
    }

    results = rawResults.map(r => bm25ResultToSearchResult(r, 'bm25'))
    // Expand with call graph
    results = expandWithCallGraph(ctx.db, results, pid)

  } else if (ctx.searchMode === 'vector') {
    // ── Vector primary, BM25 fallback ──
    if (ctx.embedder) {
      const vecResults = await vectorSearch(ctx.db, args.query, pid, ctx.embedder, thresholds.vectorMaxDistance)
      topScore = vecResults.length > 0 ? (1 - vecResults[0].distance) : 0

      if (vecResults.length > 0) {
        results = vecResults.map(v => vectorResultToSearchResult(v, ctx.db, 'vector'))
      } else {
        // Vector returned nothing — fall back to BM25
        gateFired = true
        const rawResults = searchBM25(ctx.db, args.query, pid, filters, thresholds.bm25MinScore)
        topScore = rawResults[0]?.bm25Score ?? 0
        if (rawResults.length === 0) {
          const reason = `No symbols found matching "${args.query}" (vector and BM25 both empty)`
          const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: true, topScore: 0 })
          return textResult(reason, meta as unknown as Record<string, unknown>)
        }
        results = rawResults.map(r => bm25ResultToSearchResult(r, 'bm25-fallback'))
        results = expandWithCallGraph(ctx.db, results, pid)
      }
    } else {
      // Embedder unavailable — fall back to BM25
      gateFired = true
      const rawResults = searchBM25(ctx.db, args.query, pid, filters, thresholds.bm25MinScore)
      topScore = rawResults[0]?.bm25Score ?? 0
      if (rawResults.length === 0) {
        const reason = `No symbols found matching "${args.query}" (vector unavailable, BM25 empty)`
        const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: true, topScore: 0 })
        return textResult(reason, meta as unknown as Record<string, unknown>)
      }
      results = rawResults.map(r => bm25ResultToSearchResult(r, 'bm25-fallback'))
      results = expandWithCallGraph(ctx.db, results, pid)
    }

  } else if (ctx.searchMode === 'smart') {
    // ── Smart: BM25 first (conservative), vector fallback ──
    const rawResults = searchBM25(ctx.db, args.query, pid, filters, thresholds.smartBm25MinScore)
    topScore = rawResults[0]?.bm25Score ?? 0

    if (rawResults.length > 0) {
      // BM25 found results above conservative threshold — use them
      gateFired = false
      results = rawResults.map(r => bm25ResultToSearchResult(r, 'bm25'))
      // Expand with call graph
      results = expandWithCallGraph(ctx.db, results, pid)
    } else if (ctx.embedder) {
      // BM25 didn't find confident results — fall back to vector
      gateFired = true
      const vecResults = await vectorSearch(ctx.db, args.query, pid, ctx.embedder, thresholds.smartVectorMaxDistance)
      if (vecResults.length === 0) {
        const reason = `No symbols found matching "${args.query}" (BM25 and vector both empty)`
        const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: true, topScore })
        return textResult(reason, meta as unknown as Record<string, unknown>)
      }
      results = vecResults.map(v => vectorResultToSearchResult(v, ctx.db, 'vector-fallback'))
    } else {
      // No embedder — return empty
      gateFired = true
      const reason = `No symbols found matching "${args.query}"`
      const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: true, topScore })
      return textResult(reason, meta as unknown as Record<string, unknown>)
    }

  } else {
    // ── Hybrid: BM25 + Vector with RRF fusion ──
    const bm25Results = searchBM25(ctx.db, args.query, pid, filters, thresholds.bm25MinScore)

    let vecResults: VectorResult[] = []
    if (ctx.embedder) {
      vecResults = await vectorSearch(ctx.db, args.query, pid, ctx.embedder, thresholds.vectorMaxDistance)
    }

    if (bm25Results.length === 0 && vecResults.length === 0) {
      const reason = `No symbols found matching "${args.query}"`
      const meta = buildMeta({ startMs, projectId: pid, projectName: ctx.projectName, architecture: ctx.architecture, symbolsReturned: 0, tokensInResponse: estimateTokens(reason), tokensIfNaive: 0, confidenceGateFired: false, topScore: 0 })
      return textResult(reason, meta as unknown as Record<string, unknown>)
    }

    const fused = rrfFusion(bm25Results, vecResults, 200) // no artificial limit
    topScore = fused[0]?.rrfScore ?? 0

    results = fused.map(f => {
      const sym = getSymbolById(ctx.db, f.symbolId)
      return {
        symbolId: f.symbolId,
        qualifiedName: sym?.qualifiedName ?? f.symbolId,
        signature: sym?.signature ?? '',
        kind: sym?.kind ?? '',
        filePath: sym?.filePath ?? '',
        springRole: sym?.springRole ?? undefined,
        hexRole: sym?.hexRole ?? undefined,
        score: Math.round(f.rrfScore * 10000) / 10000,
        searchMode: 'hybrid',
      }
    })
    // Expand with call graph
    results = expandWithCallGraph(ctx.db, results, pid)
  }

  const text = JSON.stringify(results, null, 2)

  // Estimate naive cost: reading all matched source files
  const uniqueFiles = [...new Set(results.map(r => r.filePath))]
  let naiveTokens = 0
  for (const fp of uniqueFiles) {
    try {
      const fullPath = path.join(ctx.safeFs.getProjectRoot(), fp)
      const stat = fs.statSync(fullPath)
      naiveTokens += Math.ceil(stat.size / 4)
    } catch {
      naiveTokens += 1000
    }
  }

  const meta = buildMeta({
    startMs,
    projectId: pid,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: results.length,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: naiveTokens,
    confidenceGateFired: gateFired,
    topScore,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── get_symbol ────────────────────────────────────────────

export async function handleGetSymbol(
  ctx: HandlerContext,
  args: { symbolId: string }
): Promise<ToolResult> {
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }
  const startMs = Date.now()
  const symbol = getSymbolById(ctx.db, args.symbolId)

  if (!symbol) {
    return textResult(`Symbol not found: ${args.symbolId}`)
  }

  // Read source code at byte offset
  const fullPath = path.join(ctx.safeFs.getProjectRoot(), symbol.filePath)
  let sourceCode: string
  let hashMismatch = false

  try {
    const buf = fs.readFileSync(fullPath)
    const snippet = buf.subarray(symbol.byteOffset, symbol.byteOffset + symbol.byteLength)
    sourceCode = snippet.toString('utf-8')

    // Verify content hash
    const actualHash = crypto.createHash('sha256').update(snippet).digest('hex').slice(0, 12)
    if (symbol.contentHash && actualHash !== symbol.contentHash) {
      hashMismatch = true
    }
  } catch (err: any) {
    return textResult(`Error reading source for ${args.symbolId}: ${err.message}`)
  }

  const result: Record<string, unknown> = {
    symbolId: symbol.id,
    qualifiedName: symbol.qualifiedName,
    signature: symbol.signature,
    kind: symbol.kind,
    filePath: symbol.filePath,
    sourceCode,
  }

  if (hashMismatch) {
    result.warning = 'Source code has changed since indexing. Content may not match symbol boundaries. Consider re-indexing.'
  }

  const text = JSON.stringify(result, null, 2)

  // Naive cost: reading entire file
  let naiveTokens = estimateTokens(text) * 5
  try {
    const stat = fs.statSync(fullPath)
    naiveTokens = Math.ceil(stat.size / 4)
  } catch { /* ignore */ }

  const meta = buildMeta({
    startMs,
    projectId: symbol.projectId,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: 1,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: naiveTokens,
    confidenceGateFired: false,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── get_symbols ───────────────────────────────────────────

export async function handleGetSymbols(
  ctx: HandlerContext,
  args: { symbolIds: string[] }
): Promise<ToolResult> {
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }
  const startMs = Date.now()
  const symbols = getSymbolsByIds(ctx.db, args.symbolIds)

  if (symbols.length === 0) {
    return textResult('No symbols found for the given IDs.')
  }

  const results: Record<string, unknown>[] = []
  let totalNaiveTokens = 0

  for (const symbol of symbols) {
    const fullPath = path.join(ctx.safeFs.getProjectRoot(), symbol.filePath)
    let sourceCode = ''
    let hashMismatch = false

    try {
      const buf = fs.readFileSync(fullPath)
      const snippet = buf.subarray(symbol.byteOffset, symbol.byteOffset + symbol.byteLength)
      sourceCode = snippet.toString('utf-8')

      const crypto = require('node:crypto')
      const actualHash = crypto.createHash('sha256').update(snippet).digest('hex').slice(0, 12)
      if (symbol.contentHash && actualHash !== symbol.contentHash) {
        hashMismatch = true
      }
    } catch { /* skip on error */ }

    const entry: Record<string, unknown> = {
      symbolId: symbol.id,
      qualifiedName: symbol.qualifiedName,
      signature: symbol.signature,
      kind: symbol.kind,
      filePath: symbol.filePath,
      sourceCode,
    }
    if (hashMismatch) entry.warning = 'Source changed since indexing.'
    results.push(entry)

    try {
      const stat = fs.statSync(fullPath)
      totalNaiveTokens += Math.ceil(stat.size / 4)
    } catch {
      totalNaiveTokens += 1000
    }
  }

  // De-duplicate naive cost by file
  const uniqueFiles = [...new Set(symbols.map(s => s.filePath))]
  totalNaiveTokens = 0
  for (const fp of uniqueFiles) {
    try {
      const stat = fs.statSync(path.join(ctx.safeFs.getProjectRoot(), fp))
      totalNaiveTokens += Math.ceil(stat.size / 4)
    } catch {
      totalNaiveTokens += 1000
    }
  }

  const text = JSON.stringify(results, null, 2)

  const meta = buildMeta({
    startMs,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: results.length,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: totalNaiveTokens,
    confidenceGateFired: false,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── search_schema ─────────────────────────────────────────

export async function handleSearchSchema(
  ctx: HandlerContext,
  args: { query: string; projectId?: string }
): Promise<ToolResult> {
  // Incremental re-index before schema search
  if (ctx.reindexer) {
    await ctx.reindexer.reindexIfNeeded()
  }

  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId

  // FTS5 search on schema_fts
  const sanitised = args.query
    .replace(/\./g, ' ')
    .replace(/['"*(){}[\]^~\\:!@#$%&+=|<>,;?/]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1)
    .join(' ')

  if (!sanitised) {
    return textResult('Empty search query.')
  }

  try {
    const rows = ctx.db.prepare(`
      SELECT
        ss.id, ss.table_name AS tableName, ss.column_name AS columnName,
        ss.data_type AS dataType, ss.nullable, ss.migration_file AS migrationFile,
        ss.summary, -schema_fts.rank AS score
      FROM schema_fts
      JOIN schema_symbols ss ON ss.id = schema_fts.id
      WHERE schema_fts MATCH ?
        AND ss.project_id = ?
      ORDER BY score DESC
      LIMIT 20
    `).all(sanitised, pid) as any[]

    if (rows.length === 0) {
      return textResult(`No schema matches for "${args.query}"`)
    }

    const text = JSON.stringify(rows, null, 2)
    const meta = buildMeta({
      startMs,
      projectId: pid,
      projectName: ctx.projectName,
      architecture: ctx.architecture,
      symbolsReturned: rows.length,
      tokensInResponse: estimateTokens(text),
      tokensIfNaive: estimateTokens(text) * 5,
      confidenceGateFired: false,
      topScore: rows[0]?.score ?? 0,
    })

    return textResult(text, meta as unknown as Record<string, unknown>)
  } catch {
    return textResult(`No schema matches for "${args.query}"`)
  }
}

// ── get_context_for_task ──────────────────────────────────

export async function handleGetContextForTask(
  ctx: HandlerContext,
  args: { task: string; tokenBudget?: number; projectId?: string }
): Promise<ToolResult> {
  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId
  const budget = args.tokenBudget ?? 50000

  // Use search_symbols logic to get ranked results
  const searchResult = await handleSearchSymbols(ctx, {
    query: args.task,
    projectId: pid,
  })

  // Parse the search results
  let searchedSymbols: { symbolId: string; qualifiedName: string; signature: string; kind: string; filePath: string; javadoc?: string; springRole?: string; hexRole?: string }[] = []
  try {
    const parsed = JSON.parse(searchResult.content[0].text)
    if (Array.isArray(parsed)) {
      searchedSymbols = parsed
    }
  } catch { /* search returned a message, not results */ }

  const context: Record<string, unknown> = {
    task: args.task,
    projectId: pid,
    searchMode: ctx.searchMode,
  }

  let usedTokens = estimateTokens(JSON.stringify(context))
  const symbolEntries: Record<string, unknown>[] = []

  for (const r of searchedSymbols) {
    // Enrich with javadoc from DB
    const fullSym = getSymbolById(ctx.db, r.symbolId)
    const entry = {
      symbolId: r.symbolId,
      qualifiedName: r.qualifiedName ?? fullSym?.qualifiedName,
      signature: r.signature ?? fullSym?.signature,
      kind: r.kind ?? fullSym?.kind,
      filePath: r.filePath ?? fullSym?.filePath,
      javadoc: fullSym?.javadoc,
      springRole: r.springRole ?? fullSym?.springRole,
      hexRole: r.hexRole ?? fullSym?.hexRole,
    }
    const entryTokens = estimateTokens(JSON.stringify(entry))
    if (usedTokens + entryTokens > budget) break
    symbolEntries.push(entry)
    usedTokens += entryTokens
  }

  context.symbols = symbolEntries
  context.tokenBudget = budget
  context.tokensUsed = usedTokens
  context.confidenceGateFired = searchedSymbols.length === 0

  const text = JSON.stringify(context, null, 2)

  // Naive cost
  const uniqueFiles = [...new Set(searchedSymbols.map(r => r.filePath))]
  let naiveTokens = 0
  for (const fp of uniqueFiles) {
    try {
      const stat = fs.statSync(path.join(ctx.safeFs.getProjectRoot(), fp))
      naiveTokens += Math.ceil(stat.size / 4)
    } catch {
      naiveTokens += 1000
    }
  }

  const meta = buildMeta({
    startMs,
    projectId: pid,
    projectName: ctx.projectName,
    architecture: ctx.architecture,
    symbolsReturned: symbolEntries.length,
    tokensInResponse: estimateTokens(text),
    tokensIfNaive: naiveTokens,
    confidenceGateFired: searchedSymbols.length === 0,
    topScore: 0,
  })

  return textResult(text, meta as unknown as Record<string, unknown>)
}

// ── index_folder ──────────────────────────────────────────

export async function handleIndexFolder(
  ctx: HandlerContext,
  args: { full?: boolean }
): Promise<ToolResult> {
  const startMs = Date.now()

  // Phase 7 will implement full parsing. For now, return a stub.
  return textResult(JSON.stringify({
    status: 'not_implemented',
    message: 'Parser not yet available. Index loading from .condex/index/ works via auto-index on startup.',
  }, null, 2))
}

// ── invalidate_cache ──────────────────────────────────────

export async function handleInvalidateCache(
  ctx: HandlerContext,
  args: { projectId?: string }
): Promise<ToolResult> {
  const startMs = Date.now()
  const pid = args.projectId ?? ctx.projectId

  clearProjectData(ctx.db, pid)

  return textResult(JSON.stringify({
    status: 'invalidated',
    projectId: pid,
    message: 'Project data cleared from in-memory database. Next query will trigger re-index.',
  }, null, 2))
}
