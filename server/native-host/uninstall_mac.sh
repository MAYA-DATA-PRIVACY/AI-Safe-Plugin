#!/usr/bin/env bash
set -euo pipefail

remove_manifest() {
  local target_dir="$1"
  local host_name
  for host_name in "com.ai_safe_plugin.gliner.server" "com.privacyshield.gliner2"; do
    local manifest_file="${target_dir}/${host_name}.json"
    if [[ -f "${manifest_file}" ]]; then
      rm "${manifest_file}"
      echo "Removed: ${manifest_file}"
    fi
  done
}

declare -a BROWSER_PATHS=(
  "${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "${HOME}/Library/Application Support/Chromium/NativeMessagingHosts"
  "${HOME}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
)

for path in "${BROWSER_PATHS[@]}"; do
  remove_manifest "${path}"
done

echo "Native host manifests removed."
