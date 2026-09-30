@echo off
rem llama-web launcher. Close this window (or press Ctrl+C) to stop the server and all llama-server processes.
rem Usage: start.bat          run the last build (builds first if there is none)
rem        start.bat build    rebuild, then run
setlocal
cd /d "%~dp0"
title llama-web

where bun >/dev/null 2>nul
if errorlevel 1 (
  echo [llama-web] bun was not found in PATH. Install it from https://bun.sh and try again.
  pause
  exit /b 1
)

if /i "%~1"=="build" goto build
if not exist ".output\server\index.mjs" goto build
goto run

:build
if not exist "node_modules" (
  echo [llama-web] installing dependencies...
  call bun install
  if errorlevel 1 goto failed
)
echo [llama-web] building...
call bun run build
if errorlevel 1 goto failed

:run
echo [llama-web] starting...
bun ".output\server\index.mjs"
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo [llama-web] stopped with an error (exit code %errorlevel%). See the messages above.
pause
exit /b 1
