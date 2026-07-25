@echo off
REM Wipes ALL data (demo or real) so you can start fresh. Asks first.
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE ( where node >nul 2>nul && set "NODE_EXE=node" )
if not defined NODE_EXE (
  echo Node.js not found. See docs\no-admin-node.md
  pause
  exit /b 1
)

echo.
echo   This deletes everything currently in the dashboard (data\db.json).
echo   Use this to clear the demo data before you start tracking real work,
echo   or to wipe the slate clean.
echo.
set /p CONFIRM="Type YES to erase all data: "
if /i not "%CONFIRM%"=="YES" (
  echo Cancelled. Nothing was deleted.
  pause
  exit /b 0
)

"%NODE_EXE%" scripts\seed.js --clear
echo.
pause
