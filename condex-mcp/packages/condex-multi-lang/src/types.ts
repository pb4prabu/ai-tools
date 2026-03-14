import type { SymbolKind } from '@condex-ai/core/types/symbol.js'

/**
 * Compact language configuration for tree-sitter based parsing.
 * Each language defines which AST node types map to which symbol kinds.
 */
export interface LangConfig {
  /** Language identifier */
  id: string
  /** File extensions (without dot) */
  extensions: string[]
  /** npm package name for the tree-sitter grammar */
  grammar: string
  /** For grammars that export sub-languages (e.g., tree-sitter-typescript exports .typescript) */
  grammarExport?: string

  /** AST node types that are class-like containers */
  classNodes: string[]
  /** AST node types that are function/method declarations */
  functionNodes: string[]
  /** AST node types that are interface declarations */
  interfaceNodes?: string[]
  /** AST node types that are type/enum/struct declarations */
  typeNodes?: string[]
  /** AST node types that are module/namespace containers */
  moduleNodes?: string[]

  /** Field name for declaration name (default: 'name') */
  nameField?: string
  /** Field name for class/function body (default: 'body') */
  bodyField?: string
  /** Field name for parameters */
  paramsField?: string
  /** Field name for return type */
  returnField?: string

  /** How to extract docstrings */
  docStyle: 'preceding_comment' | 'first_body_string' | 'jsdoc' | 'triple_slash' | 'hash_comment'
  /** AST node types for comments */
  commentTypes?: string[]

  /** How to extract the package/module name from root */
  packageExtractor?: (root: any) => string

  /** Node types that wrap declarations (e.g., decorated_definition in Python) */
  wrapperNodes?: string[]

  /** For languages where methods have receivers (Go) */
  receiverField?: string
}

/** Resolved symbol from a generic parse */
export interface ParsedSymbol {
  name: string
  qualifiedName: string
  kind: SymbolKind
  signature: string
  docstring: string | null
  enclosingClass: string | null
  byteOffset: number
  byteLength: number
  parameterTypes: string[]
  returnType: string | null
}
