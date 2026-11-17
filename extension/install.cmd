@echo off
setlocal
set "SRC=%~dp0"
set "DST=%APPDATA%\OCS Desktop\downloads\extensions\tiku-panel"

echo Installing Tiku Gateway Panel extension...
echo Target: %DST%

if not exist "%DST%" mkdir "%DST%"
copy /Y "%SRC%manifest.json" "%DST%\" >nul
copy /Y "%SRC%background.js" "%DST%\" >nul
copy /Y "%SRC%panel.html" "%DST%\" >nul
copy /Y "%SRC%panel.js" "%DST%\" >nul
copy /Y "%SRC%icon.png" "%DST%\" >nul

echo.
echo Done. Files installed:
dir /b "%DST%"
echo.
echo NEXT: fully quit OCS (including tray icon), then start it again.
echo The extension auto-loads on next launch. Look for the blue book icon
echo in the browser toolbar; click it to open the side panel.
echo.
echo NOTE: start.cmd (the local gateway) must be running for the panel
echo to show data. Keep it open in the background.
pause
