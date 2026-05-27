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
| `start.sh` | Boots the Express server on `:5500` and opens the browser. |
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
| `SAFETY_METRIC_ID` | UUID of the safety metric in Tableau Pulse |
| `SAFETY_DATASOURCE_LUID` | LUID of the safety datasource (queried via VizQL Data Service) |

---

## Run it

```bash
npm run start
```

The Express server starts on **http://localhost:5500** and your browser opens automatically.

Stop with `Ctrl+C` — the trap in `start.sh` cleans up child processes.

> Want HTTPS? Run `openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"` and the next start will switch to HTTPS automatically.

---

## How it fits together

```
Browser (index.html)
        │
        ▼
Express :5500
        │
        ▼
Tableau Cloud (JWT-authenticated)
  ├── Pulse Insights API     → AI-written narrative summaries
  └── VizQL Data Service API → row-level incident queries
```

The Express server mints a short-lived JWT for the Tableau Connected App, calls Pulse Insights for the AI-generated narratives, and uses VizQL Data Service for row-level incident data. No external LLM, no MCP — Pulse already does the AI summarization on Tableau's side.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Tableau auth failing | Hit `http://localhost:5500/debug-auth` for a JWT diagnostic dump. |
| `vizql ... HTTP 4xx` | Confirm VizQL Data Service is enabled on your Tableau site and `SAFETY_DATASOURCE_LUID` is correct. |
| Port already in use | Make sure nothing else is on `5500` (`lsof -i :5500`). |
| HTTPS instead of HTTP | If `key.pem`/`cert.pem` exist in the repo root, the server uses HTTPS. Delete them to force HTTP. |

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
