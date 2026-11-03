@echo off
rem Double-click to run Arch Prompt Studio at http://localhost:8787 (page + AI server together).
rem First run on a new PC: checks Node.js, installs the packages and builds the app (a few minutes).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [!] Node.js is not installed on this PC.
  echo      Install the LTS version from https://nodejs.org then double-click start.bat again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  goto :eof
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo  [!] Node.js %NODE_MAJOR% is too old. Install Node.js 20 or newer from https://nodejs.org
  pause
  goto :eof
)

if not exist .env (
  echo  [!] .env is missing: copy your .env file next to start.bat ^(see .env.example^).
  echo      The app still opens, but image analysis and rendering need the keys in .env.
  echo.
)

if not exist node_modules (
  echo Installing packages ^(first run only^)...
  call npm ci --no-audit --no-fund || goto :error
)
if not exist dist-single\index.html (
  echo Building the app ^(first run only^)...
  call npm run build:single || goto :error
)

start "" http://localhost:8787/
call npx tsx server/index.ts
goto :eof

:error
echo.
echo Something went wrong. Check the messages above.
pause
