/**
 * MCP tool definitions — schema only.
 * Each tool has a name, description, and JSON Schema for inputSchema.
 */

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'list_projects',
    description:
      'List all indexed projects in the current workspace. Returns project names, architectures, symbol counts, and indexing timestamps.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_project_outline',
    description:
      'Get a high-level overview of a project: packages, symbol counts by kind, architecture. Use this FIRST to understand the project structure before diving into specifics.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID (from list_projects). If omitted, uses the default project.',
        },
      },
    },
  },
  {
    name: 'get_file_outline',
    description:
      'List all symbols (classes, methods, fields) in a source file. Returns signatures only — use get_symbol to read implementation.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the source file (e.g., "src/main/java/com/app/OrderService.java")',
        },
        projectId: {
          type: 'string',
          description: 'Project ID. If omitted, uses the default project.',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'search_symbols',
    description:
      'Search for symbols by name, description, or role. Uses full-text search (BM25). Returns ranked results with signatures — much cheaper than reading source files. Supports filtering by kind (class/method/interface), Spring role, hex role, and file pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query or symbol name (e.g., "order creation handler", "CreateOrderHandler", "com.app.order")',
        },
        projectId: {
          type: 'string',
          description: 'Project ID. If omitted, uses the default project.',
        },
        kind: {
          type: 'string',
          enum: ['class', 'interface', 'method', 'field', 'constant', 'constructor', 'enum', 'annotation_type'],
          description: 'Filter by symbol kind',
        },
        springRole: {
          type: 'string',
          enum: ['REST_CONTROLLER', 'CONTROLLER', 'SERVICE', 'REPOSITORY', 'COMPONENT', 'CONFIGURATION', 'ENTITY', 'EVENT_HANDLER', 'SCHEDULED'],
          description: 'Filter by Spring Framework role',
        },
        hexRole: {
          type: 'string',
          enum: ['INBOUND_PORT', 'OUTBOUND_PORT', 'USE_CASE_HANDLER', 'ADAPTER', 'DOMAIN_ENTITY', 'DOMAIN_VALUE_OBJECT', 'DOMAIN_EVENT', 'DOMAIN_COMMAND'],
          description: 'Filter by hexagonal architecture role',
        },
        filePattern: {
          type: 'string',
          description: 'Filter by file path pattern (e.g., "order" matches files containing "order")',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_symbol',
    description:
      'Get a single symbol\'s full source code by reading the file at the stored byte offset. Verifies content hash — warns if source changed since indexing. Much cheaper than reading the entire file.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolId: {
          type: 'string',
          description: 'Symbol ID (from search_symbols or get_file_outline)',
        },
      },
      required: ['symbolId'],
    },
  },
  {
    name: 'get_symbols',
    description:
      'Batch version of get_symbol. Get source code for multiple symbols at once. Use after search_symbols to retrieve implementations.',
    inputSchema: {
      type: 'object',
      properties: {
        symbolIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of symbol IDs',
        },
      },
      required: ['symbolIds'],
    },
  },
  {
    name: 'search_schema',
    description:
      'Search database schema (tables, columns) extracted from SQL migration files. Use when investigating data models or persistence.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "orders table", "user_id column")',
        },
        projectId: {
          type: 'string',
          description: 'Project ID. If omitted, uses the default project.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_context_for_task',
    description:
      'Get a compact context block for a coding task. Searches symbols + schema + config, assembles relevant context within a token budget. Use this when starting a new task to get oriented quickly.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Natural language description of the task (e.g., "add validation to order creation")',
        },
        tokenBudget: {
          type: 'number',
          description: 'Maximum tokens in the response (default: 2000)',
        },
        projectId: {
          type: 'string',
          description: 'Project ID. If omitted, uses the default project.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'index_folder',
    description:
      'Force a full re-index of the project. Normally not needed — Condex auto-indexes on startup and incrementally on every query. Use only if you suspect the index is stale.',
    inputSchema: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Force full re-index (default: incremental)',
        },
      },
    },
  },
  {
    name: 'invalidate_cache',
    description:
      'Delete the index for a project. Next query will trigger a full re-index.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project ID. If omitted, invalidates the default project.',
        },
      },
    },
  },
]
