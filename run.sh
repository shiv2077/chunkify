#!/bin/bash
# Launches Chunkify: starts a local static server (if not already running) and
# opens it in a chromeless app window. YouTube's IFrame Player API rejects
# file:// origins (Error 153), so this must be served over http, even localhost.
#
#   run.sh               serve + open the app window
#   run.sh --serve-only  just guarantee the server is up (used by the launcher)
#   run.sh --helper      also start the local generator and helper.py, then open
#
# Optional config in ~/.config/chunkify/env (see README) supplies the judge key.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Optional config, deliberately outside the repo so a provider key can never be
# committed by accident. Anything already exported in the environment wins.
CONFIG="${CHUNKIFY_ENV:-$HOME/.config/chunkify/env}"
if [ -f "$CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
fi

PORT=8934
HELPER_PORT="${CHUNKIFY_HELPER_PORT:-8935}"
URL="http://localhost:$PORT/index.html"

if ! curl -s -o /dev/null "$URL"; then
  (cd "$DIR" && nohup python3 -m http.server "$PORT" >/tmp/chunkify-server.log 2>&1 &)
  for i in $(seq 1 20); do
    curl -s -o /dev/null "$URL" && break
    sleep 0.2
  done
fi

# The helper is optional in every sense: it is off unless asked for, and the app
# hides its features and works normally when it is not answering.
if [ "$1" = "--helper" ] || [ "$CHUNKIFY_HELPER" = "1" ]; then
  # local card generator, if it is installed
  OLLAMA="${OLLAMA_BIN:-$HOME/.local/ollama/bin/ollama}"
  if [ -x "$OLLAMA" ] && ! curl -s -o /dev/null -m 2 http://localhost:11434/api/version; then
    (OLLAMA_HOST=127.0.0.1:11434 nohup "$OLLAMA" serve >/tmp/ollama.log 2>&1 &)
    for i in $(seq 1 30); do
      curl -s -o /dev/null -m 1 http://localhost:11434/api/version && break
      sleep 0.5
    done
  fi

  if ! curl -s -o /dev/null "http://localhost:$HELPER_PORT/health"; then
    (cd "$DIR" && nohup python3 helper.py >/tmp/chunkify-helper.log 2>&1 &)
    for i in $(seq 1 20); do
      curl -s -o /dev/null "http://localhost:$HELPER_PORT/health" && break
      sleep 0.2
    done
  fi
  curl -s -o /dev/null "http://localhost:$HELPER_PORT/health" \
    || echo "helper did not start; see /tmp/chunkify-helper.log" >&2
fi

[ "$1" = "--serve-only" ] && exit 0

# App window (no tabs/address bar) via any Chromium-family browser; --class
# binds the window to the desktop entry so the dock shows the Chunkify icon.
for b in google-chrome brave chromium chromium-browser microsoft-edge; do
  if command -v "$b" >/dev/null; then
    exec "$b" --app="$URL" --class=chunkify --name=chunkify
  fi
done
xdg-open "$URL"   # no chromium-family browser: plain tab
