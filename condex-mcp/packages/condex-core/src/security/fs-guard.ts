/**
 * Filesystem Access Guard
 *
 * Restricts all file operations to the project root directory.
 * - Reads: allowed within {projectRoot}/**
 * - Writes: allowed within {projectRoot}/.condex/** only
 * - Everything else: blocked
 *
 * All Condex code MUST use SafeFS instead of raw `node:fs`.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export class SafeFS {
  private readonly projectRoot: string
  private readonly condexDir: string

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot)
    this.condexDir = path.join(this.projectRoot, '.condex')
  }

  /**
   * Assert a path is within the project root (for reads).
   */
  assertReadAllowed(targetPath: string): string {
    const resolved = path.resolve(targetPath)
    if (resolved !== this.projectRoot && !resolved.startsWith(this.projectRoot + path.sep)) {
      throw new Error(
        `FS_BLOCKED: Read access denied outside project root.\n` +
        `  Attempted: ${resolved}\n` +
        `  Allowed:   ${this.projectRoot}/`
      )
    }
    return resolved
  }

  /**
   * Assert a path is within .condex/ (for writes).
   */
  assertWriteAllowed(targetPath: string): string {
    const resolved = path.resolve(targetPath)
    if (resolved !== this.condexDir && !resolved.startsWith(this.condexDir + path.sep)) {
      throw new Error(
        `FS_BLOCKED: Write access denied outside .condex/ directory.\n` +
        `  Attempted: ${resolved}\n` +
        `  Allowed:   ${this.condexDir}/`
      )
    }
    return resolved
  }

  getProjectRoot(): string {
    return this.projectRoot
  }

  getCondexDir(): string {
    return this.condexDir
  }

  getIndexDir(): string {
    return path.join(this.condexDir, 'index')
  }

  // ── Read Operations ──────────────────────────────────────

  async readFile(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    const resolved = this.assertReadAllowed(filePath)
    return fsp.readFile(resolved, encoding)
  }

  async readdir(dirPath: string): Promise<string[]> {
    const resolved = this.assertReadAllowed(dirPath)
    return fsp.readdir(resolved)
  }

  async stat(filePath: string): Promise<fs.Stats> {
    const resolved = this.assertReadAllowed(filePath)
    return fsp.stat(resolved)
  }

  async exists(filePath: string): Promise<boolean> {
    const resolved = this.assertReadAllowed(filePath)
    try {
      await fsp.access(resolved)
      return true
    } catch {
      return false
    }
  }

  readFileSync(filePath: string, encoding: BufferEncoding = 'utf-8'): string {
    const resolved = this.assertReadAllowed(filePath)
    return fs.readFileSync(resolved, encoding)
  }

  existsSync(filePath: string): boolean {
    const resolved = this.assertReadAllowed(filePath)
    return fs.existsSync(resolved)
  }

  // ── Write Operations (restricted to .condex/) ────────────

  async writeFile(filePath: string, data: string): Promise<void> {
    const resolved = this.assertWriteAllowed(filePath)
    await fsp.mkdir(path.dirname(resolved), { recursive: true })
    await fsp.writeFile(resolved, data, 'utf-8')
  }

  async mkdir(dirPath: string): Promise<void> {
    const resolved = this.assertWriteAllowed(dirPath)
    await fsp.mkdir(resolved, { recursive: true })
  }

  async rm(filePath: string): Promise<void> {
    const resolved = this.assertWriteAllowed(filePath)
    await fsp.rm(resolved, { force: true })
  }

  async rmdir(dirPath: string): Promise<void> {
    const resolved = this.assertWriteAllowed(dirPath)
    await fsp.rm(resolved, { recursive: true, force: true })
  }

  writeFileSync(filePath: string, data: string): void {
    const resolved = this.assertWriteAllowed(filePath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, data, 'utf-8')
  }
}
