@echo off
REM ==========================================================================
REM  Puts a "Maintenance Dashboard" icon on your desktop. Run this ONCE.
REM  After that, just double-click the desktop icon to open the dashboard.
REM  (No administrator rights needed.)
REM ==========================================================================
cd /d "%~dp0"

set "ICON=%~dp0dashboard.ico"
if not exist "%ICON%" set "ICON=%SystemRoot%\System32\shell32.dll,21"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$desktop=[Environment]::GetFolderPath('Desktop');" ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($desktop+'\Maintenance Dashboard.lnk');" ^
  "$s.TargetPath='%~dp0open-dashboard.bat';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='%ICON%';" ^
  "$s.Description='Open the Maintenance Dashboard';" ^
  "$s.WindowStyle=7;" ^
  "$s.Save()"

if errorlevel 1 (
  echo.
  echo   Could not create the shortcut. See the message above.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo   Done! A "Maintenance Dashboard" icon is on your desktop.
echo   Double-click it any time to open the dashboard.
echo ============================================================
echo.
pause
