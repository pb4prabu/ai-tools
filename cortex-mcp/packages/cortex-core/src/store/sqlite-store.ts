import Database from 'better-sqlite3'
import type { Symbol } from '../types/symbol.js'
import type { SchemaSymbol, ConfigSymbol, SymbolRef } from '../types/schema.js'
import type { ProjectMeta } from '../types/config.js'

/**
 * Create all tables, indexes, FTS virtual tables, and triggers.
 */
export function createSchema(db: Database.Database): void {
  db.exec(`
    -- Projects
    CREATE TABLE IF NOT EXISTS projects (
      id                     TEXT PRIMARY KEY,
      name                   TEXT NOT NULL,
      root_path              TEXT NOT NULL,
      language               TEXT,
      architecture           TEXT,
      architecture_confidence REAL,
      symbol_count           INTEGER DEFAULT 0,
      schema_count           INTEGER DEFAULT 0,
      config_count           INTEGER DEFAULT 0,
      indexed_at             TEXT,
      tool_version           TEXT
    );

    -- Symbols
    CREATE TABLE IF NOT EXISTS symbols (
      id                 TEXT PRIMARY KEY,
      project_id         TEXT NOT NULL REFERENCES projects(id),
      file_path          TEXT NOT NULL,
      qualified_name     TEXT NOT NULL,
      simple_name        TEXT,
      class_name         TEXT,
      package_name       TEXT,
      kind               TEXT NOT NULL,
      signature          TEXT NOT NULL,
      javadoc            TEXT,
      annotations        TEXT,
      spring_role        TEXT,
      hex_role           TEXT,
      module_layer       TEXT,
      implemented_interfaces TEXT,
      extends_class      TEXT,
      parameter_types    TEXT,
      return_type        TEXT,
      throws_types       TEXT,
      byte_offset        INTEGER,
      byte_length        INTEGER,
      content_hash       TEXT,
      indexed_at         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_project ON symbols(project_id);
    CREATE INDEX IF NOT EXISTS idx_symbols_file    ON symbols(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind    ON symbols(project_id, kind);
    CREATE INDEX IF NOT EXISTS idx_symbols_spring  ON symbols(project_id, spring_role);
    CREATE INDEX IF NOT EXISTS idx_symbols_hex     ON symbols(project_id, hex_role);

    -- FTS5 for symbol search (standalone — we pre-process CamelCase on insert)
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      id              UNINDEXED,
      project_id      UNINDEXED,
      qualified_name,
      simple_name,
      class_name,
      package_name,
      signature,
      javadoc,
      annotations,
      tokenize='porter unicode61'
    );

    -- Schema symbols (from SQL migrations)
    CREATE TABLE IF NOT EXISTS schema_symbols (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id),
      table_name     TEXT NOT NULL,
      column_name    TEXT,
      data_type      TEXT,
      nullable       INTEGER,
      migration_file TEXT,
      summary        TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS schema_fts USING fts5(
      id         UNINDEXED,
      project_id UNINDEXED,
      table_name,
      column_name,
      summary,
      content=schema_symbols,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS schema_fts_insert AFTER INSERT ON schema_symbols BEGIN
      INSERT INTO schema_fts(rowid, id, project_id, table_name, column_name, summary)
      VALUES (new.rowid, new.id, new.project_id, new.table_name, new.column_name, new.summary);
    END;

    CREATE TRIGGER IF NOT EXISTS schema_fts_delete AFTER DELETE ON schema_symbols BEGIN
      INSERT INTO schema_fts(schema_fts, rowid, id, project_id, table_name, column_name, summary)
      VALUES ('delete', old.rowid, old.id, old.project_id, old.table_name, old.column_name, old.summary);
    END;

    -- Config symbols (from YAML files)
    CREATE TABLE IF NOT EXISTS config_symbols (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL REFERENCES projects(id),
      key_path     TEXT NOT NULL,
      value        TEXT,
      profile      TEXT,
      source_file  TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS config_fts USING fts5(
      id         UNINDEXED,
      project_id UNINDEXED,
      key_path,
      value,
      profile,
      content=config_symbols,
      content_rowid=rowid,
      tokenize='porter unicode61'
    );

    CREATE TRIGGER IF NOT EXISTS config_fts_insert AFTER INSERT ON config_symbols BEGIN
      INSERT INTO config_fts(rowid, id, project_id, key_path, value, profile)
      VALUES (new.rowid, new.id, new.project_id, new.key_path, new.value, new.profile);
    END;

    CREATE TRIGGER IF NOT EXISTS config_fts_delete AFTER DELETE ON config_symbols BEGIN
      INSERT INTO config_fts(config_fts, rowid, id, project_id, key_path, value, profile)
      VALUES ('delete', old.rowid, old.id, old.project_id, old.key_path, old.value, old.profile);
    END;

    -- Symbol references (call graph)
    CREATE TABLE IF NOT EXISTS symbol_refs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      source_symbol_id      TEXT NOT NULL,
      target_qualified_name TEXT NOT NULL,
      ref_type              TEXT NOT NULL,
      project_id            TEXT NOT NULL,
      source_file           TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_refs_source  ON symbol_refs(source_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_refs_target  ON symbol_refs(target_qualified_name);
    CREATE INDEX IF NOT EXISTS idx_refs_project ON symbol_refs(project_id);
  `)
}

// ── CamelCase Splitting for FTS5 ──────────────────────────

/**
 * Split CamelCase and dots so FTS5 can match partial names.
 * "CreateOrderHandler" → "Create Order Handler"
 * "com.app.order" → "com app order"
 */
export function splitCamelCase(text: string | null): string {
  if (!text) return ''
  return text
    // Split before uppercase letter preceded by lowercase: orderH → order H
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split runs of uppercase before uppercase+lowercase: XMLParser → XML Parser
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Dots to spaces: com.app → com app
    .replace(/\./g, ' ')
}

// ── Insert Operations ─────────────────────────────────────

export function insertProject(db: Database.Database, meta: ProjectMeta): void {
  db.prepare(`
    INSERT OR REPLACE INTO projects (id, name, root_path, language, architecture,
      architecture_confidence, symbol_count, schema_count, config_count, indexed_at, tool_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    meta.projectId, meta.projectName, meta.projectRoot,
    meta.language ?? null, meta.architecture ?? null,
    meta.architectureConfidence ?? null,
    meta.symbolCount, meta.schemaCount, meta.configCount,
    meta.lastIncrementalIndex ?? meta.lastFullIndex ?? new Date().toISOString(),
    meta.toolVersion
  )
}

export function insertSymbols(db: Database.Database, symbols: Symbol[]): void {
  const symStmt = db.prepare(`
    INSERT OR REPLACE INTO symbols (id, project_id, file_path, qualified_name, simple_name,
      class_name, package_name, kind, signature, javadoc, annotations, spring_role, hex_role,
      module_layer, implemented_interfaces, extends_class, parameter_types, return_type,
      throws_types, byte_offset, byte_length, content_hash, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  // Delete existing FTS entries for these symbols before re-inserting
  const ftsDeleteStmt = db.prepare('DELETE FROM symbols_fts WHERE id = ?')

  const ftsStmt = db.prepare(`
    INSERT INTO symbols_fts (id, project_id, qualified_name, simple_name,
      class_name, package_name, signature, javadoc, annotations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((syms: Symbol[]) => {
    for (const s of syms) {
      symStmt.run(
        s.id, s.projectId, s.filePath, s.qualifiedName, s.simpleName,
        s.className ?? null, s.packageName ?? null, s.kind, s.signature,
        s.javadoc ?? null, JSON.stringify(s.annotations),
        s.springRole ?? null, s.hexRole ?? null, s.moduleLayer ?? null,
        JSON.stringify(s.implementedInterfaces), s.extendsClass ?? null,
        JSON.stringify(s.parameterTypes), s.returnType ?? null,
        JSON.stringify(s.throwsTypes),
        s.byteOffset, s.byteLength, s.contentHash,
        s.indexedAt ?? new Date().toISOString()
      )

      // Insert CamelCase-split text into FTS5
      ftsDeleteStmt.run(s.id)
      ftsStmt.run(
        s.id,
        s.projectId,
        splitCamelCase(s.qualifiedName),
        splitCamelCase(s.simpleName),
        splitCamelCase(s.className ?? null),
        splitCamelCase(s.packageName ?? null),
        splitCamelCase(s.signature),
        s.javadoc ?? null,  // javadoc is natural language, no split needed
        JSON.stringify(s.annotations),
      )
    }
  })

  insertMany(symbols)
}

export function insertSchemaSymbols(db: Database.Database, schemas: SchemaSymbol[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO schema_symbols (id, project_id, table_name, column_name,
      data_type, nullable, migration_file, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((items: SchemaSymbol[]) => {
    for (const s of items) {
      stmt.run(s.id, s.projectId, s.tableName, s.columnName ?? null,
        s.dataType ?? null, s.nullable ? 1 : 0, s.migrationFile, s.summary)
    }
  })

  insertMany(schemas)
}

export function insertConfigSymbols(db: Database.Database, configs: ConfigSymbol[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO config_symbols (id, project_id, key_path, value, profile, source_file)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((items: ConfigSymbol[]) => {
    for (const c of items) {
      stmt.run(c.id, c.projectId, c.keyPath, c.value ?? null,
        c.profile ?? null, c.sourceFile)
    }
  })

  insertMany(configs)
}

// ── Query Operations ──────────────────────────────────────

export function getSymbolById(db: Database.Database, id: string): Symbol | null {
  const row = db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as any
  return row ? rowToSymbol(row) : null
}

export function getSymbolsByIds(db: Database.Database, ids: string[]): Symbol[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM symbols WHERE id IN (${placeholders})`).all(...ids) as any[]
  return rows.map(rowToSymbol)
}

export function getSymbolsByFile(
  db: Database.Database,
  projectId: string,
  filePath: string
): Symbol[] {
  const rows = db.prepare(
    'SELECT * FROM symbols WHERE project_id = ? AND file_path = ?'
  ).all(projectId, filePath) as any[]
  return rows.map(rowToSymbol)
}

export interface ProjectOutline {
  projectId: string
  projectName: string
  architecture: string | null
  totalSymbols: number
  packages: { name: string; symbolCount: number }[]
  kindCounts: { kind: string; count: number }[]
}

export function getProjectOutline(
  db: Database.Database,
  projectId: string
): ProjectOutline | null {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any
  if (!project) return null

  const packages = db.prepare(`
    SELECT package_name as name, COUNT(*) as symbolCount
    FROM symbols WHERE project_id = ?
    GROUP BY package_name ORDER BY symbolCount DESC
  `).all(projectId) as any[]

  const kindCounts = db.prepare(`
    SELECT kind, COUNT(*) as count
    FROM symbols WHERE project_id = ?
    GROUP BY kind ORDER BY count DESC
  `).all(projectId) as any[]

  return {
    projectId,
    projectName: project.name,
    architecture: project.architecture,
    totalSymbols: project.symbol_count,
    packages,
    kindCounts,
  }
}

export function clearProjectData(db: Database.Database, projectId: string): void {
  db.transaction(() => {
    // Clear FTS entries first (standalone tables, no auto-triggers)
    db.prepare('DELETE FROM symbols_fts WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM symbols WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM schema_symbols WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM config_symbols WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM symbol_refs WHERE project_id = ?').run(projectId)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
  })()
}

// ── Symbol Refs (Call Graph) ─────────────────────────────

export function insertRefs(db: Database.Database, refs: SymbolRef[]): void {
  if (refs.length === 0) return

  const stmt = db.prepare(`
    INSERT INTO symbol_refs (source_symbol_id, target_qualified_name, ref_type, project_id, source_file)
    VALUES (?, ?, ?, ?, ?)
  `)

  const insertMany = db.transaction((items: SymbolRef[]) => {
    for (const r of items) {
      stmt.run(r.sourceSymbolId, r.targetQualifiedName, r.refType, r.projectId, r.sourceFile)
    }
  })

  insertMany(refs)
}

/**
 * Given a set of symbol IDs found by search, expand to include related symbols
 * via the call graph (callers + callees, one hop).
 * Returns de-duplicated set of all symbol IDs.
 */
export function getRelatedSymbolIds(
  db: Database.Database,
  symbolIds: string[],
  projectId: string
): string[] {
  if (symbolIds.length === 0) return []

  const idSet = new Set(symbolIds)

  // Get qualified names for the input symbols
  const placeholders = symbolIds.map(() => '?').join(',')
  const inputSymbols = db.prepare(
    `SELECT id, qualified_name FROM symbols WHERE id IN (${placeholders})`
  ).all(...symbolIds) as { id: string; qualified_name: string }[]

  const qualifiedNames = inputSymbols.map(s => s.qualified_name)

  if (qualifiedNames.length > 0) {
    // Forward: symbols that our results call/reference
    const fwdPlaceholders = symbolIds.map(() => '?').join(',')
    const forwardRefs = db.prepare(`
      SELECT DISTINCT target_qualified_name FROM symbol_refs
      WHERE source_symbol_id IN (${fwdPlaceholders}) AND project_id = ?
    `).all(...symbolIds, projectId) as { target_qualified_name: string }[]

    // Resolve target qualified names to symbol IDs
    for (const ref of forwardRefs) {
      const targets = db.prepare(
        'SELECT id FROM symbols WHERE qualified_name = ? AND project_id = ?'
      ).all(ref.target_qualified_name, projectId) as { id: string }[]
      for (const t of targets) idSet.add(t.id)
    }

    // Reverse: symbols that call/reference our results
    const qnPlaceholders = qualifiedNames.map(() => '?').join(',')
    const reverseRefs = db.prepare(`
      SELECT DISTINCT source_symbol_id FROM symbol_refs
      WHERE target_qualified_name IN (${qnPlaceholders}) AND project_id = ?
    `).all(...qualifiedNames, projectId) as { source_symbol_id: string }[]

    for (const ref of reverseRefs) {
      idSet.add(ref.source_symbol_id)
    }
  }

  return [...idSet]
}

// ── Helpers ───────────────────────────────────────────────

function rowToSymbol(row: any): Symbol {
  return {
    id: row.id,
    projectId: row.project_id,
    filePath: row.file_path,
    qualifiedName: row.qualified_name,
    simpleName: row.simple_name,
    className: row.class_name,
    packageName: row.package_name,
    kind: row.kind,
    signature: row.signature,
    javadoc: row.javadoc,
    annotations: safeJsonParse(row.annotations, []),
    springRole: row.spring_role,
    hexRole: row.hex_role,
    moduleLayer: row.module_layer,
    implementedInterfaces: safeJsonParse(row.implemented_interfaces, []),
    extendsClass: row.extends_class,
    parameterTypes: safeJsonParse(row.parameter_types, []),
    returnType: row.return_type,
    throwsTypes: safeJsonParse(row.throws_types, []),
    byteOffset: row.byte_offset,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at,
  }
}

function safeJsonParse<T>(str: string | null, fallback: T): T {
  if (!str) return fallback
  try {
    return JSON.parse(str)
  } catch {
    return fallback
  }
}
