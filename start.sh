#!/bin/bash

# Load env vars
export $(cat .env | xargs)
export AWS_REGION=us-west-2   # or whichever region your company uses

MCP_PATH=~/Library/Application\ Support/Claude/Claude\ Extensions/local.mcpb.tableau.tableau/build/index.js

# Start supergateway, passing Tableau env vars explicitly to the child process
SERVER="$TABLEAU_SERVER" \
SITE_NAME="$TABLEAU_SITE" \
PAT_NAME="$TABLEAU_PAT_NAME" \
PAT_VALUE="$TABLEAU_PAT_VALUE" \
npx -y supergateway --port 3100 --stdio "node '$MCP_PATH'" &
MCP_PID=$!
echo "MCP proxy started on port 3100 (PID: $MCP_PID)"

# Give the proxy a moment to start
sleep 2

# Start the Express server
node server.js &
SERVER_PID=$!
echo "Express server started (PID: $SERVER_PID)"

# Handle shutdown cleanly
trap "kill $MCP_PID $SERVER_PID" EXIT
wait
