import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { Symbol, SymbolKind } from '@condex-ai/core/types/symbol.js'
import { buildSymbolId } from '@condex-ai/core/types/symbol.js'
import type { LangConfig } from './types.js'
import { LANGUAGE_REGISTRY, EXTENSION_MAP } from './registry.js'

const esmRequire = createRequire(import.meta.url)

// Cache: loaded parsers per language
const parserCache = new Map<string, any>()
// Cache: loaded grammars per language
const grammarCache = new Map<string, any>()
// Set of grammars that failed to load (don't retry)
const failedGrammars = new Set<string>()

interface ParseOptions {
  projectId: string
  filePath: string
}

/**
 * Load a tree-sitter grammar for a language. Returns null if not installed.
 */
function loadGrammar(config: LangConfig): any | null {
  const cacheKey = config.id
  if (grammarCache.has(cacheKey)) return grammarCache.get(cacheKey)
  if (failedGrammars.has(cacheKey)) return null

  try {
    let grammar = esmRequire(config.grammar)
    // Some packages export sub-languages (e.g., tree-sitter-typescript exports .typescript)
    if (config.grammarExport && grammar[config.grammarExport]) {
      grammar = grammar[config.grammarExport]
    }
    grammarCache.set(cacheKey, grammar)
    return grammar
  } catch {
    failedGrammars.add(cacheKey)
    return null
  }
}

/**
 * Get or create a tree-sitter parser for a language.
 */
function getParser(config: LangConfig): any | null {
  if (parserCache.has(config.id)) return parserCache.get(config.id)

  const grammar = loadGrammar(config)
  if (!grammar) return null

  try {
    const Parser = esmRequire('tree-sitter')
    const parser = new Parser()
    parser.setLanguage(grammar)
    parserCache.set(config.id, parser)
    return parser
  } catch {
    failedGrammars.add(config.id)
    return null
  }
}

/**
 * Detect language from file extension.
 */
export function detectLanguageFromExt(filePath: string): string | null {
  const ext = path.extname(filePath).slice(1).toLowerCase() // remove dot
  return EXTENSION_MAP[ext] ?? null
}

/**
 * Get list of supported languages (grammars that can be loaded).
 */
export function getSupportedLanguages(): string[] {
  const supported: string[] = []
  for (const [id, config] of Object.entries(LANGUAGE_REGISTRY)) {
    if (!failedGrammars.has(id)) {
      const grammar = loadGrammar(config)
      if (grammar) supported.push(id)
    }
  }
  return supported
}

/**
 * Parse a source file into symbols using the appropriate tree-sitter grammar.
 * Returns null if the language is unsupported or grammar not installed.
 */
export function parseMultiLangFile(
  content: string,
  opts: ParseOptions
): Symbol[] | null {
  const langId = detectLanguageFromExt(opts.filePath)
  if (!langId) return null

  const config = LANGUAGE_REGISTRY[langId]
  if (!config) return null

  const parser = getParser(config)
  if (!parser) return null

  try {
    const tree = parser.parse(content)
    if (!tree?.rootNode) return null

    const packageName = config.packageExtractor?.(tree.rootNode) ?? ''
    const symbols: Symbol[] = []

    walkNode(tree.rootNode, config, content, opts, packageName, null, symbols)

    return symbols.length > 0 ? symbols : null
  } catch (err: any) {
    console.error(`[condex-multi-lang] Error parsing ${opts.filePath} as ${langId}: ${err.message}`)
    return null
  }
}

/**
 * Recursively walk the AST and extract symbols.
 */
function walkNode(
  node: any,
  config: LangConfig,
  content: string,
  opts: ParseOptions,
  packageName: string,
  enclosingClass: string | null,
  symbols: Symbol[]
): void {
  for (const child of node.namedChildren ?? []) {
    // Check if this is a wrapper node (e.g., decorated_definition in Python)
    if (config.wrapperNodes?.includes(child.type)) {
      // Recurse into wrapper to find the actual declaration
      walkNode(child, config, content, opts, packageName, enclosingClass, symbols)
      continue
    }

    // Check class-like containers
    if (config.classNodes.includes(child.type)) {
      const name = extractName(child, config)
      if (!name) {
        // For unnamed containers (like Rust impl blocks), extract type name
        const typeName = child.childForFieldName?.('type')?.text
          ?? child.childForFieldName?.('name')?.text
        if (typeName) {
          // Recurse into the impl/container body with the type as enclosing class
          const bodyNode = findBodyNode(child, config)
          if (bodyNode) {
            walkNode(bodyNode, config, content, opts, packageName, typeName, symbols)
          }
          continue
        }
        walkNode(child, config, content, opts, packageName, enclosingClass, symbols)
        continue
      }

      const qualifiedName = buildQualifiedName(packageName, enclosingClass, name)
      const kind = classifyClassNode(child, config)

      symbols.push(createSymbol(child, config, content, opts, {
        name,
        qualifiedName,
        kind,
        packageName,
        enclosingClass,
      }))

      // Recurse into class body for methods
      const bodyNode = findBodyNode(child, config)
      if (bodyNode) {
        walkNode(bodyNode, config, content, opts, packageName, qualifiedName, symbols)
      }
      continue
    }

    // Check interface nodes
    if (config.interfaceNodes?.includes(child.type)) {
      const name = extractName(child, config)
      if (name) {
        const qualifiedName = buildQualifiedName(packageName, enclosingClass, name)
        symbols.push(createSymbol(child, config, content, opts, {
          name,
          qualifiedName,
          kind: 'interface',
          packageName,
          enclosingClass,
        }))

        const bodyNode = findBodyNode(child, config)
        if (bodyNode) {
          walkNode(bodyNode, config, content, opts, packageName, qualifiedName, symbols)
        }
      }
      continue
    }

    // Check type nodes (structs, enums, type aliases)
    if (config.typeNodes?.includes(child.type)) {
      const name = extractTypeName(child, config)
      if (name) {
        const qualifiedName = buildQualifiedName(packageName, enclosingClass, name)
        const kind = classifyTypeNode(child, config)
        symbols.push(createSymbol(child, config, content, opts, {
          name,
          qualifiedName,
          kind,
          packageName,
          enclosingClass,
        }))

        // Recurse into type body for methods (e.g., Rust struct impl)
        const bodyNode = findBodyNode(child, config)
        if (bodyNode) {
          walkNode(bodyNode, config, content, opts, packageName, qualifiedName, symbols)
        }
      }
      continue
    }

    // Check module nodes
    if (config.moduleNodes?.includes(child.type)) {
      const name = extractName(child, config)
      if (name) {
        const qualifiedName = buildQualifiedName(packageName, null, name)
        symbols.push(createSymbol(child, config, content, opts, {
          name,
          qualifiedName,
          kind: 'module',
          packageName,
          enclosingClass: null,
        }))

        const bodyNode = findBodyNode(child, config)
        if (bodyNode) {
          walkNode(bodyNode, config, content, opts, packageName, qualifiedName, symbols)
        }
      }
      continue
    }

    // Check function/method nodes
    if (config.functionNodes.includes(child.type)) {
      const name = extractFunctionName(child, config)
      if (name) {
        // Determine if this is a method (inside a class) or a function
        let methodClass = enclosingClass

        // Go-style receivers: method_declaration has a receiver field
        if (config.receiverField) {
          const receiver = child.childForFieldName?.(config.receiverField)
          if (receiver) {
            // Extract the type name from the receiver
            const receiverType = extractReceiverType(receiver)
            if (receiverType) methodClass = receiverType
          }
        }

        const kind: SymbolKind = methodClass ? 'method' : 'function'
        const qualifiedName = buildQualifiedName(packageName, methodClass, name)

        symbols.push(createSymbol(child, config, content, opts, {
          name,
          qualifiedName,
          kind,
          packageName,
          enclosingClass: methodClass,
        }))
      }
      continue
    }

    // Recurse into other nodes to find nested declarations
    walkNode(child, config, content, opts, packageName, enclosingClass, symbols)
  }
}

// ── Helper Functions ────────────────────────────────────────

function extractName(node: any, config: LangConfig): string | null {
  const nameField = config.nameField ?? 'name'
  const nameNode = node.childForFieldName?.(nameField)
  if (nameNode) return nameNode.text

  // Fallback: look for identifier child
  for (const child of node.namedChildren ?? []) {
    if (child.type === 'identifier' || child.type === 'simple_identifier' || child.type === 'type_identifier') {
      return child.text
    }
  }
  return null
}

function extractFunctionName(node: any, config: LangConfig): string | null {
  // For C/C++, functions have declarator field containing the name
  const nameField = config.nameField ?? 'name'
  const nameNode = node.childForFieldName?.(nameField)

  if (nameNode) {
    // C/C++: declarator might be a function_declarator wrapping the actual name
    if (nameNode.type === 'function_declarator' || nameNode.type === 'pointer_declarator') {
      return extractDeclaratorName(nameNode)
    }
    return nameNode.text
  }

  // Fallback: look for identifier child (Kotlin uses simple_identifier as node type, not field)
  for (const child of node.namedChildren ?? []) {
    if (child.type === 'identifier' || child.type === 'simple_identifier' || child.type === 'type_identifier') {
      return child.text
    }
  }

  // Fallback for arrow functions assigned to variables
  const parent = node.parent
  if (parent?.type === 'variable_declarator' || parent?.type === 'lexical_declaration') {
    const varName = parent.childForFieldName?.('name')
    if (varName) return varName.text
  }

  // Another fallback: pair node (object methods in JS)
  if (parent?.type === 'pair') {
    const key = parent.childForFieldName?.('key')
    if (key) return key.text
  }

  return null
}

function extractDeclaratorName(node: any): string | null {
  // Walk down through nested declarators to find the identifier
  if (node.type === 'identifier') return node.text
  const declarator = node.childForFieldName?.('declarator')
  if (declarator) return extractDeclaratorName(declarator)
  // Look for first identifier child
  for (const child of node.namedChildren ?? []) {
    if (child.type === 'identifier') return child.text
  }
  return null
}

function extractTypeName(node: any, config: LangConfig): string | null {
  // For Go type_declaration, the actual type spec is a child
  if (node.type === 'type_declaration') {
    for (const child of node.namedChildren ?? []) {
      if (child.type === 'type_spec') {
        return child.childForFieldName?.('name')?.text ?? null
      }
    }
  }
  return extractName(node, config)
}

function extractReceiverType(receiverNode: any): string | null {
  // Go receiver: (s *UserService) or (s UserService)
  // Walk to find the type identifier
  for (const child of receiverNode.namedChildren ?? []) {
    if (child.type === 'parameter_declaration') {
      const typeNode = child.childForFieldName?.('type')
      if (typeNode) {
        // Remove pointer (*) prefix
        return typeNode.text?.replace(/^\*/, '') ?? null
      }
    }
  }
  return null
}

function classifyClassNode(node: any, config: LangConfig): SymbolKind {
  const text = node.type
  if (text.includes('interface')) return 'interface'
  if (text.includes('struct') || text === 'struct_specifier') return 'struct'
  if (text.includes('trait')) return 'trait'
  if (text.includes('enum')) return 'enum'
  if (text.includes('module') || text.includes('namespace')) return 'module'
  if (text.includes('impl')) return 'class' // Rust impl blocks → class
  return 'class'
}

function classifyTypeNode(node: any, _config: LangConfig): SymbolKind {
  const text = node.type
  if (text.includes('struct')) return 'struct'
  if (text.includes('enum')) return 'enum'
  if (text.includes('type_alias') || text.includes('type_definition') || text.includes('type_item')) return 'type_alias'
  if (text === 'type_declaration') {
    // Go: check inner type_spec
    for (const child of node.namedChildren ?? []) {
      if (child.type === 'type_spec') {
        const typeNode = child.childForFieldName?.('type')
        if (typeNode?.type?.includes('struct')) return 'struct'
        if (typeNode?.type?.includes('interface')) return 'interface'
      }
    }
  }
  return 'type_alias'
}

function buildQualifiedName(packageName: string, enclosingClass: string | null, name: string): string {
  // If enclosingClass already has package prefix, just append the name
  if (enclosingClass) {
    if (packageName && enclosingClass.startsWith(packageName + '.')) {
      return `${enclosingClass}.${name}`
    }
    if (packageName) return `${packageName}.${enclosingClass}.${name}`
    return `${enclosingClass}.${name}`
  }
  if (packageName) return `${packageName}.${name}`
  return name
}

/**
 * Find the body node of a declaration. First tries childForFieldName,
 * then falls back to finding a named child with the bodyField type.
 * This handles languages like Kotlin where the body is a named child (e.g., class_body)
 * but not accessible via field names.
 */
function findBodyNode(node: any, config: LangConfig): any | null {
  const bodyField = config.bodyField ?? 'body'

  // Try field access first (works for most languages)
  const byField = node.childForFieldName?.(bodyField)
  if (byField) return byField

  // Fallback: find named child with matching type (e.g., class_body, function_body)
  for (const child of node.namedChildren ?? []) {
    if (child.type === bodyField || child.type === `${bodyField}_body` || child.type === 'function_body') {
      return child
    }
  }
  return null
}

function extractSignature(node: any, content: string, maxLen = 200): string {
  const start = node.startIndex
  const text = content.slice(start, node.endIndex)
  // Signature = everything up to opening brace/colon/body
  const braceIdx = text.indexOf('{')
  const colonIdx = text.indexOf(':')

  // For Python (colon-based blocks), use colon
  let endIdx = braceIdx
  if (endIdx < 0) endIdx = colonIdx
  if (endIdx < 0) endIdx = Math.min(text.length, maxLen)
  else endIdx = Math.min(endIdx, maxLen)

  return text.slice(0, endIdx).trim().replace(/\s+/g, ' ')
}

function extractDocstring(node: any, config: LangConfig, content: string): string | null {
  switch (config.docStyle) {
    case 'first_body_string': {
      // Python: first expression_statement > string in body
      const body = node.childForFieldName?.('body') ?? node.namedChildren?.find((c: any) => c.type === 'block')
      if (!body) return null
      for (const child of body.namedChildren ?? []) {
        if (child.type === 'expression_statement') {
          const str = child.namedChildren?.[0]
          if (str?.type === 'string' || str?.type === 'concatenated_string') {
            return cleanDocstring(str.text)
          }
        }
        break // Only check first statement
      }
      return null
    }

    case 'jsdoc': {
      // JS/TS/PHP: /** */ comment preceding the declaration
      let prev = node.previousSibling
      // Skip past decorators
      while (prev?.type === 'decorator') prev = prev.previousSibling
      if (prev?.type === 'comment' && prev.text?.startsWith('/**')) {
        return cleanDocstring(prev.text)
      }
      return null
    }

    case 'preceding_comment': {
      // Go, C, C++, Kotlin, etc.: // or /* */ comments immediately before
      const comments: string[] = []
      let prev = node.previousSibling
      while (prev && (config.commentTypes ?? ['comment']).includes(prev.type)) {
        comments.unshift(prev.text)
        prev = prev.previousSibling
      }
      if (comments.length > 0) {
        return cleanDocstring(comments.join('\n'))
      }
      return null
    }

    case 'triple_slash': {
      // Rust: /// comments
      const comments: string[] = []
      let prev = node.previousSibling
      while (prev?.type === 'line_comment' && prev.text?.startsWith('///')) {
        comments.unshift(prev.text.replace(/^\/\/\/\s?/, ''))
        prev = prev.previousSibling
      }
      return comments.length > 0 ? comments.join('\n').trim() : null
    }

    case 'hash_comment': {
      // Ruby, R, Bash: # comments
      const comments: string[] = []
      let prev = node.previousSibling
      while (prev?.type === 'comment') {
        comments.unshift(prev.text.replace(/^#\s?/, ''))
        prev = prev.previousSibling
      }
      return comments.length > 0 ? comments.join('\n').trim() : null
    }

    default:
      return null
  }
}

function cleanDocstring(text: string): string {
  return text
    .replace(/^"""|^'''|"""$|'''$/g, '')  // Python triple quotes
    .replace(/^\/\*\*|\*\/$/g, '')         // JSDoc
    .replace(/^\/\*|\*\/$/g, '')           // Block comment
    .replace(/^\s*\*\s?/gm, '')            // Leading * in block comments
    .replace(/^\/\/\s?/gm, '')             // Line comments
    .replace(/^#\s?/gm, '')               // Hash comments
    .trim()
}

function extractParamTypes(node: any, config: LangConfig): string[] {
  const paramsField = config.paramsField ?? 'parameters'
  const paramsNode = node.childForFieldName?.(paramsField)
  if (!paramsNode) return []

  const types: string[] = []
  for (const child of paramsNode.namedChildren ?? []) {
    // Try to find type annotation
    const typeNode = child.childForFieldName?.('type')
    if (typeNode) {
      types.push(typeNode.text)
    } else {
      // Just use the parameter name as a placeholder
      const name = child.childForFieldName?.('name')?.text ?? child.text
      if (name && name !== ',' && name.trim()) types.push(name.trim())
    }
  }
  return types
}

function extractReturnType(node: any, config: LangConfig): string | null {
  if (!config.returnField) return null
  const retNode = node.childForFieldName?.(config.returnField)
  return retNode?.text ?? null
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function createSymbol(
  node: any,
  config: LangConfig,
  content: string,
  opts: ParseOptions,
  info: {
    name: string
    qualifiedName: string
    kind: SymbolKind
    packageName: string
    enclosingClass: string | null
  }
): Symbol {
  const signature = extractSignature(node, content)
  const docstring = extractDocstring(node, config, content)
  const paramTypes = info.kind === 'method' || info.kind === 'function' || info.kind === 'constructor'
    ? extractParamTypes(node, config)
    : []
  const returnType = info.kind === 'method' || info.kind === 'function'
    ? extractReturnType(node, config)
    : null
  const snippet = content.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 500))

  return {
    id: buildSymbolId(opts.projectId, opts.filePath, info.qualifiedName, info.kind),
    projectId: opts.projectId,
    filePath: opts.filePath,
    qualifiedName: info.qualifiedName,
    simpleName: info.name,
    className: info.enclosingClass ?? (info.kind === 'class' || info.kind === 'interface' || info.kind === 'struct' ? info.name : undefined),
    packageName: info.packageName,
    kind: info.kind,
    signature,
    javadoc: docstring ?? undefined,
    annotations: [],
    springRole: 'NONE',
    hexRole: 'NONE',
    implementedInterfaces: [],
    parameterTypes: paramTypes,
    returnType: returnType ?? undefined,
    throwsTypes: [],
    byteOffset: node.startIndex,
    byteLength: node.endIndex - node.startIndex,
    contentHash: hashContent(snippet),
  }
}
