"""
Regression tests for bundled backend release metadata.
"""
from __future__ import annotations

import importlib.util
import io
import json
import tarfile
import zipfile
from pathlib import Path


SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "build_backend_bundle.py"


def load_build_bundle_module():
    spec = importlib.util.spec_from_file_location("ai_safe_plugin_build_backend_bundle", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_build_release_metadata_defaults_to_the_repo_version(monkeypatch):
    module = load_build_bundle_module()

    monkeypatch.delenv("AI_SAFE_PLUGIN_RELEASE_TAG", raising=False)
    monkeypatch.delenv("AI_SAFE_PLUGIN_RELEASE_PUBLISHED_AT", raising=False)
    monkeypatch.delenv("AI_SAFE_PLUGIN_RELEASE_HTML_URL", raising=False)

    metadata = module.build_release_metadata()

    assert metadata["tag"] == f"v{module.load_package_version()}"
    assert metadata["repository"] == "Maya-Data-Privacy/AI-Safe-Plugin"
    assert metadata["html_url"].endswith(f"/releases/tag/v{module.load_package_version()}")


def test_backend_archives_embed_bundle_release_metadata(monkeypatch, tmp_path):
    module = load_build_bundle_module()

    monkeypatch.setattr(module, "DIST", tmp_path)
    monkeypatch.setattr(module, "UNIX_ARCHIVE", tmp_path / "ai-safe-plugin-backend-unix.tar.gz")
    monkeypatch.setattr(module, "WINDOWS_ARCHIVE", tmp_path / "ai-safe-plugin-backend-windows.zip")
    monkeypatch.setenv("AI_SAFE_PLUGIN_RELEASE_TAG", "v1.2.5")
    monkeypatch.setenv("AI_SAFE_PLUGIN_RELEASE_PUBLISHED_AT", "2026-04-02T12:34:56Z")
    monkeypatch.setenv("AI_SAFE_PLUGIN_RELEASE_HTML_URL", "https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v1.2.5")

    module.build_unix_archive()
    module.build_windows_archive()

    with tarfile.open(module.UNIX_ARCHIVE, "r:gz") as archive:
        member = archive.extractfile(module.BUNDLE_RELEASE_ARCNAME)
        assert member is not None
        unix_metadata = json.load(io.TextIOWrapper(member, encoding="utf-8"))

    with zipfile.ZipFile(module.WINDOWS_ARCHIVE) as archive:
        windows_metadata = json.loads(archive.read(module.BUNDLE_RELEASE_ARCNAME).decode("utf-8"))

    for payload in (unix_metadata, windows_metadata):
        assert payload == {
            "tag": "v1.2.5",
            "published_at": "2026-04-02T12:34:56Z",
            "html_url": "https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/tag/v1.2.5",
            "repository": "Maya-Data-Privacy/AI-Safe-Plugin",
        }
