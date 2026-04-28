# Pacifica Rentals Operations Portal - Local Setup

## Prerequisites

1. **Node.js** (v18+) and npm installed
2. **AWS credentials** configured for Claude via Bedrock (us-west-2 region)
3. **Tableau Connected App** credentials (see below)

## Setup Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. SSL Certificates (Already Generated ✓)
The self-signed SSL certificates (`key.pem` and `cert.pem`) have been generated. Your browser will show a security warning - click "Advanced" and "Proceed to localhost" to accept.

### 3. Configure AWS Credentials

This app uses Claude via AWS Bedrock. Configure your AWS credentials using one of these methods:

**Option A: AWS CLI**
```bash
aws configure
# Enter your AWS Access Key ID, Secret Access Key, and set region to us-west-2
```

**Option B: Environment Variables**
```bash
export AWS_ACCESS_KEY_ID="your-access-key"
export AWS_SECRET_ACCESS_KEY="your-secret-key"
export AWS_REGION="us-west-2"
```

**Option C: AWS Profile**
```bash
# Add to ~/.aws/credentials
[default]
aws_access_key_id = your-access-key
aws_secret_access_key = your-secret-key
region = us-west-2
```

### 4. Environment Configuration

Your `.env` file is already configured with:
- Tableau Connected App credentials
- Tableau server and site details  
- Safety metric ID
- AWS region

**Important**: If you need different Tableau credentials or metric IDs, edit `.env`

### 5. Start the Server

**Simple start (Express server only):**
```bash
npm start
# or
node server.js
```

**Full start (with MCP server for advanced Tableau Pulse features):**
```bash
./start.sh
```

The MCP server path in `start.sh` may need adjustment based on your Claude extensions location.

### 6. Access the Application

Open your browser to:
```
https://localhost:5500
```

Accept the self-signed certificate warning.

## Diagnostic Endpoints

- `https://localhost:5500/debug-auth` - Test Tableau authentication
- `https://localhost:5500/mcp-tools` - List available MCP tools
- `https://localhost:5500/session-token` - Get Tableau REST token
- `https://localhost:5500/pulse-metrics` - Fetch Pulse metrics

## Troubleshooting

### "Cannot find module" errors
```bash
npm install
```

### AWS/Bedrock authentication errors
Verify AWS credentials are configured and you have access to Claude models in Bedrock (us-west-2):
```bash
aws bedrock list-foundation-models --region us-west-2
```

### Tableau authentication errors
1. Check `.env` has correct Connected App credentials
2. Verify the user email has access to the Tableau site
3. Check the Connected App has required scopes:
   - `tableau:views:embed`
   - `tableau:metrics_subscriptions:read`
   - `tableau:insights:read`

### HTTPS certificate warnings
This is normal for self-signed certificates. Click "Advanced" → "Proceed to localhost"

### MCP server not starting
The MCP server is optional. If `start.sh` fails:
1. Check the MCP_PATH in `start.sh` matches your Claude extensions location
2. Or just run `node server.js` directly (MCP features will fall back to direct API)

## Architecture

- **Express server** (server.js) - Main API server on port 5500
- **MCP server** (optional) - Tableau Pulse connector on port 3100
- **Claude via Bedrock** - AI analysis powered by Anthropic Claude Opus 4.5
- **Tableau Connected App** - JWT-based authentication for embedded analytics
- **HTTPS** - Required for Tableau embedded vizzes and browser security features
