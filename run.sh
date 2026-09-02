#!/bin/bash
# Launches Chunkify: starts a local static server (if not already running) and
# opens it in the default browser. YouTube's IFrame Player API rejects file://
# origins (Error 153), so this must be served over http, even just localhost.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8934

if ! curl -s -o /dev/null "http://localhost:$PORT/index.html"; then
  (cd "$DIR" && nohup python3 -m http.server "$PORT" >/tmp/chunkify-server.log 2>&1 &)
  for i in $(seq 1 20); do
    curl -s -o /dev/null "http://localhost:$PORT/index.html" && break
    sleep 0.2
  done
fi

xdg-open "http://localhost:$PORT/index.html"
