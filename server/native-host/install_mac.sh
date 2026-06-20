#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: bash server/native-host/install_mac.sh <extension_id>"
  exit 1
fi

EXTENSION_ID="$1"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST_SCRIPT="${REPO_DIR}/server/native_host.py"
HOST_LAUNCHER="${REPO_DIR}/server/native-host/native_host_unix.sh"
HOST_NAME="com.ai_safe_plugin.gliner.server"
LEGACY_HOST_NAME="com.privacyshield.gliner2"
RUNTIME_DIR="${REPO_DIR}/.runtime"

if [[ ! -f "${HOST_SCRIPT}" ]]; then
  echo "Native host script not found: ${HOST_SCRIPT}"
  exit 1
fi

if [[ ! -f "${HOST_LAUNCHER}" ]]; then
  echo "Native host launcher not found: ${HOST_LAUNCHER}"
  exit 1
fi

chmod +x "${HOST_SCRIPT}" "${HOST_LAUNCHER}"
mkdir -p "${RUNTIME_DIR}/cache"
touch "${RUNTIME_DIR}/gliner2_server.log"

if [[ ! -x "${REPO_DIR}/.venv/bin/python" ]]; then
  echo "AI-Safe Plugin managed runtime not found at ${REPO_DIR}/.venv/bin/python" >&2
  echo "Run the AI-Safe Plugin installer first so uv can provision the local runtime." >&2
  exit 1
fi

write_manifest() {
  local target_dir="$1"
  mkdir -p "${target_dir}"
  rm -f "${target_dir}/${LEGACY_HOST_NAME}.json"
  local manifest_file="${target_dir}/${HOST_NAME}.json"
  cat > "${manifest_file}" <<EOF
{
  "name": "${HOST_NAME}",
  "description": "AI-Safe Plugin GLiNER Server Native Host",
  "path": "${HOST_LAUNCHER}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF
  echo "Installed: ${manifest_file}"
}

write_manifest "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
write_manifest "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts"
write_manifest "${HOME}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"

echo "Native host installed for extension id: ${EXTENSION_ID}"
echo "Run 'bash server/autostart/install_mac.sh' to register AI-Safe Plugin autostart at login."
