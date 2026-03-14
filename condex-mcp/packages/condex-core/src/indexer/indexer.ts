import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import { minimatch } from 'minimatch'
import type Database from 'better-sqlite3'
import type { SafeFS } from '../security/fs-guard.js'
import type { Symbol } from '../types/symbol.js'
import type { SchemaSymbol, ConfigSymbol, SymbolRef } from '../types/schema.js'
import type { CondexConfig, ProjectMeta } from '../types/config.js'
import { generateNamespace } from '../namespace/namespace.js'
import {
  initCondexDir,
  writeSymbolFile,
  writeSchemaSymbols,
  writeConfigSymbols,
  writeMeta,
  readMeta,
  readCondexConfig,
  acquireIndexLock,
  releaseIndexLock,
  writeErrorLog,
  writeSkippedLog,
  type SkippedFile,
} from '../store/fs-store.js'
import {
  insertRefs,
  clearProjectData,
} from '../store/sqlite-store.js'
import { loadProject } from '../store/loader.js'
import { parseGenericFile, isBinaryExtension } from './generic-file-parser.js'
import {
  detectLanguage,
  findSourceFiles,
  findSupplementalFiles,
  findFiles,
  mergeExcludes,
  hashContent,
  type ParseFileWithRefsFn,
} from './shared.js'

const TOOL_VERSION = '1.0.0'

export interface IndexResult {
  projectId: string
  projectName: string
  architecture: string | null
  symbolCount: number
  filesProcessed: number
  filesSkipped: number
  loadTimeMs: number
  incremental: boolean
  language?: string
  sourceFilesFound?: number
  supplementalFilesFound?: number
  zeroSymbolFiles?: string[]
  symbolsByKind?: Record<string, number>
  parseErrors?: number
}

export type ParseFileFn = (content: string, opts: {
  projectId: string
  filePath: string
  profile?: any
}) => Symbol[]

export type DetectArchFn = (filePaths: string[]) => {
  architecture: string
  confidence: number
  signals: string[]
}

export type ParseSqlFn = (content: string, projectId: string, sourceFile: string) => SchemaSymbol[]
export type ParseYamlFn = (content: string, projectId: string, sourceFile: string) => ConfigSymbol[]

/**
 * Full index of a project folder.
 */
export async function indexProject(
  db: Database.Database,
  safeFs: SafeFS,
  opts: {
    full?: boolean
    parseFile?: ParseFileFn
    parseFileWithRefs?: ParseFileWithRefsFn
    detectArch?: DetectArchFn
    parseSql?: ParseSqlFn
    parseYaml?: ParseYamlFn
  } = {},
): Promise<IndexResult> {
  const startMs = Date.now()
  const projectRoot = safeFs.getProjectRoot()
  const projectName = path.basename(projectRoot)
  const projectId = generateNamespace(projectRoot)
  const config: Partial<CondexConfig> = await readCondexConfig(safeFs) ?? {}

  await initCondexDir(safeFs)

  const lockAcquired = await acquireIndexLock(safeFs)
  if (!lockAcquired) {
    console.error('[condex] Index lock held by another process, skipping')
    return {
      projectId, projectName, architecture: null,
      symbolCount: 0, filesProcessed: 0, filesSkipped: 0,
      loadTimeMs: Date.now() - startMs, incremental: false,
    }
  }

  try {
    const existingMeta = opts.full ? null : await readMeta(safeFs)
    const existingHashes = existingMeta?.fileHashes ?? {}

    // Detect language & find source files
    const language = config.language === 'auto' || !config.language
      ? detectLanguage(projectRoot) : config.language
    const sourceFiles = await findSourceFiles(projectRoot, language ?? 'java', config)

    logFileDiscovery(sourceFiles, language, config)

    // Detect architecture
    let architecture: string | null = null
    let archConfidence: number | undefined
    if (opts.detectArch) {
      const profile = opts.detectArch(sourceFiles)
      architecture = profile.architecture
      archConfidence = profile.confidence
    }

    // Parse source files
    const { symbols: allSymbols, refs: allRefs, filesProcessed, filesSkipped, skippedFiles, zeroSymbolFiles, parseErrors } =
      await parseSourceFiles(sourceFiles, projectRoot, projectId, existingHashes, opts, config)

    // Parse supplemental files
    const primaryFileSet = new Set(sourceFiles)
    const supplementalFiles = await findSupplementalFiles(projectRoot, config, primaryFileSet)
    const suppResult = parseSupplementalFiles(supplementalFiles, projectRoot, projectId, existingHashes, opts.full)
    allSymbols.push(...suppResult.symbols)
    const totalProcessed = filesProcessed + suppResult.filesProcessed
    const totalNewHashes = { ...suppResult.newHashes }
    // Merge source file hashes
    for (const relPath of sourceFiles) {
      const absPath = path.join(projectRoot, relPath)
      try {
        const content = fs.readFileSync(absPath, 'utf-8')
        totalNewHashes[relPath] = hashContent(content)
      } catch { /* skip */ }
    }

    // Write symbol files to .condex/index/
    for (const sym of allSymbols) {
      await writeSymbolFile(safeFs, sym)
    }

    // Parse SQL migrations
    const allSchemas = await parseSchemaFiles(opts.parseSql, projectRoot, projectId, config, safeFs)

    // Parse YAML config
    const allConfigs = await parseConfigFiles(opts.parseYaml, projectRoot, projectId, config, safeFs)

    // Write meta
    const meta: ProjectMeta = {
      projectId, projectName, projectRoot,
      language: language ?? undefined,
      architecture: architecture ?? undefined,
      architectureConfidence: archConfidence,
      lastFullIndex: opts.full ? new Date().toISOString() : existingMeta?.lastFullIndex,
      lastIncrementalIndex: new Date().toISOString(),
      toolVersion: TOOL_VERSION,
      symbolCount: allSymbols.length,
      schemaCount: allSchemas.length,
      configCount: allConfigs.length,
      fileHashes: totalNewHashes,
    }
    await writeMeta(safeFs, meta)

    // Load into SQLite
    clearProjectData(db, projectId)
    const loadResult = await loadProject(db, safeFs)

    if (allRefs.length > 0) {
      insertRefs(db, allRefs)
      console.error(`[condex] Refs: ${allRefs.length} call-graph references extracted`)
    }

    const loadTimeMs = Date.now() - startMs
    console.error(
      `[condex] Indexed: ${totalProcessed} files, ${allSymbols.length} symbols ` +
      `(${filesSkipped} skipped) in ${loadTimeMs}ms`,
    )

    // Write skipped log
    const indexedFileSet = new Set([...sourceFiles, ...supplementalFiles])
    const excludedFiles = await findExcludedFiles(projectRoot, language ?? 'java', config, indexedFileSet)
    const allSkipped = [...skippedFiles, ...excludedFiles]
    if (allSkipped.length > 0) {
      await writeSkippedLog(safeFs, allSkipped)
      console.error(`[condex] Skipped log: ${allSkipped.length} files (see .condex/index/skipped.json)`)
    }

    // Symbol-by-kind breakdown
    const symbolsByKind: Record<string, number> = {}
    for (const sym of allSymbols) {
      symbolsByKind[sym.kind] = (symbolsByKind[sym.kind] ?? 0) + 1
    }

    return {
      projectId, projectName, architecture,
      symbolCount: loadResult?.symbolCount ?? allSymbols.length,
      filesProcessed: totalProcessed, filesSkipped,
      loadTimeMs,
      incremental: !opts.full && Object.keys(existingHashes).length > 0,
      language: language ?? undefined,
      sourceFilesFound: sourceFiles.length,
      supplementalFilesFound: supplementalFiles.length,
      zeroSymbolFiles: zeroSymbolFiles.length > 0 ? zeroSymbolFiles.slice(0, 20) : undefined,
      symbolsByKind,
      parseErrors: parseErrors > 0 ? parseErrors : undefined,
    }
  } catch (err: any) {
    await writeErrorLog(safeFs, {
      phase: 'indexProject',
      message: err.message,
      stack: err.stack,
      context: { projectId, projectName, full: !!opts.full },
    })
    throw err
  } finally {
    await releaseIndexLock(safeFs)
  }
}

// ── Internal helpers ──────────────────────────────────────

function logFileDiscovery(sourceFiles: string[], language: string | null, config: Partial<CondexConfig>): void {
  const extCounts: Record<string, number> = {}
  for (const f of sourceFiles) {
    const ext = path.extname(f) || '(no ext)'
    extCounts[ext] = (extCounts[ext] ?? 0) + 1
  }
  console.error(`[condex] Language: ${language}, Files found: ${sourceFiles.length}`)
  console.error(`[condex] Extensions: ${JSON.stringify(extCounts)}`)
  if (config.include) {
    console.error(`[condex] Using config include: ${JSON.stringify(config.include)}`)
  }
}

interface ParseResult {
  symbols: Symbol[]
  refs: SymbolRef[]
  filesProcessed: number
  filesSkipped: number
  skippedFiles: SkippedFile[]
  zeroSymbolFiles: string[]
  parseErrors: number
}

async function parseSourceFiles(
  sourceFiles: string[],
  projectRoot: string,
  projectId: string,
  existingHashes: Record<string, string>,
  opts: {
    full?: boolean
    parseFile?: ParseFileFn
    parseFileWithRefs?: ParseFileWithRefsFn
    detectArch?: DetectArchFn
  },
  config: Partial<CondexConfig>,
): Promise<ParseResult> {
  const symbols: Symbol[] = []
  const refs: SymbolRef[] = []
  const skippedFiles: SkippedFile[] = []
  const zeroSymbolFiles: string[] = []
  let filesProcessed = 0
  let filesSkipped = 0
  let parseErrors = 0

  for (const relPath of sourceFiles) {
    const absPath = path.join(projectRoot, relPath)
    let content: string
    try {
      content = fs.readFileSync(absPath, 'utf-8')
    } catch (err: any) {
      filesSkipped++
      skippedFiles.push({ file: relPath, reason: 'unreadable', detail: err.message })
      continue
    }

    const hash = hashContent(content)

    // Incremental: skip unchanged files
    if (!opts.full && existingHashes[relPath] === hash) {
      filesSkipped++
      skippedFiles.push({ file: relPath, reason: 'unchanged' })
      continue
    }

    const parseOpts = {
      projectId,
      filePath: relPath,
      profile: opts.detectArch ? opts.detectArch(sourceFiles) : undefined,
    }

    let parsed = false

    if (opts.parseFileWithRefs) {
      try {
        const result = opts.parseFileWithRefs(content, parseOpts)
        if (result.symbols.length > 0) {
          symbols.push(...result.symbols)
          refs.push(...result.refs)
          filesProcessed++
          parsed = true
        } else if (relPath.endsWith('.java')) {
          zeroSymbolFiles.push(relPath)
          console.error(`[condex] WARNING: 0 symbols from language parser for ${relPath} (${content.length} bytes)`)
        }
      } catch (err: any) {
        console.error(`[condex] Language parser failed for ${relPath}, falling back to generic: ${err.message}`)
        parseErrors++
      }
    } else if (opts.parseFile) {
      try {
        const result = opts.parseFile(content, parseOpts)
        if (result.length > 0) {
          symbols.push(...result)
          filesProcessed++
          parsed = true
        }
      } catch (err: any) {
        console.error(`[condex] Language parser failed for ${relPath}, falling back to generic: ${err.message}`)
        parseErrors++
      }
    }

    // Fallback to generic file parser
    if (!parsed) {
      const sym = parseGenericFile(content, { projectId, filePath: relPath })
      if (sym) {
        symbols.push(sym)
        filesProcessed++
      } else {
        filesSkipped++
        skippedFiles.push({ file: relPath, reason: 'no_parser', detail: 'Both language and generic parsers returned no symbols' })
      }
    }
  }

  if (parseErrors > 0) {
    console.error(`[condex] WARNING: ${parseErrors} files failed to parse`)
  }

  return { symbols, refs, filesProcessed, filesSkipped, skippedFiles, zeroSymbolFiles, parseErrors }
}

function parseSupplementalFiles(
  supplementalFiles: string[],
  projectRoot: string,
  projectId: string,
  existingHashes: Record<string, string>,
  full?: boolean,
): { symbols: Symbol[]; filesProcessed: number; newHashes: Record<string, string> } {
  const symbols: Symbol[] = []
  const newHashes: Record<string, string> = {}
  let filesProcessed = 0

  if (supplementalFiles.length > 0) {
    console.error(`[condex] Supplemental files: ${supplementalFiles.length} non-language files`)
  }

  for (const relPath of supplementalFiles) {
    let content: string
    try {
      content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8')
    } catch { continue }

    const hash = hashContent(content)
    newHashes[relPath] = hash

    if (!full && existingHashes[relPath] === hash) continue

    const sym = parseGenericFile(content, { projectId, filePath: relPath })
    if (sym) {
      symbols.push(sym)
      filesProcessed++
    }
  }

  return { symbols, filesProcessed, newHashes }
}

async function parseSchemaFiles(
  parseSql: ParseSqlFn | undefined,
  projectRoot: string,
  projectId: string,
  config: Partial<CondexConfig>,
  safeFs: SafeFS,
): Promise<SchemaSymbol[]> {
  if (!parseSql) return []

  const sqlPattern = config.sources?.sql || '**/*.sql'
  const sqlFiles = await findFiles(projectRoot, sqlPattern, config)
  const allSchemas: SchemaSymbol[] = []

  for (const relPath of sqlFiles) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8')
      allSchemas.push(...parseSql(content, projectId, relPath))
    } catch (err: any) {
      console.error(`[condex] Error parsing SQL ${relPath}: ${err.message}`)
      try {
        await writeErrorLog(safeFs, {
          phase: 'indexProject:sql',
          message: `SQL parse error: ${err.message}`,
          context: { file: relPath },
        })
      } catch { /* best effort */ }
    }
  }

  if (allSchemas.length > 0) {
    await writeSchemaSymbols(safeFs, allSchemas)
    console.error(`[condex] Schema: ${allSchemas.length} symbols from ${sqlFiles.length} SQL files`)
  }

  return allSchemas
}

async function parseConfigFiles(
  parseYaml: ParseYamlFn | undefined,
  projectRoot: string,
  projectId: string,
  config: Partial<CondexConfig>,
  safeFs: SafeFS,
): Promise<ConfigSymbol[]> {
  if (!parseYaml) return []

  const yamlPattern = config.sources?.yaml || '**/*.{yml,yaml}'
  const yamlFiles = await findFiles(projectRoot, yamlPattern, config)
  const allConfigs: ConfigSymbol[] = []

  for (const relPath of yamlFiles) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8')
      allConfigs.push(...parseYaml(content, projectId, relPath))
    } catch (err: any) {
      console.error(`[condex] Error parsing YAML ${relPath}: ${err.message}`)
      try {
        await writeErrorLog(safeFs, {
          phase: 'indexProject:yaml',
          message: `YAML parse error: ${err.message}`,
          context: { file: relPath },
        })
      } catch { /* best effort */ }
    }
  }

  if (allConfigs.length > 0) {
    await writeConfigSymbols(safeFs, allConfigs)
    console.error(`[condex] Config: ${allConfigs.length} properties from ${yamlFiles.length} YAML files`)
  }

  return allConfigs
}

/**
 * Find files excluded by glob patterns for the skipped log.
 */
async function findExcludedFiles(
  projectRoot: string,
  language: string,
  config: Partial<CondexConfig>,
  indexedFiles: Set<string>,
): Promise<SkippedFile[]> {
  const skipped: SkippedFile[] = []
  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: ['**/.condex/**', '**/.git/**'],
    nodir: true,
  })

  const allExclude = mergeExcludes(config)

  for (const file of allFiles) {
    if (indexedFiles.has(file)) continue

    if (isBinaryExtension(file)) {
      skipped.push({ file, reason: 'binary_extension', detail: path.extname(file) })
      continue
    }

    const matchedPattern = findMatchingPattern(file, allExclude)
    if (matchedPattern) {
      skipped.push({ file, reason: 'excluded_by_pattern', pattern: matchedPattern })
    }
  }

  return skipped
}

function findMatchingPattern(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (minimatch(filePath, pattern, { dot: true })) return pattern
  }
  return null
}

// Re-export shared utilities for external consumers (CLI, etc.)
export { detectLanguage, findSourceFiles, hashContent, type ParseFileWithRefsFn } from './shared.js'
