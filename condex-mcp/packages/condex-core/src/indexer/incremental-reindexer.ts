/**
 * Query-time incremental re-indexer.
 *
 * Before each search, detects source files that changed since the last index
 * (via content hashing) and updates both BM25 (FTS5) and vector indexes
 * for only the changed symbols.
 */
import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { Symbol } from '../types/symbol.js'
import type { SymbolRef } from '../types/schema.js'
import type { CondexConfig } from '../types/config.js'
import { DEFAULT_CONFIG } from '../types/config.js'
import { insertSymbols, insertRefs } from '../store/sqlite-store.js'
import { insertVectors } from '../retrieval/vector-search.js'
import type { Embedder } from '../embeddings/local-embed.js'
import { glob } from 'glob'
import { parseGenericFile, isBinaryExtension } from './generic-file-parser.js'
import { detectLanguage, findSourceFiles, hashContent, mergeExcludes, type ParseFileWithRefsFn, type PrepareSymbolTextFn } from './shared.js'

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
  private fileHashes = new Map<string, string>()
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

  initializeHashes(fileHashes: Record<string, string>): void {
    this.fileHashes.clear()
    for (const [filePath, hash] of Object.entries(fileHashes)) {
      this.fileHashes.set(filePath, hash)
    }
    this.initialized = true
  }

  /**
   * Check for changed files and re-index only what changed.
   * Fast no-op if nothing changed.
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
        // File deleted — remove its symbols
        this.removeSymbolsForFile(relPath)
        this.fileHashes.delete(relPath)
        console.error(`[condex] File deleted, symbols removed: ${relPath}`)
        continue
      }

      this.fileHashes.set(relPath, hashContent(content))
      this.removeSymbolsForFile(relPath)

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
        const sym = parseGenericFile(content, {
          projectId: this.projectId,
          filePath: relPath,
        })
        if (sym) allNewSymbols.push(sym)
      }
    }

    if (allNewSymbols.length > 0) insertSymbols(this.db, allNewSymbols)
    if (allNewRefs.length > 0) insertRefs(this.db, allNewRefs)

    if (this.embedder && this.prepareSymbolText && allNewSymbols.length > 0) {
      await this.updateVectorIndex(allNewSymbols)
    }

    console.error(`[condex] Re-indexed ${allNewSymbols.length} symbols from ${changedFiles.length} files`)
    return changedFiles.length
  }

  private async detectChangedFiles(): Promise<{
    languageFiles: string[]
    supplementalFiles: string[]
  }> {
    const language = detectLanguage(this.projectRoot)
    const sourceFiles = await findSourceFiles(this.projectRoot, language, this.config)
    const sourceFileSet = new Set(sourceFiles)

    const allExclude = mergeExcludes(this.config)
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
      let content: string
      try {
        content = fs.readFileSync(path.join(this.projectRoot, relPath), 'utf-8')
      } catch {
        if (this.fileHashes.has(relPath)) {
          ;(sourceFileSet.has(relPath) ? changedLang : changedSupp).push(relPath)
        }
        continue
      }

      if (this.fileHashes.get(relPath) !== hashContent(content)) {
        ;(sourceFileSet.has(relPath) ? changedLang : changedSupp).push(relPath)
      }
    }

    // Detect deleted files
    const allFileSet = new Set(allFilesToCheck)
    for (const relPath of this.fileHashes.keys()) {
      if (!allFileSet.has(relPath) && !fs.existsSync(path.join(this.projectRoot, relPath))) {
        ;(sourceFileSet.has(relPath) ? changedLang : changedSupp).push(relPath)
      }
    }

    return {
      languageFiles: [...new Set(changedLang)],
      supplementalFiles: [...new Set(changedSupp)],
    }
  }

  private removeSymbolsForFile(filePath: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM symbols WHERE project_id = ? AND file_path = ?',
    ).all(this.projectId, filePath) as { id: string }[]

    if (rows.length === 0) return

    const deleteSymbol = this.db.prepare('DELETE FROM symbols WHERE id = ?')
    const deleteFts = this.db.prepare('DELETE FROM symbols_fts WHERE id = ?')
    const deleteRefs = this.db.prepare(
      'DELETE FROM symbol_refs WHERE source_symbol_id = ? AND project_id = ?',
    )

    let deleteVec: ReturnType<Database.Database['prepare']> | null = null
    try {
      this.db.prepare('SELECT 1 FROM symbol_vectors LIMIT 0').get()
      deleteVec = this.db.prepare('DELETE FROM symbol_vectors WHERE symbol_id = ?')
    } catch { /* table doesn't exist */ }

    this.db.transaction(() => {
      for (const row of rows) {
        deleteFts.run(row.id)
        deleteSymbol.run(row.id)
        deleteRefs.run(row.id, this.projectId)
        deleteVec?.run(row.id)
      }
    })()
  }

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
