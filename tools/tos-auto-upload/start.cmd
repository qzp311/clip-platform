@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM Try to locate Node.js even when PATH is empty (Explorer double-click)
call :find_node
if not defined NODE_EXE (
  echo [ERROR] Node.js not found.
  echo.
  echo Install Node.js LTS from:
  echo   https://nodejs.org/
  echo.
  echo During install, keep checkbox:
  echo   [x] Add to PATH
  echo Then CLOSE this window, open a NEW one, run start.cmd again.
  echo.
  echo Or install with winget:
  echo   winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

set "NODE_DIR=%~dp0"
for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

echo [INFO] Using Node: %NODE_EXE%
"%NODE_EXE%" -v
where npm.cmd >nul 2>nul
if errorlevel 1 (
  if exist "%NODE_DIR%npm.cmd" (
    set "NPM_CMD=%NODE_DIR%npm.cmd"
  ) else (
    echo [ERROR] npm.cmd not found next to node.exe
    pause
    exit /b 1
  )
) else (
  set "NPM_CMD=npm.cmd"
)

if not exist "node_modules\@volcengine\tos-sdk" (
  echo [INFO] First run: npm install ...
  call "%NPM_CMD%" install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "config.json" (
  echo [INFO] config.json missing. Copy from config.example.json
  copy /Y "config.example.json" "config.json" >nul
  echo [INFO] Edit config.json then run start.cmd again.
  notepad "config.json"
  pause
  exit /b 1
)

echo [INFO] Starting watch...
"%NODE_EXE%" "watch.mjs" %*
set ERR=%ERRORLEVEL%
echo.
echo [INFO] Exit code %ERR%
pause
exit /b %ERR%

:find_node
set "NODE_EXE="
where node.exe >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%A in ('where node.exe') do (
    set "NODE_EXE=%%A"
    goto :eof
  )
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  goto :eof
)
if exist "%ProgramFiles(x86)%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
  goto :eof
)
if exist "%LocalAppData%\Programs\nodejs\node.exe" (
  set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
  goto :eof
)
if exist "%USERPROFILE%\scoop\apps\nodejs\current\node.exe" (
  set "NODE_EXE=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
  goto :eof
)
if exist "%USERPROFILE%\AppData\Roaming\nvm" (
  for /f "delims=" %%V in ('dir /b /ad /o-n "%USERPROFILE%\AppData\Roaming\nvm\v*" 2^>nul') do (
    if exist "%USERPROFILE%\AppData\Roaming\nvm\%%V\node.exe" (
      set "NODE_EXE=%USERPROFILE%\AppData\Roaming\nvm\%%V\node.exe"
      goto :eof
    )
  )
)
goto :eof
