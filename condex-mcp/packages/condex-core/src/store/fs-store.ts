import crypto from 'node:crypto'
import path from 'node:path'
import { SafeFS } from '../security/fs-guard.js'
import type { Symbol } from '../types/symbol.js'
import type { SchemaSymbol, ConfigSymbol } from '../types/schema.js'
import type { CondexConfig, ProjectMeta, DEFAULT_CONFIG } from '../types/config.js'

const TOOL_VERSION = '1.0.0'

const CONDEX_GITIGNORE = `# Never commit runtime files
*.db
*.db-shm
*.db-wal
savings.json
.indexing.lock
`

/**
 * Initialize .condex/ directory structure inside project root.
 */
export async function initCondexDir(safeFs: SafeFS): Promise<void> {
  const condexDir = safeFs.getCondexDir()
  const indexDir = safeFs.getIndexDir()

  await safeFs.mkdir(path.join(indexDir, 'symbols'))
  await safeFs.mkdir(path.join(indexDir, 'schema'))
  await safeFs.mkdir(path.join(indexDir, 'config'))
  await safeFs.writeFile(path.join(condexDir, '.gitignore'), CONDEX_GITIGNORE)
}

// ── Symbol Files ────────────────────────────────────────────

/**
 * Symbol filename uses sha256 of the symbol ID to avoid path length limits.
 */
function symbolFileName(symbolId: string): string {
  const hash = crypto.createHash('sha256').update(symbolId).digest('hex')
  return `${hash}.json`
}

export async function writeSymbolFile(safeFs: SafeFS, symbol: Symbol): Promise<void> {
  const filePath = path.join(safeFs.getIndexDir(), 'symbols', symbolFileName(symbol.id))
  await safeFs.writeFile(filePath, JSON.stringify(symbol, null, 2))
}

export async function readSymbolFiles(safeFs: SafeFS): Promise<Symbol[]> {
  const symbolsDir = path.join(safeFs.getIndexDir(), 'symbols')
  if (!await safeFs.exists(symbolsDir)) return []

  const files = await safeFs.readdir(symbolsDir)
  const symbols: Symbol[] = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const content = await safeFs.readFile(path.join(symbolsDir, file))
      symbols.push(JSON.parse(content) as Symbol)
    } catch {
      // Skip malformed files
      console.error(`[condex] Warning: skipping malformed symbol file: ${file}`)
    }
  }

  return symbols
}

/**
 * Remove all symbol files that belong to a specific source file.
 */
export async function removeSymbolFilesForSource(
  safeFs: SafeFS,
  sourceFilePath: string
): Promise<number> {
  const symbolsDir = path.join(safeFs.getIndexDir(), 'symbols')
  if (!await safeFs.exists(symbolsDir)) return 0

  const files = await safeFs.readdir(symbolsDir)
  let removed = 0

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const content = await safeFs.readFile(path.join(symbolsDir, file))
      const symbol = JSON.parse(content) as Symbol
      if (symbol.filePath === sourceFilePath) {
        await safeFs.rm(path.join(symbolsDir, file))
        removed++
      }
    } catch {
      // Skip
    }
  }

  return removed
}

// ── Schema Files ────────────────────────────────────────────

export async function writeSchemaSymbols(
  safeFs: SafeFS,
  schemas: SchemaSymbol[]
): Promise<void> {
  const filePath = path.join(safeFs.getIndexDir(), 'schema', 'migrations.json')
  await safeFs.writeFile(filePath, JSON.stringify(schemas, null, 2))
}

export async function readSchemaSymbols(safeFs: SafeFS): Promise<SchemaSymbol[]> {
  const filePath = path.join(safeFs.getIndexDir(), 'schema', 'migrations.json')
  if (!await safeFs.exists(filePath)) return []
  try {
    const content = await safeFs.readFile(filePath)
    return JSON.parse(content) as SchemaSymbol[]
  } catch {
    return []
  }
}

// ── Config Files ────────────────────────────────────────────

export async function writeConfigSymbols(
  safeFs: SafeFS,
  configs: ConfigSymbol[]
): Promise<void> {
  const filePath = path.join(safeFs.getIndexDir(), 'config', 'application.json')
  await safeFs.writeFile(filePath, JSON.stringify(configs, null, 2))
}

export async function readConfigSymbols(safeFs: SafeFS): Promise<ConfigSymbol[]> {
  const filePath = path.join(safeFs.getIndexDir(), 'config', 'application.json')
  if (!await safeFs.exists(filePath)) return []
  try {
    const content = await safeFs.readFile(filePath)
    return JSON.parse(content) as ConfigSymbol[]
  } catch {
    return []
  }
}

// ── Meta ────────────────────────────────────────────────────

export async function writeMeta(safeFs: SafeFS, meta: ProjectMeta): Promise<void> {
  const filePath = path.join(safeFs.getIndexDir(), 'meta.json')
  await safeFs.writeFile(filePath, JSON.stringify(meta, null, 2))
}

export async function readMeta(safeFs: SafeFS): Promise<ProjectMeta | null> {
  const filePath = path.join(safeFs.getIndexDir(), 'meta.json')
  if (!await safeFs.exists(filePath)) return null
  try {
    const content = await safeFs.readFile(filePath)
    return JSON.parse(content) as ProjectMeta
  } catch {
    return null
  }
}

// ── Error Log ────────────────────────────────────────────────

export async function writeErrorLog(safeFs: SafeFS, error: {
  phase: string
  message: string
  stack?: string
  context?: Record<string, unknown>
}): Promise<void> {
  const logDir = path.join(safeFs.getCondexDir(), 'index')
  try {
    await safeFs.mkdir(logDir)
  } catch { /* already exists */ }

  const logPath = path.join(logDir, 'errors.log')
  const entry = {
    timestamp: new Date().toISOString(),
    ...error,
  }

  // Append to log file
  let existing = ''
  try {
    existing = await safeFs.readFile(logPath)
  } catch { /* file doesn't exist yet */ }

  const separator = existing ? '\n---\n' : ''
  await safeFs.writeFile(logPath, existing + separator + JSON.stringify(entry, null, 2))
}

// ── Condex Config ───────────────────────────────────────────

export async function readCondexConfig(safeFs: SafeFS): Promise<CondexConfig | null> {
  const filePath = path.join(safeFs.getCondexDir(), 'condex.config.json')
  if (!await safeFs.exists(filePath)) return null
  try {
    const content = await safeFs.readFile(filePath)
    return JSON.parse(content) as CondexConfig
  } catch {
    return null
  }
}

export async function writeCondexConfig(
  safeFs: SafeFS,
  config: CondexConfig
): Promise<void> {
  const filePath = path.join(safeFs.getCondexDir(), 'condex.config.json')
  await safeFs.writeFile(filePath, JSON.stringify(config, null, 2))
}

// ── Lockfile ────────────────────────────────────────────────

interface LockInfo {
  pid: number
  timestamp: string
  hostname: string
}

const LOCK_STALE_MS = 5 * 60 * 1000 // 5 minutes

export async function acquireIndexLock(safeFs: SafeFS): Promise<boolean> {
  const lockPath = path.join(safeFs.getCondexDir(), '.indexing.lock')

  // Check for existing lock
  if (await safeFs.exists(lockPath)) {
    try {
      const content = await safeFs.readFile(lockPath)
      const lock = JSON.parse(content) as LockInfo
      const lockAge = Date.now() - new Date(lock.timestamp).getTime()

      if (lockAge < LOCK_STALE_MS) {
        // Lock is fresh — someone else is indexing
        return false
      }
      // Lock is stale — clear it
      console.error(`[condex] Clearing stale index lock (age: ${Math.round(lockAge / 1000)}s)`)
    } catch {
      // Malformed lock file — clear it
    }
  }

  // Write our lock
  const lock: LockInfo = {
    pid: process.pid,
    timestamp: new Date().toISOString(),
    hostname: (await import('node:os')).hostname(),
  }
  await safeFs.writeFile(lockPath, JSON.stringify(lock, null, 2))
  return true
}

export async function releaseIndexLock(safeFs: SafeFS): Promise<void> {
  const lockPath = path.join(safeFs.getCondexDir(), '.indexing.lock')
  try {
    await safeFs.rm(lockPath)
  } catch {
    // Ignore — lock may have been cleared by another process
  }
}

// ── Utilities ───────────────────────────────────────────────

/**
 * SHA256 hash of file content for change detection.
 */
export async function sha256File(safeFs: SafeFS, filePath: string): Promise<string> {
  const content = await safeFs.readFile(filePath)
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * SHA256 hash of a string (for content hashing).
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 20)
}
