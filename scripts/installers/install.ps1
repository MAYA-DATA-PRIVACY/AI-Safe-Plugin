function Invoke-VeilCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Command,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    $exe = $Command[0]
    $args = @()
    if ($Command.Length -gt 1) {
        $args = $Command[1..($Command.Length - 1)]
    }

    & $exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

# Verify a downloaded asset against the release's SHA256SUMS file. Returns $true
# when the checksum matches, when SHA256SUMS is unavailable (older releases), or
# when the asset is not listed (warn-and-continue). Returns $false only on a real
# mismatch, so callers can decide whether to abort (backend) or fall back (model).
function Test-VeilAssetChecksum {
    param(
        [Parameter(Mandatory = $true)][string]$AssetPath,
        [Parameter(Mandatory = $true)][string]$ReleaseBase,
        [Parameter(Mandatory = $true)][string]$TempRoot
    )

    $assetName = Split-Path -Leaf $AssetPath
    $sumsFile = Join-Path $TempRoot "SHA256SUMS"

    if (-not (Test-Path -LiteralPath $sumsFile)) {
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBase/SHA256SUMS" -OutFile $sumsFile
        }
        catch {
            Write-Host "Warning: SHA256SUMS not available from release; skipping checksum verification for $assetName."
            return $true
        }
    }

    $expected = $null
    foreach ($line in Get-Content -LiteralPath $sumsFile) {
        $parts = $line -split '\s+\*?'
        if ($parts.Length -ge 2 -and $parts[-1] -eq $assetName) {
            $expected = $parts[0]
            break
        }
    }
    if (-not $expected) {
        Write-Host "Warning: $assetName not listed in SHA256SUMS; skipping verification."
        return $true
    }

    $actual = (Get-FileHash -LiteralPath $AssetPath -Algorithm SHA256).Hash
    if ($actual -ieq $expected) {
        Write-Host "Checksum verified: $assetName"
        return $true
    }
    Write-Host "Checksum verification failed for $assetName."
    return $false
}

function Get-VeilPythonVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PythonPath
    )

    try {
        $output = & $PythonPath -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($output)) {
            return $null
        }
        return [version]($output | Select-Object -Last 1).Trim()
    }
    catch {
        return $null
    }
}

function Get-VeilScheduledTaskNames {
    return @(
        "Veil GLiNER Server",
        "PrivacyShieldGLiNER2"
    )
}

function Stop-VeilScheduledTask {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TaskName
    )

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        return $false
    }

    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    return $true
}

function Start-VeilScheduledTask {
    param(
        [Parameter(Mandatory = $true)]
        [string]$TaskName
    )

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        return $false
    }

    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    return $true
}

function Test-VeilServerHealthy {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8765/health" -TimeoutSec 2
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
    }
    catch {
        return $false
    }
}

function Test-VeilPortOpen {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $client.BeginConnect("127.0.0.1", 8765, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(750, $false)) {
            return $false
        }

        $client.EndConnect($asyncResult)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Test-VeilProcessRunning {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    try {
        return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
    }
    catch {
        return $false
    }
}

function Get-VeilServerProcessState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    $statePath = Join-Path $InstallDir ".runtime\server_process.json"
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }

    try {
        return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

function Test-VeilServerProcessStarting {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    $state = Get-VeilServerProcessState -InstallDir $InstallDir
    if ($null -eq $state) {
        return $false
    }

    $processIdText = [string]($state.pid)
    if ([string]::IsNullOrWhiteSpace($processIdText)) {
        return $false
    }

    $serverProcessId = 0
    if (-not [int]::TryParse($processIdText, [ref]$serverProcessId)) {
        return $false
    }

    return Test-VeilProcessRunning -ProcessId $serverProcessId
}

function Start-VeilServerNow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    $venvPython = Join-Path $InstallDir ".venv\Scripts\python.exe"
    $serverScript = Join-Path $InstallDir "server\gliner2_server.py"

    if (Test-VeilServerHealthy) {
        Write-Host "Veil server already healthy; skipping immediate start."
        return $true
    }

    if (Test-VeilServerProcessStarting -InstallDir $InstallDir) {
        Write-Host "Veil server is already starting for the current session."
        return $true
    }

    if (Test-VeilPortOpen) {
        Write-Host "Warning: port 8765 is already in use by another local process. Skipping immediate Veil start for this session."
        return $false
    }

    if (-not (Test-Path -LiteralPath $venvPython) -or -not (Test-Path -LiteralPath $serverScript)) {
        Write-Host "Warning: Veil installed, but the managed runtime was not found for an immediate start."
        return $false
    }

    # Set cache env vars so the server finds the pre-downloaded model
    $env:HF_HOME = Join-Path $InstallDir ".runtime\cache\hf"
    $env:HUGGINGFACE_HUB_CACHE = Join-Path $InstallDir ".runtime\cache\hf\hub"
    $env:TRANSFORMERS_CACHE = Join-Path $InstallDir ".runtime\cache\hf\transformers"
    $env:XDG_CACHE_HOME = Join-Path $InstallDir ".runtime\cache\xdg"

    try {
        Start-Process -FilePath $venvPython -ArgumentList @("-u", $serverScript, "--host", "127.0.0.1", "--port", "8765") -WorkingDirectory $InstallDir -WindowStyle Hidden | Out-Null
    }
    catch {
        Write-Host "Warning: Veil installed successfully, but the server could not be started immediately."
        return $false
    }

    for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
        Start-Sleep -Milliseconds 500
        if (Test-VeilServerHealthy) {
            Write-Host "Veil server started for the current session."
            return $true
        }
    }

    if (Test-VeilServerProcessStarting -InstallDir $InstallDir) {
        Write-Host "Veil server is still loading GLiNER2 for the current session."
        return $true
    }

    if (Test-VeilPortOpen) {
        Write-Host "Veil server opened port 8765 and is still finishing startup."
        return $true
    }

    Write-Host "Warning: Veil installed successfully, but the server was not detected after launch."
    return $false
}

function Stop-VeilWindowsProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    foreach ($taskName in Get-VeilScheduledTaskNames) {
        Stop-VeilScheduledTask -TaskName $taskName | Out-Null
    }

    $patterns = @(
        [regex]::Escape((Join-Path $InstallDir "server\gliner2_server.py")),
        [regex]::Escape((Join-Path $InstallDir "server\native_host.py")),
        [regex]::Escape((Join-Path $InstallDir "server\native-host\native_host_win.bat"))
    )

    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $cmd = $_.CommandLine
            if ([string]::IsNullOrWhiteSpace($cmd)) {
                return $false
            }

            foreach ($pattern in $patterns) {
                if ($cmd -match $pattern) {
                    return $true
                }
            }

            return $false
        })

    foreach ($process in $processes) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }

    if ($processes.Count -gt 0) {
        Start-Sleep -Seconds 1
    }
}

function Remove-VeilInstallContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    for ($attempt = 1; $attempt -le 3; $attempt += 1) {
        try {
            $items = @(Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object {
                    $_.Name -notin @(".venv", ".runtime", ".env")
                })

            if ($items.Count -eq 0) {
                return
            }

            $items | Remove-Item -Recurse -Force
            return
        }
        catch {
            if ($attempt -eq 3) {
                throw
            }
            Start-Sleep -Seconds 1
        }
    }
}

function Test-VeilModelFilesPresent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ModelDir
    )

    if (-not (Test-Path -LiteralPath $ModelDir -PathType Container)) {
        return $false
    }

    return (
        (Test-Path -LiteralPath (Join-Path $ModelDir "config.json") -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $ModelDir "gliner2_config.json") -PathType Leaf)
    )
}

function Test-VeilModelPresent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    $bundledModelDir = Join-Path $InstallDir ".runtime\cache\model\model"
    if (Test-VeilModelFilesPresent -ModelDir $bundledModelDir) {
        return $true
    }

    $snapshotsDir = Join-Path $InstallDir ".runtime\cache\hf\hub\models--lmo3--gliner2-large-v1-onnx\snapshots"
    if (-not (Test-Path -LiteralPath $snapshotsDir -PathType Container)) {
        return $false
    }

    foreach ($snapshot in Get-ChildItem -LiteralPath $snapshotsDir -Directory -ErrorAction SilentlyContinue) {
        if (Test-VeilModelFilesPresent -ModelDir $snapshot.FullName) {
            return $true
        }
    }

    return $false
}

function Write-VeilReleaseMetadata {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SourcePath,
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,
        [Parameter(Mandatory = $true)]
        [string]$RepoSlug
    )

    $releaseMeta = @{
        tag = ""
        published_at = ""
        html_url = ""
        repository = $RepoSlug
        installed_at = (Get-Date).ToUniversalTime().ToString("o")
    }

    if (Test-Path -LiteralPath $SourcePath) {
        try {
            $sourceMeta = Get-Content -LiteralPath $SourcePath -Raw | ConvertFrom-Json
            $releaseMeta.tag = [string]($sourceMeta.tag)
            $releaseMeta.published_at = [string]($sourceMeta.published_at)
            $releaseMeta.html_url = [string]($sourceMeta.html_url)
            if (-not [string]::IsNullOrWhiteSpace([string]($sourceMeta.repository))) {
                $releaseMeta.repository = [string]($sourceMeta.repository)
            }
        }
        catch {
            # Fall back to an unknown-but-valid payload so local installs remain verifiable.
        }
    }

    $releaseMeta | ConvertTo-Json | Set-Content -LiteralPath $TargetPath -Encoding UTF8
}

function Ensure-VeilUv {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir,
        [Parameter(Mandatory = $true)]
        [string]$UvVersion,
        [Parameter(Mandatory = $true)]
        [string]$TempRoot,
        [string]$UvPath
    )

    if (-not [string]::IsNullOrWhiteSpace($UvPath)) {
        if (-not (Test-Path -LiteralPath $UvPath)) {
            throw "Specified uv binary was not found: $UvPath"
        }
        return $UvPath
    }

    $uvInstallDir = Join-Path $InstallDir ".runtime\tools\uv"
    $uvExe = Join-Path $uvInstallDir "uv.exe"
    New-Item -ItemType Directory -Force -Path $uvInstallDir | Out-Null

    $needsInstall = $true
    if (Test-Path -LiteralPath $uvExe) {
        try {
            $currentVersion = (& $uvExe --version | Select-Object -Last 1).Trim()
            if ($currentVersion -eq "uv $UvVersion") {
                $needsInstall = $false
            }
        }
        catch {
            $needsInstall = $true
        }
    }

    if ($needsInstall) {
        $uvInstaller = Join-Path $TempRoot "uv-install.ps1"
        Invoke-WebRequest -UseBasicParsing -Uri "https://astral.sh/uv/$UvVersion/install.ps1" -OutFile $uvInstaller

        $previousInstall = $env:UV_UNMANAGED_INSTALL
        $previousPathFlag = $env:UV_NO_MODIFY_PATH
        try {
            $env:UV_UNMANAGED_INSTALL = $uvInstallDir
            $env:UV_NO_MODIFY_PATH = "1"
            # Keep the installer's console output visible without letting it leak
            # into this function's return value.
            & powershell -NoProfile -ExecutionPolicy Bypass -File $uvInstaller | Out-Host
            $uvInstallExitCode = $LASTEXITCODE
            if ($uvInstallExitCode -ne 0) {
                throw "uv installer failed with exit code $uvInstallExitCode."
            }
        }
        finally {
            $env:UV_UNMANAGED_INSTALL = $previousInstall
            $env:UV_NO_MODIFY_PATH = $previousPathFlag
        }
    }

    if (-not (Test-Path -LiteralPath $uvExe)) {
        throw "Failed to install pinned uv $UvVersion into $uvInstallDir."
    }

    return $uvExe
}

function Sync-VeilRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir,
        [Parameter(Mandatory = $true)]
        [string]$UvExe,
        [Parameter(Mandatory = $true)]
        [string]$PythonVersion,
        [switch]$RecreateVenv
    )

    $runtimeDir = Join-Path $InstallDir ".runtime"
    $venvDir = Join-Path $InstallDir ".venv"
    $venvPython = Join-Path $venvDir "Scripts\python.exe"

    if ($RecreateVenv -and (Test-Path -LiteralPath $venvDir)) {
        Remove-Item -LiteralPath $venvDir -Recurse -Force
    }

    $venvVersion = $null
    if (Test-Path -LiteralPath $venvPython) {
        $venvVersion = Get-VeilPythonVersion -PythonPath $venvPython
        if (-not $venvVersion -or $venvVersion.Major -ne 3 -or $venvVersion.Minor -ne 11) {
            Remove-Item -LiteralPath $venvDir -Recurse -Force
        }
    }

    $previousCache = $env:UV_CACHE_DIR
    $previousInstall = $env:UV_PYTHON_INSTALL_DIR
    $previousEnv = $env:UV_PROJECT_ENVIRONMENT
    $previousLinkMode = $env:UV_LINK_MODE
    try {
        $env:UV_CACHE_DIR = Join-Path $runtimeDir "cache\uv"
        $env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeDir "python"
        $env:UV_PROJECT_ENVIRONMENT = $venvDir
        $env:UV_LINK_MODE = "copy"

        Invoke-VeilCommand -Command @($UvExe, "python", "install", $PythonVersion, "--install-dir", $env:UV_PYTHON_INSTALL_DIR) -FailureMessage "Failed to install Veil's managed Python runtime"
        Invoke-VeilCommand -Command @($UvExe, "sync", "--frozen", "--no-dev", "--no-install-project", "--directory", $InstallDir, "--python", $PythonVersion, "--managed-python") -FailureMessage "Failed to sync the Veil runtime from uv.lock"
    }
    finally {
        $env:UV_CACHE_DIR = $previousCache
        $env:UV_PYTHON_INSTALL_DIR = $previousInstall
        $env:UV_PROJECT_ENVIRONMENT = $previousEnv
        $env:UV_LINK_MODE = $previousLinkMode
    }
}

function Assert-VeilBundledPayload {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    $requiredPaths = @(
        (Join-Path $InstallDir "server\gliner2_server.py"),
        (Join-Path $InstallDir "server\native-host\install_windows.bat"),
        (Join-Path $InstallDir "pyproject.toml"),
        (Join-Path $InstallDir "uv.lock"),
        (Join-Path $InstallDir ".python-version")
    )

    foreach ($path in $requiredPaths) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Veil setup is missing a required bundled file: $path"
        }
    }
}

function global:Install-Veil {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExtensionId,
        [string]$InstallDir = $env:VEIL_INSTALL_DIR,
        [switch]$RecreateVenv,
        [switch]$UseExistingBundle,
        [string]$UvVersion = $env:VEIL_UV_VERSION,
        [string]$UvPath = $env:VEIL_UV_PATH
    )

    $repoSlug = "Maya-Data-Privacy/Veil"
    $releaseBase = "https://github.com/$repoSlug/releases/latest/download"
    $assetName = "veil-backend-windows.zip"
    $defaultAnonEndpoint = "https://app.mayadataprivacy.in/mdp/engine/anonymization"
    $pinnedUvVersion = "0.10.7"
    $pinnedPythonVersion = "3.11.11"

    if ([string]::IsNullOrWhiteSpace($UvVersion)) {
        $UvVersion = $pinnedUvVersion
    }

    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $InstallDir = Join-Path $env:LOCALAPPDATA "Veil"
    }

    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("veil-install-" + [guid]::NewGuid().ToString("N"))
    $archivePath = Join-Path $tempRoot $assetName
    $extractDir = Join-Path $tempRoot "extract"

    try {
        $ErrorActionPreference = "Stop"
        New-Item -ItemType Directory -Force -Path $tempRoot, $extractDir, $InstallDir | Out-Null

        $nativeHostUninstall = Join-Path $InstallDir "server\native-host\uninstall_windows.bat"
        $autostartUninstall = Join-Path $InstallDir "server\autostart\uninstall_windows.bat"
        if (Test-Path -LiteralPath $autostartUninstall) {
            & $autostartUninstall
            $null = $LASTEXITCODE
        }
        if (Test-Path -LiteralPath $nativeHostUninstall) {
            & $nativeHostUninstall
            $null = $LASTEXITCODE
        }

        Stop-VeilWindowsProcesses -InstallDir $InstallDir
        if ($UseExistingBundle) {
            Write-Host "Using the Veil files already installed by VeilSetup.exe..."
            Assert-VeilBundledPayload -InstallDir $InstallDir
        }
        else {
            Write-Host "Downloading Veil backend bundle..."
            Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$assetName" -OutFile $archivePath
            if (-not (Test-VeilAssetChecksum -AssetPath $archivePath -ReleaseBase $releaseBase -TempRoot $tempRoot)) {
                throw "Backend bundle checksum verification failed. Aborting install."
            }
            Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force

            Remove-VeilInstallContents -InstallDir $InstallDir
            Copy-Item -Path (Join-Path $extractDir "*") -Destination $InstallDir -Recurse -Force
        }

        $envFile = Join-Path $InstallDir ".env"
        if (-not (Test-Path -LiteralPath $envFile)) {
            "MDP_ANONYMIZATION_ENDPOINT=$defaultAnonEndpoint" | Set-Content -LiteralPath $envFile -Encoding UTF8
        }
        else {
            $envContent = Get-Content -LiteralPath $envFile -Raw
            if ($envContent -notmatch "(?m)^MDP_ANONYMIZATION_ENDPOINT=") {
                Add-Content -LiteralPath $envFile -Value "`r`nMDP_ANONYMIZATION_ENDPOINT=$defaultAnonEndpoint"
            }
        }

        $runtimeDir = Join-Path $InstallDir ".runtime"
        New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
        Write-VeilReleaseMetadata -SourcePath (Join-Path $runtimeDir "bundle_release.json") -TargetPath (Join-Path $runtimeDir "bundle_release.json") -RepoSlug $repoSlug

        $uvExe = Ensure-VeilUv -InstallDir $InstallDir -UvVersion $UvVersion -TempRoot $tempRoot -UvPath $UvPath
        Sync-VeilRuntime -InstallDir $InstallDir -UvExe $uvExe -PythonVersion $pinnedPythonVersion -RecreateVenv:$RecreateVenv

        # Set cache env vars so the server and pre-download use the same location.
        $env:HF_HOME = Join-Path $InstallDir ".runtime\cache\hf"
        $env:HUGGINGFACE_HUB_CACHE = Join-Path $InstallDir ".runtime\cache\hf\hub"
        $env:TRANSFORMERS_CACHE = Join-Path $InstallDir ".runtime\cache\hf\transformers"
        $env:XDG_CACHE_HOME = Join-Path $InstallDir ".runtime\cache\xdg"

        # Download pre-packaged fp16 model from GitHub Release (faster than HF Hub).
        $modelAsset = "veil-model-fp16.tar.gz"
        $modelUrl = "$releaseBase/$modelAsset"
        $modelArchive = Join-Path $tempRoot $modelAsset
        $modelDest = Join-Path $InstallDir ".runtime\cache\model"

        Write-Host ""
        if (Test-VeilModelPresent -InstallDir $InstallDir) {
            Write-Host "Existing GLiNER2 model cache found; skipping download."
        }
        else {
            Write-Host "Downloading GLiNER2 model (~1.8 GB, this may take a few minutes)..."
            try {
                # Use .NET WebClient for large downloads — Invoke-WebRequest is very slow for big files
                $wc = New-Object System.Net.WebClient
                $wc.DownloadFile($modelUrl, $modelArchive)
                if (-not (Test-VeilAssetChecksum -AssetPath $modelArchive -ReleaseBase $releaseBase -TempRoot $tempRoot)) {
                    throw "Model checksum verification failed."
                }
                New-Item -ItemType Directory -Force -Path $modelDest | Out-Null
                tar -xzf $modelArchive -C $modelDest
                Write-Host "Model extracted to $modelDest"
            }
            catch {
                Write-Host "Bundled model unavailable or failed verification; downloading from HuggingFace Hub..."
                $venvPythonPreDl = Join-Path $InstallDir ".venv\Scripts\python.exe"
                $serverScriptPreDl = Join-Path $InstallDir "server\gliner2_server.py"
                try {
                    & $venvPythonPreDl $serverScriptPreDl --download-only
                }
                catch {
                    Write-Host "Warning: model download failed. It will download on first use."
                }
            }
        }

        Invoke-VeilCommand -Command @((Join-Path $InstallDir "server\native-host\install_windows.bat"), $ExtensionId) -FailureMessage "Failed to register the Veil native host"

        $autostartRegistered = $false
        try {
            Invoke-VeilCommand -Command @((Join-Path $InstallDir "server\autostart\install_windows.bat")) -FailureMessage "Failed to register Veil autostart"
            $autostartRegistered = $true
        }
        catch {
            Write-Host $_.Exception.Message
            Write-Host "Warning: Veil install completed, but autostart could not be registered. You can still start the server from the extension now, or rerun the installer in an Administrator PowerShell later."
        }

        if ($autostartRegistered) {
            Write-Host "Veil autostart is configured for the next sign-in."
        }
        Start-VeilServerNow -InstallDir $InstallDir | Out-Null

        Write-Host ""
        Write-Host "Veil install complete."
        Write-Host "Install directory: $InstallDir"
        Write-Host "Extension ID: $ExtensionId"
    }
    finally {
        if (Test-Path $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}

# ── Auto-execute when run directly (not dot-sourced) ──
# Usage:
#   One-command install (PowerShell):
#     powershell -ExecutionPolicy Bypass -File install.ps1 --extension-id YOUR_EXTENSION_ID
#   Or via irm:
#     $env:VEIL_EXTENSION_ID='YOUR_EXTENSION_ID'; irm https://github.com/Maya-Data-Privacy/Veil/releases/latest/download/install.ps1 | iex
if ($MyInvocation.InvocationName -ne '.') {
    $extId = $null
    $installDir = $null
    $recreate = $false
    $useExistingBundle = $false

    for ($i = 0; $i -lt $args.Count; $i++) {
        switch ($args[$i]) {
            '--extension-id' { $extId = $args[++$i] }
            '-ExtensionId'   { $extId = $args[++$i] }
            '--install-dir'  { $installDir = $args[++$i] }
            '-InstallDir'    { $installDir = $args[++$i] }
            '--recreate-venv' { $recreate = $true }
            '--use-existing-bundle' { $useExistingBundle = $true }
            '-UseExistingBundle' { $useExistingBundle = $true }
        }
    }

    if ([string]::IsNullOrWhiteSpace($extId)) {
        $extId = $env:VEIL_EXTENSION_ID
    }

    if ([string]::IsNullOrWhiteSpace($extId)) {
        # No extension ID — show usage and make the function available for manual call
        Write-Host "Usage:" -ForegroundColor Yellow
        Write-Host "  powershell -ExecutionPolicy Bypass -File install.ps1 --extension-id <EXTENSION_ID>" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Or via irm (two ways):" -ForegroundColor Yellow
        Write-Host '  $env:VEIL_EXTENSION_ID="YOUR_ID"; irm .../install.ps1 | iex' -ForegroundColor Cyan
        Write-Host '  irm .../install.ps1 | iex; Install-Veil -ExtensionId "YOUR_ID"' -ForegroundColor Cyan
        # Don't exit — let the function remain available for the user to call next
        return
    }

    $params = @{ ExtensionId = $extId }
    if (-not [string]::IsNullOrWhiteSpace($installDir)) { $params.InstallDir = $installDir }
    if ($recreate) { $params.RecreateVenv = $true }
    if ($useExistingBundle) { $params.UseExistingBundle = $true }
    Install-Veil @params
}
