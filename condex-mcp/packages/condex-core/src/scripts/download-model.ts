#!/usr/bin/env node

/**
 * Pre-download the embedding model to the cache directory.
 *
 * Usage:
 *   npx tsx src/scripts/download-model.ts
 *   CONDEX_MODEL_CACHE_DIR=/custom/path npx tsx src/scripts/download-model.ts
 *
 * This avoids the ~100MB download during MCP server startup.
 */

import { getCacheDir, ensureModelDownloaded, resetEmbedder } from '../embeddings/local-embed.js'

async function main() {
  const cacheDir = getCacheDir()
  console.log(`[condex] Model cache directory: ${cacheDir}`)
  console.log(`[condex] Downloading embedding model (nomic-ai/nomic-embed-text-v1.5, ~100MB)...`)
  console.log(`[condex] This is a one-time download. Subsequent starts will use the cached model.`)
  console.log()

  const startMs = Date.now()
  const usedDir = await ensureModelDownloaded()
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)

  console.log()
  console.log(`[condex] Model downloaded successfully in ${elapsed}s`)
  console.log(`[condex] Cached at: ${usedDir}`)

  // Reset singleton so the process can exit cleanly
  resetEmbedder()
}

main().catch(err => {
  console.error(`[condex] FAILED to download model: ${err.message}`)
  console.error(err.stack)
  console.error()
  console.error(`[condex] Possible causes:`)
  console.error(`  1. Corporate proxy/firewall blocking huggingface.co`)
  console.error(`  2. No internet access`)
  console.error(`  3. Disk full or /tmp not writable`)
  console.error()
  console.error(`[condex] Workarounds:`)
  console.error(`  - Set HTTPS_PROXY=http://your-proxy:port and retry`)
  console.error(`  - Download on a machine with internet, then copy /tmp/condex/models/ to this machine`)
  console.error(`  - Set CONDEX_MODEL_CACHE_DIR to a writable path if /tmp is restricted`)
  process.exit(1)
})
