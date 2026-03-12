import type { Symbol } from './symbol.js'
import type { SchemaSymbol, ConfigSymbol } from './schema.js'

export interface ParseResult {
  symbols: Symbol[]
  schemaSymbols?: SchemaSymbol[]
  configSymbols?: ConfigSymbol[]
  projectProfile: ProjectProfile
}

export interface CoreParser {
  /** Which file extensions this parser handles */
  readonly supportedExtensions: string[]

  /** Primary parse: extract symbols from one source file */
  parseFile(filePath: string, content: string, projectId: string, profile: ProjectProfile): Promise<Symbol[]>

  /** Parse SQL migration files (optional) */
  parseSqlFile?(filePath: string, content: string, projectId: string): Promise<SchemaSymbol[]>

  /** Parse YAML config files (optional) */
  parseYamlFile?(filePath: string, content: string, projectId: string): Promise<ConfigSymbol[]>

  /** Architecture detection — called once during full index */
  detectArchitecture(allFilePaths: string[]): ProjectProfile
}

export type ArchitectureType = 'hexagonal' | 'layered' | 'mvc' | 'unknown'

export interface ProjectProfile {
  architecture: ArchitectureType
  confidence: number // 0.0 to 1.0
  modules: ModuleInfo[]
  detectedPatterns: string[]
}

export interface ModuleInfo {
  name: string
  path: string
  layer?: string
  fileCount: number
}
