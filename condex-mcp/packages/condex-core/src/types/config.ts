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
    defaultTokenBudget?: number // default: 50000
  }
}

/** Default config values used when no condex.config.json exists */
export const DEFAULT_CONFIG: Required<CondexConfig> = {
  projectName: '',
  language: 'auto',
  include: ['**/*'],
  exclude: [
    '**/node_modules/**',
    '**/.git/**',
    '**/.condex/**', // always excluded — hardcoded
    '**/.gradle/**',
    '**/.settings/**',
    '**/.idea/**',
    // Build output dirs — only at module root level, NOT inside src/main/java/com/target/...
    // Using negated patterns: exclude build/target/dist dirs but NOT when inside src/ paths
    'target/classes/**',
    'target/generated-sources/**',
    'target/generated-test-sources/**',
    'target/test-classes/**',
    'target/maven-status/**',
    'target/surefire-reports/**',
    '**/target/classes/**',
    '**/target/generated-sources/**',
    '**/target/generated-test-sources/**',
    '**/target/test-classes/**',
    '**/target/maven-status/**',
    '**/target/surefire-reports/**',
    '**/build/classes/**',
    '**/build/generated/**',
    '**/build/libs/**',
    '**/build/tmp/**',
    '**/build/reports/**',
    '**/build/test-results/**',
    '**/dist/out/**',
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
    defaultTokenBudget: 50000,
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
