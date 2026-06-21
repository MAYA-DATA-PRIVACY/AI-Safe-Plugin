#!/usr/bin/env bash
set -euo pipefail

# Stable extension ID derived from the pinned "key" in extension/manifest.json.
# Used as the default so a fresh install works without passing an ID; explicit
# arguments still override it (e.g. for a custom unpacked build).
DEFAULT_EXTENSION_ID="aggkonihfabdcbgomkfecjhdolddfabe"

if [[ $# -lt 1 ]]; then
  set -- "${DEFAULT_EXTENSION_ID}"
  echo "No extension id supplied; using the pinned AI-Safe Plugin id ${DEFAULT_EXTENSION_ID}."
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOST_SCRIPT="${REPO_DIR}/server/native_host.py"
HOST_LAUNCHER="${REPO_DIR}/server/native-host/native_host_unix.sh"
HOST_NAME="com.ai_safe_plugin.gliner.server"
LEGACY_HOST_NAME="com.privacyshield.gliner2"
RUNTIME_DIR="${REPO_DIR}/.runtime"
VENV_PYTHON="${REPO_DIR}/.venv/bin/python"

if [[ ! -f "${HOST_SCRIPT}" ]]; then
  echo "Error: Native host script not found: ${HOST_SCRIPT}"
  exit 1
fi

if [[ ! -f "${HOST_LAUNCHER}" ]]; then
  echo "Error: Native host launcher not found: ${HOST_LAUNCHER}"
  exit 1
fi

chmod +x "${HOST_SCRIPT}" "${HOST_LAUNCHER}"
mkdir -p "${RUNTIME_DIR}/cache"
touch "${RUNTIME_DIR}/gliner2_server.log"

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "Error: AI-Safe Plugin managed runtime not found at ${VENV_PYTHON}" >&2
  echo "Run the AI-Safe Plugin installer first so uv can provision the local runtime." >&2
  exit 1
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
      # Guard the empty-array expansion for portability with older bash + `set -u`.
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

# Build JSON allowed_origins array from all provided extension IDs
build_origins() {
  local -a arr=()
  for id in "$@"; do
    arr+=("\"chrome-extension://${id}/\"")
  done
  local joined
  joined="$(printf ',\n    %s' "${arr[@]}")"
  joined="${joined:2}"  # strip leading ",\n    "
  printf '[\n    %s\n  ]' "${joined}"
}

ORIGINS="$(build_origins "${EXTENSION_IDS[@]}")"

write_manifest() {
  local target_dir="$1"
  # Only write if the parent browser config directory exists (browser is installed)
  if [[ ! -d "$(dirname "${target_dir}")" ]]; then
    return 0
  fi
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
  echo "  Installed → ${manifest_file}"
}

# All known Chromium-based browser paths on Linux
declare -a BROWSER_PATHS=(
  "${HOME}/.config/google-chrome/NativeMessagingHosts"
  "${HOME}/.config/chromium/NativeMessagingHosts"
  "${HOME}/.snap/chromium/current/.config/chromium/NativeMessagingHosts"
  "${HOME}/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "${HOME}/.config/microsoft-edge/NativeMessagingHosts"
  "${HOME}/.config/vivaldi/NativeMessagingHosts"
  "${HOME}/.config/opera/NativeMessagingHosts"
)

echo ""
echo "Installing native host manifest for: ${EXTENSION_IDS[*]}"
echo ""

installed=0
for path in "${BROWSER_PATHS[@]}"; do
  write_manifest "${path}" && ((installed++)) || true
done

if [[ "${installed}" -eq 0 ]]; then
  # Fallback: install to Chrome path unconditionally
  mkdir -p "${HOME}/.config/google-chrome/NativeMessagingHosts"
  write_manifest "${HOME}/.config/google-chrome/NativeMessagingHosts"
  echo "  (Fallback: wrote to Chrome path; no known browser config dirs found)"
fi

echo ""
echo "Done. Reload your browser extensions to apply."
echo "  IDs registered: ${EXTENSION_IDS[*]}"
