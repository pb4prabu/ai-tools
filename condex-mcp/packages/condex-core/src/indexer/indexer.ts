import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import { minimatch } from 'minimatch'
import type Database from 'better-sqlite3'
import type { SafeFS } from '../security/fs-guard.js'
import type { Symbol } from '../types/symbol.js'
import type { SchemaSymbol, ConfigSymbol, SymbolRef } from '../types/schema.js'
import type { CondexConfig, ProjectMeta } from '../types/config.js'
import { DEFAULT_CONFIG } from '../types/config.js'
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
  hashContent,
  writeErrorLog,
  writeSkippedLog,
  type SkippedFile,
} from '../store/fs-store.js'
import {
  insertProject,
  insertSymbols,
  insertRefs,
  clearProjectData,
} from '../store/sqlite-store.js'
import { loadProject } from '../store/loader.js'
import { parseGenericFile, isBinaryExtension } from './generic-file-parser.js'

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
  /** Diagnostic info: language detected */
  language?: string
  /** Diagnostic: source files found by glob */
  sourceFilesFound?: number
  /** Diagnostic: supplemental (non-language) files found */
  supplementalFilesFound?: number
  /** Diagnostic: files that produced 0 symbols from language parser */
  zeroSymbolFiles?: string[]
  /** Diagnostic: symbol count by kind */
  symbolsByKind?: Record<string, number>
  /** Diagnostic: parse errors count */
  parseErrors?: number
}

export type ParseFileFn = (content: string, opts: {
  projectId: string
  filePath: string
  profile?: any
}) => Symbol[]

export type ParseFileWithRefsFn = (content: string, opts: {
  projectId: string
  filePath: string
  profile?: any
}) => { symbols: Symbol[]; refs: SymbolRef[] }

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
  } = {}
): Promise<IndexResult> {
  const startMs = Date.now()
  const projectRoot = safeFs.getProjectRoot()
  const projectName = path.basename(projectRoot)
  const projectId = generateNamespace(projectRoot)

  // Read config (optional) — use empty object so language-specific patterns are used
  const config: Partial<CondexConfig> = await readCondexConfig(safeFs) ?? {}

  // Ensure .condex/index/ dirs exist
  await initCondexDir(safeFs)

  // Acquire lock
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
    // Read existing meta for incremental indexing
    const existingMeta = opts.full ? null : await readMeta(safeFs)
    const existingHashes = existingMeta?.fileHashes ?? {}

    // Detect language & find source files
    const language = config.language === 'auto' || !config.language
      ? detectLanguage(projectRoot)
      : config.language
    const sourceFiles = await findSourceFiles(projectRoot, language ?? 'java', config)

    // Log file discovery stats for debugging
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

    // Detect architecture
    let architecture: string | null = null
    let archConfidence: number | undefined
    if (opts.detectArch) {
      const profile = opts.detectArch(sourceFiles)
      architecture = profile.architecture
      archConfidence = profile.confidence
    }

    // Parse files
    const allSymbols: Symbol[] = []
    const allRefs: SymbolRef[] = []
    const newHashes: Record<string, string> = {}
    let filesProcessed = 0
    let filesSkipped = 0
    const zeroSymbolFiles: string[] = []
    const skippedFiles: SkippedFile[] = []

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
      newHashes[relPath] = hash

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
            allSymbols.push(...result.symbols)
            allRefs.push(...result.refs)
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
          const symbols = opts.parseFile(content, parseOpts)
          if (symbols.length > 0) {
            allSymbols.push(...symbols)
            filesProcessed++
            parsed = true
          }
        } catch (err: any) {
          console.error(`[condex] Language parser failed for ${relPath}, falling back to generic: ${err.message}`)
          parseErrors++
        }
      }

      // Fallback: if language parser didn't produce symbols, use generic file parser
      // This ensures ALL source files (Python, Kotlin, etc.) are searchable via BM25 + Vector
      if (!parsed) {
        const sym = parseGenericFile(content, { projectId, filePath: relPath })
        if (sym) {
          allSymbols.push(sym)
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

    // ── Parse supplemental (non-language) files as generic file symbols ──
    const primaryFileSet = new Set(sourceFiles)
    const supplementalFiles = await findSupplementalFiles(projectRoot, config, primaryFileSet)
    if (supplementalFiles.length > 0) {
      console.error(`[condex] Supplemental files: ${supplementalFiles.length} non-language files`)
      for (const relPath of supplementalFiles) {
        const absPath = path.join(projectRoot, relPath)
        let content: string
        try {
          content = fs.readFileSync(absPath, 'utf-8')
        } catch {
          continue
        }

        const hash = hashContent(content)
        newHashes[relPath] = hash

        // Incremental: skip unchanged files
        if (!opts.full && existingHashes[relPath] === hash) {
          continue
        }

        const sym = parseGenericFile(content, { projectId, filePath: relPath })
        if (sym) {
          allSymbols.push(sym)
          filesProcessed++
        }
      }
    }

    // Write symbol files to .condex/index/
    for (const sym of allSymbols) {
      await writeSymbolFile(safeFs, sym)
    }

    // ── Parse SQL migrations ──
    const allSchemas: SchemaSymbol[] = []
    if (opts.parseSql) {
      const sqlPattern = config.sources?.sql || '**/*.sql'
      const sqlFiles = await findFiles(projectRoot, sqlPattern, config)
      for (const relPath of sqlFiles) {
        try {
          const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8')
          const schemas = opts.parseSql(content, projectId, relPath)
          allSchemas.push(...schemas)
        } catch (err: any) {
          console.error(`[condex] Error parsing SQL ${relPath}: ${err.message}`)
        }
      }
      if (allSchemas.length > 0) {
        await writeSchemaSymbols(safeFs, allSchemas)
        console.error(`[condex] Schema: ${allSchemas.length} symbols from ${sqlFiles.length} SQL files`)
      }
    }

    // ── Parse YAML config ──
    const allConfigs: ConfigSymbol[] = []
    if (opts.parseYaml) {
      const yamlPattern = config.sources?.yaml || '**/*.{yml,yaml}'
      const yamlFiles = await findFiles(projectRoot, yamlPattern, config)
      for (const relPath of yamlFiles) {
        try {
          const content = fs.readFileSync(path.join(projectRoot, relPath), 'utf-8')
          const configs = opts.parseYaml(content, projectId, relPath)
          allConfigs.push(...configs)
        } catch (err: any) {
          console.error(`[condex] Error parsing YAML ${relPath}: ${err.message}`)
        }
      }
      if (allConfigs.length > 0) {
        await writeConfigSymbols(safeFs, allConfigs)
        console.error(`[condex] Config: ${allConfigs.length} properties from ${yamlFiles.length} YAML files`)
      }
    }

    // Write meta
    const meta: ProjectMeta = {
      projectId,
      projectName,
      projectRoot,
      language: language ?? undefined,
      architecture: architecture ?? undefined,
      architectureConfidence: archConfidence,
      lastFullIndex: opts.full ? new Date().toISOString() : existingMeta?.lastFullIndex,
      lastIncrementalIndex: new Date().toISOString(),
      toolVersion: TOOL_VERSION,
      symbolCount: allSymbols.length,
      schemaCount: allSchemas.length,
      configCount: allConfigs.length,
      fileHashes: newHashes,
    }
    await writeMeta(safeFs, meta)

    // Load into SQLite (this clears existing data first)
    clearProjectData(db, projectId)
    const loadResult = await loadProject(db, safeFs)

    // Insert refs AFTER loadProject (loadProject clears SQLite, so refs must come after)
    if (allRefs.length > 0) {
      insertRefs(db, allRefs)
      console.error(`[condex] Refs: ${allRefs.length} call-graph references extracted`)
    }

    const loadTimeMs = Date.now() - startMs
    console.error(
      `[condex] Indexed: ${filesProcessed} files, ${allSymbols.length} symbols ` +
      `(${filesSkipped} skipped) in ${loadTimeMs}ms`
    )

    // Detect files excluded by glob patterns and write skipped log
    const indexedFileSet = new Set([...sourceFiles, ...supplementalFiles])
    const excludedFiles = await findExcludedFiles(projectRoot, language ?? 'java', config, indexedFileSet)
    const allSkipped = [...skippedFiles, ...excludedFiles]
    if (allSkipped.length > 0) {
      await writeSkippedLog(safeFs, allSkipped)
      console.error(`[condex] Skipped log: ${allSkipped.length} files (see .condex/index/skipped.json)`)
    }

    // Build symbol-by-kind breakdown
    const symbolsByKind: Record<string, number> = {}
    for (const sym of allSymbols) {
      symbolsByKind[sym.kind] = (symbolsByKind[sym.kind] ?? 0) + 1
    }

    return {
      projectId,
      projectName,
      architecture,
      symbolCount: loadResult?.symbolCount ?? allSymbols.length,
      filesProcessed,
      filesSkipped,
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
    // Log error to .condex/index/errors.log for diagnosis
    await writeErrorLog(safeFs, {
      phase: 'indexProject',
      message: err.message,
      stack: err.stack,
      context: { projectId, projectName, full: !!opts.full },
    })
    throw err // re-throw so caller knows indexing failed
  } finally {
    await releaseIndexLock(safeFs)
  }
}

function detectLanguage(projectRoot: string): string {
  // Priority-ordered: Java > TypeScript > Python
  // Use glob to search any depth (real projects can be 20+ levels deep)
  const ignore = ['**/node_modules/**', '**/build/classes/**', '**/build/generated/**', '**/build/libs/**', '**/build/tmp/**', '**/target/classes/**', '**/target/generated-sources/**', '**/target/test-classes/**', '**/dist/out/**', '**/.git/**', '**/.condex/**']

  // Check Java markers at any depth
  const javaMarkers = ['pom.xml', 'build.gradle', 'build.gradle.kts']
  for (const marker of javaMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'java'
    } catch { /* ignore */ }
  }

  // Check TypeScript markers at any depth
  const tsMarkers = ['tsconfig.json']
  for (const marker of tsMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'typescript'
    } catch { /* ignore */ }
  }

  // Check for package.json only at root (monorepos have it for workspace management)
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'typescript'

  // Check Python markers at any depth
  const pyMarkers = ['requirements.txt', 'pyproject.toml']
  for (const marker of pyMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'python'
    } catch { /* ignore */ }
  }

  return 'java' // default
}

async function findFiles(
  projectRoot: string,
  pattern: string,
  config: Partial<CondexConfig>
): Promise<string[]> {
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
  const allExclude = [...new Set([...exclude, '**/.condex/**'])]

  const files = await glob(pattern, {
    cwd: projectRoot,
    ignore: allExclude,
    nodir: true,
  })
  return [...new Set(files)].sort()
}

async function findSourceFiles(
  projectRoot: string,
  language: string,
  config: Partial<CondexConfig>
): Promise<string[]> {
  const extensionMap: Record<string, string[]> = {
    java: ['**/*.java', '**/*.kt', '**/*.kts'],
    typescript: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    python: ['**/*.py'],
  }

  const include = config.include ?? extensionMap[language] ?? extensionMap.java
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude

  // Always exclude .condex/
  const allExclude = [...new Set([...exclude, '**/.condex/**'])]

  const files: string[] = []
  for (const pattern of include) {
    const matched = await glob(pattern, {
      cwd: projectRoot,
      ignore: allExclude,
      nodir: true,
    })
    files.push(...matched)
  }

  return [...new Set(files)].sort()
}

/**
 * Find supplemental (non-language) text files that should also be indexed
 * as generic file-level symbols.
 * Excludes files already found by the language-specific search and binary files.
 */
async function findSupplementalFiles(
  projectRoot: string,
  config: Partial<CondexConfig>,
  alreadyFound: Set<string>
): Promise<string[]> {
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
  const allExclude = [...new Set([...exclude, '**/.condex/**'])]

  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: allExclude,
    nodir: true,
  })

  return allFiles
    .filter(f => !alreadyFound.has(f))
    .filter(f => !isBinaryExtension(f))
    .sort()
}

/**
 * Find files that exist on disk but were excluded by glob patterns.
 * Compares a full unfiltered scan against the filtered source + supplemental sets.
 */
async function findExcludedFiles(
  projectRoot: string,
  language: string,
  config: Partial<CondexConfig>,
  indexedFiles: Set<string>
): Promise<SkippedFile[]> {
  const skipped: SkippedFile[] = []

  // Get ALL files with minimal exclusions (just .condex and .git internals)
  const allFiles = await glob('**/*', {
    cwd: projectRoot,
    ignore: ['**/.condex/**', '**/.git/**'],
    nodir: true,
  })

  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
  const allExclude = [...new Set([...exclude, '**/.condex/**'])]

  for (const file of allFiles) {
    if (indexedFiles.has(file)) continue

    // Determine why this file was skipped
    if (isBinaryExtension(file)) {
      skipped.push({ file, reason: 'binary_extension', detail: path.extname(file) })
      continue
    }

    // Check which exclusion pattern matched
    const matchedPattern = findMatchingPattern(file, allExclude)
    if (matchedPattern) {
      skipped.push({ file, reason: 'excluded_by_pattern', pattern: matchedPattern })
      continue
    }

    // If not binary and not pattern-excluded, it might be a language file
    // that didn't match include patterns — only relevant for source files
    const extensionMap: Record<string, string[]> = {
      java: ['.java'],
      typescript: ['.ts', '.tsx'],
      python: ['.py'],
    }
    const langExts = extensionMap[language] ?? extensionMap.java
    const ext = path.extname(file)
    if (langExts.length > 0 && !langExts.includes(ext)) {
      // Non-language file that passed through supplemental — no action needed
      continue
    }
  }

  return skipped
}

/**
 * Check if a file path matches any of the given glob exclusion patterns.
 * Returns the first matching pattern, or null.
 */
function findMatchingPattern(filePath: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (minimatch(filePath, pattern, { dot: true })) return pattern
  }
  return null
}
