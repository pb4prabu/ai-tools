#!/bin/bash
# Download the embedding model for Condex vector search.
# Usage: bash setup-model.sh
# With proxy: HTTPS_PROXY=http://proxy:port bash setup-model.sh

set -e

MODEL_DIR="${CONDEX_MODEL_CACHE_DIR:-/tmp/condex/models}/nomic-ai/nomic-embed-text-v1.5"
ONNX_DIR="$MODEL_DIR/onnx"
BASE_URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main"

echo "=== Condex Model Setup ==="
echo "Target: $MODEL_DIR"
echo ""

# Check if already downloaded
if [ -f "$ONNX_DIR/model_quantized.onnx" ]; then
  echo "Model already exists at $ONNX_DIR/model_quantized.onnx"
  echo "Delete it first if you want to re-download."
  exit 0
fi

mkdir -p "$ONNX_DIR"

echo "[1/4] Downloading config.json..."
curl -L --fail --progress-bar -o "$MODEL_DIR/config.json" "$BASE_URL/config.json"

echo "[2/4] Downloading tokenizer.json (~700KB)..."
curl -L --fail --progress-bar -o "$MODEL_DIR/tokenizer.json" "$BASE_URL/tokenizer.json"

echo "[3/4] Downloading tokenizer_config.json..."
curl -L --fail --progress-bar -o "$MODEL_DIR/tokenizer_config.json" "$BASE_URL/tokenizer_config.json"

echo "[4/4] Downloading model_quantized.onnx (~145MB)..."
curl -L --fail --progress-bar -o "$ONNX_DIR/model_quantized.onnx" "$BASE_URL/onnx/model_quantized.onnx"

echo ""
echo "=== Done! Model downloaded to $MODEL_DIR ==="
echo ""
echo "Files:"
ls -lh "$MODEL_DIR"/*.json "$ONNX_DIR"/*.onnx
