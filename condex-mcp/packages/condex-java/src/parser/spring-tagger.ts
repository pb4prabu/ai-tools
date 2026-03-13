import type { SpringRole } from '@condex-ai/core'

const SPRING_ANNOTATION_MAP: Record<string, SpringRole> = {
  '@RestController': 'REST_CONTROLLER',
  '@Controller': 'CONTROLLER',
  '@Service': 'SERVICE',
  '@Repository': 'REPOSITORY',
  '@Component': 'COMPONENT',
  '@Configuration': 'CONFIGURATION',
  '@Entity': 'ENTITY',
  '@EventListener': 'EVENT_HANDLER',
  '@Scheduled': 'SCHEDULED',
  '@SpringBootApplication': 'CONFIGURATION',
}

/**
 * Assign Spring Framework role based on annotations.
 * Returns the most specific role found, or 'NONE'.
 */
export function assignSpringRole(annotations: string[]): SpringRole {
  for (const annotation of annotations) {
    // Extract the annotation name without parameters
    const name = annotation.split('(')[0].trim()
    const role = SPRING_ANNOTATION_MAP[name]
    if (role) return role
  }
  return 'NONE'
}
