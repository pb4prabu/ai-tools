# local-embed.ts — Local Embedding Model

**Path:** `packages/condex-core/src/embeddings/local-embed.ts`

## What it does

Runs a local embedding model to convert text into 768-dimensional vectors for semantic search. Uses `@huggingface/transformers` v3 with the `nomic-ai/nomic-embed-text-v1.5` model.

## Model details

| Property | Value |
|----------|-------|
| Model | `nomic-ai/nomic-embed-text-v1.5` |
| Dimensions | 768 |
| Quantization | q8 (8-bit, ~100MB download) |
| Runtime | CPU (no GPU required) |
| First run | Downloads model (~100MB) |

## Key functions

### `getEmbedder()`
Returns a singleton `Embedder` instance. First call downloads and loads the model.

### `embedder.embed(text)`
Converts a single text string to a float32 array of 768 dimensions.

### `embedder.embedBatch(texts)`
Converts multiple texts to vectors in one call (more efficient than calling `embed()` repeatedly).

### `prepareSymbolText(symbol)`
Prepares a symbol for embedding by concatenating its metadata into a searchable text block:

```
class com.example.OrderService
public Order createOrder(OrderRequest request) throws ValidationException
Creates a new order from the given request. Validates stock availability.
@Service @Transactional
```

Truncated to 512 characters to fit model context.

## Why local?

Running embeddings locally means:
- No API calls, no latency, no cost
- Works offline (after first download)
- BM25 mode can block all network access
- Privacy — code never leaves the machine
