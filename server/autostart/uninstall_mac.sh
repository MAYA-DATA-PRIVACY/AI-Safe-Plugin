#!/usr/bin/env bash
set -euo pipefail

remove_plist() {
  local plist_label="$1"
  local plist_file="${HOME}/Library/LaunchAgents/${plist_label}.plist"
  if [[ -f "${plist_file}" ]]; then
    launchctl unload "${plist_file}" 2>/dev/null || true
    rm -f "${plist_file}"
    echo "Removed ${plist_file}"
  fi
}

remove_plist "com.ai_safe_plugin.gliner.server"
remove_plist "com.privacyshield.gliner2"
