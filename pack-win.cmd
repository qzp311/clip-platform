@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pack-win.ps1"
exit /b %ERRORLEVEL%
