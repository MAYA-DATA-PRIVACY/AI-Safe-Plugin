#!/usr/bin/env python3
"""Build release assets for the local AI-Safe Plugin backend installer."""

from __future__ import annotations

import io
import json
import os
import shutil
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
UNIX_ARCHIVE = DIST / "ai-safe-plugin-backend-unix.tar.gz"
WINDOWS_ARCHIVE = DIST / "ai-safe-plugin-backend-windows.zip"
REPO_SLUG = "Maya-Data-Privacy/AI-Safe-Plugin"
BUNDLE_RELEASE_ARCNAME = ".runtime/bundle_release.json"
INSTALLER_FILES = [
    ROOT / "scripts" / "installers" / "install.sh",
    ROOT / "scripts" / "installers" / "install.ps1",
    ROOT / "scripts" / "installers" / "uninstall.sh",
    ROOT / "scripts" / "installers" / "uninstall.ps1",
]
INCLUDE_PATHS = [
    ROOT / "server",
    ROOT / "pyproject.toml",
    ROOT / "uv.lock",
    ROOT / ".python-version",
    ROOT / "LICENSE",
]
SKIP_DIRS = {"__pycache__", ".pytest_cache"}
SKIP_SUFFIXES = {".pyc", ".pyo", ".DS_Store"}


def load_package_version() -> str:
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package_json["version"]).strip()


def build_release_metadata() -> dict[str, str]:
    tag = str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_TAG") or "").strip()
    if not tag:
        tag = f"v{load_package_version()}"

    html_url = str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_HTML_URL") or "").strip()
    if not html_url:
        html_url = f"https://github.com/{REPO_SLUG}/releases/tag/{tag}"

    return {
        "tag": tag,
        "published_at": str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_PUBLISHED_AT") or "").strip(),
        "html_url": html_url,
        "repository": REPO_SLUG,
    }


def serialize_release_metadata() -> bytes:
    payload = json.dumps(build_release_metadata(), indent=2)
    return f"{payload}\n".encode("utf-8")


def iter_files(base: Path):
    if base.is_file():
        yield base
        return

    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix in SKIP_SUFFIXES or path.name in SKIP_SUFFIXES:
            continue
        yield path


def build_unix_archive() -> None:
    metadata_bytes = serialize_release_metadata()
    with tarfile.open(UNIX_ARCHIVE, "w:gz") as archive:
        for base in INCLUDE_PATHS:
            for path in iter_files(base):
                archive.add(path, arcname=path.relative_to(ROOT))
        tar_info = tarfile.TarInfo(BUNDLE_RELEASE_ARCNAME)
        tar_info.size = len(metadata_bytes)
        archive.addfile(tar_info, io.BytesIO(metadata_bytes))


def build_windows_archive() -> None:
    metadata_bytes = serialize_release_metadata()
    with zipfile.ZipFile(WINDOWS_ARCHIVE, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for base in INCLUDE_PATHS:
            for path in iter_files(base):
                archive.write(path, arcname=path.relative_to(ROOT))
        archive.writestr(BUNDLE_RELEASE_ARCNAME, metadata_bytes)


def main() -> None:
    DIST.mkdir(parents=True, exist_ok=True)
    build_unix_archive()
    build_windows_archive()
    for installer in INSTALLER_FILES:
        shutil.copy2(installer, DIST / installer.name)
    print(f"Built {UNIX_ARCHIVE}")
    print(f"Built {WINDOWS_ARCHIVE}")
    for installer in INSTALLER_FILES:
        print(f"Copied {DIST / installer.name}")


if __name__ == "__main__":
    main()
