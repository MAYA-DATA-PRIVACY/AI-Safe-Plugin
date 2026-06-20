"""
Regression tests for the Windows setup packaging flow.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "build_windows_installer.py"
ISS_PATH = ROOT / "packaging" / "windows" / "VeilSetup.iss"
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "release.yml"
POPUP_SCRIPT_PATH = ROOT / "extension" / "popup.js"


def load_module():
    spec = importlib.util.spec_from_file_location("build_windows_installer", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_build_stage_copies_installer_scripts_and_writes_model_asset_metadata(tmp_path, monkeypatch):
    module = load_module()
    repo_root = tmp_path / "repo"
    dist_dir = repo_root / "dist"
    dist_dir.mkdir(parents=True)

    (repo_root / "package.json").write_text('{"version":"9.9.9"}', encoding="utf-8")
    (repo_root / "pyproject.toml").write_text('version = "9.9.9"\n', encoding="utf-8")
    (repo_root / "uv.lock").write_text("", encoding="utf-8")
    (repo_root / ".python-version").write_text("3.11\n", encoding="utf-8")
    (repo_root / "LICENSE").write_text("MIT\n", encoding="utf-8")

    server_dir = repo_root / "server"
    server_dir.mkdir()
    (server_dir / "native_host.py").write_text("print('veil')\n", encoding="utf-8")

    installers_dir = repo_root / "scripts" / "installers"
    installers_dir.mkdir(parents=True)
    (installers_dir / "install.ps1").write_text("Write-Host 'veil'\n", encoding="utf-8")

    monkeypatch.setattr(module, "ROOT", repo_root)
    monkeypatch.setattr(module, "DIST", dist_dir)
    monkeypatch.setattr(module, "STAGING_ROOT", dist_dir / "windows-installer")
    monkeypatch.setattr(module, "STAGE_DIR", dist_dir / "windows-installer" / "stage")
    monkeypatch.setattr(module, "METADATA_ISS", dist_dir / "windows-installer" / "metadata.iss")
    monkeypatch.setattr(
        module,
        "COPY_PATHS",
        [
            repo_root / "server",
            repo_root / "scripts" / "installers",
            repo_root / "pyproject.toml",
            repo_root / "uv.lock",
            repo_root / ".python-version",
            repo_root / "LICENSE",
        ],
    )

    module.build_stage()

    assert (module.STAGE_DIR / "server" / "native_host.py").exists()
    assert (module.STAGE_DIR / "scripts" / "installers" / "install.ps1").exists()
    assert not (module.STAGE_DIR / ".venv").exists()
    assert not (module.STAGE_DIR / ".runtime" / "cache" / "model" / "model" / "config.json").exists()

    release_meta = json.loads((module.STAGE_DIR / ".runtime" / "bundle_release.json").read_text(encoding="utf-8"))
    assert release_meta["tag"] == "v9.9.9"
    assert release_meta["repository"] == "Maya-Data-Privacy/Veil"

    metadata_iss = module.METADATA_ISS.read_text(encoding="utf-8")
    assert '#define MyAppVersion "9.9.9"' in metadata_iss
    assert '#define MyReleaseTag "v9.9.9"' in metadata_iss
    assert '#define MyModelAssetName "veil-model-fp16.tar.gz"' in metadata_iss
    assert '#define MyModelAssetUrl "https://github.com/Maya-Data-Privacy/Veil/releases/download/v9.9.9/veil-model-fp16.tar.gz"' in metadata_iss
    assert '#define MyStageDir "' in metadata_iss


def test_release_workflow_builds_and_publishes_windows_setup():
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    windows_job = workflow.split("build-windows-installer:", 1)[1].split("publish-release-assets:", 1)[0]

    assert "build-windows-installer:" in workflow
    assert "runs-on: windows-latest" in workflow
    assert 'choco install innosetup --no-progress -y' in workflow
    assert 'ISCC.exe' in workflow
    assert "actions/upload-artifact@v7" in workflow
    assert "actions/download-artifact@v8" in workflow
    assert "dist/VeilSetup-${{ needs.verify-release-version.outputs.release_version }}.exe" in workflow
    assert "dist/VeilSetup.exe" in workflow
    assert "scripts/build_model_bundle.py" not in windows_job
    assert "dist/veil-model-fp16.tar.gz" in workflow


def test_release_workflow_publishes_asset_checksums():
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")

    # A SHA256SUMS file is generated over the staged assets and uploaded.
    assert "Generate asset checksums" in workflow
    assert "sha256sum" in workflow
    assert "> SHA256SUMS" in workflow
    assert "dist/SHA256SUMS" in workflow


def test_inno_setup_script_uses_branding_extension_id_capture_and_model_download_pages():
    script = ISS_PATH.read_text(encoding="utf-8")

    assert "SetupIconFile=assets\\veil-installer.ico" in script
    assert "WizardImageFile=assets\\veil-wizard.bmp" in script
    assert "WizardSmallImageFile=assets\\veil-wizard-small.bmp" in script
    assert "CreateInputQueryPage" in script
    assert "scripts\\installers\\install.ps1" in script
    assert "-UseExistingBundle" in script
    assert "/EXTENSION_ID=<id>" in script
    assert "if GetCliExtensionId() <> '' then" in script
    assert "CreateDownloadPage" in script
    assert "CreateExtractionPage" in script
    assert "{#MyModelAssetUrl}" in script
    assert "Result := AddBackslash(GetTemporaryExtractDir()) + 'veil-model-fp16.tar';" in script
    assert "Type: filesandordirs; Name: \"{app}\\.runtime\"" in script


def test_popup_windows_install_command_prefers_stable_setup_exe():
    script = POPUP_SCRIPT_PATH.read_text(encoding="utf-8")

    assert "VeilSetup.exe" in script
    assert "/EXTENSION_ID=${chrome.runtime.id}" in script
    assert "-Command '$installer = Join-Path $env:TEMP ''VeilSetup.exe'';" in script
    assert "install.ps1" in script
