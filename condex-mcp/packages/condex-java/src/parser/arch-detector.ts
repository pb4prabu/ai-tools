export type ArchitectureType = 'hexagonal' | 'layered' | 'mvc' | 'unknown'

export interface ProjectProfile {
  architecture: ArchitectureType
  confidence: number
  signals: string[]
}

const HEX_SIGNALS = [
  { pattern: /\/application\//, weight: 2, name: 'application layer' },
  { pattern: /\/domain\//, weight: 2, name: 'domain layer' },
  { pattern: /\/infrastructure\//, weight: 2, name: 'infrastructure layer' },
  { pattern: /Port\.(java|kt)$/, weight: 3, name: 'Port suffix' },
  { pattern: /Adapter\.(java|kt)$/, weight: 3, name: 'Adapter suffix' },
  { pattern: /UseCase\.(java|kt)$/, weight: 3, name: 'UseCase suffix' },
  { pattern: /Handler\.(java|kt)$/, weight: 1, name: 'Handler suffix' },
  { pattern: /\/ports\//, weight: 2, name: 'ports directory' },
  { pattern: /\/adapters\//, weight: 2, name: 'adapters directory' },
]

const LAYERED_SIGNALS = [
  { pattern: /\/service\//, weight: 2, name: 'service layer' },
  { pattern: /\/repository\//, weight: 2, name: 'repository layer' },
  { pattern: /\/controller\//, weight: 2, name: 'controller layer' },
  { pattern: /\/dao\//, weight: 2, name: 'DAO layer' },
  { pattern: /\/dto\//, weight: 1, name: 'DTO layer' },
]

const MVC_SIGNALS = [
  { pattern: /\/model\//, weight: 2, name: 'model directory' },
  { pattern: /\/view\//, weight: 2, name: 'view directory' },
  { pattern: /\/controllers\//, weight: 2, name: 'controllers directory' },
]

/**
 * Detect project architecture from file paths.
 */
export function detectArchitecture(filePaths: string[]): ProjectProfile {
  let hexScore = 0
  let layeredScore = 0
  let mvcScore = 0
  const signals: string[] = []

  const matchedSignals = new Set<string>()

  for (const fp of filePaths) {
    for (const signal of HEX_SIGNALS) {
      if (signal.pattern.test(fp) && !matchedSignals.has(`hex:${signal.name}`)) {
        hexScore += signal.weight
        matchedSignals.add(`hex:${signal.name}`)
        signals.push(`hex: ${signal.name}`)
      }
    }
    for (const signal of LAYERED_SIGNALS) {
      if (signal.pattern.test(fp) && !matchedSignals.has(`layered:${signal.name}`)) {
        layeredScore += signal.weight
        matchedSignals.add(`layered:${signal.name}`)
        signals.push(`layered: ${signal.name}`)
      }
    }
    for (const signal of MVC_SIGNALS) {
      if (signal.pattern.test(fp) && !matchedSignals.has(`mvc:${signal.name}`)) {
        mvcScore += signal.weight
        matchedSignals.add(`mvc:${signal.name}`)
        signals.push(`mvc: ${signal.name}`)
      }
    }
  }

  const maxScore = Math.max(hexScore, layeredScore, mvcScore)
  if (maxScore === 0) {
    return { architecture: 'unknown', confidence: 0, signals: [] }
  }

  const totalScore = hexScore + layeredScore + mvcScore
  const confidence = Math.round((maxScore / totalScore) * 100) / 100

  if (hexScore >= layeredScore && hexScore >= mvcScore) {
    return { architecture: 'hexagonal', confidence, signals }
  } else if (layeredScore >= mvcScore) {
    return { architecture: 'layered', confidence, signals }
  } else {
    return { architecture: 'mvc', confidence, signals }
  }
}
