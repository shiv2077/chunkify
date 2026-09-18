#!/bin/bash
# Launches Chunkify: starts a local static server (if not already running) and
# opens it in a chromeless app window. YouTube's IFrame Player API rejects
# file:// origins (Error 153), so this must be served over http, even localhost.
#
#   run.sh               serve + open the app window
#   run.sh --serve-only  just guarantee the server is up (used by the launcher)
#   run.sh --helper      also start helper.py (transcripts + judge), then open
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
