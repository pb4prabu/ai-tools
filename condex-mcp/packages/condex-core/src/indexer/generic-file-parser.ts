/**
 * Generic text file parser.
 *
 * Creates a single file-level Symbol from any text file so it can be
 * searched via BM25 (FTS5) and vector (embeddings).
 *
 * Used for non-language files: .xml, .properties, .md, .json, .yml, etc.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import type { Symbol } from '../types/symbol.js'
import { buildSymbolId } from '../types/symbol.js'

/** Extensions that are definitely binary — never parse these */
const BINARY_EXTENSIONS = new Set([
  '.class', '.jar', '.war', '.ear',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.tiff',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.exe', '.dll', '.so', '.dylib',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.sqlite3',
  '.o', '.a', '.lib',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
  '.lock',
])

export function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * Check if content looks binary (has null bytes in first 1024 bytes).
 */
function isBinaryContent(content: string): boolean {
  const sample = content.slice(0, 1024)
  return sample.includes('\0')
}

/**
 * Parse a generic text file into a file-level Symbol.
 * Returns null if the file is binary or empty.
 */
export function parseGenericFile(content: string, opts: {
  projectId: string
  filePath: string
}): Symbol | null {
  if (!content || content.trim().length === 0) return null
  if (isBinaryExtension(opts.filePath)) return null
  if (isBinaryContent(content)) return null

  const fileName = path.basename(opts.filePath)
  const dirPath = path.dirname(opts.filePath)
  const ext = path.extname(opts.filePath)

  // Use file content for FTS searchability:
  // - signature: first 500 chars (FTS5 indexes this)
  // - javadoc: next 500 chars (FTS5 indexes this too)
  const cleanContent = content.replace(/\r\n/g, '\n')
  const signature = cleanContent.slice(0, 500).trim()
  const javadoc = cleanContent.length > 500
    ? cleanContent.slice(500, 1000).trim()
    : undefined

  const contentHash = crypto.createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 12)

  return {
    id: buildSymbolId(opts.projectId, opts.filePath, opts.filePath, 'file'),
    projectId: opts.projectId,
    filePath: opts.filePath,
    qualifiedName: opts.filePath,
    simpleName: fileName,
    className: fileName,
    packageName: dirPath === '.' ? '' : dirPath,
    kind: 'file',
    signature,
    javadoc,
    annotations: [],
    springRole: 'NONE' as any,
    hexRole: 'NONE' as any,
    implementedInterfaces: [],
    parameterTypes: [],
    throwsTypes: [],
    byteOffset: 0,
    byteLength: Buffer.byteLength(content, 'utf-8'),
    contentHash,
  }
}
