---
name: dashboard
description: Install the Atlas dashboard — a read-only web interface for a self-hosted Hermes Agent — and connect it to an agent that is already running. One command. Use when the user says "add a dashboard", "I want an interface", "/dashboard", "connect a frontend", or "monitor my agent in a browser".
---

# /dashboard — give your running Hermes Agent a face

`/dashboard` stands up **Atlas**, hstack's read-only monitoring dashboard, and points it at a
Hermes Agent you **already have running**. It's the one-command way to go from "my agent works
over Telegram" to "I can watch it work in a browser" — no rebuild of the agent, no risk to it.

Atlas ships in this repo under [`dashboard/`](../../dashboard): a zero-build HTML **prototype**
and a production **Next.js** app. Both read the agent's own JSON API and render:

- **Overview / Channels / Schedule / Activity / Usage** — status, connected platforms, cron jobs, recent sessions, token cost.
- **Visualize** — a live pixel "office" where each room is a Hermes **toolset** (Web, Browser, Terminal, Code, Memory, Channels, Media, Integrations·MCP, …) and agents walk to the room of whatever tool they're running.
- **Self-improving:** rooms and toolset tiles are built from the agent's **live capabilities** (`/v1/capabilities`). Add a new tool or MCP server to your agent and a new room + tile appear automatically — in both the normal and pixel skins.

## When to use this vs `/hermes-deploy`

- **Already have Hermes running** (set it up manually or earlier) → run `/dashboard`. It only adds the interface.
- **Starting from scratch** → run `/hermes-deploy`; it sets up the agent *and* offers the dashboard at the end.

## Prerequisites (Claude: confirm these first)

1. A reachable Hermes Agent. The dashboard reads its **dashboard API on port `9119`**
   (`HERMES_DASHBOARD=1`). The capability probe additionally uses the **API server on `8642`**
   (`API_SERVER_ENABLED=true`, Bearer token) — optional but it powers live toolset detection.
2. Node.js ≥ 18 **only if** the user wants the Next.js build. The prototype needs nothing but a browser.

## Steps

### 1. Get the dashboard files
They're already in this repo. If the user installed hstack, they're at `~/.claude/skills/hstack/dashboard/`.
Otherwise clone shallowly:
```bash
git clone --depth 1 https://github.com/paarths-collab/hstack.git ~/hstack && cd ~/hstack/dashboard
```

### 2. Open a secure tunnel to the agent (never expose :9119 raw)
The upstream Hermes dashboard has **no authentication**. Reach it over SSH from the user's laptop:
```bash
ssh -L 9119:127.0.0.1:9119 USER@YOUR-VPS      # leave running; the agent's API is now at 127.0.0.1:9119
```
For always-on remote access, put an HTTPS + password reverse proxy (Caddy/Traefik) in front instead.

### 3a. Fastest — the zero-build prototype
Set the API base to the tunnel, then serve the folder (any static server; GET-only):
- In `dashboard/prototype/data.js`, set `API_BASE: "http://127.0.0.1:9119"` (and, if exposing `:8642`, `API_SERVER_BASE` + `TOKEN` for live capabilities).
- Serve it: `cd dashboard/prototype && python3 -m http.server 4173` → open `http://localhost:4173`.
- If no agent is reachable, the page shows clearly-labelled **DEMO DATA** so it never looks broken.

### 3b. Production — the Next.js app
```bash
cd dashboard/nextjs-handoff
npm install
cp .env.example .env.local        # set HERMES_BASE=http://127.0.0.1:9119 (the tunnel)
npm run dev                       # http://localhost:3000
```
`next.config.ts` proxies the browser's same-origin `/api/*` to `HERMES_BASE`, so there's **no CORS** and any token stays server-side.

### 4. Verify
- The header shows **● LIVE** (not DEMO) and the real Hermes version.
- **Visualize → Active toolsets** lists exactly the tools the agent reports; a freshly-added tool appears as a new tile and a new room.

## Security model (do not weaken)
- **Read-only:** the data layer defines a GET helper only — no POST/PUT/DELETE exists, so the UI cannot change or restart the agent.
- **Localhost-bound:** reach the agent over an SSH tunnel, or an authenticated HTTPS proxy. Never bind `0.0.0.0` / expose `:9119` to the internet — it can read your `.env` secrets.
- **Token stays server-side** (Next.js path); never pasted into chat.

## Notes for Claude
- Pick the prototype for a non-technical user (no Node), the Next.js app for someone deploying it properly.
- Field names in Hermes responses aren't officially documented — the data layer reads defensively and falls back to demo values; if a panel looks empty, log one real response and adjust the normalizers.
- Keep Hermes pinned to **v0.15.2** (current stable) for the dashboard API.
