@echo off
setlocal
set "REMOVED_ANY=0"

call :remove_task "AISafePluginGLiNER2"
call :remove_task "AI-Safe Plugin GLiNER Server"
call :remove_task "Veil GLiNER Server"
call :remove_task "PrivacyShieldGLiNER2"

if "%REMOVED_ANY%"=="0" (
    echo AISafePluginGLiNER2 scheduled task not found.
)

endlocal
exit /b 0

:remove_task
schtasks /delete /tn "%~1" /f >nul 2>&1
if not errorlevel 1 (
    echo Removed scheduled task: %~1
    set "REMOVED_ANY=1"
)
exit /b 0
