#!/usr/bin/env bash
# scripts/build_crx.sh — Build an extension ZIP.
#
# By default the ZIP KEEPS the manifest "key" field. That key pins a stable
# extension ID for "Load unpacked" installs, so the GitHub-released zip (built
# here in CI) lines up with the pinned id the installer registers.
#
# Pass --store to STRIP "key" for a Chrome Web Store upload. The Web Store
# rejects any manifest that contains "key" and assigns its own permanent id, so
# the store package must not carry one. The source manifest is never modified.
#
# Usage:
#   bash scripts/build_crx.sh [output_path]           # GitHub/unpacked, keeps key
#   bash scripts/build_crx.sh --store [output_path]   # Web Store upload, strips key
set -euo pipefail

STRIP_KEY=0
OUTPUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --store) STRIP_KEY=1; shift ;;
    *) OUTPUT="$1"; shift ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
EXTENSION_DIR="$ROOT/extension"
OUTPUT="${OUTPUT:-$ROOT/dist/ai-safe-plugin-extension.zip}"
if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$PWD/$OUTPUT"
fi

echo "🛡  MAYA AISafe Plugin Extension — CRX Package Builder"
echo "   Source : $EXTENSION_DIR"
echo "   Output : $OUTPUT"
if [[ "$STRIP_KEY" -eq 1 ]]; then
  echo "   Mode   : Web Store (manifest \"key\" stripped)"
else
  echo "   Mode   : unpacked/GitHub (manifest \"key\" kept for a stable id)"
fi
echo ""

mkdir -p "$(dirname "$OUTPUT")"
rm -f "$OUTPUT"

# Verify extension dir exists
if [[ ! -d "$EXTENSION_DIR" ]]; then
  echo "❌ extension/ directory not found at $EXTENSION_DIR"
  exit 1
fi

if [[ "$STRIP_KEY" -eq 1 ]]; then
  # Stage a copy and drop the dev-only "key" so the upload is store-valid. The
  # working tree manifest keeps "key" for local dev and the GitHub asset.
  STAGE_DIR="$(mktemp -d)"
  trap 'rm -rf "$STAGE_DIR"' EXIT
  cp -R "$EXTENSION_DIR/." "$STAGE_DIR/"
  python3 - "$STAGE_DIR/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    manifest = json.load(f)
removed = manifest.pop("key", None) is not None
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print("   Stripped manifest \"key\" for Web Store upload." if removed
      else "   No \"key\" field present — nothing to strip.")
PY
  cd "$STAGE_DIR"
else
  cd "$EXTENSION_DIR"
fi

# Create the zip
zip -r "$OUTPUT" . --quiet --exclude "*.DS_Store" --exclude "__pycache__/*"

SIZE=$(du -sh "$OUTPUT" | awk '{print $1}')
echo "✅ Package created: $OUTPUT ($SIZE)"
if [[ "$STRIP_KEY" -eq 1 ]]; then
  echo ""
  echo "Upload this file at:"
  echo "  https://chrome.google.com/webstore/devconsole"
fi
