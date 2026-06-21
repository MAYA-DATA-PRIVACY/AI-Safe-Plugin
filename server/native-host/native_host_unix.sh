#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VENV_PYTHON="${REPO_DIR}/.venv/bin/python"
HOST_SCRIPT="${REPO_DIR}/server/native_host.py"

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "AI-Safe Plugin native host runtime is missing: ${VENV_PYTHON}" >&2
  echo "Re-run the AI-Safe Plugin installer to restore the managed runtime." >&2
  exit 1
fi

exec "${VENV_PYTHON}" "${HOST_SCRIPT}"
