"""
Regression tests for the Unix installer metadata stamping path.
"""
from pathlib import Path


INSTALLER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "installers" / "install.sh"
UNINSTALLER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "installers" / "uninstall.sh"


def test_release_metadata_uses_field_extraction_instead_of_greedy_html_url_matching():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "extract_release_field()" in script
    assert 'grep -o "\\"${field}\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\""' in script
    assert '"html_url"[[:space:]]*:[[:space:]]*"\\([^"]*\\)"' not in script


def test_installer_stamps_installed_release_metadata_from_the_bundled_file():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert 'stamp_release_metadata "${INSTALL_DIR}/.runtime/bundle_release.json" "${INSTALL_DIR}/.runtime/bundle_release.json"' in script
    assert 'tag="$(extract_release_field "${payload}" "tag")"' in script
    assert 'tag="$(extract_release_field "${payload}" "tag_name")"' in script
    assert "RELEASE_API=" not in script
    assert 'curl -fsSL "${RELEASE_API}"' not in script


def test_unix_installer_reuses_existing_model_cache_before_downloading_again():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "model_cache_present()" in script
    assert 'if model_cache_present; then' in script
    assert 'echo "Existing GLiNER2 model cache found; skipping download."' in script


def test_unix_installer_hardens_macos_runtime_against_sigkill():
    # Regression: Apple Silicon SIGKILLs the downloaded CPython unless quarantine is
    # stripped and the Mach-O files are (ad-hoc) re-signed before `uv sync` runs.
    script = INSTALLER_PATH.read_text(encoding="utf-8")
    assert "harden_macos_runtime" in script
    assert "xattr -dr com.apple.quarantine" in script
    assert "codesign --force --sign -" in script


def test_uninstaller_waits_for_process_shutdown_and_retries_directory_removal():
    script = UNINSTALLER_PATH.read_text(encoding="utf-8")

    assert "wait_for_ai_safe_plugin_shutdown" in script
    assert "remove_install_dir" in script
    assert 'wait_for_ai_safe_plugin_shutdown "${INSTALL_DIR}" || true' in script
    assert 'remove_install_dir "${INSTALL_DIR}"' in script


def test_unix_installer_verifies_asset_checksums():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    # Verification helper exists and fetches the release SHA256SUMS.
    assert "verify_asset_checksum()" in script
    assert "${RELEASE_BASE}/SHA256SUMS" in script
    # Backend bundle is verified (hard) before extraction.
    assert 'verify_asset_checksum "${ARCHIVE_PATH}" hard' in script
    # Model is verified (soft) and only extracted when verification passes.
    assert 'verify_asset_checksum "${MODEL_ARCHIVE}" soft' in script


def test_unix_installer_defaults_to_pinned_extension_id():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert 'DEFAULT_EXTENSION_ID="aggkonihfabdcbgomkfecjhdolddfabe"' in script
    assert 'EXTENSION_IDS=("${DEFAULT_EXTENSION_ID}")' in script
    assert 'No extension id supplied; using the pinned AI-Safe Plugin id ${DEFAULT_EXTENSION_ID}.' in script
    assert 'fail "Usage: curl .../install.sh | bash -s -- --extension-id <EXTENSION_ID>' not in script

def test_unix_installer_warns_and_continues_when_sha256sums_missing():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "SHA256SUMS not available from release; skipping checksum verification" in script
    # A hard mismatch aborts via fail(); missing sums returns 0 (continue).
    assert "Checksum verification failed for ${asset_name}. Aborting install." in script


def test_unix_installer_auto_detects_installed_extension_ids():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    # Belt-and-suspenders: scan local Chromium profiles for the published build
    # (whose id Google assigns) and register it alongside the pinned default.
    assert "detect_installed_extension_ids()" in script
    assert '"name"[[:space:]]*:[[:space:]]*"MAYA AISafe Plugin"' in script
    assert "-name manifest.json -path '*/Extensions/*'" in script
    assert "EXTENSION_IDS+=(\"${detected_id}\")" in script
    # The pinned default must still be the fallback when nothing is detected.
    assert 'EXTENSION_IDS=("${DEFAULT_EXTENSION_ID}")' in script
