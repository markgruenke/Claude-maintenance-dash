@echo off
REM Loads example machines / work orders / parts so you can see the dashboard
REM populated. Safe to run on a fresh copy. Double-click it.
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE ( where node >nul 2>nul && set "NODE_EXE=node" )
if not defined NODE_EXE (
  echo Node.js not found. See docs\no-admin-node.md
  pause
  exit /b 1
)

"%NODE_EXE%" scripts\seed.js
echo.
pause
