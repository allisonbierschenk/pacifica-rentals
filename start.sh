#!/bin/bash

set -a
source .env
set +a

node server.js &
SERVER_PID=$!
echo "Express server started (PID: $SERVER_PID)"

PORT="${PORT:-5500}"
SCHEME="http"
[ -f key.pem ] && [ -f cert.pem ] && SCHEME="https"
URL="$SCHEME://localhost:$PORT"

(
  for _ in $(seq 1 30); do
    if curl -sk -o /dev/null "$URL"; then
      case "$(uname)" in
        Darwin) open "$URL" ;;
        Linux)  xdg-open "$URL" >/dev/null 2>&1 || true ;;
      esac
      break
    fi
    sleep 0.5
  done
) &

trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait
