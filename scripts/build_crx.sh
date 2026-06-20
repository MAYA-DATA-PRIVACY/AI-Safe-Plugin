#!/usr/bin/env bash
# scripts/build_crx.sh — Build a Chrome Web Store submission ZIP
# Usage: bash scripts/build_crx.sh [output_path]
# Output: dist/ai-safe-plugin-extension.zip (or $1 if specified)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
EXTENSION_DIR="$ROOT/extension"
OUTPUT="${1:-$ROOT/dist/ai-safe-plugin-extension.zip}"
if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PWD/$OUTPUT"
fi

echo "🛡  AI-Safe Plugin Extension — CRX Package Builder"
echo "   Source : $EXTENSION_DIR"
echo "   Output : $OUTPUT"
echo ""

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"

# Verify extension dir exists
if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "❌ extension/ directory not found at $EXTENSION_DIR"
  exit 1
fi

# Create the zip from the extension/ directory
cd "$EXTENSION_DIR"
zip -r "$OUTPUT" . --quiet --exclude "*.DS_Store" --exclude "__pycache__/*"

SIZE=$(du -sh "$OUTPUT" | awk '{print $1}')
echo "✅ Package created: $OUTPUT ($SIZE)"
echo ""
echo "Upload this file at:"
echo "  https://chrome.google.com/webstore/devconsole"
