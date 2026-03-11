import type { HexRole } from '@cortex-ai/core'
import type { ProjectProfile } from './arch-detector.js'

/**
 * Assign hexagonal architecture role based on naming conventions and file location.
 * Only active when architecture is detected as 'hexagonal'.
 */
export function assignHexRole(
  qualifiedName: string,
  filePath: string,
  profile: ProjectProfile
): HexRole {
  if (profile.architecture !== 'hexagonal') return 'NONE'

  // Port patterns
  if (/Port$/.test(qualifiedName) || /\/ports\//.test(filePath)) {
    if (/\/infrastructure\/|\/adapter\/|\/adapters\//.test(filePath)) {
      return 'OUTBOUND_PORT'
    }
    return 'INBOUND_PORT'
  }

  // Adapter patterns
  if (/Adapter$/.test(qualifiedName) || /\/adapters?\//.test(filePath)) {
    return 'ADAPTER'
  }

  // Use case handler patterns
  if (/UseCase$|Handler$|Command$/.test(qualifiedName) && /\/application\//.test(filePath)) {
    return 'USE_CASE_HANDLER'
  }

  // Domain patterns
  if (/\/domain\//.test(filePath)) {
    if (/Event$/.test(qualifiedName)) return 'DOMAIN_EVENT'
    if (/Command$/.test(qualifiedName)) return 'DOMAIN_COMMAND'
    if (/ValueObject$|VO$/.test(qualifiedName)) return 'DOMAIN_VALUE_OBJECT'
    return 'DOMAIN_ENTITY'
  }

  return 'NONE'
}
