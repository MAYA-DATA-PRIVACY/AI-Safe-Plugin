@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "REPO_DIR=%SCRIPT_DIR%..\.."
pushd "%REPO_DIR%"
set "REPO_DIR=%CD%"
popd

set "VENV_PYTHON=%REPO_DIR%\.venv\Scripts\python.exe"
set "SERVER_SCRIPT=%REPO_DIR%\server\gliner2_server.py"
set "TASK_NAME=AI-Safe Plugin GLiNER Server"
set "LEGACY_TASK_NAME=PrivacyShieldGLiNER2"

if not exist "%VENV_PYTHON%" (
    echo ERROR: .venv not found. Run install_native_host_windows.bat first.
    exit /b 1
)

schtasks /delete /tn "%LEGACY_TASK_NAME%" /f >nul 2>&1
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Create a wrapper script that sets cache env vars before starting the server.
:: This ensures the model cache lives inside the AI-Safe Plugin install directory, matching
:: the location used by the pre-download step during install.
set "WRAPPER=%REPO_DIR%\server\autostart\start_server.cmd"
(
  echo @echo off
  echo set "HF_HOME=%REPO_DIR%\.runtime\cache\hf"
  echo set "HUGGINGFACE_HUB_CACHE=%REPO_DIR%\.runtime\cache\hf\hub"
  echo set "TRANSFORMERS_CACHE=%REPO_DIR%\.runtime\cache\hf\transformers"
  echo set "XDG_CACHE_HOME=%REPO_DIR%\.runtime\cache\xdg"
  echo "%VENV_PYTHON%" "%SERVER_SCRIPT%" --host 127.0.0.1 --port 8765
) > "%WRAPPER%"

:: Create scheduled task to run at logon
schtasks /create /tn "%TASK_NAME%" ^
  /tr "\"%WRAPPER%\"" ^
  /sc onlogon /ru "%USERNAME%" /f >nul

if errorlevel 1 (
    echo ERROR: Failed to create scheduled task. Try running as Administrator.
    exit /b 1
)

echo Scheduled task created: %TASK_NAME%
echo The AI-Safe Plugin GLiNER server will start automatically at next login.
echo.
echo Manual start from Command Prompt:
echo   start "" "%VENV_PYTHON%" "%SERVER_SCRIPT%" --host 127.0.0.1 --port 8765
echo.
echo Manual start from PowerShell:
echo   Start-Process "%VENV_PYTHON%" -ArgumentList '"%SERVER_SCRIPT%" --host 127.0.0.1 --port 8765'
endlocal
