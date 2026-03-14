#!/bin/bash
# ============================================================
# Condex MCP — Full Setup Script
# Run this once after cloning or on a new machine.
# Usage: bash condex-setup.sh
# With proxy: HTTPS_PROXY=http://proxy:port bash condex-setup.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
step() { echo -e "\n${YELLOW}[$1]${NC} $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_JS="$SCRIPT_DIR/packages/condex-core/dist/server.js"
MODEL_DIR="${CONDEX_MODEL_CACHE_DIR:-$HOME/.condex/models}"
MODEL_SUBDIR="$MODEL_DIR/nomic-ai/nomic-embed-text-v1.5"
ONNX_DIR="$MODEL_SUBDIR/onnx"
BASE_URL="https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main"
MIN_NODE_MAJOR=18

echo ""
echo "========================================="
echo "  Condex MCP — Setup"
echo "========================================="

# ── Step 1: Check Node.js ──────────────────────────
step "1/5" "Checking Node.js..."

if ! command -v node &> /dev/null; then
  fail "Node.js not found. Install Node.js >= $MIN_NODE_MAJOR from https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js $NODE_VERSION found, but >= $MIN_NODE_MAJOR required"
  exit 1
fi
ok "Node.js $NODE_VERSION"

# ── Step 2: Check npm ─────────────────────────────
step "2/5" "Checking npm..."

if ! command -v npm &> /dev/null; then
  fail "npm not found. Install npm (comes with Node.js)"
  exit 1
fi

NPM_VERSION=$(npm -v)
ok "npm $NPM_VERSION"

# ── Step 3: Install dependencies ──────────────────
step "3/5" "Installing dependencies..."

cd "$SCRIPT_DIR"
npm install 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 4: Build ─────────────────────────────────
step "4/5" "Building all packages..."

npm run build 2>&1 | tail -5
ok "Build complete"

# ── Step 5: Download embedding model ──────────────
step "5/5" "Setting up embedding model..."

if [ -f "$ONNX_DIR/model_quantized.onnx" ]; then
  ONNX_SIZE=$(du -h "$ONNX_DIR/model_quantized.onnx" | cut -f1)
  ok "Model already cached ($ONNX_SIZE) at $MODEL_SUBDIR"
else
  echo "  Downloading from HuggingFace to $MODEL_SUBDIR..."
  mkdir -p "$ONNX_DIR"

  echo "  [1/4] config.json"
  curl -sL --fail -o "$MODEL_SUBDIR/config.json" "$BASE_URL/config.json" && ok "config.json" || { fail "config.json download failed"; exit 1; }

  echo "  [2/4] tokenizer.json (~700KB)"
  curl -sL --fail -o "$MODEL_SUBDIR/tokenizer.json" "$BASE_URL/tokenizer.json" && ok "tokenizer.json" || { fail "tokenizer.json download failed"; exit 1; }

  echo "  [3/4] tokenizer_config.json"
  curl -sL --fail -o "$MODEL_SUBDIR/tokenizer_config.json" "$BASE_URL/tokenizer_config.json" && ok "tokenizer_config.json" || { fail "tokenizer_config.json download failed"; exit 1; }

  echo "  [4/4] model_quantized.onnx (~145MB)"
  curl -L --fail --progress-bar -o "$ONNX_DIR/model_quantized.onnx" "$BASE_URL/onnx/model_quantized.onnx" && ok "model_quantized.onnx" || { fail "ONNX model download failed. Try: HTTPS_PROXY=http://proxy:port bash condex-setup.sh"; exit 1; }
fi

# ── Verify ────────────────────────────────────────
echo ""
echo "========================================="
echo "  Verifying setup..."
echo "========================================="

cd "$SCRIPT_DIR"
node -e "
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const db = new Database(':memory:');
sqliteVec.load(db);
db.exec('CREATE VIRTUAL TABLE t USING vec0(id TEXT PRIMARY KEY, e float[4])');
console.log('  sqlite-vec: OK');
" 2>&1 | grep -E "OK|Error|FAIL" || fail "sqlite-vec check failed"

if [ -f "$ONNX_DIR/model_quantized.onnx" ]; then
  ok "Model: cached at $MODEL_SUBDIR"
else
  fail "Model: not found"
  exit 1
fi

# ── Done ──────────────────────────────────────────
echo ""
echo "========================================="
echo -e "  ${GREEN}Setup complete!${NC}"
echo "========================================="
echo ""
echo "  Model cache:  $MODEL_DIR"
echo "  Server path:  $SERVER_JS"
echo ""
echo "========================================="
echo "  Next: Add Condex to your project"
echo "========================================="
echo ""
echo "  Run this to setup Condex MCP in your project:"
echo "    ${CYAN}npx condex setup /path/to/your/project${NC}"
echo ""
