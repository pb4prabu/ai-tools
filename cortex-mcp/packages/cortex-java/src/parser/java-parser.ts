import crypto from 'node:crypto'
import Parser from 'tree-sitter'
// @ts-ignore — tree-sitter-java has no type declarations
import Java from 'tree-sitter-java'
import type { Symbol, SymbolKind } from '@cortex-ai/core'
import { buildSymbolId } from '@cortex-ai/core'
import { assignSpringRole } from './spring-tagger.js'
import { assignHexRole } from './hex-role-tagger.js'
import type { ProjectProfile } from './arch-detector.js'

let parser: Parser | null = null

function getParser(): Parser {
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(Java as any)
  }
  return parser
}

export interface ParseOptions {
  projectId: string
  filePath: string
  profile?: ProjectProfile
}

/**
 * Parse a Java source file and extract symbols.
 */
export function parseJavaFile(content: string, opts: ParseOptions): Symbol[] {
  const p = getParser()

  let tree: Parser.Tree
  try {
    tree = p.parse(content)
  } catch {
    console.error(`[cortex-java] Failed to parse: ${opts.filePath}`)
    return []
  }

  const symbols: Symbol[] = []
  const packageName = extractPackageName(tree.rootNode)

  // Walk top-level declarations
  for (const node of tree.rootNode.namedChildren) {
    try {
      extractSymbols(node, content, opts, packageName, null, symbols)
    } catch (err: any) {
      console.error(`[cortex-java] Error extracting from ${opts.filePath}: ${err.message}`)
    }
  }

  return symbols
}

function extractPackageName(root: Parser.SyntaxNode): string {
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration') {
      const nameNode = child.childForFieldName('name') ?? child.namedChildren.find(c => c.type === 'scoped_identifier' || c.type === 'identifier')
      return nameNode?.text ?? ''
    }
  }
  return ''
}

function extractSymbols(
  node: Parser.SyntaxNode,
  content: string,
  opts: ParseOptions,
  packageName: string,
  enclosingClass: string | null,
  symbols: Symbol[]
): void {
  const type = node.type

  if (type === 'class_declaration' || type === 'interface_declaration' || type === 'enum_declaration' || type === 'annotation_type_declaration') {
    extractClassLike(node, content, opts, packageName, enclosingClass, symbols)
  } else if (type === 'method_declaration' || type === 'constructor_declaration') {
    if (enclosingClass) {
      extractMethod(node, content, opts, packageName, enclosingClass, symbols)
    }
  } else if (type === 'field_declaration') {
    if (enclosingClass) {
      extractField(node, content, opts, packageName, enclosingClass, symbols)
    }
  }
}

function extractClassLike(
  node: Parser.SyntaxNode,
  content: string,
  opts: ParseOptions,
  packageName: string,
  enclosingClass: string | null,
  symbols: Symbol[]
): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return

  const simpleName = nameNode.text
  const className = enclosingClass ? `${enclosingClass}.${simpleName}` : simpleName
  const qualifiedName = packageName ? `${packageName}.${className}` : className

  const kind = nodeTypeToKind(node.type)
  const annotations = extractAnnotations(node)
  const javadoc = extractJavadoc(node, content)
  const signature = buildSignature(node, content)
  const interfaces = extractInterfaces(node)
  const extendsClass = extractSuperclass(node)

  const byteOffset = node.startIndex
  const byteLength = node.endIndex - node.startIndex
  const snippet = content.slice(byteOffset, byteOffset + byteLength)
  const contentHash = crypto.createHash('sha256').update(snippet).digest('hex').slice(0, 12)

  const springRole = assignSpringRole(annotations)
  const hexRole = opts.profile ? assignHexRole(qualifiedName, opts.filePath, opts.profile) : 'NONE'

  const symbol: Symbol = {
    id: buildSymbolId(opts.projectId, opts.filePath, qualifiedName, kind),
    projectId: opts.projectId,
    filePath: opts.filePath,
    qualifiedName,
    simpleName,
    className,
    packageName,
    kind,
    signature,
    javadoc: javadoc || undefined,
    annotations,
    springRole: springRole as any,
    hexRole: hexRole as any,
    implementedInterfaces: interfaces,
    extendsClass: extendsClass || undefined,
    parameterTypes: [],
    throwsTypes: [],
    byteOffset,
    byteLength,
    contentHash,
  }

  symbols.push(symbol)

  // Recurse into class body for methods, fields, inner classes
  const body = node.childForFieldName('body')
  if (body) {
    for (const child of body.namedChildren) {
      extractSymbols(child, content, opts, packageName, className, symbols)
    }
  }
}

function extractMethod(
  node: Parser.SyntaxNode,
  content: string,
  opts: ParseOptions,
  packageName: string,
  enclosingClass: string,
  symbols: Symbol[]
): void {
  const isConstructor = node.type === 'constructor_declaration'
  const nameNode = node.childForFieldName('name')
  if (!nameNode && !isConstructor) return

  const simpleName = isConstructor
    ? enclosingClass.split('.').pop()!
    : nameNode!.text

  const params = extractParameterTypes(node)
  const paramSuffix = `(${params.join(',')})`
  const qualifiedName = packageName
    ? `${packageName}.${enclosingClass}.${simpleName}${paramSuffix}`
    : `${enclosingClass}.${simpleName}${paramSuffix}`

  const kind: SymbolKind = isConstructor ? 'constructor' : 'method'
  const annotations = extractAnnotations(node)
  const javadoc = extractJavadoc(node, content)
  const signature = buildSignature(node, content)
  const returnType = extractReturnType(node)
  const throwsTypes = extractThrowsTypes(node)

  const byteOffset = node.startIndex
  const byteLength = node.endIndex - node.startIndex
  const snippet = content.slice(byteOffset, byteOffset + byteLength)
  const contentHash = crypto.createHash('sha256').update(snippet).digest('hex').slice(0, 12)

  symbols.push({
    id: buildSymbolId(opts.projectId, opts.filePath, qualifiedName, kind),
    projectId: opts.projectId,
    filePath: opts.filePath,
    qualifiedName,
    simpleName,
    className: enclosingClass,
    packageName,
    kind,
    signature,
    javadoc: javadoc || undefined,
    annotations,
    springRole: assignSpringRole(annotations) as any,
    hexRole: (opts.profile ? assignHexRole(qualifiedName, opts.filePath, opts.profile) : 'NONE') as any,
    implementedInterfaces: [],
    parameterTypes: params,
    returnType: returnType || undefined,
    throwsTypes,
    byteOffset,
    byteLength,
    contentHash,
  })
}

function extractField(
  node: Parser.SyntaxNode,
  content: string,
  opts: ParseOptions,
  packageName: string,
  enclosingClass: string,
  symbols: Symbol[]
): void {
  const declarators = node.namedChildren.filter(c => c.type === 'variable_declarator')
  for (const decl of declarators) {
    const nameNode = decl.childForFieldName('name')
    if (!nameNode) continue

    const simpleName = nameNode.text
    const qualifiedName = packageName
      ? `${packageName}.${enclosingClass}.${simpleName}`
      : `${enclosingClass}.${simpleName}`

    // Check if it's a constant (static final)
    const modifiers = node.namedChildren.find(c => c.type === 'modifiers')
    const modText = modifiers?.text ?? ''
    const isConstant = modText.includes('static') && modText.includes('final')
    const kind: SymbolKind = isConstant ? 'constant' : 'field'

    const annotations = extractAnnotations(node)
    const signature = buildSignature(node, content)

    const byteOffset = node.startIndex
    const byteLength = node.endIndex - node.startIndex
    const snippet = content.slice(byteOffset, byteOffset + byteLength)
    const contentHash = crypto.createHash('sha256').update(snippet).digest('hex').slice(0, 12)

    symbols.push({
      id: buildSymbolId(opts.projectId, opts.filePath, qualifiedName, kind),
      projectId: opts.projectId,
      filePath: opts.filePath,
      qualifiedName,
      simpleName,
      className: enclosingClass,
      packageName,
      kind,
      signature,
      annotations,
      springRole: 'NONE' as any,
      hexRole: 'NONE' as any,
      implementedInterfaces: [],
      parameterTypes: [],
      throwsTypes: [],
      byteOffset,
      byteLength,
      contentHash,
    })
  }
}

// ── Helpers ─────────────────────────────────────────────────

function nodeTypeToKind(type: string): SymbolKind {
  switch (type) {
    case 'class_declaration': return 'class'
    case 'interface_declaration': return 'interface'
    case 'enum_declaration': return 'enum'
    case 'annotation_type_declaration': return 'annotation_type'
    default: return 'class'
  }
}

function extractAnnotations(node: Parser.SyntaxNode): string[] {
  const annotations: string[] = []
  // Annotations appear as siblings before the declaration or inside modifiers
  let prev = node.previousNamedSibling
  while (prev && (prev.type === 'marker_annotation' || prev.type === 'annotation')) {
    annotations.unshift(prev.text)
    prev = prev.previousNamedSibling
  }
  // Also check modifiers node
  const modifiers = node.namedChildren.find(c => c.type === 'modifiers')
  if (modifiers) {
    for (const child of modifiers.namedChildren) {
      if (child.type === 'marker_annotation' || child.type === 'annotation') {
        annotations.push(child.text)
      }
    }
  }
  return annotations
}

function extractJavadoc(node: Parser.SyntaxNode, content: string): string | null {
  // Look for block_comment starting with /** before the node
  let prev = node.previousSibling
  // Skip annotations
  while (prev && (prev.type === 'marker_annotation' || prev.type === 'annotation')) {
    prev = prev.previousSibling
  }
  if (prev && prev.type === 'block_comment') {
    const text = prev.text
    if (text.startsWith('/**')) {
      // Clean javadoc: remove /**, */, leading * on each line
      return text
        .replace(/^\/\*\*\s*/, '')
        .replace(/\s*\*\/\s*$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .join('\n')
        .trim()
    }
  }
  // Also look inside modifiers for comment nodes
  const modifiers = node.namedChildren.find(c => c.type === 'modifiers')
  if (modifiers) {
    let prevMod = modifiers.previousSibling
    if (prevMod && prevMod.type === 'block_comment' && prevMod.text.startsWith('/**')) {
      return prevMod.text
        .replace(/^\/\*\*\s*/, '')
        .replace(/\s*\*\/\s*$/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\*\s?/, ''))
        .join('\n')
        .trim()
    }
  }
  return null
}

function buildSignature(node: Parser.SyntaxNode, content: string): string {
  // For classes/interfaces: everything up to the opening brace
  const body = node.childForFieldName('body')
  if (body) {
    return content.slice(node.startIndex, body.startIndex).trim()
  }
  // For methods without body (abstract), or fields: up to semicolon or end
  const text = node.text
  const braceIdx = text.indexOf('{')
  if (braceIdx > 0) {
    return text.slice(0, braceIdx).trim()
  }
  return text.trim()
}

function extractParameterTypes(node: Parser.SyntaxNode): string[] {
  const params = node.childForFieldName('parameters')
  if (!params) return []

  const types: string[] = []
  for (const child of params.namedChildren) {
    if (child.type === 'formal_parameter' || child.type === 'spread_parameter') {
      const typeNode = child.childForFieldName('type')
      if (typeNode) types.push(typeNode.text)
    }
  }
  return types
}

function extractReturnType(node: Parser.SyntaxNode): string | null {
  const typeNode = node.childForFieldName('type')
  return typeNode?.text ?? null
}

function extractThrowsTypes(node: Parser.SyntaxNode): string[] {
  // Look for throws clause
  for (const child of node.namedChildren) {
    if (child.type === 'throws') {
      return child.namedChildren
        .filter(c => c.type === 'type_identifier' || c.type === 'scoped_type_identifier')
        .map(c => c.text)
    }
  }
  return []
}

function extractInterfaces(node: Parser.SyntaxNode): string[] {
  const interfaces = node.childForFieldName('interfaces')
  if (!interfaces) return []

  const result: string[] = []
  // super_interfaces contains type_list which contains the actual type identifiers
  function collectTypes(n: Parser.SyntaxNode) {
    if (n.type === 'type_identifier' || n.type === 'scoped_type_identifier' || n.type === 'generic_type') {
      result.push(n.text)
    } else {
      for (const child of n.namedChildren) {
        collectTypes(child)
      }
    }
  }
  collectTypes(interfaces)
  return result
}

function extractSuperclass(node: Parser.SyntaxNode): string | null {
  const superclass = node.childForFieldName('superclass')
  return superclass?.text ?? null
}
