import type { LangConfig } from './types.js'

/**
 * Find the first matching node in tree-sitter AST.
 */
function findFirst(node: any, type: string): any | null {
  if (node.type === type) return node
  for (const child of node.namedChildren ?? []) {
    const found = findFirst(child, type)
    if (found) return found
  }
  return null
}

// ── Language Configurations ─────────────────────────────────

const python: LangConfig = {
  id: 'python',
  extensions: ['py'],
  grammar: 'tree-sitter-python',
  classNodes: ['class_definition'],
  functionNodes: ['function_definition'],
  typeNodes: [],
  wrapperNodes: ['decorated_definition'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  docStyle: 'first_body_string',
  commentTypes: ['comment'],
  packageExtractor: () => '', // Python uses module paths, not package declarations
}

const javascript: LangConfig = {
  id: 'javascript',
  extensions: ['js', 'jsx', 'mjs', 'cjs'],
  grammar: 'tree-sitter-javascript',
  classNodes: ['class_declaration', 'class'],
  functionNodes: ['function_declaration', 'method_definition', 'arrow_function', 'generator_function_declaration'],
  interfaceNodes: [],
  typeNodes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  docStyle: 'jsdoc',
  commentTypes: ['comment'],
}

const typescript: LangConfig = {
  id: 'typescript',
  extensions: ['ts', 'mts', 'cts'],
  grammar: 'tree-sitter-typescript',
  grammarExport: 'typescript',
  classNodes: ['class_declaration', 'class'],
  functionNodes: ['function_declaration', 'method_definition', 'arrow_function'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: ['type_alias_declaration', 'enum_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  docStyle: 'jsdoc',
  commentTypes: ['comment'],
}

const tsx: LangConfig = {
  id: 'tsx',
  extensions: ['tsx'],
  grammar: 'tree-sitter-typescript',
  grammarExport: 'tsx',
  classNodes: ['class_declaration', 'class'],
  functionNodes: ['function_declaration', 'method_definition', 'arrow_function'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: ['type_alias_declaration', 'enum_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  docStyle: 'jsdoc',
  commentTypes: ['comment'],
}

const go: LangConfig = {
  id: 'go',
  extensions: ['go'],
  grammar: 'tree-sitter-go',
  classNodes: [], // Go has no classes
  functionNodes: ['function_declaration', 'method_declaration'],
  interfaceNodes: [],
  typeNodes: ['type_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  receiverField: 'receiver',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
  packageExtractor: (root: any) => {
    const pkg = findFirst(root, 'package_clause')
    return pkg?.namedChildren?.[0]?.text ?? ''
  },
}

const rust: LangConfig = {
  id: 'rust',
  extensions: ['rs'],
  grammar: 'tree-sitter-rust',
  classNodes: ['impl_item'],
  functionNodes: ['function_item'],
  interfaceNodes: ['trait_item'],
  typeNodes: ['struct_item', 'enum_item', 'type_item'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  docStyle: 'triple_slash',
  commentTypes: ['line_comment', 'block_comment'],
}

const c: LangConfig = {
  id: 'c',
  extensions: ['c', 'h'],
  grammar: 'tree-sitter-c',
  classNodes: [],
  functionNodes: ['function_definition'],
  typeNodes: ['struct_specifier', 'enum_specifier', 'type_definition'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const cpp: LangConfig = {
  id: 'cpp',
  extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh'],
  grammar: 'tree-sitter-cpp',
  classNodes: ['class_specifier', 'namespace_definition'],
  functionNodes: ['function_definition'],
  interfaceNodes: [],
  typeNodes: ['struct_specifier', 'enum_specifier', 'type_definition'],
  nameField: 'declarator',
  bodyField: 'body',
  paramsField: 'parameters',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const ruby: LangConfig = {
  id: 'ruby',
  extensions: ['rb', 'rake', 'gemspec'],
  grammar: 'tree-sitter-ruby',
  classNodes: ['class', 'module'],
  functionNodes: ['method', 'singleton_method'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  docStyle: 'hash_comment',
  commentTypes: ['comment'],
}

const csharp: LangConfig = {
  id: 'csharp',
  extensions: ['cs'],
  grammar: 'tree-sitter-c-sharp',
  classNodes: ['class_declaration', 'namespace_declaration'],
  functionNodes: ['method_declaration', 'constructor_declaration'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: ['struct_declaration', 'enum_declaration', 'record_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  docStyle: 'triple_slash',
  commentTypes: ['comment'],
}

const bash: LangConfig = {
  id: 'bash',
  extensions: ['sh', 'bash', 'zsh'],
  grammar: 'tree-sitter-bash',
  classNodes: [],
  functionNodes: ['function_definition'],
  nameField: 'name',
  bodyField: 'body',
  docStyle: 'hash_comment',
  commentTypes: ['comment'],
}

const kotlin: LangConfig = {
  id: 'kotlin',
  extensions: ['kt', 'kts'],
  grammar: 'tree-sitter-kotlin',
  classNodes: ['class_declaration', 'object_declaration'],
  functionNodes: ['function_declaration'],
  interfaceNodes: ['class_declaration'], // Kotlin interfaces use class_declaration with 'interface' keyword
  typeNodes: ['type_alias'],
  nameField: 'simple_identifier',
  bodyField: 'class_body',
  paramsField: 'function_value_parameters',
  returnField: 'user_type',
  docStyle: 'preceding_comment',
  commentTypes: ['multiline_comment', 'line_comment'],
  packageExtractor: (root: any) => {
    const pkg = findFirst(root, 'package_header')
    const ident = pkg ? findFirst(pkg, 'identifier') : null
    return ident?.text ?? ''
  },
}

const swift: LangConfig = {
  id: 'swift',
  extensions: ['swift'],
  grammar: 'tree-sitter-swift',
  classNodes: ['class_declaration'],
  functionNodes: ['function_declaration'],
  interfaceNodes: ['protocol_declaration'],
  typeNodes: ['struct_declaration', 'enum_declaration'],
  nameField: 'name',
  bodyField: 'body',
  docStyle: 'preceding_comment',
  commentTypes: ['comment', 'multiline_comment'],
}

const php: LangConfig = {
  id: 'php',
  extensions: ['php'],
  grammar: 'tree-sitter-php',
  classNodes: ['class_declaration'],
  functionNodes: ['function_definition', 'method_declaration'],
  interfaceNodes: ['interface_declaration'],
  typeNodes: ['trait_declaration', 'enum_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'formal_parameters',
  returnField: 'return_type',
  docStyle: 'jsdoc',
  commentTypes: ['comment'],
  packageExtractor: (root: any) => {
    const ns = findFirst(root, 'namespace_definition')
    return ns?.childForFieldName?.('name')?.text ?? ''
  },
}

const scala: LangConfig = {
  id: 'scala',
  extensions: ['scala', 'sc'],
  grammar: 'tree-sitter-scala',
  classNodes: ['class_definition', 'object_definition'],
  functionNodes: ['function_definition'],
  interfaceNodes: ['trait_definition'],
  typeNodes: ['type_definition'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  docStyle: 'preceding_comment',
  commentTypes: ['comment', 'block_comment'],
  packageExtractor: (root: any) => {
    const pkg = findFirst(root, 'package_clause')
    return pkg?.namedChildren?.slice(1)?.map((n: any) => n.text)?.join('.') ?? ''
  },
}

const lua: LangConfig = {
  id: 'lua',
  extensions: ['lua'],
  grammar: 'tree-sitter-lua',
  classNodes: [],
  functionNodes: ['function_declaration', 'local_function'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const haskell: LangConfig = {
  id: 'haskell',
  extensions: ['hs', 'lhs'],
  grammar: 'tree-sitter-haskell',
  classNodes: ['class', 'instance'],
  functionNodes: ['function', 'bind'],
  typeNodes: ['type', 'newtype', 'data'],
  nameField: 'name',
  bodyField: 'match',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const elixir: LangConfig = {
  id: 'elixir',
  extensions: ['ex', 'exs'],
  grammar: 'tree-sitter-elixir',
  classNodes: [],
  functionNodes: ['call'], // defmodule, def, defp are all 'call' nodes
  moduleNodes: ['call'],
  nameField: 'target',
  bodyField: 'body',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const r: LangConfig = {
  id: 'r',
  extensions: ['r', 'R'],
  grammar: 'tree-sitter-r',
  classNodes: [],
  functionNodes: ['binary_operator'], // R functions are assignments: foo <- function()
  nameField: 'lhs',
  bodyField: 'body',
  docStyle: 'hash_comment',
  commentTypes: ['comment'],
}

const ocaml: LangConfig = {
  id: 'ocaml',
  extensions: ['ml', 'mli'],
  grammar: 'tree-sitter-ocaml',
  grammarExport: 'ocaml',
  classNodes: ['class_definition'],
  functionNodes: ['let_binding'],
  typeNodes: ['type_definition'],
  moduleNodes: ['module_definition'],
  nameField: 'name',
  bodyField: 'body',
  docStyle: 'preceding_comment',
  commentTypes: ['comment'],
}

const zig: LangConfig = {
  id: 'zig',
  extensions: ['zig'],
  grammar: 'tree-sitter-zig',
  classNodes: [],
  functionNodes: ['FnProto'],
  typeNodes: ['ContainerDecl'],
  nameField: 'name',
  bodyField: 'body',
  docStyle: 'preceding_comment',
  commentTypes: ['doc_comment', 'line_comment'],
}

// ── Registry ────────────────────────────────────────────────

/** All language configs, keyed by language ID */
export const LANGUAGE_REGISTRY: Record<string, LangConfig> = {
  python, javascript, typescript, tsx, go, rust, c, cpp, ruby, csharp,
  bash, kotlin, swift, php, scala, lua, haskell, elixir, r, ocaml, zig,
}

/** Map file extensions to language IDs */
export const EXTENSION_MAP: Record<string, string> = {}
for (const [id, config] of Object.entries(LANGUAGE_REGISTRY)) {
  for (const ext of config.extensions) {
    EXTENSION_MAP[ext] = id
  }
}
