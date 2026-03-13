#!/usr/bin/env bash
#
# Run the Condex real-world integration test.
#
# Creates a realistic project (6+ levels deep, multiple file types),
# indexes with BM25 + vector, downloads the real embedding model,
# runs search queries, and prints a full stats report.
#
# Usage:
#   bash realtest.sh
#
# Requires: Node.js 18+, npm packages installed and built.
#

set -euo pipefail
cd "$(dirname "$0")"

echo "=== Condex Real-World Integration Test ==="
echo ""

# Check prerequisites
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first."
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "ERROR: Node.js 18+ required (found v${NODE_VERSION})"
  exit 1
fi

# Ensure packages are built
if [ ! -d "packages/condex-core/dist" ]; then
  echo "Building packages..."
  npm run build --workspace=packages/condex-core
  npm run build --workspace=packages/condex-java 2>/dev/null || true
fi

# Run the real-world test
# The ONNX runtime may print a C++ exception during process teardown — harmless, suppress stderr noise at exit.
npx tsx packages/condex-core/src/scripts/realworld-test.ts 2>/dev/null
exit $?
