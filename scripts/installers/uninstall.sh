#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${AI_SAFE_PLUGIN_INSTALL_DIR:-}"

collect_ai_safe_plugin_pids() {
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

  printf '%s\n' "${pids[@]}"
}

kill_ai_safe_plugin_processes() {
  local install_dir="$1"
  mapfile -t pids < <(collect_ai_safe_plugin_pids "${install_dir}")
  local pid
  for pid in "${pids[@]}"; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  sleep 1
  for pid in "${pids[@]}"; do
    kill -0 "${pid}" >/dev/null 2>&1 && kill -KILL "${pid}" >/dev/null 2>&1 || true
  done
}

wait_for_ai_safe_plugin_shutdown() {
  local install_dir="$1"
  local attempts="${2:-10}"
  local remaining=()
  local i

  for ((i=0; i<attempts; i+=1)); do
    mapfile -t remaining < <(collect_ai_safe_plugin_pids "${install_dir}")
    if [[ "${#remaining[@]}" -eq 0 ]]; then
      return 0
    fi
    sleep 1
  done

  return 1
}

remove_install_dir() {
  local install_dir="$1"
  local attempt

  chmod -R u+w "${install_dir}" >/dev/null 2>&1 || true
  for attempt in 1 2 3; do
    rm -rf "${install_dir}" && return 0
    sleep 1
  done

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

OS_NAME="$(uname -s)"
case "${OS_NAME}" in
  Linux*) PLATFORM="linux"; DEFAULT_INSTALL_DIR="${HOME}/.local/share/ai-safe-plugin" ;;
  Darwin*) PLATFORM="mac"; DEFAULT_INSTALL_DIR="${HOME}/Library/Application Support/AI-Safe Plugin" ;;
  *)
    echo "Unsupported OS for uninstall.sh: ${OS_NAME}" >&2
    exit 1
    ;;
esac

INSTALL_DIR="${INSTALL_DIR:-${DEFAULT_INSTALL_DIR}}"

if [[ ! -d "${INSTALL_DIR}" ]]; then
  echo "AI-Safe Plugin local server is not installed at ${INSTALL_DIR}."
  exit 0
fi

echo "Removing AI-Safe Plugin local server from ${INSTALL_DIR}..."

if [[ "${PLATFORM}" == "linux" ]]; then
  [[ -f "${INSTALL_DIR}/server/autostart/uninstall_linux.sh" ]] && bash "${INSTALL_DIR}/server/autostart/uninstall_linux.sh" || true
  [[ -f "${INSTALL_DIR}/server/native-host/uninstall_linux.sh" ]] && bash "${INSTALL_DIR}/server/native-host/uninstall_linux.sh" || true
else
  [[ -f "${INSTALL_DIR}/server/autostart/uninstall_mac.sh" ]] && bash "${INSTALL_DIR}/server/autostart/uninstall_mac.sh" || true
  [[ -f "${INSTALL_DIR}/server/native-host/uninstall_mac.sh" ]] && bash "${INSTALL_DIR}/server/native-host/uninstall_mac.sh" || true
fi

kill_ai_safe_plugin_processes "${INSTALL_DIR}"
wait_for_ai_safe_plugin_shutdown "${INSTALL_DIR}" || true
remove_install_dir "${INSTALL_DIR}"

echo
echo "AI-Safe Plugin uninstall complete."
echo "Removed: ${INSTALL_DIR} (server, venv, models, and all cached data)"
