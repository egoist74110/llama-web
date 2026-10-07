@echo off
rem llama-web release helper: bump version, notes, push, build the Windows + macOS draft Release.
rem Usage: release.bat [next|patch|minor|major|<version>] [-m "commit message"] [--windows-only] [--publish] [--dry-run]
rem The logic lives in scripts/release.ts (shared with release.command).
setlocal
cd /d "%~dp0"
title llama-web release

where bun >nul 2>nul
if errorlevel 1 (
  echo [release] bun was not found in PATH. Install it from https://bun.sh and try again.
  pause
  exit /b 1
)

call bun scripts\release.ts %*
if errorlevel 1 (
  echo.
  echo [release] stopped with an error (exit code %errorlevel%). See the messages above.
  pause
  exit /b 1
)
pause
exit /b 0
