---
name: integration-webflow
description: Connect Webflow (marketing site CMS, pages, collections, publishing) to a running Hermes agent using a static site API token. Use when the user wants Hermes to read, query, create, update, or publish Webflow CMS items and pages.
---

# /integration-webflow — connect Webflow to Hermes

You are the engineer connecting Webflow to a running Hermes agent. Webflow is the agent's
marketing-site CMS: collections, pages, SEO fields, and publish actions. Work autonomously;
stop only for the two things a machine cannot do: minting the site API token in the Webflow
UI, and (Path A) publishing the MCP Bridge App to the workspace.

**Honest auth picture (verified 2026-06):** Webflow ships an official **hosted** remote MCP
server at `https://mcp.webflow.com/sse` (and `https://mcp.webflow.com/mcp`), but it is
**OAuth-only** — each authorization grants per-workspace browser-consented access. That
breaks the one-click / headless promise for a server-side agent, so we do **not** wire the
hosted MCP via `/hermes-mcp-add`. Instead use the official open-source server
`webflow-mcp-server`, which takes a **static site API token** — perfect for a self-hosted
agent. See <https://github.com/webflow/mcp-server> and
<https://developers.webflow.com/data/reference/authentication/site-token>.

## Before you start — gather (ask once)

1. **Site API token** — a v2 Data API site token. Mint it at:
   workspace → site → **gear icon (Site settings)** → **Apps & integrations** → scroll to
   **API access** → **Generate API token** → pick scopes (`cms:read`, `cms:write`,
   `pages:read`, `pages:write`, `sites:read`, `sites:write` cover marketing-site work) →
   copy once. Each site allows up to 5 tokens; tokens expire after 365 days of inactivity.
2. **Site ID** — the long ID for the site you will manage. Get it from `GET /v2/sites` with
   the token, or from the URL of site settings.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<webflow-site-token> # the secret; injected via sed, never echoed
SITE_ID=<site-id>
```

---

## Step 1 — store the token in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set WEBFLOW_TOKEN "$TOKEN"
docker exec -i -u hermes "$AGENT" hermes config set WEBFLOW_SITE_ID "$SITE_ID"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `1` each, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^WEBFLOW_TOKEN=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^WEBFLOW_SITE_ID=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (note the `|` delimiter — site tokens are alnum but stay consistent
> with the base procedure):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^WEBFLOW_TOKEN=' /opt/data/.env || printf 'WEBFLOW_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^WEBFLOW_TOKEN=.*|WEBFLOW_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Webflow. Pick the path that matches your Hermes build.

A static token alone does **not** connect Webflow to the agent — it only stores the
credential. You must give the agent a tool surface. Two verified options:

### Path A (preferred) — official open-source MCP server (static token, stdio)

The official server `webflow-mcp-server` reads `WEBFLOW_TOKEN` and exposes Webflow Data API
operations (sites, pages, collections, CMS items, publish) as MCP tools. It is a **local
stdio** server (run with `npx`), so it is added to Hermes as a command-based MCP, not via the
HTTP `/hermes-mcp-add` probe flow (that flow is for remote HTTP endpoints). Register it if
your Hermes supports stdio MCP servers:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add webflow \
    --command "npx" \
    --args "-y,webflow-mcp-server@latest" \
    --env "WEBFLOW_TOKEN=\${WEBFLOW_TOKEN}"
```

Use `${WEBFLOW_TOKEN}` indirection so the secret stays only in `/opt/data/.env`. The MCP
Bridge App must be **published** in the target workspace once before the server can act on a
site; do that step in the Webflow UI if Path A returns "app not installed" errors.

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
> If your build is HTTP-MCP-only and cannot launch a stdio command, use Path B.

### Path B — generic HTTP tool against the Webflow Data API

No bearer-auth remote MCP exists for Webflow (the hosted one is OAuth-only, see top). If you
cannot run the stdio server, point a generic HTTP/tool capability at the REST API directly:

- **Base URL:** `https://api.webflow.com/v2`
- **Auth header:** `Authorization: Bearer ${WEBFLOW_TOKEN}`
- **Accept version:** `accept-version: 2.0.0` (optional on v2 but explicit is safer)
- **Content type:** `Content-Type: application/json`

Common endpoints: `GET /v2/sites`, `GET /v2/sites/{site_id}/pages`,
`GET /v2/sites/{site_id}/collections`, `GET /v2/collections/{collection_id}/items`,
`POST /v2/collections/{collection_id}/items`, `PATCH /v2/collections/{collection_id}/items/{item_id}`,
`POST /v2/sites/{site_id}/publish`.

> Do **not** try to register `https://mcp.webflow.com/sse` or `/mcp` through
> `/hermes-mcp-add` with a bearer token — those endpoints only accept OAuth and will reject
> the site token.

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
| 1 | Wiring `mcp.webflow.com` with a site token | It is **OAuth-only**; bearer tokens are rejected. No headless path. | Use the stdio server (Path A) or REST (Path B). |
| 2 | MCP Bridge App not published in the workspace | Path A tools register but every site call errors "app not installed". | Publish the Bridge App in Webflow once per workspace. |
| 3 | Token scope too narrow | Token mints fine but writes/publish return `403`. | Re-mint with `cms:write`, `pages:write`, `sites:write` as needed. |
| 4 | v1 endpoint confusion | Old `/v1` examples return `410`/`404` or wrong shapes. | Use `/v2` exclusively; v1 is deprecated. |
| 5 | Site has 5 tokens already | New token request silently overwrites or fails. | List/rotate at site settings → API access; cap is 5/site. |
| 6 | Publish call without staging review | `POST /v2/sites/{id}/publish` ships live immediately. | Default to `publishTargets: ["staging"]`; explicit opt-in for live. |
| 7 | Rate limits | Webflow throttles ~60 req/min per token; bursts get `429`. | Backoff on `429`; batch CMS reads with pagination. |
| 8 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path A):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*webflow" | tail -5
   ```
2. **Real API call returns data (works for both paths):** run inside the container so the
   token comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X GET "https://api.webflow.com/v2/sites" \
       -H "Authorization: Bearer $WEBFLOW_TOKEN" \
       -H "accept-version: 2.0.0"'
   ```
   `200` = token valid and scoped. `401` = bad/empty token (re-check step 1). `403` = token
   scope too narrow (pitfall 3).
3. **Site-scoped read:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X GET "https://api.webflow.com/v2/sites/$WEBFLOW_SITE_ID/collections" \
       -H "Authorization: Bearer $WEBFLOW_TOKEN"'
   ```
   `200` confirms the token is bound to the right site.
4. **End-to-end from chat:** `@<agent> list my Webflow collections for site <name>` should
   return the collection names.

---

## Definition of done

- [ ] `WEBFLOW_TOKEN` and `WEBFLOW_SITE_ID` are in `/opt/data/.env` with `chmod 600`; not in `config.yaml` or chat.
- [ ] Webflow is connected via Path A (stdio MCP tools registered, Bridge App published) or Path B (REST base documented and reachable).
- [ ] `GET /v2/sites` from inside the container returns `200`.
- [ ] `GET /v2/sites/$WEBFLOW_SITE_ID/collections` returns `200`.
- [ ] A chat-driven Webflow query returns real collection or page data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
