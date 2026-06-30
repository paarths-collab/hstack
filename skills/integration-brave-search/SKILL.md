---
name: integration-brave-search
description: Connect the Brave Search API (real-time web, news, image, video, local search) to a running Hermes agent. Use when the user wants Hermes to do live web research, breaking-news lookups, or LLM-context retrieval without scraping.
---

# /integration-brave-search — connect Brave Search to Hermes

You are the engineer connecting the Brave Search API to a running Hermes agent. Brave Search
gives the agent a real-time research surface: web, news, image, video, local POIs, and an
LLM-context endpoint that returns clean, citation-ready snippets. Work autonomously; stop
only for the one thing a machine cannot do — minting the API subscription key.

**Honest auth picture (verified 2026-06):** Brave ships an official open-source MCP server
at `github.com/brave/brave-search-mcp-server` (npm `@brave/brave-search-mcp-server`). It
supports **STDIO (default) and HTTP** transports, takes a static `BRAVE_API_KEY`, and is
**self-hosted** — there is no first-party hosted remote MCP URL to point `/hermes-mcp-add`
at. So the right shape is: store the key in the Hermes runtime `.env` and register the
official server either as a stdio MCP (Path A, preferred) or as a self-hosted HTTP MCP
wired through `/hermes-mcp-add` (Path B). Brave's REST API itself authenticates via the
`X-Subscription-Token` header, not `Authorization: Bearer` — this matters in Path C.

## Before you start — gather (ask once)

1. **Brave Search API subscription key** — mint at
   <https://api-dashboard.search.brave.com/> → sign in → **API Keys** → **Add API Key**
   (pick a plan; the Free tier supports 1 req/sec and 2,000 queries/month). The key is an
   opaque alphanumeric string with no fixed prefix.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.
3. **Which surfaces** — confirm the user wants web search at minimum; news/image/video/POI/
   `summarizer`/`llm-context` are extras enabled by the same key (plan permitting).

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<brave-api-key>      # the subscription token; injected via sed, never echoed
```

---

## Step 1 — store the key in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write. Never `echo >>` (can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set BRAVE_API_KEY "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^BRAVE_API_KEY=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (use `|` delimiter — Brave keys are alnum but stay consistent):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^BRAVE_API_KEY=' /opt/data/.env || printf 'BRAVE_API_KEY=\n' >> /opt/data/.env; \
>    sed -i 's|^BRAVE_API_KEY=.*|BRAVE_API_KEY=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Brave Search. Pick the path that matches your Hermes build.

### Path A (preferred) — official stdio MCP server, run via npx

`@brave/brave-search-mcp-server` reads `BRAVE_API_KEY` from env and exposes web, news,
image, video, local POI, summarizer, and `llm-context` tools over stdio. Register as a
command-based MCP:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add brave-search \
    --command "npx" \
    --args "-y,@brave/brave-search-mcp-server" \
    --env "BRAVE_API_KEY=\${BRAVE_API_KEY}"
```

Use `${BRAVE_API_KEY}` indirection so the secret stays only in `/opt/data/.env`. The
default transport is stdio; no extra flags needed.

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
> If your build is HTTP-MCP-only and cannot launch a stdio command, use Path B.

### Path B — self-host the official MCP server in HTTP mode, wire via /hermes-mcp-add

Run the same server with `BRAVE_MCP_TRANSPORT=http` (default `BRAVE_MCP_HOST=0.0.0.0`,
`BRAVE_MCP_PORT=8080`) as a sidecar container, then point `/hermes-mcp-add` at it. The
server itself reads `BRAVE_API_KEY` from its own env, so the Hermes-side MCP needs no
auth header — register with `--auth none` (or whatever your build calls "no auth"):

```bash
# On the host, run the Brave MCP server as a sidecar on the agent's docker network
docker run -d --name brave-mcp \
  --network "$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$AGENT")" \
  -e BRAVE_API_KEY="$TOKEN" \
  -e BRAVE_MCP_TRANSPORT=http \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/brave/brave-search-mcp-server:latest

# Then run /hermes-mcp-add with URL=http://brave-mcp:8080/mcp and NAME=brave-search.
# Since auth is enforced by Brave's REST under the hood (not by the MCP wrapper), the
# probe matrix in /hermes-mcp-add step 1 should return 200 on variant B (bare, no header).
```

Follow `/hermes-mcp-add` end to end from step 1 (probe) through step 6 (verify).

### Path C — generic HTTP tool against the Brave REST API

If you cannot run the MCP server at all, point a generic HTTP capability at Brave's REST:

- **Base URL:** `https://api.search.brave.com/res/v1`
- **Auth header:** `X-Subscription-Token: ${BRAVE_API_KEY}` (NOT `Authorization: Bearer`)
- **Accept:** `application/json`
- **Accept-Encoding:** `gzip`

Common endpoints:
- `GET /web/search?q=<query>` — web results
- `GET /news/search?q=<query>` — news results
- `GET /images/search?q=<query>` — images
- `GET /videos/search?q=<query>` — videos
- `GET /summarizer/search?key=<summarizer_key>` — AI summary (key returned by web search)

---

## Step 3 — reload the gateway so the new env / MCP is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new env is
re-read cleanly — same rule as `/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer <key>` | Brave rejects it — REST auth is `X-Subscription-Token`. Returns `401`. | Use `X-Subscription-Token` exactly (case-sensitive header name). |
| 2 | Looking for a hosted remote MCP URL | None exists; the server is self-hosted only. Wiring a made-up URL through `/hermes-mcp-add` fails. | Use Path A (stdio) or Path B (self-host then wire). |
| 3 | Free-tier rate limit | 1 req/sec, 2,000 q/month. Bursty agent traffic hits `429`. | Backoff on `429`; cache repeat queries; upgrade plan for production. |
| 4 | `summarizer` / `llm-context` plan gating | Higher-tier endpoints return `403` on Free. | Confirm plan before enabling those tools in chat. |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file — world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 6 | Stale `gateway restart` | Doesn't always re-read `.env`. | `gateway stop` + `gateway run` (Hermes-specific). |
| 7 | `npx` cold start in Path A | First call after gateway boot times out while npm fetches the package. | Warm it: `docker exec "$AGENT" sh -c 'npx -y @brave/brave-search-mcp-server --help'` once. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path A or B):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*brave" | tail -5
   ```
2. **Real REST call returns data (works for all paths):** run inside the container so the
   token comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Accept: application/json" \
       -H "Accept-Encoding: gzip" \
       -H "X-Subscription-Token: $BRAVE_API_KEY" \
       "https://api.search.brave.com/res/v1/web/search?q=hermes+agent&count=1"'
   ```
   `200` = key valid and quota available. `401` = bad/empty key (re-check step 1). `429` =
   key valid but rate limited (pitfall 3).
3. **End-to-end from chat:** `@<agent> use Brave to search for "<recent news topic>"` should
   return live results with URLs and snippets.

---

## Definition of done

- [ ] `BRAVE_API_KEY` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] Brave Search is connected via Path A (stdio MCP tools registered), Path B (self-hosted HTTP MCP wired through `/hermes-mcp-add`), or Path C (REST base + `X-Subscription-Token` documented).
- [ ] `GET /res/v1/web/search` from inside the container returns `200`.
- [ ] A chat-driven Brave search returns real web results.
- [ ] Gateway was reloaded with `gateway stop` + `gateway run`, not `restart`.

See `reference/TROUBLESHOOTING.md` for gateway reload, MCP registration, and rate-limit failure modes.
