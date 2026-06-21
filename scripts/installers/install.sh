#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="Maya-Data-Privacy/AI-Safe-Plugin"
RELEASE_BASE="https://github.com/${REPO_SLUG}/releases/latest/download"
ASSET_NAME="ai-safe-plugin-backend-unix.tar.gz"
DEFAULT_ANON_ENDPOINT="https://app.mayadataprivacy.in/mdp/engine/anonymization"
PINNED_UV_VERSION="0.10.7"
PINNED_PYTHON_VERSION="3.11.11"
DEFAULT_EXTENSION_ID="aggkonihfabdcbgomkfecjhdolddfabe"

EXTENSION_IDS=()
INSTALL_DIR="${AI_SAFE_PLUGIN_INSTALL_DIR:-}"
RECREATE_VENV=0
UV_VERSION="${AI_SAFE_PLUGIN_UV_VERSION:-${PINNED_UV_VERSION}}"
UV_BIN_OVERRIDE=""
UV_BIN=""

fail() {
  echo "$1" >&2
  exit 1
}

# Compute the SHA-256 of a file using whichever tool is available (Linux ships
# sha256sum; macOS ships shasum). Prints the hex digest, or an empty string when
# no tool is found.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo ""
  fi
}

# verify_asset_checksum <downloaded_file> <hard|soft>
# Verifies the file against the release's SHA256SUMS (downloaded once into
# TMP_DIR). Missing SHA256SUMS or a missing tool → warn and continue (back-compat
# with older releases). A mismatch aborts in "hard" mode (backend bundle) and
# returns non-zero in "soft" mode (model, which has a HuggingFace fallback).
verify_asset_checksum() {
  local asset_path="$1"
  local mode="${2:-hard}"
  local asset_name
  asset_name="$(basename "${asset_path}")"
  local sums_file="${TMP_DIR}/SHA256SUMS"

  if [[ ! -f "${sums_file}" ]]; then
    if ! curl -fsSL "${RELEASE_BASE}/SHA256SUMS" -o "${sums_file}" 2>/dev/null; then
      echo "Warning: SHA256SUMS not available from release; skipping checksum verification for ${asset_name}." >&2
      return 0
    fi
  fi

  local expected
  expected="$(grep -E "[[:space:]]\*?${asset_name}\$" "${sums_file}" | head -n1 | awk '{print $1}')"
  if [[ -z "${expected}" ]]; then
    echo "Warning: ${asset_name} not listed in SHA256SUMS; skipping verification." >&2
    return 0
  fi

  local actual
  actual="$(sha256_of "${asset_path}")"
  if [[ -z "${actual}" ]]; then
    echo "Warning: no SHA-256 tool available; skipping verification for ${asset_name}." >&2
    return 0
  fi

  if [[ "${actual}" == "${expected}" ]]; then
    echo "Checksum verified: ${asset_name}"
    return 0
  fi

  if [[ "${mode}" == "soft" ]]; then
    echo "Warning: checksum verification failed for ${asset_name}; continuing." >&2
    return 1
  fi
  fail "Checksum verification failed for ${asset_name}. Aborting install."
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

extract_release_field() {
  local payload="$1"
  local field="$2"
  local match=""
  match="$(printf '%s' "${payload}" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 || true)"
  if [[ -z "${match}" ]]; then
    return 0
  fi
  printf '%s' "${match}" | sed -E "s/\"${field}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\\1/"
}

python_version_of() {
  local python_bin="$1"
  if [[ ! -x "${python_bin}" ]]; then
    return 1
  fi
  "${python_bin}" -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>/dev/null || true
}

kill_ai_safe_plugin_processes() {
  local install_dir="$1"
  local -a patterns=(
    "${install_dir}/server/gliner2_server.py"
    "${install_dir}/server/native_host.py"
    "${install_dir}/server/native-host/native_host_unix.sh"
    "${install_dir}/server/native-host/native_host_win.bat"
  )
  local -a pids=()
  while IFS= read -r line; do
    local pid cmd pattern
    pid="${line%% *}"
    cmd="${line#* }"
    for pattern in "${patterns[@]}"; do
      if [[ "${cmd}" == *"${pattern}"* ]]; then
        pids+=("${pid}")
        break
      fi
    done
  done < <(ps -eo pid=,args=)

  if [[ "${#pids[@]}" -eq 0 ]]; then
    return 0
  fi

  local pid
  for pid in "${pids[@]}"; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  sleep 1
  for pid in "${pids[@]}"; do
    kill -0 "${pid}" >/dev/null 2>&1 && kill -KILL "${pid}" >/dev/null 2>&1 || true
  done
}

remove_install_contents() {
  local install_dir="$1"
  find "${install_dir}" -mindepth 1 -maxdepth 1 ! -name ".venv" ! -name ".runtime" ! -name ".env" -exec rm -rf {} +
}

model_files_present_in_dir() {
  local model_dir="$1"
  [[ -d "${model_dir}" ]] || return 1
  [[ -f "${model_dir}/config.json" ]] || return 1
  [[ -f "${model_dir}/gliner2_config.json" ]] || return 1
}

model_cache_present() {
  local bundled_dir="${INSTALL_DIR}/.runtime/cache/model/model"
  local snapshots_dir="${INSTALL_DIR}/.runtime/cache/hf/hub/models--lmo3--gliner2-large-v1-onnx/snapshots"
  local snapshot_dir

  if model_files_present_in_dir "${bundled_dir}"; then
    return 0
  fi

  if [[ -d "${snapshots_dir}" ]]; then
    for snapshot_dir in "${snapshots_dir}"/*; do
      [[ -d "${snapshot_dir}" ]] || continue
      if model_files_present_in_dir "${snapshot_dir}"; then
        return 0
      fi
    done
  fi

  return 1
}

stamp_release_metadata() {
  local release_info_path="$1"
  local target_path="$2"
  local installed_at tag published html_url payload
  installed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if [[ ! -f "${release_info_path}" ]]; then
    cat > "${target_path}" <<EOF
{
  "tag": "",
  "published_at": "",
  "html_url": "",
  "repository": "${REPO_SLUG}",
  "installed_at": "${installed_at}"
}
EOF
    return 0
  fi

  payload="$(tr -d '\n' < "${release_info_path}")"
  tag="$(extract_release_field "${payload}" "tag")"
  if [[ -z "${tag}" ]]; then
    tag="$(extract_release_field "${payload}" "tag_name")"
  fi
  published="$(extract_release_field "${payload}" "published_at")"
  html_url="$(extract_release_field "${payload}" "html_url")"

  cat > "${target_path}" <<EOF
{
  "tag": "$(json_escape "${tag}")",
  "published_at": "$(json_escape "${published}")",
  "html_url": "$(json_escape "${html_url}")",
  "repository": "${REPO_SLUG}",
  "installed_at": "${installed_at}"
}
EOF
}

ensure_local_uv() {
  if [[ -n "${UV_BIN_OVERRIDE}" ]]; then
    [[ -x "${UV_BIN_OVERRIDE}" ]] || fail "Specified uv binary is not executable: ${UV_BIN_OVERRIDE}"
    UV_BIN="${UV_BIN_OVERRIDE}"
    return 0
  fi

  local uv_install_dir="${INSTALL_DIR}/.runtime/tools/uv"
  local uv_candidate="${uv_install_dir}/uv"
  local current_version=""
  mkdir -p "${uv_install_dir}"

  if [[ -x "${uv_candidate}" ]]; then
    current_version="$("${uv_candidate}" --version 2>/dev/null || true)"
  fi

  if [[ "${current_version}" != "uv ${UV_VERSION}" ]]; then
    local installer_path="${TMP_DIR}/uv-install.sh"
    curl -fsSL "https://astral.sh/uv/${UV_VERSION}/install.sh" -o "${installer_path}"
    env UV_UNMANAGED_INSTALL="${uv_install_dir}" UV_NO_MODIFY_PATH=1 sh "${installer_path}"
  fi

  [[ -x "${uv_candidate}" ]] || fail "Failed to install pinned uv ${UV_VERSION} into ${uv_install_dir}"
  UV_BIN="${uv_candidate}"
}

sync_runtime() {
  local runtime_dir="${INSTALL_DIR}/.runtime"
  local venv_python="${INSTALL_DIR}/.venv/bin/python"
  local venv_version=""

  if (( RECREATE_VENV == 1 )) && [[ -d "${INSTALL_DIR}/.venv" ]]; then
    rm -rf "${INSTALL_DIR}/.venv"
  fi

  if [[ -x "${venv_python}" ]]; then
    venv_version="$(python_version_of "${venv_python}")"
    if [[ -z "${venv_version}" || "${venv_version}" != 3.11.* ]]; then
      rm -rf "${INSTALL_DIR}/.venv"
    fi
  fi

  env \
    UV_CACHE_DIR="${runtime_dir}/cache/uv" \
    UV_PYTHON_INSTALL_DIR="${runtime_dir}/python" \
    UV_PROJECT_ENVIRONMENT="${INSTALL_DIR}/.venv" \
    UV_LINK_MODE=copy \
    "${UV_BIN}" python install "${PINNED_PYTHON_VERSION}" --install-dir "${runtime_dir}/python"

  # macOS (esp. Apple Silicon) kills freshly-downloaded interpreters with SIGKILL
  # ("Killed: 9") when they still carry the com.apple.quarantine xattr or lack a
  # valid signature. Strip quarantine and best-effort ad-hoc re-sign so `uv sync`
  # (which queries the interpreter) and the server can actually execute it.
  if [[ "${PLATFORM}" == "mac" ]]; then
    harden_macos_runtime "${runtime_dir}/python"
  fi

  env \
    UV_CACHE_DIR="${runtime_dir}/cache/uv" \
    UV_PYTHON_INSTALL_DIR="${runtime_dir}/python" \
    UV_PROJECT_ENVIRONMENT="${INSTALL_DIR}/.venv" \
    UV_LINK_MODE=copy \
    "${UV_BIN}" sync --frozen --no-dev --no-install-project --directory "${INSTALL_DIR}" --python "${PINNED_PYTHON_VERSION}" --managed-python

  if [[ "${PLATFORM}" == "mac" ]]; then
    harden_macos_runtime "${INSTALL_DIR}/.venv"
  fi
}

# Remove the Gatekeeper quarantine attribute and ad-hoc-sign any Mach-O files under
# a runtime directory so macOS will execute the downloaded CPython instead of
# SIGKILL-ing it. All steps are best-effort (no-ops on non-mac / missing tools).
harden_macos_runtime() {
  local target="$1"
  [[ -d "${target}" ]] || return 0
  xattr -dr com.apple.quarantine "${target}" >/dev/null 2>&1 || true
  if command -v codesign >/dev/null 2>&1; then
    while IFS= read -r macho; do
      codesign --force --sign - "${macho}" >/dev/null 2>&1 || true
    done < <(find "${target}" -type f \( -name 'python3*' -o -name '*.dylib' -o -name '*.so' \) 2>/dev/null)
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_IDS+=("${2:-}")
      shift 2
      ;;
    --extension-ids)
      EXTENSION_IDS+=("${2:-}")
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    --recreate-venv)
      RECREATE_VENV=1
      shift
      ;;
    --uv-version)
      UV_VERSION="${2:-}"
      shift 2
      ;;
    --uv-bin)
      UV_BIN_OVERRIDE="${2:-}"
      shift 2
      ;;
    *)
      fail "Unknown argument: $1"
      ;;
  esac
done

if [[ "${#EXTENSION_IDS[@]}" -eq 0 ]]; then
  EXTENSION_IDS=("${DEFAULT_EXTENSION_ID}")
  echo "No extension id supplied; using the pinned AI-Safe Plugin id ${DEFAULT_EXTENSION_ID}."
fi

OS_NAME="$(uname -s)"
case "${OS_NAME}" in
  Linux*) PLATFORM="linux"; DEFAULT_INSTALL_DIR="${HOME}/.local/share/ai-safe-plugin" ;;
  Darwin*) PLATFORM="mac"; DEFAULT_INSTALL_DIR="${HOME}/Library/Application Support/AI-Safe Plugin" ;;
  *)
    fail "Unsupported OS for install.sh: ${OS_NAME}"
    ;;
esac

INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"
TMP_DIR="$(mktemp -d)"
ARCHIVE_PATH="${TMP_DIR}/${ASSET_NAME}"
EXTRACT_DIR="${TMP_DIR}/extract"

cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "Downloading AI-Safe Plugin backend bundle..."
curl -fsSL "${RELEASE_BASE}/${ASSET_NAME}" -o "${ARCHIVE_PATH}"
verify_asset_checksum "${ARCHIVE_PATH}" hard

mkdir -p "${EXTRACT_DIR}" "${INSTALL_DIR}"
tar -xzf "${ARCHIVE_PATH}" -C "${EXTRACT_DIR}"

if [[ "${PLATFORM}" == "linux" ]]; then
  [[ -f "${INSTALL_DIR}/server/autostart/uninstall_linux.sh" ]] && bash "${INSTALL_DIR}/server/autostart/uninstall_linux.sh" || true
  [[ -f "${INSTALL_DIR}/server/native-host/uninstall_linux.sh" ]] && bash "${INSTALL_DIR}/server/native-host/uninstall_linux.sh" || true
else
  [[ -f "${INSTALL_DIR}/server/autostart/uninstall_mac.sh" ]] && bash "${INSTALL_DIR}/server/autostart/uninstall_mac.sh" || true
  [[ -f "${INSTALL_DIR}/server/native-host/uninstall_mac.sh" ]] && bash "${INSTALL_DIR}/server/native-host/uninstall_mac.sh" || true
fi

kill_ai_safe_plugin_processes "${INSTALL_DIR}"
remove_install_contents "${INSTALL_DIR}"
cp -R "${EXTRACT_DIR}/." "${INSTALL_DIR}/"

ENV_FILE="${INSTALL_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  cat > "${ENV_FILE}" <<EOF
MDP_ANONYMIZATION_ENDPOINT=${DEFAULT_ANON_ENDPOINT}
EOF
elif ! grep -q '^MDP_ANONYMIZATION_ENDPOINT=' "${ENV_FILE}"; then
  printf '\nMDP_ANONYMIZATION_ENDPOINT=%s\n' "${DEFAULT_ANON_ENDPOINT}" >> "${ENV_FILE}"
fi

mkdir -p "${INSTALL_DIR}/.runtime"
stamp_release_metadata "${INSTALL_DIR}/.runtime/bundle_release.json" "${INSTALL_DIR}/.runtime/bundle_release.json"

ensure_local_uv
sync_runtime

cd "${INSTALL_DIR}"

# Set cache env vars so the server and pre-download use the same location.
export HF_HOME="${INSTALL_DIR}/.runtime/cache/hf"
export HUGGINGFACE_HUB_CACHE="${INSTALL_DIR}/.runtime/cache/hf/hub"
export TRANSFORMERS_CACHE="${INSTALL_DIR}/.runtime/cache/hf/transformers"
export XDG_CACHE_HOME="${INSTALL_DIR}/.runtime/cache/xdg"

# Download the pre-packaged fp16 model from the GitHub Release (much faster than
# pulling from HuggingFace Hub). Falls back to HF download if the asset is missing.
MODEL_ASSET="ai-safe-plugin-model-fp16.tar.gz"
MODEL_ARCHIVE="${TMP_DIR}/${MODEL_ASSET}"
MODEL_DEST="${INSTALL_DIR}/.runtime/cache/model"

echo
if model_cache_present; then
  echo "Existing GLiNER2 model cache found; skipping download."
else
  echo "Downloading GLiNER2 model (~1.8 GB, this may take a few minutes)..."
  if curl -fL --progress-bar "${RELEASE_BASE}/${MODEL_ASSET}" -o "${MODEL_ARCHIVE}" 2>&1 && verify_asset_checksum "${MODEL_ARCHIVE}" soft; then
    echo "Extracting model..."
    mkdir -p "${MODEL_DEST}"
    tar -xzf "${MODEL_ARCHIVE}" -C "${MODEL_DEST}"
    echo "Model extracted to ${MODEL_DEST}"
  else
    echo "Bundled model unavailable or failed verification; downloading from HuggingFace Hub..."
    "${INSTALL_DIR}/.venv/bin/python" "${INSTALL_DIR}/server/gliner2_server.py" --download-only || echo "Warning: model download failed. It will download on first use."
  fi
fi

if [[ "${PLATFORM}" == "linux" ]]; then
  bash server/native-host/install_linux.sh "${EXTENSION_IDS[@]}"
  bash server/autostart/install_linux.sh
else
  bash server/native-host/install_mac.sh "${EXTENSION_IDS[@]}"
  bash server/autostart/install_mac.sh
fi

echo
echo "AI-Safe Plugin install complete."
echo "Install directory: ${INSTALL_DIR}"
echo "Extension IDs: ${EXTENSION_IDS[*]}"
