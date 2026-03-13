/**
 * Local embedding using @huggingface/transformers v3.
 * Model: nomic-ai/nomic-embed-text-v1.5 (768 dimensions, ONNX, CPU)
 * 100% local — no external API calls.
 *
 * The model is bundled in the repo at packages/condex-core/models/ (ONNX gzipped).
 * On first use, it's decompressed to /tmp/condex/models/ for fast loading.
 */

import path from 'node:path'
import fs from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

let embedderInstance: Embedder | null = null

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
 * Get the path to the bundled model directory inside the repo.
 * Works from both src/ (dev) and dist/ (built).
 */
function getBundledModelDir(): string {
  // From src/embeddings/local-embed.ts → ../../models
  // From dist/embeddings/local-embed.js → ../../models
  return path.resolve(__dirname, '..', '..', 'models')
}

/**
 * Ensure the bundled model is extracted to the cache directory.
 * Copies JSON files directly and decompresses the .onnx.gz file.
 */
async function extractBundledModel(cacheDir: string): Promise<void> {
  const bundledDir = getBundledModelDir()
  const modelSubdir = 'nomic-ai/nomic-embed-text-v1.5'
  const bundledModelDir = path.join(bundledDir, modelSubdir)
  const targetModelDir = path.join(cacheDir, modelSubdir)
  const targetOnnxDir = path.join(targetModelDir, 'onnx')

  // Check if already extracted
  const onnxPath = path.join(targetOnnxDir, 'model_quantized.onnx')
  if (fs.existsSync(onnxPath)) {
    return // Already extracted
  }

  // Check bundled model exists
  const gzPath = path.join(bundledModelDir, 'onnx', 'model_quantized.onnx.gz')
  if (!fs.existsSync(gzPath)) {
    console.error(`[condex] Bundled model not found at ${gzPath}`)
    console.error(`[condex] Will attempt to download from HuggingFace instead`)
    return
  }

  console.error(`[condex] Extracting bundled model to ${targetModelDir}...`)

  // Create target directories
  fs.mkdirSync(targetOnnxDir, { recursive: true })

  // Copy JSON files
  for (const jsonFile of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
    const src = path.join(bundledModelDir, jsonFile)
    const dst = path.join(targetModelDir, jsonFile)
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst)
    }
  }

  // Decompress ONNX model
  console.error(`[condex] Decompressing ONNX model (~145MB)...`)
  const startMs = Date.now()
  await streamPipeline(
    fs.createReadStream(gzPath),
    createGunzip(),
    fs.createWriteStream(onnxPath)
  )
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
  console.error(`[condex] Model extracted in ${elapsed}s`)
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

  // Default: /tmp/condex/models/ — universally writable, no permission issues.
  // Works across macOS/Linux without needing project-root write access.
  return path.join('/tmp', 'condex', 'models')
}

/**
 * Ensure the model is available in the cache directory.
 * First tries to extract from bundled repo copy (no network needed).
 * Falls back to downloading from HuggingFace if bundled model not found.
 */
export async function ensureModelDownloaded(): Promise<string> {
  const cacheDir = getCacheDir()

  // Try extracting bundled model first (works offline)
  await extractBundledModel(cacheDir)

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
