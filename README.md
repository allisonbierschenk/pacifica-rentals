# Pacifica Rentals — Tableau Pulse Demo

An Express + Claude demo that pulls live metrics from **Tableau Pulse** through an MCP proxy and renders an executive briefing in the browser.

> Already have your dev environment set up? Skip ahead to **[Run it](#run-it)**. If not, see the separate dev-bootstrap demo first.

---

## What's in the box

| File | Purpose |
| --- | --- |
| `server.js` | Express server. Mints a Tableau JWT, talks to Claude + the MCP proxy, serves the UI. |
| `index.html` | Single-page UI for the brief. |
| `pulse-brief-utils.js` | Helpers used by the brief renderer. |
| `start.sh` | Boots the MCP proxy on `:3100` and the Express server on `:5500`. |
| `.env.example` | Required environment variables — copy to `.env` and fill in. |

---

## Configure your `.env`

```bash
cp .env.example .env
```

Fill in every value. **Never commit this file** — it's already in `.gitignore`.

| Variable | Where it comes from |
| --- | --- |
| `TABLEAU_CLIENT_ID` | Tableau → Settings → **Connected Apps** → your app |
| `TABLEAU_SECRET_ID` | Same Connected App → secret pair |
| `TABLEAU_SECRET_VALUE` | Same Connected App → secret pair (shown once) |
| `TABLEAU_USER` | Email of the service account that owns the Connected App |
| `TABLEAU_SERVER` | Your Tableau Cloud URL, e.g. `https://10az.online.tableau.com` |
| `TABLEAU_SITE` | Site name from the Tableau URL |
| `TABLEAU_API` | API version, e.g. `3.28` |
| `TABLEAU_PAT_NAME` | Personal Access Token name (used by the MCP proxy) |
| `TABLEAU_PAT_VALUE` | Personal Access Token value |
| `SAFETY_METRIC_ID` | UUID of the safety metric in Tableau Pulse |
| `SAFETY_DATASOURCE_LUID` | LUID of the safety datasource |
| `MCP_SERVER_URL` | MCP endpoint (defaults to `http://localhost:3100/mcp`) |

---

## Run it

```bash
./start.sh
```

This launches two processes:

- **MCP proxy** → `http://localhost:3100`
- **Express server** → `https://localhost:5500`

Open **https://localhost:5500** and accept the self-signed certificate warning.

Stop both with `Ctrl+C` — the trap in `start.sh` cleans up child processes.

---

## How it fits together

```
Browser (index.html)
        │
        ▼
Express :5500 ──► Claude
        │
        ▼
Supergateway MCP proxy :3100 ──► Tableau MCP (Claude Desktop extension)
        │
        ▼
Tableau Cloud (Pulse + REST API, JWT-authenticated)
```

The Express server mints a short-lived JWT for the Tableau Connected App, asks Claude to summarize the metrics, and streams the result back to the page.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ENOENT: key.pem` on start | Generate certs (`openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes`), or delete the files to force HTTP. |
| MCP proxy fails to start | Confirm Claude Desktop is installed and the path in `start.sh` (line 7) exists on your machine. |
| Tableau auth failing | Hit `https://localhost:5500/debug-auth` for a JWT diagnostic dump. |
| Port already in use | Make sure nothing else is on `5500` or `3100` (`lsof -i :5500`). |

---

## Security notes

- `.env`, `*.pem`, `*.key`, and `*.crt` are gitignored. **Do not commit secrets.**
- The Tableau Connected App secret gives wide access — rotate it if it ever lands in a commit, screenshot, or chat thread.
- The self-signed cert is for **local development only**. Don't reuse it for anything reachable from the internet.

---

## Repo layout

```
pacifica-rentals/
├── architecture.html          # Static architecture diagram
├── index.html                 # Brief UI
├── pulse-brief-utils.js       # Brief renderer helpers
├── server.js                  # Express server + Claude + MCP client
├── start.sh                   # Boots MCP proxy + Express
├── Safety_Production_Mock_2.csv
├── .env.example               # Template — copy to .env
├── package.json
└── README.md
```
