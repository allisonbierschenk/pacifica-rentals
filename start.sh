#!/bin/bash

set -a
source .env
set +a
export AWS_REGION="${AWS_REGION:-us-west-2}"

MCP_PID=""

if [ -z "$MCP_SERVER_URL" ]; then
  MCP_PATH="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.tableau.tableau/build/index.js"
  if [ ! -f "$MCP_PATH" ]; then
    echo "ERROR: MCP_SERVER_URL not set and local Tableau MCP not installed at:"
    echo "  $MCP_PATH"
    exit 1
  fi

  SERVER="$TABLEAU_SERVER" \
  SITE_NAME="$TABLEAU_SITE" \
  PAT_NAME="$TABLEAU_PAT_NAME" \
  PAT_VALUE="$TABLEAU_PAT_VALUE" \
  npx -y supergateway --port 3100 --stdio "node '$MCP_PATH'" &
  MCP_PID=$!
  echo "MCP proxy started on port 3100 (PID: $MCP_PID)"
  sleep 2
else
  echo "Using remote MCP_SERVER_URL=$MCP_SERVER_URL (skipping local proxy)"
fi

node server.js &
SERVER_PID=$!
echo "Express server started (PID: $SERVER_PID)"

PORT="${PORT:-5500}"
SCHEME="http"
[ -f key.pem ] && [ -f cert.pem ] && SCHEME="https"
URL="$SCHEME://localhost:$PORT"

# Wait for the server to be ready, then open the browser
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

trap 'kill ${MCP_PID:-} $SERVER_PID 2>/dev/null' EXIT
wait
