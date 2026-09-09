@echo off
cd /d "%~dp0"
echo Applying ClipAgent FunASR hotfix in: %CD%
taskkill /F /IM clip-agent-desktop.exe >nul 2>&1
taskkill /F /IM python.exe >nul 2>&1
timeout /t 2 /nobreak >nul
set CLIP_ACTIVATE_INSTALL_DIR=%CD%
if exist "%CD%\portable.flag" (
  echo Mode: portable
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\activate-funasr-engine.ps1" -Portable
) else (
  echo Mode: installed
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\activate-funasr-engine.ps1"
)
if errorlevel 1 (
  echo Activate failed
  pause
  exit /b 1
)
echo Activate OK. Repairing sentencepiece...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\repair-funasr-sentencepiece.ps1"
if errorlevel 1 (
  echo sentencepiece repair failed.
  echo Try: right-click engines\funasr\runtime\vc_redist.x64.exe - Run as administrator
  echo Then re-run APPLY-HOTFIX.bat
  pause
  exit /b 1
)
echo Repair OK. Starting...
start "" "%~dp0clip-agent-desktop.exe"
