"""
Regression tests for server/native_host.py utility behavior.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "server"))

import native_host


@pytest.fixture()
def runtime_paths(monkeypatch, tmp_path):
    runtime_dir = tmp_path / "runtime"
    cache_dir = runtime_dir / "cache"
    monkeypatch.setattr(native_host, "RUNTIME_DIR", runtime_dir)
    monkeypatch.setattr(native_host, "STATE_DIR", runtime_dir)
    monkeypatch.setattr(native_host, "STATE_FILE", runtime_dir / "native_host_state.json")
    monkeypatch.setattr(native_host, "LOG_FILE", runtime_dir / "gliner2_server.log")
    monkeypatch.setattr(native_host, "CACHE_DIR", cache_dir)
    monkeypatch.setattr(native_host, "PIP_CACHE_DIR", cache_dir / "pip")
    monkeypatch.setattr(native_host, "HF_HOME", cache_dir / "hf")
    monkeypatch.setattr(native_host, "HF_HUB_CACHE", cache_dir / "hf" / "hub")
    monkeypatch.setattr(native_host, "TRANSFORMERS_CACHE", cache_dir / "hf" / "transformers")
    monkeypatch.setattr(native_host, "XDG_CACHE_HOME", cache_dir / "xdg")
    monkeypatch.setattr(native_host, "UV_CACHE_DIR", cache_dir / "uv")
    monkeypatch.setattr(native_host, "UV_PYTHON_INSTALL_DIR", runtime_dir / "python")
    monkeypatch.setattr(native_host, "UV_BIN_DIR", runtime_dir / "tools" / "uv")
    monkeypatch.setattr(native_host, "UV_BINARY", runtime_dir / "tools" / "uv" / ("uv.exe" if native_host.os.name == "nt" else "uv"))
    monkeypatch.setattr(native_host, "RELEASE_INFO_FILE", runtime_dir / "bundle_release.json")
    monkeypatch.setattr(native_host, "PROCESS_STATE_FILE", runtime_dir / "server_process.json")
    monkeypatch.setattr(native_host, "PYPROJECT_FILE", tmp_path / "pyproject.toml")
    monkeypatch.setattr(native_host, "UV_LOCK_FILE", tmp_path / "uv.lock")
    return runtime_dir


def test_load_state_reads_existing_json(runtime_paths):
    native_host.ensure_runtime_dirs()
    native_host.STATE_FILE.write_text('{"pid": 1234}', encoding="utf-8")

    assert native_host.load_state() == {"pid": 1234}


def test_read_process_state_reads_existing_json(runtime_paths):
    native_host.ensure_runtime_dirs()
    native_host.PROCESS_STATE_FILE.write_text('{"pid": 5678, "session_id": "abc"}', encoding="utf-8")

    assert native_host.read_process_state() == {"pid": 5678, "session_id": "abc"}


def test_get_server_token_returns_token_when_present(runtime_paths):
    native_host.ensure_runtime_dirs()
    (native_host.RUNTIME_DIR / "server_token").write_text("deadbeef\n", encoding="utf-8")

    result = native_host.handle_request({"action": "get_server_token"})

    assert result == {"success": True, "token": "deadbeef"}


def test_get_server_token_reports_unavailable_when_missing(runtime_paths):
    native_host.ensure_runtime_dirs()

    result = native_host.get_server_token()

    assert result == {"success": False, "error": "token_unavailable"}


def test_read_bundle_release_info_reads_installed_bundle_metadata(runtime_paths):
    native_host.ensure_runtime_dirs()
    native_host.RELEASE_INFO_FILE.write_text(
        '{"tag":"v1.2.5","published_at":"2026-04-02T12:34:56Z","html_url":"https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v1.2.5","installed_at":"2026-04-02T12:40:00Z"}',
        encoding="utf-8",
    )

    assert native_host.read_bundle_release_info() == {
        "bundleReleaseTag": "v1.2.5",
        "bundleReleasePublishedAt": "2026-04-02T12:34:56Z",
        "bundleReleaseUrl": "https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v1.2.5",
        "bundleReleaseInstalledAt": "2026-04-02T12:40:00Z",
    }


def test_read_bundle_release_info_falls_back_to_unknown_for_invalid_json(runtime_paths):
    native_host.ensure_runtime_dirs()
    native_host.RELEASE_INFO_FILE.write_text("{invalid", encoding="utf-8")

    assert native_host.read_bundle_release_info() == {
        "bundleReleaseTag": None,
        "bundleReleasePublishedAt": None,
        "bundleReleaseUrl": None,
        "bundleReleaseInstalledAt": None,
    }


def test_start_server_reports_port_conflict_for_non_ai_safe_plugin_process(monkeypatch, runtime_paths):
    monkeypatch.setattr(native_host, "is_server_healthy", lambda: False)
    monkeypatch.setattr(native_host, "is_port_open", lambda host="127.0.0.1", port=8765: True)
    monkeypatch.setattr(native_host, "wait_for_health", lambda timeout=native_host.WAIT_SECONDS: False)
    monkeypatch.setattr(native_host, "discover_owned_server_pids", lambda: [])
    monkeypatch.setattr(native_host, "load_state", lambda: {})
    monkeypatch.setattr(native_host, "read_process_state", lambda: {})
    monkeypatch.setattr(native_host, "runtime_meta", lambda: {})

    def fail_popen(*args, **kwargs):
        raise AssertionError("start_server should not spawn a new process when port 8765 is already bound")

    monkeypatch.setattr(native_host.subprocess, "Popen", fail_popen)

    result = native_host.start_server(install_deps=False, download_model=False)

    assert result["success"] is True
    assert result["running"] is False
    assert result["healthy"] is False
    assert result["portConflict"] is True
    assert "already in use by another local process" in result["message"]


def test_server_status_treats_loading_tracked_process_as_owned(monkeypatch, runtime_paths):
    monkeypatch.setattr(native_host, "read_process_state", lambda: {"pid": "4242", "phase": "loading_model"})
    monkeypatch.setattr(native_host, "load_state", lambda: {})
    monkeypatch.setattr(native_host, "is_pid_running", lambda pid: pid is not None and int(pid) == 4242)
    monkeypatch.setattr(native_host, "discover_owned_server_pids", lambda: [])
    monkeypatch.setattr(native_host, "is_server_healthy", lambda: False)
    monkeypatch.setattr(native_host, "is_port_open", lambda host="127.0.0.1", port=8765: True)
    monkeypatch.setattr(native_host, "read_runtime_python_version", lambda: None)
    monkeypatch.setattr(native_host, "resolve_uv_binary", lambda: None)
    monkeypatch.setattr(native_host, "read_uv_version", lambda: None)

    result = native_host.server_status()

    assert result["running"] is True
    assert result["healthy"] is False
    assert result["pid"] == 4242
    assert result["portConflict"] is False
    assert result["processPhase"] == "loading_model"


def test_stop_server_only_targets_tracked_ai_safe_plugin_processes(monkeypatch, runtime_paths):
    stopped = []
    monkeypatch.setattr(native_host, "tracked_server_pids", lambda: [4242])
    monkeypatch.setattr(native_host, "kill_pid", lambda pid: stopped.append(pid) or True)
    monkeypatch.setattr(native_host, "runtime_meta", lambda: {})

    result = native_host.stop_server()

    assert result["success"] is True
    assert result["running"] is False
    assert stopped == [4242]


def test_restart_server_stops_then_starts(monkeypatch, runtime_paths):
    events = []
    monkeypatch.setattr(native_host, "stop_server", lambda: events.append("stop") or {"success": True})
    monkeypatch.setattr(
        native_host,
        "start_server",
        lambda install_deps, download_model, hf_token="", model_id="": events.append(
            ("start", install_deps, download_model, hf_token, model_id)
        ) or {"success": True, "running": True},
    )

    result = native_host.restart_server(
        install_deps=True,
        download_model=False,
        hf_token="hf_token",
        model_id="fastino/gliner2-large-v1",
    )

    assert result["success"] is True
    assert events == [
        "stop",
        ("start", True, False, "hf_token", "fastino/gliner2-large-v1"),
    ]


def test_is_pid_running_uses_windows_process_query(monkeypatch):
    monkeypatch.setattr(native_host, "is_windows_platform", lambda: True)
    monkeypatch.setattr(native_host, "is_pid_running_windows", lambda pid: pid == 4242)
    monkeypatch.setattr(native_host.os, "kill", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("os.kill should not be used on Windows pid probes")))

    assert native_host.is_pid_running(4242) is True
    assert native_host.is_pid_running(7) is False


def test_owned_server_command_matches_windows_autostart_wrapper(monkeypatch):
    repo_dir = Path("C:/Users/example/AppData/Local/AI-Safe-Plugin")
    monkeypatch.setattr(native_host, "is_windows_platform", lambda: True)
    monkeypatch.setattr(native_host, "REPO_DIR", repo_dir)
    monkeypatch.setattr(native_host, "SCRIPT_PATH", repo_dir / "server" / "gliner2_server.py")
    monkeypatch.setattr(native_host, "AUTOSTART_WRAPPER_PATH", repo_dir / "server" / "autostart" / "start_server.cmd")

    assert native_host.is_owned_server_command(
        r'cmd.exe /d /c "C:\Users\example\AppData\Local\AI-Safe-Plugin\server\autostart\start_server.cmd"'
    )
    assert native_host.is_owned_server_command(
        r'"C:\Users\example\AppData\Local\AI-Safe-Plugin\.venv\Scripts\python.exe" "C:\Users\example\AppData\Local\AI-Safe-Plugin\server\gliner2_server.py" --host 127.0.0.1 --port 8765'
    )
    assert not native_host.is_owned_server_command(
        r'"C:\other\AI-Safe-Plugin\.venv\Scripts\python.exe" "C:\other\AI-Safe-Plugin\server\gliner2_server.py"'
    )


def test_kill_pid_windows_uses_taskkill(monkeypatch):
    calls = []
    running_states = iter([True, False])
    monkeypatch.setattr(native_host, "is_windows_platform", lambda: True)
    monkeypatch.setattr(native_host, "is_pid_running", lambda pid: next(running_states))
    monkeypatch.setattr(native_host, "run_cmd", lambda cmd, cwd=None, env=None: calls.append(cmd) or SimpleNamespace(returncode=0))
    monkeypatch.setattr(native_host.os, "kill", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("os.kill should not be used on Windows stop path")))

    assert native_host.kill_pid(4242) is True
    assert calls == [["taskkill", "/PID", "4242", "/T"]]


def test_build_server_launch_kwargs_uses_windows_creationflags(monkeypatch):
    monkeypatch.setattr(native_host, "is_windows_platform", lambda: True)
    monkeypatch.setattr(native_host.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200, raising=False)
    monkeypatch.setattr(native_host.subprocess, "CREATE_NO_WINDOW", 0x08000000, raising=False)

    kwargs = native_host.build_server_launch_kwargs(log_handle=object(), extra_env={"HF_TOKEN": "secret"})

    assert kwargs["stdin"] is native_host.subprocess.DEVNULL
    assert kwargs["creationflags"] == 0x08000200
    assert "start_new_session" not in kwargs
    assert kwargs["env"]["HF_TOKEN"] == "secret"
    assert kwargs["env"]["PYTHONUNBUFFERED"] == "1"


def test_start_server_wraps_launch_failures(monkeypatch, runtime_paths):
    venv_python = runtime_paths / ".venv" / "Scripts" / "python.exe"
    venv_python.parent.mkdir(parents=True, exist_ok=True)
    venv_python.write_text("", encoding="utf-8")
    monkeypatch.setattr(native_host, "VENV_PYTHON", venv_python)
    monkeypatch.setattr(native_host, "server_status", lambda: {"healthy": False, "running": False})
    monkeypatch.setattr(native_host, "read_process_state", lambda: {})
    monkeypatch.setattr(native_host, "is_port_open", lambda host="127.0.0.1", port=8765: False)
    monkeypatch.setattr(native_host, "build_server_launch_kwargs", lambda log_handle, extra_env=None: {})
    monkeypatch.setattr(
        native_host.subprocess,
        "Popen",
        lambda *args, **kwargs: (_ for _ in ()).throw(SystemError("<class 'OSError'> returned a result with an exception set")),
    )

    with pytest.raises(RuntimeError, match="Failed to launch local GLiNER2 server process"):
        native_host.start_server(install_deps=False, download_model=False)
