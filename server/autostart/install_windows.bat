@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "REPO_DIR=%SCRIPT_DIR%..\.."
pushd "%REPO_DIR%"
set "REPO_DIR=%CD%"
popd

set "VENV_PYTHON=%REPO_DIR%\.venv\Scripts\python.exe"
set "VENV_PYTHONW=%REPO_DIR%\.venv\Scripts\pythonw.exe"
set "SERVER_SCRIPT=%REPO_DIR%\server\gliner2_server.py"
set "SERVER_LOG=%REPO_DIR%\.runtime\gliner2_server.log"
set "TASK_NAME=AISafePluginGLiNER2"

if not exist "%VENV_PYTHON%" (
    echo ERROR: .venv not found. Run install_native_host_windows.bat first.
    exit /b 1
)

:: Prefer pythonw.exe (no console window). Fall back to python.exe if absent.
set "SERVER_PYTHON=%VENV_PYTHONW%"
if not exist "%VENV_PYTHONW%" set "SERVER_PYTHON=%VENV_PYTHON%"

if not exist "%REPO_DIR%\.runtime" mkdir "%REPO_DIR%\.runtime" >nul 2>&1

schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
schtasks /delete /tn "AI-Safe Plugin GLiNER Server" /f >nul 2>&1
schtasks /delete /tn "Veil GLiNER Server" /f >nul 2>&1
schtasks /delete /tn "PrivacyShieldGLiNER2" /f >nul 2>&1

:: Create a wrapper script that sets cache env vars before starting the server.
:: This ensures the model cache lives inside the AI-Safe Plugin install directory, matching
:: the location used by the pre-download step during install. stdout/stderr are redirected
:: to the runtime log so the extension's "Show Logs" keeps working when run windowless.
set "WRAPPER=%REPO_DIR%\server\autostart\start_server.cmd"
(
  echo @echo off
  echo set "HF_HOME=%REPO_DIR%\.runtime\cache\hf"
  echo set "HUGGINGFACE_HUB_CACHE=%REPO_DIR%\.runtime\cache\hf\hub"
  echo set "TRANSFORMERS_CACHE=%REPO_DIR%\.runtime\cache\hf\transformers"
  echo set "XDG_CACHE_HOME=%REPO_DIR%\.runtime\cache\xdg"
  echo "%SERVER_PYTHON%" "%SERVER_SCRIPT%" --host 127.0.0.1 --port 8765 ^>^> "%SERVER_LOG%" 2^>^&1
) > "%WRAPPER%"

:: Create a VBScript launcher that runs the wrapper with a hidden window (style 0).
:: wscript.exe shows no console, so nothing pops up at logon and there is no window for
:: the user to accidentally close (which previously killed the server).
set "LAUNCHER=%REPO_DIR%\server\autostart\start_server.vbs"
(
  echo CreateObject^("WScript.Shell"^).Run "cmd /c """"%WRAPPER%""""", 0, False
) > "%LAUNCHER%"

:: Create scheduled task to run the hidden launcher at logon
schtasks /create /tn "%TASK_NAME%" ^
  /tr "wscript.exe \"%LAUNCHER%\"" ^
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
