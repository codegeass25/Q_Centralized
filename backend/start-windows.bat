@echo off
setlocal
cd /d "%~dp0"
if not exist .env (
  copy /y .env.example .env >nul
  echo Created backend\.env from .env.example.
  echo IMPORTANT: edit backend\.env and set OFFICE_ACCESS_CODE and REPORT_ADMIN_PASSWORD before continuing.
  notepad .env
)
if not exist node_modules (
  echo Installing backend dependencies...
  call npm install
  if errorlevel 1 goto :fail
)
node server.js
exit /b %errorlevel%
:fail
echo Backend dependency installation failed.
pause
exit /b 1
