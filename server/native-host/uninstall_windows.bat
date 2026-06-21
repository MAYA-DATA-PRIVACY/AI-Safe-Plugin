@echo off
setlocal
for %%H in ("com.ai_safe_plugin.gliner.server" "com.privacyshield.gliner2") do (
    reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%%~H" /f >nul 2>&1
    reg delete "HKCU\Software\Chromium\NativeMessagingHosts\%%~H" /f >nul 2>&1
    reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%%~H" /f >nul 2>&1
    del "%~dp0%%~H.json" >nul 2>&1
)
echo AI-Safe Plugin native host registry entries removed.
endlocal
