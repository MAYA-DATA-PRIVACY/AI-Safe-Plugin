#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${REPO_DIR}/.venv/bin/python"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_LABEL="com.ai_safe_plugin.gliner.server"
LEGACY_PLIST_LABEL="com.privacyshield.gliner2"
PLIST_FILE="${PLIST_DIR}/${PLIST_LABEL}.plist"
LOG_FILE="${REPO_DIR}/.runtime/gliner2_server.log"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Missing virtualenv python: ${PYTHON_BIN}"
  echo "Run the AI-Safe Plugin installer first so uv can provision the managed runtime."
  exit 1
fi

mkdir -p "${PLIST_DIR}"
mkdir -p "${REPO_DIR}/.runtime"
touch "${LOG_FILE}"

LEGACY_PLIST_FILE="${PLIST_DIR}/${LEGACY_PLIST_LABEL}.plist"
if [[ -f "${LEGACY_PLIST_FILE}" ]]; then
  launchctl unload "${LEGACY_PLIST_FILE}" 2>/dev/null || true
  rm -f "${LEGACY_PLIST_FILE}"
fi

cat > "${PLIST_FILE}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PYTHON_BIN}</string>
    <string>${REPO_DIR}/server/gliner2_server.py</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>8765</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>HF_HOME</key>
    <string>${REPO_DIR}/.runtime/cache/hf</string>
    <key>HUGGINGFACE_HUB_CACHE</key>
    <string>${REPO_DIR}/.runtime/cache/hf/hub</string>
    <key>TRANSFORMERS_CACHE</key>
    <string>${REPO_DIR}/.runtime/cache/hf/transformers</string>
    <key>XDG_CACHE_HOME</key>
    <string>${REPO_DIR}/.runtime/cache/xdg</string>
  </dict>
</dict>
</plist>
EOF

launchctl unload "${PLIST_FILE}" 2>/dev/null || true
launchctl load "${PLIST_FILE}"
echo "Installed and started: ${PLIST_FILE}"
echo "Status: $(launchctl list | grep ${PLIST_LABEL} || echo 'not listed yet — may take a moment')"
