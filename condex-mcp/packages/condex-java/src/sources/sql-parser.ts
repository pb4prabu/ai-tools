import type { SchemaSymbol } from '@condex-ai/core'

/**
 * Parse SQL migration files (Flyway/Liquibase style) to extract schema symbols.
 */
export function parseSqlFile(
  content: string,
  projectId: string,
  sourceFile: string
): SchemaSymbol[] {
  const symbols: SchemaSymbol[] = []

  // Match CREATE TABLE statements
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\);/gi
  let match: RegExpExecArray | null

  while ((match = createTableRegex.exec(content)) !== null) {
    const tableName = match[1]
    const columnsBlock = match[2]

    // Table-level symbol
    symbols.push({
      id: `${projectId}::${sourceFile}::${tableName}#table`,
      projectId,
      tableName,
      migrationFile: sourceFile,
      summary: `Table ${tableName}`,
    })

    // Parse columns
    const lines = columnsBlock.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('--') || /^(PRIMARY|UNIQUE|FOREIGN|INDEX|KEY|CONSTRAINT|CHECK)\s/i.test(trimmed)) {
        continue
      }

      const colMatch = trimmed.match(/^[`"']?(\w+)[`"']?\s+(\w+(?:\([^)]*\))?)\s*(.*?)(?:,\s*)?$/i)
      if (colMatch) {
        const columnName = colMatch[1]
        const dataType = colMatch[2]
        const rest = colMatch[3]
        const nullable = !/NOT\s+NULL/i.test(rest)

        symbols.push({
          id: `${projectId}::${sourceFile}::${tableName}.${columnName}#column`,
          projectId,
          tableName,
          columnName,
          dataType,
          nullable,
          migrationFile: sourceFile,
          summary: `${tableName}.${columnName} ${dataType}${nullable ? '' : ' NOT NULL'}`,
        })
      }
    }
  }

  // Match ALTER TABLE ADD COLUMN
  const alterRegex = /ALTER\s+TABLE\s+[`"']?(\w+)[`"']?\s+ADD\s+(?:COLUMN\s+)?[`"']?(\w+)[`"']?\s+(\w+(?:\([^)]*\))?)/gi
  while ((match = alterRegex.exec(content)) !== null) {
    const tableName = match[1]
    const columnName = match[2]
    const dataType = match[3]

    symbols.push({
      id: `${projectId}::${sourceFile}::${tableName}.${columnName}#column`,
      projectId,
      tableName,
      columnName,
      dataType,
      migrationFile: sourceFile,
      summary: `${tableName}.${columnName} ${dataType} (added via ALTER)`,
    })
  }

  return symbols
}
