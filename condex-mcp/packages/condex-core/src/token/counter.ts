import { encodingForModel } from 'js-tiktoken'

let encoding: ReturnType<typeof encodingForModel> | null = null

function getEncoding() {
  if (!encoding) {
    encoding = encodingForModel('gpt-4o')
  }
  return encoding
}

/**
 * Count tokens in a text string using cl100k_base tokenizer.
 * Uses js-tiktoken (pure JS, no WASM).
 */
export function countTokens(text: string): number {
  if (!text) return 0
  return getEncoding().encode(text).length
}

/**
 * Estimate tokens from byte size (rough: ~4 chars per token).
 * Used when we don't have the actual text.
 */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / 4)
}
