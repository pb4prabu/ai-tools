export interface SchemaSymbol {
  id: string
  projectId: string
  tableName: string
  columnName?: string // null for table-level entries
  dataType?: string
  nullable?: boolean
  migrationFile: string
  summary: string
}

export interface ConfigSymbol {
  id: string
  projectId: string
  keyPath: string // e.g. "spring.datasource.url"
  value?: string
  profile?: string // "prod", "dev", null for default
  sourceFile: string
}

export type RefType = 'calls' | 'creates' | 'field_dep' | 'implements' | 'extends'

export interface SymbolRef {
  sourceSymbolId: string      // the caller/user (fully qualified symbol ID)
  targetQualifiedName: string // what it calls/uses (qualified name, may not be exact symbol ID)
  refType: RefType
  projectId: string
  sourceFile: string
}
