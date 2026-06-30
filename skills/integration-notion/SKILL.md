---
name: integration-notion
description: Connect Notion (docs, CRM-lite, memory, SOPs) to a running Hermes agent using a static internal integration token. Use when the user wants Hermes to read, search, create, or update Notion pages and databases.
---

# /integration-notion — connect Notion to Hermes

You are the engineer connecting Notion to a running Hermes agent. Notion is the agent's
docs / CRM-lite / long-term memory / SOP store. Work autonomously; stop only for the two
things a machine cannot do: minting the integration token, and sharing the target pages /
databases with the integration inside the Notion UI.

**Honest auth picture (verified 2026-06):** Notion ships an official **hosted** remote MCP
server at `https://mcp.notion.com/mcp`, but it is **OAuth-only** — Notion's own docs state
it "requires user-based OAuth authentication and does not support bearer token
authentication." That breaks the one-click / headless promise for a server-side agent, so we
do **not** wire the hosted MCP via `/hermes-mcp-add`. Instead use the official open-source
server, which takes a **static `ntn_` integration token** — perfect for a self-hosted agent.

## Before you start — gather (ask once)

1. **Internal integration token** — starts with `ntn_`. Mint it at
   <https://www.notion.com/my-integrations> → **Build** sidebar → **Internal connections** →
   **Create a new connection** → copy the token from the **Configuration** tab.
2. **Shared content** — the integration sees **nothing** until pages/databases are shared
   with it. In Notion: open each target page/DB → `...` menu → **+ Add Connections** →
   select your integration. Confirm this is done, or every call returns empty / 404.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<ntn_...>           # the integration secret; injected via sed, never echoed
```

---

## Step 1 — store the token in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set NOTION_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^NOTION_TOKEN=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (note the `|` delimiter — `ntn_` tokens are alnum but stay
> consistent with the base procedure):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^NOTION_TOKEN=' /opt/data/.env || printf 'NOTION_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^NOTION_TOKEN=.*|NOTION_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Notion. Pick the path that matches your Hermes build.

A static token alone does **not** connect Notion to the agent — it only stores the
credential. You must give the agent a tool surface. Two verified options:

### Path A (preferred) — official open-source MCP server (static token, stdio)

The official server `@notionhq/notion-mcp-server` reads a static `ntn_` token and exposes
Notion search/read/create/update as MCP tools. It is a **local stdio** server (run with
`npx`), so it is added to Hermes as a command-based MCP, not via the HTTP `/hermes-mcp-add`
probe flow (that flow is for remote HTTP endpoints). Register it if your Hermes supports
stdio MCP servers:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add notion \
    --command "npx" \
    --args "-y,@notionhq/notion-mcp-server" \
    --env "NOTION_TOKEN=\${NOTION_TOKEN}"
```

The server also accepts the header form if you prefer explicit versioning:
`OPENAPI_MCP_HEADERS={"Authorization":"Bearer ntn_...","Notion-Version":"2025-09-03"}`.
Use `${NOTION_TOKEN}` indirection so the secret stays only in `/opt/data/.env`.

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
> If your build is HTTP-MCP-only and cannot launch a stdio command, use Path B.

### Path B — generic HTTP tool against the Notion REST API

No bearer-auth remote MCP exists for Notion (the hosted one is OAuth-only, see top). If you
cannot run the stdio server, point a generic HTTP/tool capability at the REST API directly:

- **Base URL:** `https://api.notion.com/v1`
- **Auth header:** `Authorization: Bearer ${NOTION_TOKEN}`
- **Required version header:** `Notion-Version: 2025-09-03`
- **Content type:** `Content-Type: application/json`

Common endpoints: `POST /v1/search`, `GET /v1/pages/{id}`, `POST /v1/pages`,
`POST /v1/databases/{id}/query`, `PATCH /v1/pages/{id}`.

> Do **not** try to register `https://mcp.notion.com/mcp` through `/hermes-mcp-add` with a
> bearer token — it returns an auth error because that endpoint only accepts OAuth.

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
| 1 | Wiring the hosted `mcp.notion.com` MCP with a token | It is **OAuth-only**; bearer tokens are rejected. No headless path. | Use the stdio server (Path A) or REST (Path B). |
| 2 | Token set but every call returns empty / 404 | The integration has not been **shared** with the page/DB. | In Notion, `...` → **+ Add Connections** on each target. |
| 3 | Missing `Notion-Version` header | Notion API rejects unversioned requests. | Always send `Notion-Version: 2025-09-03` (or current). |
| 4 | Internal vs public token confusion | Public/OAuth tokens behave differently and may expire. | Use an **internal** integration token (`ntn_`). |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 6 | Search returns partial results | Notion `/search` only spans content the integration can see, and paginates. | Confirm sharing scope; follow `next_cursor`. |
| 7 | Rate limits | Notion throttles at roughly 3 requests/sec average; bursts get `429`. | Backoff on `429`; batch reads via DB queries. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path A):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*notion" | tail -5
   ```
2. **Real API call returns data (works for both paths):** run inside the container so the
   token comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://api.notion.com/v1/search" \
       -H "Authorization: Bearer $NOTION_TOKEN" \
       -H "Notion-Version: 2025-09-03" \
       -H "Content-Type: application/json" \
       -d "{\"page_size\":1}"'
   ```
   `200` = token valid and scoped. `401` = bad/empty token (re-check step 1). A `200` with an
   empty `results` array means the token works but nothing is shared yet (pitfall 2).
3. **End-to-end from chat:** `@<agent> search my Notion for "<a page you shared>"` should
   return the page. An empty-but-valid response is still a pass for the wiring.

---

## Definition of done

- [ ] `NOTION_TOKEN` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] Target pages/databases are shared with the integration (+ Add Connections done).
- [ ] Notion is connected via Path A (stdio MCP tools registered) or Path B (REST base documented and reachable).
- [ ] `POST /v1/search` from inside the container returns `200`.
- [ ] A chat-driven Notion search returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
