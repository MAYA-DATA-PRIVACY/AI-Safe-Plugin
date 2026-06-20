#!/usr/bin/env python3
"""
Native messaging host for AI-Safe Plugin.

The host exposes start / stop / restart / status controls for the local
GLiNER2 server. The backend runtime itself is managed by uv and kept inside the
AI-Safe Plugin install directory.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List

HOST_NAME = "com.ai_safe_plugin.gliner.server"
SERVER_HOST = "127.0.0.1"
SERVER_PORT = 8765
SERVER_URL = f"http://{SERVER_HOST}:{SERVER_PORT}/health"
WAIT_SECONDS = 30
MODEL_ENV_VAR = "GLINER2_MODEL"
PINNED_UV_VERSION = "0.10.7"
PINNED_PYTHON_VERSION = "3.11.11"

REPO_DIR = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_DIR / "server" / "gliner2_server.py"
AUTOSTART_WRAPPER_PATH = REPO_DIR / "server" / "autostart" / "start_server.cmd"
VENV_DIR = REPO_DIR / ".venv"
VENV_PYTHON = VENV_DIR / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
PYPROJECT_FILE = REPO_DIR / "pyproject.toml"
UV_LOCK_FILE = REPO_DIR / "uv.lock"

RUNTIME_DIR = REPO_DIR / ".runtime"
STATE_DIR = RUNTIME_DIR
STATE_FILE = STATE_DIR / "native_host_state.json"
LOG_FILE = STATE_DIR / "gliner2_server.log"
CACHE_DIR = RUNTIME_DIR / "cache"
PIP_CACHE_DIR = CACHE_DIR / "pip"
HF_HOME = CACHE_DIR / "hf"
HF_HUB_CACHE = HF_HOME / "hub"
TRANSFORMERS_CACHE = HF_HOME / "transformers"
XDG_CACHE_HOME = CACHE_DIR / "xdg"
UV_CACHE_DIR = CACHE_DIR / "uv"
UV_PYTHON_INSTALL_DIR = RUNTIME_DIR / "python"
UV_BIN_DIR = RUNTIME_DIR / "tools" / "uv"
UV_BINARY = UV_BIN_DIR / ("uv.exe" if os.name == "nt" else "uv")
RELEASE_INFO_FILE = RUNTIME_DIR / "bundle_release.json"
PROCESS_STATE_FILE = RUNTIME_DIR / "server_process.json"


def read_native_message() -> Dict[str, Any]:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return {}
    if len(raw_length) < 4:
        raise RuntimeError("Invalid native message length prefix.")
    message_length = struct.unpack("<I", raw_length)[0]
    payload = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(payload)


def send_native_message(message: Dict[str, Any]) -> None:
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def ensure_runtime_dirs() -> None:
    for path in (
        RUNTIME_DIR,
        STATE_DIR,
        CACHE_DIR,
        PIP_CACHE_DIR,
        HF_HOME,
        HF_HUB_CACHE,
        TRANSFORMERS_CACHE,
        XDG_CACHE_HOME,
        UV_CACHE_DIR,
        UV_PYTHON_INSTALL_DIR,
        UV_BIN_DIR,
    ):
        path.mkdir(parents=True, exist_ok=True)
    LOG_FILE.touch(exist_ok=True)


def runtime_env(extra_env: Dict[str, str] | None = None) -> Dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PIP_CACHE_DIR": str(PIP_CACHE_DIR),
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "HF_HOME": str(HF_HOME),
            "HUGGINGFACE_HUB_CACHE": str(HF_HUB_CACHE),
            "TRANSFORMERS_CACHE": str(TRANSFORMERS_CACHE),
            "XDG_CACHE_HOME": str(XDG_CACHE_HOME),
            "UV_CACHE_DIR": str(UV_CACHE_DIR),
            "UV_PYTHON_INSTALL_DIR": str(UV_PYTHON_INSTALL_DIR),
            "UV_PROJECT_ENVIRONMENT": str(VENV_DIR),
            "UV_LINK_MODE": "copy",
        }
    )
    if extra_env:
        env.update(extra_env)
    return env


def is_windows_platform() -> bool:
    return os.name == "nt"


def run_cmd(
    cmd: list[str],
    cwd: Path | None = None,
    env: Dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def trim_output(text: str, max_lines: int = 28) -> str:
    lines = [line for line in str(text or "").splitlines() if line.strip()]
    if not lines:
        return ""
    if len(lines) <= max_lines:
        return "\n".join(lines)
    return "\n".join(lines[-max_lines:])


def load_state() -> Dict[str, Any]:
    ensure_runtime_dirs()
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(state: Dict[str, Any]) -> None:
    ensure_runtime_dirs()
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def read_process_state() -> Dict[str, Any]:
    ensure_runtime_dirs()
    if not PROCESS_STATE_FILE.exists():
        return {}
    try:
        return json.loads(PROCESS_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def clear_process_state() -> None:
    ensure_runtime_dirs()
    try:
        PROCESS_STATE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def read_bundle_release_info() -> Dict[str, Any]:
    ensure_runtime_dirs()
    defaults = {
        "bundleReleaseTag": None,
        "bundleReleasePublishedAt": None,
        "bundleReleaseUrl": None,
        "bundleReleaseInstalledAt": None,
    }
    if not RELEASE_INFO_FILE.exists():
        return defaults
    try:
        payload = json.loads(RELEASE_INFO_FILE.read_text(encoding="utf-8"))
    except Exception:
        return defaults
    return {
        "bundleReleaseTag": str(payload.get("tag") or "").strip() or None,
        "bundleReleasePublishedAt": str(payload.get("published_at") or "").strip() or None,
        "bundleReleaseUrl": str(payload.get("html_url") or "").strip() or None,
        "bundleReleaseInstalledAt": str(payload.get("installed_at") or "").strip() or None,
    }


def read_recent_logs(lines: int = 120) -> list[str]:
    ensure_runtime_dirs()
    try:
        all_lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    process_state = read_process_state()
    session_id = str(process_state.get("session_id") or "").strip()
    if session_id:
        marker = f"[server-session {session_id}]"
        for index in range(len(all_lines) - 1, -1, -1):
            if marker in all_lines[index]:
                all_lines = all_lines[index:]
                break
    keep = max(1, min(int(lines), 500))
    return all_lines[-keep:]


def normalize_pid(pid: Any) -> int | None:
    try:
        normalized_pid = int(pid)
    except (TypeError, ValueError):
        return None
    if normalized_pid <= 0:
        return None
    return normalized_pid


def is_pid_running(pid: Any) -> bool:
    normalized_pid = normalize_pid(pid)
    if normalized_pid is None:
        return False
    if is_windows_platform():
        return is_pid_running_windows(normalized_pid)
    try:
        os.kill(normalized_pid, 0)
        return True
    except OSError:
        return False


def is_pid_running_windows(pid: int) -> bool:
    # On Windows, os.kill(pid, 0) is not a harmless existence probe. Per the
    # Python docs, non-CTRL signals are implemented via TerminateProcess.
    script = (
        "$ErrorActionPreference='SilentlyContinue';"
        f"$proc = Get-Process -Id {int(pid)};"
        "if ($null -ne $proc) { exit 0 }"
        "exit 1"
    )
    try:
        result = run_cmd(["powershell", "-NoProfile", "-Command", script])
    except OSError:
        return False
    return result.returncode == 0


def is_port_open(host: str = SERVER_HOST, port: int = SERVER_PORT) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def is_server_healthy() -> bool:
    try:
        with urllib.request.urlopen(SERVER_URL, timeout=1.5) as response:
            if response.status != 200:
                return False
            data = json.loads(response.read().decode("utf-8"))
            return bool(data.get("ok"))
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def wait_for_health(timeout: float = WAIT_SECONDS) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_server_healthy():
            return True
        time.sleep(0.4)
    return False


def normalize_command(command: str) -> str:
    normalized = str(command or "")
    if is_windows_platform():
        return normalized.replace("/", "\\").lower()
    return normalized


def is_owned_server_command(command: str) -> bool:
    normalized = normalize_command(command)
    script_path = normalize_command(str(SCRIPT_PATH))
    autostart_wrapper_path = normalize_command(str(AUTOSTART_WRAPPER_PATH))
    repo_dir = normalize_command(str(REPO_DIR))
    server_script_name = normalize_command("gliner2_server.py")
    return (
        script_path in normalized
        or autostart_wrapper_path in normalized
        or (repo_dir in normalized and server_script_name in normalized)
    )


def list_processes() -> list[dict[str, Any]]:
    if is_windows_platform():
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            "Get-CimInstance Win32_Process | "
            "Select-Object @{Name='pid';Expression={[int]$_.ProcessId}},"
            "@{Name='command';Expression={[string]$_.CommandLine}} | "
            "ConvertTo-Json -Compress"
        )
        result = run_cmd(["powershell", "-NoProfile", "-Command", script])
        if result.returncode != 0 or not result.stdout.strip():
            return []
        try:
            payload = json.loads(result.stdout)
        except Exception:
            return []
        if isinstance(payload, dict):
            payload = [payload]
        return [item for item in payload if isinstance(item, dict)]

    result = run_cmd(["ps", "-eo", "pid=,args="])
    if result.returncode != 0:
        return []

    processes: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 1)
        if not parts:
            continue
        try:
            pid = int(parts[0])
        except ValueError:
            continue
        command = parts[1] if len(parts) > 1 else ""
        processes.append({"pid": pid, "command": command})
    return processes


def discover_owned_server_pids() -> list[int]:
    pids: list[int] = []
    seen: set[int] = set()
    for item in list_processes():
        pid = item.get("pid")
        command = item.get("command")
        if not isinstance(pid, int) or pid in seen:
            continue
        if pid == os.getpid():
            continue
        if is_owned_server_command(str(command or "")) and is_pid_running(pid):
            seen.add(pid)
            pids.append(pid)
    return pids


def tracked_server_pids() -> list[int]:
    candidates: list[int] = []
    seen: set[int] = set()
    for payload in (read_process_state(), load_state()):
        normalized_pid = normalize_pid(payload.get("pid"))
        if normalized_pid is None:
            continue
        if normalized_pid not in seen and is_pid_running(normalized_pid):
            seen.add(normalized_pid)
            candidates.append(normalized_pid)
    for pid in discover_owned_server_pids():
        if pid not in seen:
            seen.add(pid)
            candidates.append(pid)
    return candidates


def remember_server_pid(pid: int | None) -> None:
    if not pid:
        return
    save_state(
        {
            "pid": int(pid),
            "started_at": int(time.time()),
            "log_file": str(LOG_FILE),
            "repo_dir": str(REPO_DIR),
            "runtime_dir": str(RUNTIME_DIR),
        }
    )


def active_server_pid() -> int | None:
    for pid in tracked_server_pids():
        remember_server_pid(pid)
        return pid
    return None


def kill_pid(pid: int) -> bool:
    if not is_pid_running(pid):
        return True
    if is_windows_platform():
        graceful = run_cmd(["taskkill", "/PID", str(pid), "/T"])
        deadline = time.time() + 5
        while time.time() < deadline:
            if not is_pid_running(pid):
                return True
            time.sleep(0.2)
        force = run_cmd(["taskkill", "/PID", str(pid), "/F", "/T"])
        return graceful.returncode == 0 or force.returncode == 0 or not is_pid_running(pid)
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass

    deadline = time.time() + 5
    while time.time() < deadline:
        if not is_pid_running(pid):
            return True
        time.sleep(0.2)

    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass
    time.sleep(0.2)
    return not is_pid_running(pid)


def build_server_launch_kwargs(
    log_handle: Any,
    extra_env: Dict[str, str] | None = None,
) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {
        "cwd": str(REPO_DIR),
        "env": runtime_env({**(extra_env or {}), "PYTHONUNBUFFERED": "1"}),
        "stdin": subprocess.DEVNULL,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
    }
    if is_windows_platform():
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )
    else:
        kwargs["start_new_session"] = True
    return kwargs


def resolve_uv_binary() -> Path | None:
    ensure_runtime_dirs()
    if UV_BINARY.exists():
        return UV_BINARY
    return None


@lru_cache(maxsize=1)
def read_uv_version() -> str | None:
    uv_binary = resolve_uv_binary()
    if not uv_binary:
        return None
    result = run_cmd([str(uv_binary), "--version"], cwd=REPO_DIR, env=runtime_env())
    if result.returncode != 0:
        return None
    return str(result.stdout.strip() or result.stderr.strip() or "").strip() or None


@lru_cache(maxsize=1)
def read_runtime_python_version() -> str | None:
    if not VENV_PYTHON.exists():
        return None
    result = run_cmd(
        [str(VENV_PYTHON), "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
        cwd=REPO_DIR,
        env=runtime_env(),
    )
    if result.returncode != 0:
        return None
    return str(result.stdout.strip() or "").strip() or None


def runtime_meta() -> Dict[str, Any]:
    model_override = os.environ.get(MODEL_ENV_VAR, "").strip()
    owned_pid = active_server_pid()
    port_open = is_port_open()
    healthy = is_server_healthy()
    return {
        "installed": VENV_PYTHON.exists(),
        "healthUrl": SERVER_URL,
        "healthCommand": f"curl {SERVER_URL}",
        "logFile": str(LOG_FILE),
        "logCommand": f"tail -n 80 {LOG_FILE}",
        "runtimeDir": str(RUNTIME_DIR),
        "venvDir": str(VENV_DIR),
        "runtimePython": str(VENV_PYTHON),
        "runtimePythonVersion": read_runtime_python_version(),
        "uvBinary": str(resolve_uv_binary()) if resolve_uv_binary() else None,
        "uvVersion": read_uv_version(),
        "uvPinnedVersion": PINNED_UV_VERSION,
        "pythonPinnedVersion": PINNED_PYTHON_VERSION,
        "lockFile": str(UV_LOCK_FILE),
        "modelOverride": model_override or None,
        "restartSupported": True,
        "portConflict": bool(port_open and owned_pid is None and not healthy),
        **read_bundle_release_info(),
    }


def sync_managed_runtime() -> None:
    uv_binary = resolve_uv_binary()
    if uv_binary is None:
        raise RuntimeError(
            "AI-Safe Plugin runtime manager is missing. Re-run the installer to restore the pinned uv runtime."
        )
    if not PYPROJECT_FILE.exists() or not UV_LOCK_FILE.exists():
        raise RuntimeError(
            "AI-Safe Plugin runtime metadata is missing. Re-run the installer to restore pyproject.toml and uv.lock."
        )

    env = runtime_env()
    python_install = run_cmd(
        [
            str(uv_binary),
            "python",
            "install",
            PINNED_PYTHON_VERSION,
            "--install-dir",
            str(UV_PYTHON_INSTALL_DIR),
        ],
        cwd=REPO_DIR,
        env=env,
    )
    if python_install.returncode != 0:
        details = trim_output(python_install.stderr or python_install.stdout)
        raise RuntimeError(f"Managed Python install failed:\n{details}")

    sync = run_cmd(
        [
            str(uv_binary),
            "sync",
            "--frozen",
            "--no-dev",
            "--no-install-project",
            "--directory",
            str(REPO_DIR),
            "--python",
            PINNED_PYTHON_VERSION,
            "--managed-python",
        ],
        cwd=REPO_DIR,
        env=env,
    )
    if sync.returncode != 0:
        details = trim_output(sync.stderr or sync.stdout)
        raise RuntimeError(f"Runtime sync failed:\n{details}")

    read_runtime_python_version.cache_clear()


def ensure_dependencies() -> None:
    ensure_runtime_dirs()
    if not VENV_PYTHON.exists():
        sync_managed_runtime()

    check_import = run_cmd(
        [str(VENV_PYTHON), "-c", "from gliner2_onnx import GLiNER2ONNXRuntime; print('ok')"],
        cwd=REPO_DIR,
        env=runtime_env(),
    )
    if check_import.returncode == 0:
        return

    sync_managed_runtime()

    verify = run_cmd(
        [str(VENV_PYTHON), "-c", "from gliner2_onnx import GLiNER2ONNXRuntime; print('ok')"],
        cwd=REPO_DIR,
        env=runtime_env(),
    )
    if verify.returncode != 0:
        details = trim_output(verify.stderr or verify.stdout)
        raise RuntimeError(f"Dependency verification failed:\n{details}")


def is_model_present() -> bool:
    """Check if model files already exist on disk (bundled or HF cache)."""
    required = ("config.json", "gliner2_config.json")
    bundled = REPO_DIR / ".runtime" / "cache" / "model" / "model"
    if bundled.is_dir() and all((bundled / f).exists() for f in required):
        return True
    hub_dir = HF_HUB_CACHE / "models--lmo3--gliner2-large-v1-onnx" / "snapshots"
    if hub_dir.is_dir():
        for snap in hub_dir.iterdir():
            if snap.is_dir() and all((snap / f).exists() for f in required):
                return True
    return False


def ensure_model_downloaded(model_id: str = "", extra_env: Dict[str, str] | None = None) -> None:
    if is_model_present():
        return
    cmd = [str(VENV_PYTHON), str(SCRIPT_PATH), "--download-only"]
    if str(model_id or "").strip():
        cmd.extend(["--model", str(model_id).strip()])
    download = run_cmd(
        cmd,
        cwd=REPO_DIR,
        env=runtime_env(extra_env),
    )
    if download.returncode != 0:
        details = trim_output(download.stderr or download.stdout)
        raise RuntimeError(
            "Model download failed. "
            "The default ONNX model is public, so no HF token is normally required. "
            "If you are using a private or gated model, set HF_TOKEN and retry, "
            "or set GLINER2_MODEL to a local model directory. "
            f"Details:\n{details}"
        )


def server_status() -> Dict[str, Any]:
    process_state = read_process_state()
    process_pid = normalize_pid(process_state.get("pid"))
    process_running = is_pid_running(process_pid)

    state = load_state()
    tracked_pid = normalize_pid(state.get("pid"))
    tracked_running = is_pid_running(tracked_pid)

    owned_pids = discover_owned_server_pids()
    owned_pid = owned_pids[0] if owned_pids else None
    healthy = is_server_healthy()
    port_open = is_port_open()
    running = bool(process_running or tracked_running or owned_pid or healthy)
    port_conflict = bool(port_open and not running and not healthy)

    if owned_pid and not tracked_running:
        remember_server_pid(owned_pid)

    if not running and not port_conflict:
        clear_process_state()
        save_state({})
    elif tracked_pid and not tracked_running and not healthy and not port_open:
        save_state({})

    return {
        "success": True,
        "running": running,
        "healthy": healthy,
        "pid": process_pid if process_running else (tracked_pid if tracked_running else owned_pid),
        "host": HOST_NAME,
        "logExists": LOG_FILE.exists(),
        "portConflict": port_conflict,
        "processPhase": str(process_state.get("phase") or "") if process_running else "",
        **runtime_meta(),
    }


def server_logs(lines: int = 120) -> Dict[str, Any]:
    return {
        "success": True,
        "logExists": LOG_FILE.exists(),
        "logLines": read_recent_logs(lines),
        **runtime_meta(),
    }


def start_server(
    install_deps: bool,
    download_model: bool,
    hf_token: str = "",
    model_id: str = "",
) -> Dict[str, Any]:
    status = server_status()
    if status["healthy"]:
        return {
            "success": True,
            "running": True,
            "healthy": True,
            "pid": status.get("pid"),
            "message": "Server already running (detected by health check).",
            **runtime_meta(),
        }

    if status["running"]:
        return {
            "success": True,
            "running": True,
            "healthy": False,
            "pid": status.get("pid"),
            "message": "Server is already starting.",
            **runtime_meta(),
        }

    # Check if a server process is still loading the model (wrote state file
    # but hasn't opened the port yet).  The process_state.json is written at
    # server startup before model loading begins.
    proc_state = read_process_state()
    proc_pid = proc_state.get("pid")
    if proc_pid and is_pid_running(proc_pid):
        healthy = wait_for_health()
        return {
            "success": True,
            "running": True,
            "healthy": healthy,
            "pid": proc_pid,
            "message": "Server started." if healthy else "Server is starting (model loading).",
            **runtime_meta(),
        }

    # If the port is already in use (e.g. autostart service loading the model),
    # wait for it to become healthy instead of launching a second server.
    if is_port_open():
        healthy = wait_for_health()
        if healthy:
            return {
                "success": True,
                "running": True,
                "healthy": True,
                "pid": status.get("pid"),
                "message": "Server started.",
                **runtime_meta(),
            }
        # Port open but never became healthy — true conflict with a non-AI-Safe Plugin process
        if status.get("portConflict"):
            return {
                "success": True,
                "running": False,
                "healthy": False,
                "pid": None,
                "portConflict": True,
                "message": "Port 8765 is already in use by another local process. AI-Safe Plugin will not stop it automatically.",
                **runtime_meta(),
            }
        # Port open, not healthy, but looks like our own server still loading
        return {
            "success": True,
            "running": True,
            "healthy": False,
            "pid": status.get("pid"),
            "message": "Server is starting (model loading).",
            **runtime_meta(),
        }

    hf_token_value = str(hf_token or "").strip()
    extra_env: Dict[str, str] = {}
    if hf_token_value:
        extra_env["HF_TOKEN"] = hf_token_value
        extra_env["HUGGING_FACE_HUB_TOKEN"] = hf_token_value

    resolved_model = str(model_id or "").strip() or os.environ.get(MODEL_ENV_VAR, "").strip()
    if resolved_model:
        extra_env[MODEL_ENV_VAR] = resolved_model

    # Skip expensive subprocess checks when the runtime is already set up.
    # These checks can trigger ONNX initialization errors on Windows when
    # another server instance is loading the model.
    runtime_ready = VENV_PYTHON.exists() and is_model_present()
    if install_deps and not runtime_ready:
        ensure_dependencies()

    if download_model and not runtime_ready:
        ensure_model_downloaded(resolved_model, extra_env)

    ensure_runtime_dirs()
    if not VENV_PYTHON.exists():
        raise RuntimeError("AI-Safe Plugin managed runtime is missing. Re-run the installer to restore the local environment.")
    log_handle = LOG_FILE.open("a", encoding="utf-8")
    cmd = [str(VENV_PYTHON), "-u", str(SCRIPT_PATH), "--host", SERVER_HOST, "--port", str(SERVER_PORT)]
    if resolved_model:
        cmd.extend(["--model", resolved_model])

    try:
        process = subprocess.Popen(
            cmd,
            **build_server_launch_kwargs(log_handle, extra_env),
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to launch local GLiNER2 server process: {exc}") from exc
    finally:
        log_handle.close()

    remember_server_pid(process.pid)

    healthy = wait_for_health()
    return {
        "success": True,
        "running": True,
        "healthy": healthy,
        "pid": process.pid,
        "message": "Server started." if healthy else "Server is starting (model loading).",
        **runtime_meta(),
    }


def stop_server() -> Dict[str, Any]:
    pids = tracked_server_pids()

    if not pids:
        clear_process_state()
        save_state({})
        return {
            "success": True,
            "running": False,
            "healthy": False,
            "message": "Server is not running.",
            **runtime_meta(),
        }

    failures = [pid for pid in pids if not kill_pid(pid)]
    if failures:
        return {
            "success": False,
            "error": f"Failed to stop AI-Safe Plugin-managed server process(es): {', '.join(map(str, failures))}.",
            "running": True,
            "healthy": is_server_healthy(),
            "pid": failures[0],
            **runtime_meta(),
        }

    clear_process_state()
    save_state({})
    return {
        "success": True,
        "running": False,
        "healthy": False,
        "message": "Server stopped.",
        **runtime_meta(),
    }


def restart_server(
    install_deps: bool,
    download_model: bool,
    hf_token: str = "",
    model_id: str = "",
) -> Dict[str, Any]:
    stop_result = stop_server()
    if not stop_result.get("success"):
        return stop_result
    return start_server(
        install_deps=install_deps,
        download_model=download_model,
        hf_token=hf_token,
        model_id=model_id,
    )


def get_server_token() -> Dict[str, Any]:
    """Return the local server's shared token so the extension can authenticate
    its detection requests. The server writes this file with 0600 permissions."""
    token_file = RUNTIME_DIR / "server_token"
    try:
        token = token_file.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return {"success": False, "error": "token_unavailable"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
    if not token:
        return {"success": False, "error": "token_unavailable"}
    return {"success": True, "token": token}


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    action = request.get("action")
    if action == "status":
        return server_status()
    if action == "get_server_token":
        return get_server_token()
    if action == "start":
        return start_server(
            install_deps=bool(request.get("installDeps", True)),
            download_model=bool(request.get("downloadModel", True)),
            hf_token=str(request.get("hfToken", "")),
            model_id=str(request.get("modelId", "")),
        )
    if action == "stop":
        return stop_server()
    if action == "restart":
        return restart_server(
            install_deps=bool(request.get("installDeps", True)),
            download_model=bool(request.get("downloadModel", True)),
            hf_token=str(request.get("hfToken", "")),
            model_id=str(request.get("modelId", "")),
        )
    if action == "logs":
        raw_lines = request.get("lines", 120)
        try:
            lines = int(raw_lines)
        except (TypeError, ValueError):
            lines = 120
        return server_logs(lines=lines)
    return {"success": False, "error": f"Unsupported action: {action}"}


def main() -> None:
    try:
        request = read_native_message()
        if not request:
            return
        response = handle_request(request)
    except Exception as exc:  # broad for native messaging stability
        response = {"success": False, "error": str(exc)}
    send_native_message(response)


if __name__ == "__main__":
    main()
