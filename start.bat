@echo off
rem ARQ Beam launcher: starts the app and opens the dashboard in an app window.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
node server.js %*
pause
