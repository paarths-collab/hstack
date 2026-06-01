# Hermes Agent — Dashboard API Contract (for building a frontend)

Give this file to Claude Code. It is the complete endpoint reference for building a monitoring
dashboard against a self-hosted Hermes Agent.

**Verification legend:** ✅ verified (official docs + source) · ⚠️ inferred (probe/log the real response shape at runtime — field names are NOT officially documented).

---

## 0. The two servers (don't conflate them)

Hermes exposes **two separate HTTP servers** on two ports. `/api/sessions` exists on *both* but they are different services.

| Server | Port | Enable | Auth | Use it for |
|--------|------|--------|------|------------|
| **Web Dashboard** | `9119` | `HERMES_DASHBOARD=1` | OAuth, or localhost-trust, or `--insecure` | ✅ **monitoring** — status, sessions, cron, logs, usage |
| **API Server** (OpenAI-compatible) | `8642` | `API_SERVER_ENABLED=true` | `Authorization: Bearer <API_SERVER_KEY>` | health ping, chat, capabilities probe |

**For a read-only monitoring dashboard, use the Web Dashboard (9119) as the primary source.** Use 8642 only for `/health` liveness and `/v1/capabilities`.

---

## 1. Connection + security (build this in from the start)

```js
// Same origin if the frontend is served behind the same proxy as :9119.
// Or an SSH-tunnelled localhost: ssh -L 9119:127.0.0.1:9119 user@vps
const API_BASE = "";                 // "" = same origin, or "http://127.0.0.1:9119"
const headers  = {};                 // 9119 localhost needs none; add Bearer for 8642
```

**Hard rules (the upstream dashboard has NO auth of its own — it only binds to 127.0.0.1):**
- A monitoring dashboard must issue **GET only**. Never wire POST/PUT/DELETE into a public view.
- **Never bind `0.0.0.0` / expose to the internet without your own password + HTTPS.** If remote, put Caddy/Traefik (HTTPS + basic-auth) in front and pin Starlette ≥1.0.1 (BadHost CVE-2026-48710).
- **CORS:** a frontend on a *different* origin can't call `:9119` directly. Either serve the frontend same-origin behind the proxy (`API_BASE=""`), or use the **8642** API server with `API_SERVER_CORS_ORIGINS` set.
- Pin Hermes **v0.15.0** for the dashboard — `v0.15.2`'s dashboard wheel is broken (#34701).

---

## 2. Web Dashboard endpoints — port 9119 (the ones you'll actually use)

All ✅ verified to exist. Response shapes ⚠️ inferred — log a real response and adapt.

### Status / health  → the "is my agent online" hero + KPI cards
```
GET /api/status
```
✅ Returns: version, gateway running state, platform connectivity, active session count. The official Status page **polls this every 5s** — do the same.
⚠️ Likely shape:
```jsonc
{ "version": "0.15.0",
  "gateway": { "running": true },          // may be a string "running" — handle both
  "platforms": [ { "name": "Telegram", "connected": true }, ... ],
  "sessions": { "active": 3 },
  "health":   { "cpu": 24, "mem": 61, "disk": 43 }   // presence not guaranteed — fallback gracefully
}
```

### Sessions  → "recent activity" / conversation list
```
GET /api/sessions                      ✅ 20 most recent, with metadata
GET /api/sessions/{id}                 ✅ single session metadata
GET /api/sessions/{id}/messages        ✅ full history incl. tool calls
GET /api/sessions/search?q=<text>      ✅ FTS5 full-text search
DELETE /api/sessions/{id}              ✅ (mutating — DO NOT use in a read-only view)
```
⚠️ Per-session fields likely include id, updated/timestamp, platform/channel, a title/summary/preview, token count. Probe to confirm.

### Logs  → live log tail panel
```
GET /api/logs?file=agent|errors|gateway&lines=50|100|200|500&level=ALL|DEBUG|INFO|WARNING|ERROR&component=<name>
```
✅ Params verified. ⚠️ Returns either an array of strings or `{lines:[...]}` — handle both.

### Usage / cost  → token + cost meter (protects the cost value-prop)
```
GET /api/analytics/usage?days=7|30|90
```
✅ Returns token / cost / cache-hit breakdown. ⚠️ Shape — expect totals + a per-day series; log to confirm field names (`tokens`, `cost`, `cache_hit_rate`, daily array).

### Cron / scheduled jobs  → "scheduled tasks" tab
```
GET    /api/cron/jobs                       ✅ list (read)
POST   /api/cron/jobs                        ⚠️ create        (mutating)
POST   /api/cron/jobs/{id}/pause             ⚠️ (mutating)
POST   /api/cron/jobs/{id}/resume            ⚠️ (mutating)
POST   /api/cron/jobs/{id}/trigger           ⚠️ (mutating)
DELETE /api/cron/jobs/{id}                    ⚠️ (mutating)
```
⚠️ Job fields likely: id, name/prompt, schedule/cadence, next_run, paused.

### Skills  → skills manager
```
GET /api/skills                ✅ installed skills
PUT /api/skills/toggle         ⚠️ enable/disable (mutating)
GET /api/tools/toolsets        ✅ available toolsets
```

### Config / env  → settings editor (advanced; mutating — gate hard)
```
GET /api/config                ✅   PUT /api/config              ⚠️ (mutating)
GET /api/config/defaults       ✅   GET /api/config/schema       ✅
GET /api/env                   ✅ (secret VALUES are redacted on GET)
PUT /api/env  DELETE /api/env  ⚠️ (mutating — writes secrets; never expose)
```

### Embedded terminal (optional, dangerous)
```
WebSocket /api/pty             ⚠️ only if HERMES_DASHBOARD_TUI=1 — this is effectively RCE. Off by default.
```

---

## 3. API Server endpoints — port 8642 (for liveness + capability probe)

Requires `API_SERVER_ENABLED=true` and `Authorization: Bearer <API_SERVER_KEY>` on **every** request.

```
GET  /health                  ✅ → {"status":"ok"}      ← lightweight liveness ping
GET  /v1/health               ✅
GET  /health/detailed         ✅ sessions + resource info
GET  /v1/capabilities         ✅ machine-readable API surface — PROBE THIS AT STARTUP to learn
                                  what the running version actually supports (the API is evolving)
GET  /v1/models               ✅ available models
GET  /v1/skills  /v1/toolsets ✅
POST /v1/chat/completions     ✅ OpenAI-compatible — powers a "send a test message" button
POST /v1/runs                 ✅ start a run
GET  /v1/runs/{id}/events     ✅ SSE stream of run events  ← for live "watch it work"
POST /v1/runs/{id}/stop       ✅
```

---

## 4. Panel → endpoint map (so the frontend knows what to call)

| UI panel | Endpoint(s) | Poll |
|----------|-------------|------|
| Online/offline hero + version | `GET /api/status` | 5s |
| Platforms connected | `GET /api/status` → `.platforms` | 5s |
| Server health (CPU/RAM/disk) | `GET /api/status` → `.health` | 5s |
| Active sessions count | `GET /api/status` → `.sessions.active` | 5s |
| Recent activity / conversations | `GET /api/sessions` | 10s |
| Scheduled tasks | `GET /api/cron/jobs` | 30s |
| Log tail | `GET /api/logs?file=gateway&lines=50` | 10s |
| Usage / cost | `GET /api/analytics/usage?days=7` | 60s |
| Liveness dot | `GET /health` (8642) | 5s |
| "Send test message" button | `POST /v1/chat/completions` (8642) | on click |

### Panels that need data Hermes may NOT expose directly (verify / derive)
These are high-value (from user feedback) but **not confirmed as dedicated endpoints** — probe `/api/status` and `/api/config`, or compute client-side; don't assume they exist:
- **Memory-ceiling meter** ("1,361/1,375 chars") — char limits are in config (`memory_char_limit: 2200`, `user_char_limit: 1375`); current usage may not be in `/api/status`. ⚠️ verify.
- **Capability health** ("Vision: degraded — no key") — derive from `/api/config` + `/v1/capabilities`; not a single endpoint. ⚠️
- **Per-provider / circuit-breaker status** — ⚠️ not confirmed; may need log parsing.

---

## 5. Enabling the servers (Docker — your VPS)

```bash
docker run -d --name hermes --restart unless-stopped \
  -v ~/.hermes:/opt/data \
  -p 8642:8642 -p 9119:9119 \
  -e HERMES_DASHBOARD=1 \
  -e API_SERVER_ENABLED=true \
  -e API_SERVER_HOST=0.0.0.0 \
  -e API_SERVER_KEY="$(openssl rand -hex 32)" \
  -e API_SERVER_CORS_ORIGINS="https://your-frontend-origin" \
  nousresearch/hermes-agent:latest gateway run
```
Native: `hermes dashboard --port 9119 --host 127.0.0.1`.

### Relevant env vars
```
HERMES_DASHBOARD=1                 HERMES_DASHBOARD_HOST (127.0.0.1 CLI / 0.0.0.0 container)
HERMES_DASHBOARD_PORT=9119         HERMES_DASHBOARD_INSECURE=1  (disables OAuth — firewalled only)
HERMES_DASHBOARD_TUI=1             (exposes /api/pty terminal — leave OFF)
API_SERVER_ENABLED=true            API_SERVER_HOST / API_SERVER_PORT(8642)
API_SERVER_KEY=<≥8 chars>          API_SERVER_CORS_ORIGINS=<origin or *>
```

---

## 6. The instruction to give Claude Code

> Build a read-only monitoring dashboard for a self-hosted Hermes Agent using the endpoints in
> hstack-api-endpoints.md. Use the Web Dashboard API on port 9119 (GET only). Poll `/api/status`
> every 5s for the hero/health/platforms, `/api/sessions` for recent activity, `/api/cron/jobs` for
> tasks, `/api/analytics/usage?days=7` for cost, `/api/logs` for the log tail. Probe
> `/v1/capabilities` (8642) at startup. Write it defensively — the exact JSON field names aren't
> documented, so log one real response and adapt, with graceful fallbacks for missing fields.
> Default `API_BASE=""` (same origin) and never wire mutating endpoints into the view.

---

### Sources
- [Web Dashboard docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard) ·
  [API Server docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server) ·
  [Docker docs](https://hermes-agent.nousresearch.com/docs/user-guide/docker)
