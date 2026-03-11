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
