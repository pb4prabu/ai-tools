import fs from 'node:fs'
import path from 'node:path'
import { glob } from 'glob'
import type Database from 'better-sqlite3'
import type { SafeFS } from '../security/fs-guard.js'
import type { Symbol } from '../types/symbol.js'
import type { SchemaSymbol, ConfigSymbol, SymbolRef } from '../types/schema.js'
import type { CortexConfig, ProjectMeta } from '../types/config.js'
import { DEFAULT_CONFIG } from '../types/config.js'
import { generateNamespace } from '../namespace/namespace.js'
import {
  initCortexDir,
  writeSymbolFile,
  writeSchemaSymbols,
  writeConfigSymbols,
  writeMeta,
  readMeta,
  readCortexConfig,
  acquireIndexLock,
  releaseIndexLock,
  hashContent,
} from '../store/fs-store.js'
import {
  insertProject,
  insertSymbols,
  insertRefs,
  clearProjectData,
} from '../store/sqlite-store.js'
import { loadProject } from '../store/loader.js'

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

  // Read config (optional)
  const config = await readCortexConfig(safeFs) ?? { ...DEFAULT_CONFIG }

  // Ensure .cortex/index/ dirs exist
  await initCortexDir(safeFs)

  // Acquire lock
  const lockAcquired = await acquireIndexLock(safeFs)
  if (!lockAcquired) {
    console.error('[cortex] Index lock held by another process, skipping')
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
    const language = config.language === 'auto' ? detectLanguage(projectRoot) : config.language
    const sourceFiles = await findSourceFiles(projectRoot, language ?? 'java', config)

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

    for (const relPath of sourceFiles) {
      const absPath = path.join(projectRoot, relPath)
      let content: string
      try {
        content = fs.readFileSync(absPath, 'utf-8')
      } catch {
        filesSkipped++
        continue
      }

      const hash = hashContent(content)
      newHashes[relPath] = hash

      // Incremental: skip unchanged files
      if (!opts.full && existingHashes[relPath] === hash) {
        filesSkipped++
        continue
      }

      const parseOpts = {
        projectId,
        filePath: relPath,
        profile: opts.detectArch ? opts.detectArch(sourceFiles) : undefined,
      }

      if (opts.parseFileWithRefs) {
        try {
          const result = opts.parseFileWithRefs(content, parseOpts)
          allSymbols.push(...result.symbols)
          allRefs.push(...result.refs)
          filesProcessed++
        } catch (err: any) {
          console.error(`[cortex] Error parsing ${relPath}: ${err.message}`)
          filesSkipped++
        }
      } else if (opts.parseFile) {
        try {
          const symbols = opts.parseFile(content, parseOpts)
          allSymbols.push(...symbols)
          filesProcessed++
        } catch (err: any) {
          console.error(`[cortex] Error parsing ${relPath}: ${err.message}`)
          filesSkipped++
        }
      } else {
        filesSkipped++
      }
    }

    // Write symbol files to .cortex/index/
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
          console.error(`[cortex] Error parsing SQL ${relPath}: ${err.message}`)
        }
      }
      if (allSchemas.length > 0) {
        await writeSchemaSymbols(safeFs, allSchemas)
        console.error(`[cortex] Schema: ${allSchemas.length} symbols from ${sqlFiles.length} SQL files`)
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
          console.error(`[cortex] Error parsing YAML ${relPath}: ${err.message}`)
        }
      }
      if (allConfigs.length > 0) {
        await writeConfigSymbols(safeFs, allConfigs)
        console.error(`[cortex] Config: ${allConfigs.length} properties from ${yamlFiles.length} YAML files`)
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
      console.error(`[cortex] Refs: ${allRefs.length} call-graph references extracted`)
    }

    const loadTimeMs = Date.now() - startMs
    console.error(
      `[cortex] Indexed: ${filesProcessed} files, ${allSymbols.length} symbols ` +
      `(${filesSkipped} skipped) in ${loadTimeMs}ms`
    )

    return {
      projectId,
      projectName,
      architecture,
      symbolCount: loadResult?.symbolCount ?? allSymbols.length,
      filesProcessed,
      filesSkipped,
      loadTimeMs,
      incremental: !opts.full && Object.keys(existingHashes).length > 0,
    }
  } finally {
    await releaseIndexLock(safeFs)
  }
}

function detectLanguage(projectRoot: string): string {
  // Simple heuristic: check for common markers
  const markers: Record<string, string> = {
    'pom.xml': 'java',
    'build.gradle': 'java',
    'build.gradle.kts': 'java',
    'package.json': 'typescript',
    'tsconfig.json': 'typescript',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
  }

  for (const [file, lang] of Object.entries(markers)) {
    if (fs.existsSync(path.join(projectRoot, file))) {
      return lang
    }
  }

  return 'java' // default
}

async function findFiles(
  projectRoot: string,
  pattern: string,
  config: Partial<CortexConfig>
): Promise<string[]> {
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
  const allExclude = [...new Set([...exclude, '**/.cortex/**'])]

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
  config: Partial<CortexConfig>
): Promise<string[]> {
  const extensionMap: Record<string, string[]> = {
    java: ['**/*.java'],
    typescript: ['**/*.ts', '**/*.tsx'],
    python: ['**/*.py'],
  }

  const include = config.include ?? extensionMap[language] ?? extensionMap.java
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude

  // Always exclude .cortex/
  const allExclude = [...new Set([...exclude, '**/.cortex/**'])]

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
