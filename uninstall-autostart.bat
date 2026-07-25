@echo off
REM ==========================================================================
REM  Turns OFF auto-start for the Maintenance Dashboard and closes port 3000.
REM  Your saved data (the data folder) is left completely untouched.
REM
REM  >>> RIGHT-CLICK this file and choose "Run as administrator" <<<
REM ==========================================================================
net session >nul 2>nul
if errorlevel 1 (
  echo.
  echo   This needs administrator rights.
  echo   Right-click uninstall-autostart.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

schtasks /end /tn "MaintenanceDashboard" >nul 2>nul
schtasks /delete /tn "MaintenanceDashboard" /f
netsh advfirewall firewall delete rule name="Maintenance Dashboard 3000" >nul 2>nul

echo.
echo Auto-start removed. Your data folder was not touched.
echo (You can still start the dashboard by hand with start-dashboard.bat.)
echo.
pause
