#!/usr/bin/env python3
"""Assemble the Windows installer payload for AI-Safe Plugin."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
STAGING_ROOT = DIST / "windows-installer"
STAGE_DIR = STAGING_ROOT / "stage"
METADATA_ISS = STAGING_ROOT / "metadata.iss"
MODEL_ASSET_NAME = "ai-safe-plugin-model-fp16.tar.gz"
BUNDLE_RELEASE_ARCNAME = Path(".runtime") / "bundle_release.json"
COPY_PATHS = [
    ROOT / "server",
    ROOT / "scripts" / "installers",
    ROOT / "pyproject.toml",
    ROOT / "uv.lock",
    ROOT / ".python-version",
    ROOT / "LICENSE",
]
REPO_SLUG = "Maya-Data-Privacy/AI-Safe-Plugin"


def load_package_version() -> str:
    package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return str(package_json["version"]).strip()


def build_release_metadata() -> dict[str, str]:
    version = load_package_version()
    tag = str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_TAG") or "").strip() or f"v{version}"
    return {
        "tag": tag,
        "published_at": str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_PUBLISHED_AT") or "").strip(),
        "html_url": str(os.environ.get("AI_SAFE_PLUGIN_RELEASE_HTML_URL") or "").strip()
        or f"https://github.com/{REPO_SLUG}/releases/tag/{tag}",
        "repository": REPO_SLUG,
    }


def clean_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def copy_path(path: Path, destination_root: Path) -> None:
    target = destination_root / path.relative_to(ROOT)
    if path.is_dir():
        shutil.copytree(path, target, dirs_exist_ok=True)
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)


def write_release_metadata(stage_dir: Path) -> None:
    target = stage_dir / BUNDLE_RELEASE_ARCNAME
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(build_release_metadata(), indent=2) + "\n"
    target.write_text(payload, encoding="utf-8")


def write_metadata_iss() -> None:
    version = load_package_version()
    release_metadata = build_release_metadata()
    tag = release_metadata["tag"]
    model_asset_url = f"https://github.com/{REPO_SLUG}/releases/download/{tag}/{MODEL_ASSET_NAME}"
    escaped_stage_dir = str(STAGE_DIR).replace("\\", "\\\\")
    lines = [
        f'#define MyAppName "AI-Safe Plugin"',
        f'#define MyAppVersion "{version}"',
        f'#define MyAppPublisher "Maya Data Privacy"',
        f'#define MyAppCopyright "Copyright (c) Maya Data Privacy"',
        f'#define MyAppUrl "https://github.com/{REPO_SLUG}"',
        f'#define MyReleaseTag "{tag}"',
        f'#define MyRepositorySlug "{REPO_SLUG}"',
        f'#define MyModelAssetName "{MODEL_ASSET_NAME}"',
        f'#define MyModelAssetUrl "{model_asset_url}"',
        f'#define MyStageDir "{escaped_stage_dir}"',
        "",
    ]
    STAGING_ROOT.mkdir(parents=True, exist_ok=True)
    METADATA_ISS.write_text("\n".join(lines), encoding="utf-8")


def build_stage() -> None:
    clean_dir(STAGE_DIR)
    for path in COPY_PATHS:
        if not path.exists():
            raise FileNotFoundError(f"Required installer input is missing: {path}")
        copy_path(path, STAGE_DIR)
    write_release_metadata(STAGE_DIR)
    write_metadata_iss()


def main() -> None:
    build_stage()
    print(f"Built Windows installer staging directory at {STAGE_DIR}")
    print(f"Wrote Inno Setup metadata to {METADATA_ISS}")


if __name__ == "__main__":
    main()
