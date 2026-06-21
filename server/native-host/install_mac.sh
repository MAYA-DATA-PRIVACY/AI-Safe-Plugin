#!/usr/bin/env bash
set -euo pipefail

# Stable extension ID derived from the pinned "key" in extension/manifest.json.
DEFAULT_EXTENSION_ID="aggkonihfabdcbgomkfecjhdolddfabe"

if [[ $# -lt 1 ]]; then
  echo "No extension id supplied; using the pinned AI-Safe Plugin id ${DEFAULT_EXTENSION_ID}."
  set -- "${DEFAULT_EXTENSION_ID}"
fi

normalize_extension_ids() {
  local -a normalized=()
  local raw id existing
  for raw in "$@" "${DEFAULT_EXTENSION_ID}"; do
    raw="${raw//,/ }"
    raw="${raw//;/ }"
    for id in ${raw}; do
      id="$(printf '%s' "${id}" | tr '[:upper:]' '[:lower:]')"
      [[ -n "${id}" ]] || continue
      if [[ ! "${id}" =~ ^[a-p]{32}$ ]]; then
        echo "Invalid extension id: ${id}" >&2
        return 1
      fi
      # Guard the empty-array expansion: macOS bash 3.2 errors on "${arr[@]}"
      # of a declared-but-empty array under `set -u`.
      if (( ${#normalized[@]} )); then
        for existing in "${normalized[@]}"; do
          [[ "${existing}" == "${id}" ]] && continue 2
        done
      fi
      normalized+=("${id}")
    done
  done
  if (( ${#normalized[@]} )); then
    printf '%s\n' "${normalized[@]}"
  fi
}

EXTENSION_IDS=()
while IFS= read -r id; do
  EXTENSION_IDS+=("${id}")
done < <(normalize_extension_ids "$@")
if [[ "${#EXTENSION_IDS[@]}" -eq 0 ]]; then
  echo "No valid extension ids supplied." >&2
  exit 1
fi

build_origins() {
  local -a arr=()
  local id joined
  for id in "$@"; do
    arr+=("\"chrome-extension://${id}/\"")
  done
  joined="$(printf ',\n    %s' "${arr[@]}")"
  joined="${joined:2}"
  printf '[\n    %s\n  ]' "${joined}"
}

ORIGINS="$(build_origins "${EXTENSION_IDS[@]}")"
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
  "allowed_origins": ${ORIGINS}
}
EOF
  echo "Installed: ${manifest_file}"
}

write_manifest "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
write_manifest "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts"
write_manifest "${HOME}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"

echo "Native host installed for extension ids: ${EXTENSION_IDS[*]}"
echo "Run 'bash server/autostart/install_mac.sh' to register AI-Safe Plugin autostart at login."
