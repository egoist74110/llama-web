#!/bin/bash
# llama-web launcher for macOS (source version). Double-click it in Finder, or run ./start.command.
# Close the Terminal window (or press Ctrl+C) to stop the server and all llama-server processes.
# Usage: ./start.command          run the last build (builds first if there is none)
#        ./start.command build    rebuild, then run
cd "$(dirname "$0")" || exit 1

# A script started from Finder gets a minimal PATH: add the usual places bun is installed.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

failed() {
  echo
  echo "[llama-web] stopped with an error (exit code $1). See the messages above."
  read -r -p "Press Enter to close. " _
  exit 1
}

if ! command -v bun >/dev/null 2>&1; then
  echo "[llama-web] bun was not found in PATH. Install it from https://bun.sh and try again."
  read -r -p "Press Enter to close. " _
  exit 1
fi

if [ "$1" = "build" ] || [ ! -f ".output/server/index.mjs" ]; then
  if [ ! -d "node_modules" ]; then
    echo "[llama-web] installing dependencies..."
    bun install || failed $?
  fi
  echo "[llama-web] building..."
  bun run build || failed $?
fi

echo "[llama-web] starting..."
bun ".output/server/index.mjs" || failed $?
