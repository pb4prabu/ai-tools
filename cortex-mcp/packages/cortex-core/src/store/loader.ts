import Database from 'better-sqlite3'
import { SafeFS } from '../security/fs-guard.js'
import { readMeta, readSymbolFiles, readSchemaSymbols, readConfigSymbols } from './fs-store.js'
import {
  insertProject,
  insertSymbols,
  insertSchemaSymbols,
  insertConfigSymbols,
  clearProjectData,
} from './sqlite-store.js'
import type { ProjectMeta } from '../types/config.js'

export interface LoadResult {
  projectId: string
  name: string
  symbolCount: number
  schemaCount: number
  configCount: number
  architecture: string | null
  loadTimeMs: number
}

/**
 * Load a project's index from .cortex/index/ into SQLite.
 * Clears any existing data for this project first.
 */
export async function loadProject(
  db: Database.Database,
  safeFs: SafeFS
): Promise<LoadResult | null> {
  const start = Date.now()

  const meta = await readMeta(safeFs)
  if (!meta) return null

  // Clear existing data for this project
  clearProjectData(db, meta.projectId)

  // Load symbols
  const symbols = await readSymbolFiles(safeFs)
  const schemas = await readSchemaSymbols(safeFs)
  const configs = await readConfigSymbols(safeFs)

  // Insert into SQLite
  insertProject(db, meta)
  if (symbols.length > 0) insertSymbols(db, symbols)
  if (schemas.length > 0) insertSchemaSymbols(db, schemas)
  if (configs.length > 0) insertConfigSymbols(db, configs)

  const loadTimeMs = Date.now() - start

  console.error(
    `[cortex] Loaded project: ${meta.projectName} ` +
    `(${symbols.length} symbols, ${schemas.length} schema, ${configs.length} config) ` +
    `in ${loadTimeMs}ms`
  )

  return {
    projectId: meta.projectId,
    name: meta.projectName,
    symbolCount: symbols.length,
    schemaCount: schemas.length,
    configCount: configs.length,
    architecture: meta.architecture ?? null,
    loadTimeMs,
  }
}
