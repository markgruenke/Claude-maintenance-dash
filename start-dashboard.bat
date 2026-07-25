@echo off
REM ==========================================================================
REM  Maintenance Dashboard launcher (Windows).
REM  Double-click to start. Keeps the server alive: if it ever stops, it
REM  restarts after a few seconds. Close this window to stop the dashboard.
REM
REM  Finds Node.js in this order:
REM    1. a "node\node.exe" folder sitting next to this script  (no-admin ZIP)
REM    2. Node.js installed normally and on the PATH
REM ==========================================================================
title Maintenance Dashboard
cd /d "%~dp0"
if not defined PORT set PORT=3000

set "NODE_EXE="
if exist "%~dp0node\node.exe" set "NODE_EXE=%~dp0node\node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul && set "NODE_EXE=node"
)
if not defined NODE_EXE (
  echo.
  echo   Node.js was not found.
  echo.
  echo   No admin rights? You don't need to "install" it:
  echo     1. Download the Windows .zip (NOT the installer) from
  echo        https://nodejs.org/en/download
  echo     2. Unzip it, and copy node.exe into a folder called "node"
  echo        right next to this file  ^(so you have  ...\node\node.exe^).
  echo   See docs\no-admin-node.md for the full walkthrough.
  echo.
  pause
  exit /b 1
)

:loop
echo.
echo ============================================================
echo   Maintenance Dashboard is running
echo   On this PC:      http://localhost:%PORT%
echo   Other shop PCs:  http://THIS-PCs-IP-ADDRESS:%PORT%
echo   (run ipconfig to find this PC's IP address)
echo.
echo   Close this window to stop the dashboard.
echo ============================================================
"%NODE_EXE%" server.js
echo.
echo Server stopped (exit code %errorlevel%). Restarting in 3 seconds...
echo Press Ctrl+C now if you want to quit for good.
timeout /t 3 /nobreak >nul
goto loop
