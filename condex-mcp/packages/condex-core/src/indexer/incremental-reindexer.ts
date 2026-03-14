/**
 * Query-time incremental re-indexer.
 *
 * Before each search, detects source files that changed since the last index
 * (via content hashing) and updates both BM25 (FTS5) and vector indexes
 * for only the changed symbols.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Symbol } from '../types/symbol.js'
import type { SymbolRef } from '../types/schema.js'
import { insertSymbols, insertRefs } from '../store/sqlite-store.js'
import { insertVectors, clearVectors } from '../retrieval/vector-search.js'
import type { Embedder } from '../embeddings/local-embed.js'
import { glob } from 'glob'
import type { CondexConfig } from '../types/config.js'
import { DEFAULT_CONFIG } from '../types/config.js'
import { parseGenericFile, isBinaryExtension } from './generic-file-parser.js'

export type ParseFileWithRefsFn = (content: string, opts: {
  projectId: string
  filePath: string
  profile?: any
}) => { symbols: Symbol[]; refs: SymbolRef[] }

export type PrepareSymbolTextFn = (symbol: {
  qualifiedName: string
  signature: string
  javadoc?: string | null
  kind?: string
}) => string

export interface IncrementalReindexerOpts {
  db: Database.Database
  projectRoot: string
  projectId: string
  parseFileWithRefs?: ParseFileWithRefsFn
  embedder?: Embedder | null
  prepareSymbolText?: PrepareSymbolTextFn
  config?: Partial<CondexConfig>
}

export class IncrementalReindexer {
  private db: Database.Database
  private projectRoot: string
  private projectId: string
  private parseFileWithRefs?: ParseFileWithRefsFn
  private embedder?: Embedder | null
  private prepareSymbolText?: PrepareSymbolTextFn
  private config: Partial<CondexConfig>

  /** In-memory file hash cache: filePath → content hash */
  private fileHashes: Map<string, string> = new Map()
  private initialized = false

  constructor(opts: IncrementalReindexerOpts) {
    this.db = opts.db
    this.projectRoot = opts.projectRoot
    this.projectId = opts.projectId
    this.parseFileWithRefs = opts.parseFileWithRefs
    this.embedder = opts.embedder
    this.prepareSymbolText = opts.prepareSymbolText
    this.config = opts.config ?? {}
  }

  /**
   * Build the initial hash cache from all currently-indexed symbols' source files.
   * Called once after startup indexing completes.
   */
  initializeHashes(fileHashes: Record<string, string>): void {
    this.fileHashes.clear()
    for (const [filePath, hash] of Object.entries(fileHashes)) {
      this.fileHashes.set(filePath, hash)
    }
    this.initialized = true
  }

  /**
   * Check for changed files and re-index only what changed.
   * Safe to call on every query — fast no-op if nothing changed.
   *
   * Returns the number of files re-indexed (0 if nothing changed).
   */
  async reindexIfNeeded(): Promise<number> {
    if (!this.initialized) return 0

    const { languageFiles, supplementalFiles } = await this.detectChangedFiles()
    const changedFiles = [...languageFiles, ...supplementalFiles]
    if (changedFiles.length === 0) return 0

    console.error(`[condex] Incremental re-index: ${changedFiles.length} file(s) changed`)

    const allNewSymbols: Symbol[] = []
    const allNewRefs: SymbolRef[] = []
    const langFileSet = new Set(languageFiles)

    for (const relPath of changedFiles) {
      const absPath = path.join(this.projectRoot, relPath)
      let content: string
      try {
        content = fs.readFileSync(absPath, 'utf-8')
      } catch {
        // File was deleted — remove its symbols
        this.removeSymbolsForFile(relPath)
        this.fileHashes.delete(relPath)
        continue
      }

      const newHash = hashContent(content)
      this.fileHashes.set(relPath, newHash)

      // Remove old symbols for this file
      this.removeSymbolsForFile(relPath)

      // Route to appropriate parser
      if (langFileSet.has(relPath) && this.parseFileWithRefs) {
        try {
          const result = this.parseFileWithRefs(content, {
            projectId: this.projectId,
            filePath: relPath,
          })
          allNewSymbols.push(...result.symbols)
          allNewRefs.push(...result.refs)
        } catch (err: any) {
          console.error(`[condex] Error re-parsing ${relPath}: ${err.message}`)
        }
      } else {
        // Generic file
        const sym = parseGenericFile(content, {
          projectId: this.projectId,
          filePath: relPath,
        })
        if (sym) allNewSymbols.push(sym)
      }
    }

    // Insert new symbols into BM25/FTS
    if (allNewSymbols.length > 0) {
      insertSymbols(this.db, allNewSymbols)
    }

    // Insert new refs
    if (allNewRefs.length > 0) {
      insertRefs(this.db, allNewRefs)
    }

    // Update vector index for changed symbols
    if (this.embedder && this.prepareSymbolText && allNewSymbols.length > 0) {
      await this.updateVectorIndex(allNewSymbols)
    }

    console.error(
      `[condex] Re-indexed ${allNewSymbols.length} symbols from ${changedFiles.length} files`
    )

    return changedFiles.length
  }

  /**
   * Scan source files and return changed paths, split into language and supplemental.
   */
  private async detectChangedFiles(): Promise<{
    languageFiles: string[]
    supplementalFiles: string[]
  }> {
    const language = detectLanguage(this.projectRoot)
    const sourceFiles = await findSourceFiles(this.projectRoot, language, this.config)
    const sourceFileSet = new Set(sourceFiles)

    // Find supplemental (non-language) files
    const exclude = this.config.exclude ?? DEFAULT_CONFIG.exclude
    const allExclude = [...new Set([...exclude, '**/.condex/**'])]
    const allFiles = await glob('**/*', {
      cwd: this.projectRoot,
      ignore: allExclude,
      nodir: true,
    })
    const supplementalFileList = allFiles
      .filter(f => !sourceFileSet.has(f) && !isBinaryExtension(f))

    const allFilesToCheck = [...sourceFiles, ...supplementalFileList]
    const changedLang: string[] = []
    const changedSupp: string[] = []

    for (const relPath of allFilesToCheck) {
      const absPath = path.join(this.projectRoot, relPath)
      let content: string
      try {
        content = fs.readFileSync(absPath, 'utf-8')
      } catch {
        if (this.fileHashes.has(relPath)) {
          if (sourceFileSet.has(relPath)) changedLang.push(relPath)
          else changedSupp.push(relPath)
        }
        continue
      }

      const currentHash = hashContent(content)
      const previousHash = this.fileHashes.get(relPath)

      if (previousHash !== currentHash) {
        if (sourceFileSet.has(relPath)) changedLang.push(relPath)
        else changedSupp.push(relPath)
      }
    }

    // Detect deleted files
    const allFileSet = new Set(allFilesToCheck)
    for (const relPath of this.fileHashes.keys()) {
      if (!allFileSet.has(relPath)) {
        const absPath = path.join(this.projectRoot, relPath)
        if (!fs.existsSync(absPath)) {
          if (sourceFileSet.has(relPath)) changedLang.push(relPath)
          else changedSupp.push(relPath)
        }
      }
    }

    return {
      languageFiles: [...new Set(changedLang)],
      supplementalFiles: [...new Set(changedSupp)],
    }
  }

  /**
   * Remove all symbols + FTS + vector entries for a given source file.
   */
  private removeSymbolsForFile(filePath: string): void {
    // Get symbol IDs for this file
    const rows = this.db.prepare(
      'SELECT id FROM symbols WHERE project_id = ? AND file_path = ?'
    ).all(this.projectId, filePath) as { id: string }[]

    if (rows.length === 0) return

    const deleteSymbol = this.db.prepare('DELETE FROM symbols WHERE id = ?')
    const deleteFts = this.db.prepare('DELETE FROM symbols_fts WHERE id = ?')
    const deleteRefs = this.db.prepare(
      'DELETE FROM symbol_refs WHERE source_symbol_id = ? AND project_id = ?'
    )

    // Check if symbol_vectors table exists (only when vec is loaded)
    let deleteVec: ReturnType<Database.Database['prepare']> | null = null
    try {
      this.db.prepare('SELECT 1 FROM symbol_vectors LIMIT 0').get()
      deleteVec = this.db.prepare('DELETE FROM symbol_vectors WHERE symbol_id = ?')
    } catch {
      // Table doesn't exist — skip vector cleanup
    }

    this.db.transaction(() => {
      for (const row of rows) {
        deleteFts.run(row.id)
        deleteSymbol.run(row.id)
        deleteRefs.run(row.id, this.projectId)
        if (deleteVec) {
          deleteVec.run(row.id)
        }
      }
    })()
  }

  /**
   * Embed and insert vector entries for new/changed symbols.
   */
  private async updateVectorIndex(symbols: Symbol[]): Promise<void> {
    if (!this.embedder || !this.prepareSymbolText) return

    const batchSize = 50
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize)
      const texts = batch.map(s => this.prepareSymbolText!({
        qualifiedName: s.qualifiedName,
        signature: s.signature,
        javadoc: s.javadoc,
        kind: s.kind,
      }))
      const embeddings = await this.embedder.embedBatch(texts)
      const vectors = batch.map((s, idx) => ({
        symbolId: s.id,
        embedding: embeddings[idx],
      }))
      insertVectors(this.db, vectors)
    }
  }
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 20)
}

function detectLanguage(projectRoot: string): string {
  // Priority-ordered: Java > TypeScript > Python
  // Use glob to search any depth (real projects can be 20+ levels deep)
  const ignore = ['**/node_modules/**', '**/build/classes/**', '**/build/generated/**', '**/build/libs/**', '**/build/tmp/**', '**/target/classes/**', '**/target/generated-sources/**', '**/target/test-classes/**', '**/dist/out/**', '**/.git/**', '**/.condex/**']

  const javaMarkers = ['pom.xml', 'build.gradle', 'build.gradle.kts']
  for (const marker of javaMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'java'
    } catch { /* ignore */ }
  }

  const tsMarkers = ['tsconfig.json']
  for (const marker of tsMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'typescript'
    } catch { /* ignore */ }
  }

  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'typescript'

  const pyMarkers = ['requirements.txt', 'pyproject.toml']
  for (const marker of pyMarkers) {
    try {
      const found = glob.sync(`**/${marker}`, { cwd: projectRoot, ignore, nodir: true, maxDepth: 50 })
      if (found.length > 0) return 'python'
    } catch { /* ignore */ }
  }

  return 'java'
}

async function findSourceFiles(
  projectRoot: string,
  language: string,
  config: Partial<CondexConfig>
): Promise<string[]> {
  const extensionMap: Record<string, string[]> = {
    java: ['**/*.java'],
    typescript: ['**/*.ts', '**/*.tsx'],
    python: ['**/*.py'],
  }
  const include = config.include ?? extensionMap[language] ?? extensionMap.java
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
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
