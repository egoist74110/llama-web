#!/bin/bash
# llama-web launcher for macOS (source version). Double-click it in Finder, or run ./start.command.
# Close the Terminal window (or press Ctrl+C) to stop the server and all llama-server processes.
# Usage: ./start.command          ask whether to rebuild (default follows whether sources changed)
#        ./start.command build    rebuild, then run
#        ./start.command run      run the last build without asking
# The logic lives in scripts/launch.ts (shared with start.bat).
cd "$(dirname "$0")" || exit 1

# A script started from Finder gets a minimal PATH: add the usual places bun is installed.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  echo "[llama-web] bun was not found in PATH. Install it from https://bun.sh and try again."
  read -r -p "Press Enter to close. " _
  exit 1
fi

bun scripts/launch.ts "$@"
code=$?
if [ "$code" -ne 0 ]; then
  echo
  echo "[llama-web] stopped with an error (exit code $code). See the messages above."
  read -r -p "Press Enter to close. " _
  exit "$code"
fi
