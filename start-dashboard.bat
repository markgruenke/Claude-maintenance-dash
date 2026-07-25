@echo off
REM ==========================================================================
REM  Maintenance Dashboard launcher (Windows).
REM  Double-click to start. Keeps the server alive: if it ever stops, it
REM  restarts after a few seconds. Close this window to stop the dashboard.
REM ==========================================================================
title Maintenance Dashboard
cd /d "%~dp0"
if not defined PORT set PORT=3000

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed, or not on this PC's PATH.
  echo   Install the LTS version from https://nodejs.org , then run this again.
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
node server.js
echo.
echo Server stopped (exit code %errorlevel%). Restarting in 3 seconds...
echo Press Ctrl+C now if you want to quit for good.
timeout /t 3 /nobreak >nul
goto loop
