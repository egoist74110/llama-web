@echo off
rem llama-web launcher. Close this window (or press Ctrl+C) to stop the server and all llama-server processes.
rem Usage: start.bat          ask whether to rebuild (default follows whether sources changed)
rem        start.bat build    rebuild, then run
rem        start.bat run      run the last build without asking
rem The logic lives in scripts/launch.ts (shared with start.command).
setlocal
cd /d "%~dp0"
title llama-web

where bun >nul 2>nul
if errorlevel 1 (
  echo [llama-web] bun was not found in PATH. Install it from https://bun.sh and try again.
  pause
  exit /b 1
)

call bun scripts\launch.ts %*
if errorlevel 1 (
  echo.
  echo [llama-web] stopped with an error (exit code %errorlevel%). See the messages above.
  pause
  exit /b 1
)
exit /b 0
