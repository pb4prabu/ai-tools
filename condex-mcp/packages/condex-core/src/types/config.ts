export interface CondexConfig {
  projectName?: string
  language?: 'java' | 'python' | 'typescript' | 'auto'
  include?: string[]
  exclude?: string[]
  vectorSearch?: boolean // default: false
  sources?: {
    sql?: string // glob pattern for SQL migrations
    yaml?: string // glob pattern for YAML config
    openapi?: boolean
  }
  retrieval?: {
    confidenceThreshold?: number // default: 0.12
    maxResultsPerSearch?: number // default: 20
    defaultTokenBudget?: number // default: 2000
  }
}

/** Default config values used when no condex.config.json exists */
export const DEFAULT_CONFIG: Required<CondexConfig> = {
  projectName: '',
  language: 'auto',
  include: ['**/*'],
  exclude: [
    '**/node_modules/**',
    '**/generated/**',
    '**/target/**',
    '**/build/**',
    '**/dist/**',
    '**/.git/**',
    '**/.condex/**', // always excluded — hardcoded
  ],
  vectorSearch: false,
  sources: {
    sql: '',
    yaml: '',
    openapi: false,
  },
  retrieval: {
    confidenceThreshold: 0.12,
    maxResultsPerSearch: 20,
    defaultTokenBudget: 2000,
  },
}

export interface ProjectMeta {
  projectId: string
  projectName: string
  projectRoot: string
  language?: string
  architecture?: string
  architectureConfidence?: number
  lastFullIndex?: string
  lastIncrementalIndex?: string
  toolVersion: string
  symbolCount: number
  schemaCount: number
  configCount: number
  fileHashes: Record<string, string> // filePath → sha256
}
