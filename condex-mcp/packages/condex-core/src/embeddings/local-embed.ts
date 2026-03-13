/**
 * Local embedding using @huggingface/transformers v3.
 * Model: nomic-ai/nomic-embed-text-v1.5 (384 dimensions, ONNX, CPU)
 * 100% local — no external API calls.
 */

let embedderInstance: Embedder | null = null

export interface Embedder {
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
  readonly dimensions: number
}

/**
 * Prepare symbol text for embedding.
 * Concatenates signature + javadoc + annotations for rich semantic representation.
 */
export function prepareSymbolText(symbol: {
  qualifiedName: string
  signature: string
  javadoc?: string | null
  annotations?: string[]
  kind?: string
}): string {
  const parts: string[] = []
  if (symbol.kind) parts.push(symbol.kind)
  parts.push(symbol.qualifiedName)
  parts.push(symbol.signature)
  if (symbol.javadoc) parts.push(symbol.javadoc)
  if (symbol.annotations?.length) parts.push(symbol.annotations.join(' '))
  return parts.join(' ').slice(0, 512) // nomic supports 8192 but shorter is faster
}

/**
 * Get or create singleton embedder. Lazy-loads the model on first call.
 * @throws Error if @huggingface/transformers is not installed
 */
export async function getEmbedder(): Promise<Embedder> {
  if (embedderInstance) return embedderInstance

  // Dynamic import — only loaded when vector search is enabled
  const { pipeline, env } = await import('@huggingface/transformers')

  // Use local cache, no remote loading indicator
  env.cacheDir = getCacheDir()

  const extractor = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', {
    dtype: 'q8' as any,         // quantized for speed
    device: 'cpu' as any,
  })

  embedderInstance = {
    dimensions: 768,

    async embed(text: string): Promise<Float32Array> {
      const output = await extractor(text, { pooling: 'mean', normalize: true })
      return new Float32Array(output.data as Float64Array)
    },

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
      const results: Float32Array[] = []
      // Process in small batches to avoid OOM
      const batchSize = 8
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize)
        for (const text of batch) {
          const output = await extractor(text, { pooling: 'mean', normalize: true })
          results.push(new Float32Array(output.data as Float64Array))
        }
      }
      return results
    }
  }

  return embedderInstance
}

export function getCacheDir(): string {
  // Allow explicit override via env var
  if (process.env.CONDEX_MODEL_CACHE_DIR) {
    return process.env.CONDEX_MODEL_CACHE_DIR
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'

  // Use platform-appropriate cache directory
  if (process.platform === 'darwin') {
    return `${home}/Library/Caches/condex/models`
  }

  // Linux: follow XDG_CACHE_HOME convention
  const xdgCache = process.env.XDG_CACHE_HOME ?? `${home}/.cache`
  return `${xdgCache}/condex/models`
}

/**
 * Ensure the model is downloaded to the cache directory.
 * Call this at startup to pre-download before the embedder is needed.
 * Returns the cache directory path used.
 */
export async function ensureModelDownloaded(): Promise<string> {
  const cacheDir = getCacheDir()
  const { env } = await import('@huggingface/transformers')
  env.cacheDir = cacheDir
  // Calling getEmbedder triggers the download if not cached
  await getEmbedder()
  return cacheDir
}

/** Reset embedder (for testing) */
export function resetEmbedder(): void {
  embedderInstance = null
}
