"""
Regression tests for the Windows PowerShell installer script.
"""
from pathlib import Path
import re


INSTALLER_PATH = Path(__file__).resolve().parents[2] / "scripts" / "installers" / "install.ps1"
AUTOSTART_INSTALLER_PATH = Path(__file__).resolve().parents[2] / "server" / "autostart" / "install_windows.bat"
AUTOSTART_UNINSTALLER_PATH = Path(__file__).resolve().parents[2] / "server" / "autostart" / "uninstall_windows.bat"
NATIVE_HOST_INSTALLER_PATH = Path(__file__).resolve().parents[2] / "server" / "native-host" / "install_windows.bat"
PINNED_EXTENSION_ID = "aggkonihfabdcbgomkfecjhdolddfabe"


def test_uv_bootstrap_output_is_not_returned_from_ensure_ai_safe_plugin_uv():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    # The nested PowerShell installer can print status lines to stdout.
    # Those lines must stay on the console instead of becoming part of
    # Ensure-AiSafePluginUv's return value, or $uvExe turns into an array.
    assert "& powershell -NoProfile -ExecutionPolicy Bypass -File $uvInstaller | Out-Host" in script
    assert "$uvInstallExitCode = $LASTEXITCODE" in script
    assert 'throw "uv installer failed with exit code $uvInstallExitCode."' in script

    direct_invoke = re.compile(
        r"^\s*& powershell -NoProfile -ExecutionPolicy Bypass -File \$uvInstaller\s*$",
        re.MULTILINE,
    )
    assert direct_invoke.search(script) is None


def test_install_ai_safe_plugin_starts_the_server_now_and_treats_autostart_as_a_warning():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "function Start-AiSafePluginServerNow" in script
    assert "function Test-AiSafePluginServerProcessStarting" in script
    assert 'Start-Process -FilePath $venvPython -ArgumentList @("-u", $serverScript, "--host", "127.0.0.1", "--port", "8765")' in script
    assert 'if (Test-AiSafePluginServerProcessStarting -InstallDir $InstallDir)' in script
    assert 'Write-Host "AI-Safe Plugin server is still loading GLiNER2 for the current session."' in script
    assert 'Write-Host "Warning: AI-Safe Plugin install completed, but autostart could not be registered.' in script
    assert "Start-AiSafePluginServerNow -InstallDir $InstallDir | Out-Null" in script


def test_install_ai_safe_plugin_can_finalize_the_bundle_already_copied_by_windows_setup():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "[switch]$UseExistingBundle" in script
    assert "function Assert-AiSafePluginBundledPayload" in script
    assert 'Write-Host "Using the AI-Safe Plugin files already installed by AISafePluginSetup.exe..."' in script
    assert 'if ($UseExistingBundle)' in script
    assert 'Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $archivePath' in script


def test_install_ai_safe_plugin_stamps_release_metadata_from_the_bundled_file_without_api_calls():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "[string]$SourcePath" in script
    assert 'Write-AiSafePluginReleaseMetadata -SourcePath (Join-Path $runtimeDir "bundle_release.json")' in script
    assert 'Invoke-RestMethod -UseBasicParsing -Uri $releaseApi' not in script


def test_install_ai_safe_plugin_reuses_existing_model_cache_before_downloading_again():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "function Test-AiSafePluginModelPresent" in script
    assert "function Test-AiSafePluginModelFilesPresent" in script
    assert 'if (Test-AiSafePluginModelPresent -InstallDir $InstallDir)' in script
    assert 'Write-Host "Existing GLiNER2 model cache found; skipping download."' in script


def test_windows_autostart_script_prints_powershell_safe_manual_start_guidance():
    script = AUTOSTART_INSTALLER_PATH.read_text(encoding="utf-8")

    assert "Manual start from PowerShell:" in script
    assert 'Start-Process "%VENV_PYTHON%" -ArgumentList' in script


def test_windows_autostart_uses_compact_task_name_and_cleans_legacy_names():
    install_script = AUTOSTART_INSTALLER_PATH.read_text(encoding="utf-8")
    uninstall_script = AUTOSTART_UNINSTALLER_PATH.read_text(encoding="utf-8")

    assert 'set "TASK_NAME=AISafePluginGLiNER2"' in install_script
    assert 'schtasks /delete /tn "AI-Safe Plugin GLiNER Server" /f' in install_script
    assert 'schtasks /delete /tn "PrivacyShieldGLiNER2" /f' in install_script
    assert 'call :remove_task "AISafePluginGLiNER2"' in uninstall_script
    assert 'call :remove_task "AI-Safe Plugin GLiNER Server"' in uninstall_script
    assert 'call :remove_task "PrivacyShieldGLiNER2"' in uninstall_script


def test_windows_native_host_installer_defaults_to_pinned_extension_id():
    script = NATIVE_HOST_INSTALLER_PATH.read_text(encoding="utf-8")

    assert f'set "DEFAULT_EXTENSION_ID={PINNED_EXTENSION_ID}"' in script
    assert 'set "EXTENSION_IDS_RAW=%DEFAULT_EXTENSION_ID%"' in script
    # Multi-ID: allowed_origins are written per id in a loop.
    assert 'chrome-extension://%%I/' in script


def test_install_ai_safe_plugin_verifies_asset_checksums():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    # Verification helper exists, uses Get-FileHash, and fetches SHA256SUMS.
    assert "function Test-AiSafePluginAssetChecksum" in script
    assert "Get-FileHash -LiteralPath $AssetPath -Algorithm SHA256" in script
    assert '"$ReleaseBase/SHA256SUMS"' in script
    # Backend verified before extraction (hard — throws on failure).
    assert "Test-AiSafePluginAssetChecksum -AssetPath $archivePath -ReleaseBase $releaseBase -TempRoot $tempRoot" in script
    assert "Backend bundle checksum verification failed. Aborting install." in script
    # Model verified before extraction (failure throws → HF fallback in catch).
    assert "Test-AiSafePluginAssetChecksum -AssetPath $modelArchive -ReleaseBase $releaseBase -TempRoot $tempRoot" in script


def test_install_ai_safe_plugin_defaults_extension_id_and_install_dir():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert f'$defaultExtensionId = "{PINNED_EXTENSION_ID}"' in script
    assert "[Parameter(Mandatory = $true)]\n        [string]$ExtensionId" not in script
    assert '$InstallDir = Join-Path $env:LOCALAPPDATA "AI-Safe-Plugin"' in script
    assert 'No extension id supplied; using the pinned AI-Safe Plugin id $defaultExtensionId.' in script
    assert 'powershell -ExecutionPolicy Bypass -File install.ps1 --extension-id <EXTENSION_ID>' not in script


def test_install_ai_safe_plugin_builds_native_host_command_as_flat_array():
    # Regression: `@((path) + $ids)` string-concats into one bogus token. The command
    # must be built as array concatenation so Invoke-AiSafePluginCommand gets [path, id...].
    script = INSTALLER_PATH.read_text(encoding="utf-8")
    assert '$nativeHostCommand = @(Join-Path $InstallDir "server\\native-host\\install_windows.bat") + $resolvedExtensionIds' in script
    assert 'Invoke-AiSafePluginCommand -Command $nativeHostCommand' in script

def test_install_ai_safe_plugin_warns_and_continues_when_sha256sums_missing():
    script = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "SHA256SUMS not available from release; skipping checksum verification" in script
