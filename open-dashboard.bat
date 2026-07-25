@echo off
REM ==========================================================================
REM  The desktop icon points here. It makes sure the server is running, then
REM  opens the dashboard in your web browser. Safe to double-click any time —
REM  it won't start a second copy if one is already running.
REM ==========================================================================
cd /d "%~dp0"
if not defined PORT set PORT=3000

REM Is something already listening on the port? If not, start the server
REM (in its own minimized window that keeps it alive).
netstat -an | find ":%PORT%" | find "LISTENING" >nul
if errorlevel 1 (
  start "Maintenance Dashboard" /min "%~dp0start-dashboard.bat"
  REM give it a couple seconds to boot before opening the browser
  timeout /t 2 /nobreak >nul
)

start "" http://localhost:%PORT%
exit
