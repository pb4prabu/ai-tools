export type SymbolKind =
  | 'class'
  | 'interface'
  | 'method'
  | 'field'
  | 'constant'
  | 'constructor'
  | 'enum'
  | 'annotation_type'
  | 'function'
  | 'module'
  | 'struct'
  | 'trait'
  | 'type_alias'
  | 'file'

export type SpringRole =
  | 'REST_CONTROLLER'
  | 'CONTROLLER'
  | 'SERVICE'
  | 'REPOSITORY'
  | 'COMPONENT'
  | 'CONFIGURATION'
  | 'ENTITY'
  | 'EVENT_HANDLER'
  | 'SCHEDULED'
  | 'NONE'

export type HexRole =
  | 'INBOUND_PORT'
  | 'OUTBOUND_PORT'
  | 'USE_CASE_HANDLER'
  | 'ADAPTER'
  | 'DOMAIN_ENTITY'
  | 'DOMAIN_VALUE_OBJECT'
  | 'DOMAIN_EVENT'
  | 'DOMAIN_COMMAND'
  | 'NONE'

export interface Symbol {
  id: string
  projectId: string
  filePath: string
  qualifiedName: string
  simpleName: string
  className?: string
  packageName?: string
  kind: SymbolKind
  signature: string
  javadoc?: string
  annotations: string[]
  springRole?: SpringRole
  hexRole?: HexRole
  moduleLayer?: string
  implementedInterfaces: string[]
  extendsClass?: string
  parameterTypes: string[]
  returnType?: string
  throwsTypes: string[]
  byteOffset: number
  byteLength: number
  contentHash: string
  indexedAt?: string
}

/**
 * Build a unique symbol ID.
 * Format: projectId::filePath::qualifiedName#kind
 */
export function buildSymbolId(
  projectId: string,
  filePath: string,
  qualifiedName: string,
  kind: SymbolKind
): string {
  return `${projectId}::${filePath}::${qualifiedName}#${kind}`
}
