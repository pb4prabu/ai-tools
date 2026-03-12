import yaml from 'js-yaml'
import path from 'node:path'
import type { ConfigSymbol } from '@condex-ai/core'

/**
 * Parse YAML config files (application.yml, application-{profile}.yml).
 * Flattens to dot-notation key paths.
 */
export function parseYamlFile(
  content: string,
  projectId: string,
  sourceFile: string
): ConfigSymbol[] {
  const symbols: ConfigSymbol[] = []

  // Detect profile from filename: application-dev.yml → "dev"
  const basename = path.basename(sourceFile, path.extname(sourceFile))
  const profileMatch = basename.match(/^application-(.+)$/)
  const profile = profileMatch ? profileMatch[1] : undefined

  let doc: any
  try {
    doc = yaml.load(content)
  } catch {
    return []
  }

  if (!doc || typeof doc !== 'object') return []

  // Flatten to dot-notation paths
  flatten(doc, '', symbols, projectId, sourceFile, profile)

  return symbols
}

function flatten(
  obj: any,
  prefix: string,
  symbols: ConfigSymbol[],
  projectId: string,
  sourceFile: string,
  profile?: string
): void {
  for (const [key, value] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${key}` : key

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recurse into nested objects
      flatten(value, keyPath, symbols, projectId, sourceFile, profile)
    } else {
      // Leaf value
      const strValue = Array.isArray(value)
        ? JSON.stringify(value)
        : String(value ?? '')

      symbols.push({
        id: `${projectId}::${sourceFile}::${keyPath}#config`,
        projectId,
        keyPath,
        value: strValue,
        profile,
        sourceFile,
      })
    }
  }
}
