@echo off
REM Wipes all work data (demo or real), keeps accounts. Asks first.
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
echo   This erases all work orders, work logs, parts and PM schedules.
echo   Sign-in accounts are KEPT. Use this to clear the demo data before you
echo   start tracking real work. Close the dashboard window first.
echo.
set /p CONFIRM="Type YES to erase all work data: "
if /i not "%CONFIRM%"=="YES" (
  echo Cancelled. Nothing was deleted.
  pause
  exit /b 0
)

"%NODE_EXE%" scripts\seed.js --clear
echo.
pause
