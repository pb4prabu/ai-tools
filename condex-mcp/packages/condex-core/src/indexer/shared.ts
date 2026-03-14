/**
 * Shared utilities for indexer and incremental-reindexer.
 * Eliminates duplication of language detection, file discovery, and hashing.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { glob } from 'glob'
import type { CondexConfig } from '../types/config.js'
import { DEFAULT_CONFIG } from '../types/config.js'
import { isBinaryExtension } from './generic-file-parser.js'

/** Directories always excluded from file scans */
const IGNORE_DIRS = [
  '**/node_modules/**', '**/build/classes/**', '**/build/generated/**',
  '**/build/libs/**', '**/build/tmp/**', '**/target/classes/**',
  '**/target/generated-sources/**', '**/target/test-classes/**',
  '**/dist/out/**', '**/.git/**', '**/.condex/**',
]

/** Language → source file glob patterns */
const EXTENSION_MAP: Record<string, string[]> = {
  java: ['**/*.java', '**/*.kt', '**/*.kts'],
  typescript: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
  python: ['**/*.py'],
  all: [
    '**/*.java', '**/*.kt', '**/*.kts',
    '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.mts', '**/*.cts',
    '**/*.py', '**/*.go', '**/*.rs',
    '**/*.c', '**/*.h', '**/*.cpp', '**/*.cc', '**/*.cxx', '**/*.hpp', '**/*.hxx', '**/*.hh',
    '**/*.rb', '**/*.rake', '**/*.gemspec', '**/*.cs',
    '**/*.sh', '**/*.bash', '**/*.zsh', '**/*.swift', '**/*.php',
    '**/*.scala', '**/*.sc', '**/*.lua', '**/*.hs', '**/*.lhs',
    '**/*.ex', '**/*.exs', '**/*.r', '**/*.R', '**/*.ml', '**/*.mli', '**/*.zig',
  ],
}

/**
 * Detect project language from build markers.
 * Priority: Java > TypeScript > Python.
 */
export function detectLanguage(projectRoot: string): string {
  const markers: [string[], string][] = [
    [['pom.xml', 'build.gradle', 'build.gradle.kts'], 'java'],
    [['tsconfig.json'], 'typescript'],
    [['requirements.txt', 'pyproject.toml'], 'python'],
  ]

  for (const [files, lang] of markers) {
    for (const marker of files) {
      try {
        if (glob.sync(`**/${marker}`, { cwd: projectRoot, ignore: IGNORE_DIRS, nodir: true, maxDepth: 50 }).length > 0) {
          return lang
        }
      } catch { /* ignore */ }
    }
  }

  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'typescript'
  return 'java'
}

/**
 * Find source files matching language-specific or config-specified patterns.
 */
export async function findSourceFiles(
  projectRoot: string,
  language: string,
  config: Partial<CondexConfig>,
): Promise<string[]> {
  const include = config.include ?? EXTENSION_MAP[language] ?? EXTENSION_MAP.all
  const exclude = mergeExcludes(config)
  const files: string[] = []

  for (const pattern of include) {
    files.push(...await glob(pattern, { cwd: projectRoot, ignore: exclude, nodir: true }))
  }
  return [...new Set(files)].sort()
}

/**
 * Find supplemental (non-language) text files for generic parsing.
 */
export async function findSupplementalFiles(
  projectRoot: string,
  config: Partial<CondexConfig>,
  alreadyFound: Set<string>,
): Promise<string[]> {
  const exclude = mergeExcludes(config)
  const allFiles = await glob('**/*', { cwd: projectRoot, ignore: exclude, nodir: true })
  return allFiles.filter(f => !alreadyFound.has(f) && !isBinaryExtension(f)).sort()
}

/**
 * Find files matching a single glob pattern with exclusions.
 */
export async function findFiles(
  projectRoot: string,
  pattern: string,
  config: Partial<CondexConfig>,
): Promise<string[]> {
  const exclude = mergeExcludes(config)
  const files = await glob(pattern, { cwd: projectRoot, ignore: exclude, nodir: true })
  return [...new Set(files)].sort()
}

/**
 * Merge config excludes with hardcoded .condex exclusion.
 */
export function mergeExcludes(config: Partial<CondexConfig>): string[] {
  const exclude = config.exclude ?? DEFAULT_CONFIG.exclude
  return [...new Set([...exclude, '**/.condex/**'])]
}

/**
 * SHA256 hash of content, truncated for change detection.
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 20)
}
