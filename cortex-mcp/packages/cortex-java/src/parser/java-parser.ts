import crypto from 'node:crypto'
import Parser from 'tree-sitter'
// @ts-ignore — tree-sitter-java has no type declarations
import Java from 'tree-sitter-java'
import type { Symbol, SymbolKind, SymbolRef, RefType } from '@cortex-ai/core'
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

export interface ParseResult {
  symbols: Symbol[]
  refs: SymbolRef[]
}

/**
 * Parse a Java source file and extract symbols.
 * Also returns symbols for backward-compat (refs ignored if not needed).
 */
export function parseJavaFile(content: string, opts: ParseOptions): Symbol[] {
  return parseJavaFileWithRefs(content, opts).symbols
}

/**
 * Parse a Java source file and extract symbols + call graph references.
 */
export function parseJavaFileWithRefs(content: string, opts: ParseOptions): ParseResult {
  const p = getParser()

  let tree: Parser.Tree
  try {
    tree = p.parse(content)
  } catch {
    console.error(`[cortex-java] Failed to parse: ${opts.filePath}`)
    return { symbols: [], refs: [] }
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

  // Extract call graph references
  const refs = extractFileRefs(tree.rootNode, packageName, opts)

  return { symbols, refs }
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

// ── Call Graph Extraction ─────────────────────────────────────

/**
 * Extract cross-symbol references from a Java file:
 * - Field dependencies (injected types)
 * - Method invocations (what each method calls)
 * - Object creation (new Foo())
 * - implements / extends relationships
 */
function extractFileRefs(
  root: Parser.SyntaxNode,
  packageName: string,
  opts: ParseOptions
): SymbolRef[] {
  const refs: SymbolRef[] = []

  // Build import map: SimpleName → qualified name
  const importMap = buildImportMap(root)

  // Build field type map: fieldName → TypeName
  const fieldTypeMap = new Map<string, string>()

  // Walk all class declarations
  const classes = findAllNodes(root, [
    'class_declaration', 'interface_declaration', 'enum_declaration',
  ])

  for (const classNode of classes) {
    const classNameNode = classNode.childForFieldName('name')
    if (!classNameNode) continue
    const className = classNameNode.text
    const classQualified = packageName ? `${packageName}.${className}` : className

    // Extract field types for this class
    const body = classNode.childForFieldName('body')
    if (!body) continue

    const localFieldTypeMap = new Map<string, string>()
    for (const child of body.namedChildren) {
      if (child.type === 'field_declaration') {
        const typeNode = child.descendantsOfType('type_identifier')[0] ??
                         child.descendantsOfType('generic_type')[0]
        const declarators = child.descendantsOfType('variable_declarator')
        if (typeNode) {
          // Extract the base type name (strip generics)
          const typeName = typeNode.type === 'generic_type'
            ? (typeNode.descendantsOfType('type_identifier')[0]?.text ?? typeNode.text)
            : typeNode.text
          for (const decl of declarators) {
            const nameNode = decl.childForFieldName('name')
            if (nameNode) {
              localFieldTypeMap.set(nameNode.text, typeName)
              // Also add as field_dep ref
              const resolvedType = importMap.get(typeName) ?? (packageName ? `${packageName}.${typeName}` : typeName)
              refs.push({
                sourceSymbolId: buildSymbolId(opts.projectId, opts.filePath, classQualified, 'class'),
                targetQualifiedName: resolvedType,
                refType: 'field_dep',
                projectId: opts.projectId,
                sourceFile: opts.filePath,
              })
            }
          }
        }
      }
    }

    // Extract implements/extends
    const interfaces = extractInterfaces(classNode)
    for (const iface of interfaces) {
      const resolved = importMap.get(iface) ?? (packageName ? `${packageName}.${iface}` : iface)
      refs.push({
        sourceSymbolId: buildSymbolId(opts.projectId, opts.filePath, classQualified, 'class'),
        targetQualifiedName: resolved,
        refType: 'implements',
        projectId: opts.projectId,
        sourceFile: opts.filePath,
      })
    }
    const superclass = extractSuperclass(classNode)
    if (superclass) {
      const resolved = importMap.get(superclass) ?? (packageName ? `${packageName}.${superclass}` : superclass)
      refs.push({
        sourceSymbolId: buildSymbolId(opts.projectId, opts.filePath, classQualified, 'class'),
        targetQualifiedName: resolved,
        refType: 'extends',
        projectId: opts.projectId,
        sourceFile: opts.filePath,
      })
    }

    // Walk methods for invocations
    const methods = findAllNodes(body, ['method_declaration', 'constructor_declaration'])
    for (const methodNode of methods) {
      const isConstructor = methodNode.type === 'constructor_declaration'
      const methodNameNode = methodNode.childForFieldName('name')
      const methodSimpleName = isConstructor
        ? className
        : methodNameNode?.text
      if (!methodSimpleName) continue

      const params = extractParameterTypes(methodNode)
      const methodQualified = packageName
        ? `${packageName}.${className}.${methodSimpleName}(${params.join(',')})`
        : `${className}.${methodSimpleName}(${params.join(',')})`
      const methodKind: SymbolKind = isConstructor ? 'constructor' : 'method'
      const sourceId = buildSymbolId(opts.projectId, opts.filePath, methodQualified, methodKind)

      // Find method invocations
      const invocations = findAllNodes(methodNode, ['method_invocation'])
      for (const inv of invocations) {
        const object = inv.childForFieldName('object')
        const name = inv.childForFieldName('name')
        if (!name) continue

        // Resolve object to type
        let targetType: string | undefined
        if (object) {
          const objText = object.text
          // Check if it's a field reference: fieldName.method()
          const fieldType = localFieldTypeMap.get(objText)
          if (fieldType) {
            targetType = importMap.get(fieldType) ?? (packageName ? `${packageName}.${fieldType}` : fieldType)
          }
          // Or a direct class reference: ClassName.method()
          else if (objText[0] && objText[0] === objText[0].toUpperCase()) {
            targetType = importMap.get(objText) ?? (packageName ? `${packageName}.${objText}` : objText)
          }
        }

        if (targetType) {
          refs.push({
            sourceSymbolId: sourceId,
            targetQualifiedName: `${targetType}.${name.text}`,
            refType: 'calls',
            projectId: opts.projectId,
            sourceFile: opts.filePath,
          })
        }
      }

      // Find object creation expressions: new Foo()
      const creations = findAllNodes(methodNode, ['object_creation_expression'])
      for (const creation of creations) {
        const typeNode = creation.descendantsOfType('type_identifier')[0]
        if (typeNode) {
          const resolved = importMap.get(typeNode.text) ?? (packageName ? `${packageName}.${typeNode.text}` : typeNode.text)
          refs.push({
            sourceSymbolId: sourceId,
            targetQualifiedName: resolved,
            refType: 'creates',
            projectId: opts.projectId,
            sourceFile: opts.filePath,
          })
        }
      }
    }
  }

  return refs
}

function buildImportMap(root: Parser.SyntaxNode): Map<string, string> {
  const importMap = new Map<string, string>()
  for (const child of root.namedChildren) {
    if (child.type === 'import_declaration') {
      const pathNode = child.namedChildren.find(
        c => c.type === 'scoped_identifier' || c.type === 'identifier'
      )
      if (pathNode) {
        const fullPath = pathNode.text
        const simpleName = fullPath.split('.').pop()
        if (simpleName) {
          importMap.set(simpleName, fullPath)
        }
      }
    }
  }
  return importMap
}

function findAllNodes(
  node: Parser.SyntaxNode,
  types: string[],
  results: Parser.SyntaxNode[] = []
): Parser.SyntaxNode[] {
  if (types.includes(node.type)) results.push(node)
  for (const child of node.namedChildren) {
    findAllNodes(child, types, results)
  }
  return results
}
