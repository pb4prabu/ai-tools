import type { HandlerContext } from './handlers.js'
import {
  handleListProjects,
  handleGetProjectOutline,
  handleGetFileOutline,
  handleSearchSymbols,
  handleGetSymbol,
  handleGetSymbols,
  handleSearchSchema,
  handleGetContextForTask,
  handleInvalidateCache,
} from './handlers.js'

export interface DispatchResult {
  content: { type: 'text'; text: string }[]
  _meta?: Record<string, unknown>
}

/**
 * Dispatch a tool call to the appropriate handler.
 */
export async function dispatch(
  toolName: string,
  args: Record<string, unknown>,
  ctx: HandlerContext
): Promise<DispatchResult> {
  switch (toolName) {
    case 'list_projects':
      return handleListProjects(ctx)

    case 'get_project_outline':
      return handleGetProjectOutline(ctx, args as any)

    case 'get_file_outline':
      return handleGetFileOutline(ctx, args as any)

    case 'search_symbols':
      return handleSearchSymbols(ctx, args as any)

    case 'get_symbol':
      return handleGetSymbol(ctx, args as any)

    case 'get_symbols':
      return handleGetSymbols(ctx, args as any)

    case 'search_schema':
      return handleSearchSchema(ctx, args as any)

    case 'get_context_for_task':
      return handleGetContextForTask(ctx, args as any)

    case 'index_folder':
      // Handled directly by server.ts with full parser context.
      // This fallback only fires if server.ts doesn't intercept (no Java parser).
      return {
        content: [{ type: 'text', text: JSON.stringify({
          status: 'unavailable',
          message: 'No parser available. Install @condex-ai/java or @condex-ai/multi-lang to enable indexing.',
        }, null, 2) }],
      }

    case 'invalidate_cache':
      return handleInvalidateCache(ctx, args as any)

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      }
  }
}
