#!/bin/bash
# llama-web release helper for macOS / Linux: bump version, notes, push, build the Windows + macOS draft Release.
# Usage: ./release.command [next|patch|minor|major|<version>] [-m "commit message"] [--windows-only] [--publish] [--dry-run]
# The logic lives in scripts/release.ts (shared with release.bat).
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "[release] bun was not found in PATH. Install it from https://bun.sh and try again."
  read -r -p "Press Enter to close. " _
  exit 1
fi

bun scripts/release.ts "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo
  echo "[release] stopped with an error (exit code $code). See the messages above."
  read -r -p "Press Enter to close. " _
  exit "$code"
fi
