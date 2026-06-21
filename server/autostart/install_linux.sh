#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${REPO_DIR}/.venv/bin/python"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_NAME="ai-safe-plugin-gliner-server.service"
LEGACY_SERVICE_NAME="privacy-shield-gliner.service"
SERVICE_FILE="${SERVICE_DIR}/${SERVICE_NAME}"
LOG_FILE="${REPO_DIR}/.runtime/gliner2_server.log"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "Missing virtualenv python: ${PYTHON_BIN}"
  echo "Run the AI-Safe Plugin installer first so uv can provision the managed runtime."
  exit 1
fi

mkdir -p "${SERVICE_DIR}"
mkdir -p "${REPO_DIR}/.runtime"
touch "${LOG_FILE}"

if systemctl --user list-unit-files | grep -q "^${LEGACY_SERVICE_NAME}$"; then
  systemctl --user disable --now "${LEGACY_SERVICE_NAME}" || true
fi
rm -f "${SERVICE_DIR}/${LEGACY_SERVICE_NAME}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=AI-Safe Plugin GLiNER Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
ExecStart=${PYTHON_BIN} ${REPO_DIR}/server/gliner2_server.py --host 127.0.0.1 --port 8765
Restart=on-failure
RestartSec=2
Environment=PYTHONUNBUFFERED=1
Environment=HF_HOME=${REPO_DIR}/.runtime/cache/hf
Environment=HUGGINGFACE_HUB_CACHE=${REPO_DIR}/.runtime/cache/hf/hub
Environment=TRANSFORMERS_CACHE=${REPO_DIR}/.runtime/cache/hf/transformers
Environment=XDG_CACHE_HOME=${REPO_DIR}/.runtime/cache/xdg
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}"

echo "Installed and started: ${SERVICE_NAME}"
echo "Status:"
systemctl --user --no-pager status "${SERVICE_NAME}" || true
