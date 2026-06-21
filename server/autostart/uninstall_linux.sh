#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="${HOME}/.config/systemd/user"
remove_service() {
  local service_name="$1"
  local service_file="${SERVICE_DIR}/${service_name}"
  if systemctl --user list-unit-files | grep -q "^${service_name}$"; then
    systemctl --user disable --now "${service_name}" || true
  fi
  rm -f "${service_file}"
}

remove_service "ai-safe-plugin-gliner-server.service"
remove_service "privacy-shield-gliner.service"

systemctl --user daemon-reload
echo "Removed AI-Safe Plugin GLiNER Server autostart units."
