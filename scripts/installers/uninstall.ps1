function Stop-AiSafePluginWindowsProcesses {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallDir
    )

    foreach ($taskName in @("AI-Safe Plugin GLiNER Server", "PrivacyShieldGLiNER2")) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($null -ne $task) {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
        }
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

    # Also kill any python.exe whose command line references the install directory
    $escapedDir = [regex]::Escape($InstallDir)
    $pythonProcs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $cmd = $_.CommandLine
            if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
            if ($cmd -match $escapedDir -and $_.Name -match 'python') { return $true }
            return $false
        } | Where-Object { $processes.ProcessId -notcontains $_.ProcessId })

    foreach ($proc in $pythonProcs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $allKilled = $processes.Count + $pythonProcs.Count
    if ($allKilled -gt 0) {
        Start-Sleep -Seconds 3
    }
}

function Uninstall-AiSafePlugin {
    param(
        [string]$InstallDir = $env:AI_SAFE_PLUGIN_INSTALL_DIR
    )

    if ([string]::IsNullOrWhiteSpace($InstallDir)) {
        $InstallDir = Join-Path $env:LOCALAPPDATA "AI-Safe Plugin"
    }

    if (-not (Test-Path -LiteralPath $InstallDir)) {
        Write-Host "AI-Safe Plugin local server is not installed at $InstallDir."
        return
    }

    Write-Host "Removing AI-Safe Plugin local server from $InstallDir..."

    $nativeHostUninstall = Join-Path $InstallDir "server\native-host\uninstall_windows.bat"
    $autostartUninstall = Join-Path $InstallDir "server\autostart\uninstall_windows.bat"

    $ErrorActionPreference = "Stop"

    if (Test-Path -LiteralPath $autostartUninstall) {
        & $autostartUninstall
        $null = $LASTEXITCODE
    }
    if (Test-Path -LiteralPath $nativeHostUninstall) {
        & $nativeHostUninstall
        $null = $LASTEXITCODE
    }

    Stop-AiSafePluginWindowsProcesses -InstallDir $InstallDir

    $removed = $false
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction Stop
            $removed = $true
            break
        }
        catch {
            if ($attempt -lt 3) {
                Write-Host "Retry $attempt/3: directory still locked, waiting..."
                Start-Sleep -Seconds 2
            }
        }
    }

    Write-Host ""
    if ($removed) {
        Write-Host "AI-Safe Plugin uninstall complete."
        Write-Host "Removed install directory: $InstallDir"
    }
    else {
        Write-Host "Warning: Could not fully remove $InstallDir (files may still be in use)."
        Write-Host "Please close Chrome/Edge and manually delete the folder, or restart and try again."
    }
}

# ── Auto-execute when run directly (not dot-sourced) ──
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   Or: irm https://github.com/Maya-Data-Privacy/AI-Safe-Plugin/releases/latest/download/uninstall.ps1 | iex
if ($MyInvocation.InvocationName -ne '.') {
    $installDir = $null
    for ($i = 0; $i -lt $args.Count; $i++) {
        switch ($args[$i]) {
            '--install-dir' { $installDir = $args[++$i] }
            '-InstallDir'   { $installDir = $args[++$i] }
        }
    }

    $params = @{}
    if (-not [string]::IsNullOrWhiteSpace($installDir)) { $params.InstallDir = $installDir }
    Uninstall-AiSafePlugin @params
}
