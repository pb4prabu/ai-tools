import crypto from 'node:crypto'
import path from 'node:path'

/**
 * Get the project root from process.cwd().
 * The CWD is inherited from OpenCode/Claude Code — that IS the project root.
 */
export function getProjectRoot(): string {
  return path.resolve(process.cwd())
}

/**
 * Generate a deterministic, unique namespace for a project.
 * Format: projectName@sha256(absolutePath)[0:6]
 *
 * Same absolute path always produces the same namespace.
 * Different paths always produce different namespaces.
 */
export function generateNamespace(rootPath: string): string {
  const absoluteRoot = path.resolve(rootPath)
  const projectName = path.basename(absoluteRoot)
  const hash = crypto
    .createHash('sha256')
    .update(absoluteRoot)
    .digest('hex')
    .slice(0, 6)
  return `${projectName}@${hash}`
}
