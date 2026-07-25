@echo off
REM ==========================================================================
REM  Makes the Maintenance Dashboard start automatically every time this PC
REM  boots, and opens port 3000 so other shop computers can view it too.
REM
REM  >>> RIGHT-CLICK this file and choose "Run as administrator" <<<
REM ==========================================================================
cd /d "%~dp0"

net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo   This needs administrator rights.
  echo   Right-click install-autostart.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Registering the dashboard to start on every boot...
schtasks /create /tn "MaintenanceDashboard" /tr "\"%~dp0start-dashboard.bat\"" /sc onstart /ru SYSTEM /rl highest /f
if errorlevel 1 (
  echo Could not create the startup task. See the message above.
  pause
  exit /b 1
)

echo Opening firewall port 3000 so other shop PCs can reach it...
netsh advfirewall firewall delete rule name="Maintenance Dashboard 3000" >nul 2>nul
netsh advfirewall firewall add rule name="Maintenance Dashboard 3000" dir=in action=allow protocol=TCP localport=3000 >nul

echo Starting the dashboard now...
schtasks /run /tn "MaintenanceDashboard" >nul

echo.
echo ============================================================
echo   Done. The dashboard now starts automatically on boot.
echo   Check it: http://localhost:3000
echo ============================================================
echo.
echo   To turn auto-start off later, run uninstall-autostart.bat
echo   (also as administrator). Your saved data is never touched.
echo.
pause
