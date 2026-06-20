# Windows Installer Plan

## Goal

Ship a branded `AISafePluginSetup.exe` release asset for Windows that installs the
local AI-Safe Plugin backend, downloads the GLiNER2 model from the matching GitHub
Release only when needed, and registers the native messaging host for the
user's AI-Safe Plugin extension.

## Why This Plan Fits AI-Safe Plugin

- AI-Safe Plugin must keep the local GLiNER2 model available after install, but should
  reuse an already valid cache across updates.
- The current PowerShell installer assembles too much at user install time:
  runtime bootstrap, dependency sync, model download, native-host setup, and
  autostart registration.
- The browser native host still needs an extension ID in order to write the
  allowed origin manifest on Windows.

## Production Shape

Phase 1 focuses on the shippable path we can build from this repository now:

1. Build a Windows-only staged payload on `windows-latest`.
2. Bundle the server files, PowerShell installer scripts, and release metadata
   into the installer staging directory, but create `.venv` locally on the
   user's machine during setup instead of shipping a CI-built virtualenv.
3. Compile a branded Inno Setup bootstrap installer from that stage.
4. Accept `/EXTENSION_ID=<id>` from the extension-generated install command,
   and only prompt during install if that argument is missing.
5. During setup, reuse an existing valid model cache if present; otherwise
   download the model asset with progress and extract it into the local cache.
6. Publish `AISafePluginSetup-<version>.exe` as a GitHub Release asset beside the raw
   backend and model bundles, plus a stable `AISafePluginSetup.exe` latest-download
   alias for extension-generated commands.

## Installer UX

- AI-Safe Plugin branding on setup binary and wizard surfaces.
- Per-user install into `%LOCALAPPDATA%\AI-Safe Plugin`.
- Backend payload copied first, then local runtime provisioning via `uv sync`
  during setup so Windows gets a machine-local `.venv`.
- Model download step with native installer progress on first install only.
- Update-safe cache reuse so repeat installs do not redownload the model.
- Extension-generated Windows command downloads `AISafePluginSetup.exe` and passes
  `/EXTENSION_ID=...`, with prompt fallback only when needed.
- Deterministic uninstall that removes the native host and autostart entries
  before deleting files, including the runtime-downloaded model cache.

## Follow-Up Phases

Phase 2:
- Sign the installer and installed executables/scripts.
- Publish checksums for release assets.
- Add a stable extension ID path once AI-Safe Plugin's distribution channel is fixed.

Phase 3:
- Graduate to MSI/WiX only if enterprise deployment requirements justify the
  added complexity for GPO, repair, and managed rollouts.
