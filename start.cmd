@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js 22 or newer.
  pause
  exit /b 1
)
node --version
echo.
echo Starting tiku gateway (SQLite backend)...
echo Then open http://127.0.0.1:8321 in your browser.
echo Press Ctrl+C to stop.
echo.

rem Launch OCS Desktop first (non-blocking, optional).
rem Override with env var OCS_EXE if OCS is installed elsewhere, e.g.:
rem   set OCS_EXE=C:\Program Files\OCS\OCS Desktop.exe
if "%OCS_EXE%"=="" set "OCS_EXE=D:\program\OCS\OCS Desktop.exe"
if exist "%OCS_EXE%" (
  echo Launching OCS Desktop...
  start "" "%OCS_EXE%"
) else (
  echo OCS Desktop not found at that path - skipped.
)

node --experimental-sqlite src/gateway.mjs
pause
