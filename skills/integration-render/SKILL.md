---
name: integration-render
description: Connect Render (backend hosting, static sites, cron jobs, Postgres) to a running Hermes agent via Render's official hosted MCP server. Use when the user wants their Hermes agent to create, deploy, inspect, or monitor Render services and databases.
---

# /integration-render — connect Render to Hermes

You are the engineer connecting Render to a running Hermes agent. Render ships a **first-party
hosted MCP server**, so the happy path is to wire that endpoint through the standard
`/hermes-mcp-add` procedure. Do everything autonomously; stop only for the one thing a machine
cannot do: mint the API key in the Render dashboard.

Render's hosted MCP server is the recommended integration path — it auto-updates as Render adds
capabilities, and it covers services, static sites, cron jobs, Postgres, logs, deploys, and
metrics. Verified first-party (repo `render-oss/render-mcp-server`, endpoint `mcp.render.com`).

## Before you start — gather (ask once)

1. **Render API key** — the user mints it at
   `https://dashboard.render.com/u/settings?add-api-key` (Account Settings -> API Keys ->
   Create API Key). It is a static bearer credential, not OAuth. Copy it once; Render shows it
   only at creation time.
   - Heads-up to relay: Render API keys are **broadly scoped** — one key grants access to
     **all workspaces and all services** the account can reach. There is no per-service or
     read-only scope. Prefer a key on an account/workspace with the minimum blast radius.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars:
```bash
AGENT=<container-name>                       # e.g. hermes-agent-xxxx-hermes-agent-1
URL=https://mcp.render.com/mcp               # official hosted Render MCP endpoint
NAME=render                                  # -> env var MCP_RENDER_API_KEY
TOKEN=<render-api-key>                       # never log; injected via sed in mcp-add step
```

---

## Step 1 — wire the hosted MCP server via /hermes-mcp-add

Render's MCP server uses **streamable HTTP** with bearer auth:
`Authorization: Bearer <RENDER_API_KEY>`. This is exactly the `--auth header` shape that
`/hermes-mcp-add` handles. Run that skill end to end with these values — do not hand-roll the
registration:

- **URL**: `https://mcp.render.com/mcp`
- **Auth**: header `Authorization` = `Bearer ${MCP_RENDER_API_KEY}`
- **Name**: `render` (Hermes derives env var `MCP_RENDER_API_KEY`)

The mcp-add procedure will: probe the endpoint, register with a **placeholder** token, inject
the real key into `/opt/data/.env` with a `|`-delimited `sed`, `chmod 600`, then reload with
`gateway stop` + `gateway run`. The condensed registration (see `/hermes-mcp-add` for the full
probe + verify steps):

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_RENDER_API_KEY

# Register with placeholder (real token never piped through docker exec)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" hermes mcp add "$NAME" --url "$URL" --auth header

# Inject the real key, then lock the file
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# Reload the gateway (stop+run, not restart — env must be re-read)
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

During the probe step note that Render's `initialize` handshake may succeed before auth is
enforced — confirm a real `tools/list` returns data **with** the bearer header, per
`/hermes-mcp-add` step 2.

## Step 2 — select the Render workspace

The Render MCP server is workspace-aware and starts with **no workspace selected**. Tool calls
that touch resources fail until you pick one. From the chat interface, drive the agent to call
the server's `list_workspaces` then `select_workspace` tools:

```
@<agent> using render, list my workspaces, then select <workspace-name>
```

`select_workspace` takes the workspace `ownerID` returned by `list_workspaces`. Until this is
set, expect "no workspace selected" style errors even though auth is correct.

---

## Pitfalls

- **Broad scope, no read-only mode.** A Render API key is all-or-nothing across every workspace
  and service on the account. There is no scoped or read-only key. Treat it as a full-control
  credential; rotate immediately at `https://dashboard.render.com/u/settings` if it leaks.
- **Workspace not selected.** Auth can be perfect and calls still fail because no workspace is
  selected (Step 2). Always select before expecting `list_services` etc. to return data.
- **Static key, not OAuth.** The key is shown once at creation. If lost, you cannot retrieve it
  — create a new one and revoke the old.
- **Self-hosted REST fallback is heavier.** If you ever bypass the hosted MCP, the REST API base
  is `https://api.render.com/v1` with the same `Authorization: Bearer <key>` header. The hosted
  MCP is strongly preferred because it tracks new Render features automatically.
- **Rate limits.** The Render API is rate limited; bursty agent loops (polling deploy status in
  a tight loop) can get throttled. Have the agent back off rather than hammer.

## Verify

```bash
# Tools registered in the gateway logs
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|render" | tail -5
```

Success shows `registered N tool(s)` for `render` (list_services, create_web_service,
get_service, deploy/log/metric tools, Postgres query). Then prove a live call end to end after
selecting a workspace:

```
@<agent> using render, list my services
```

An empty-but-valid list (`[]`) is a pass — every layer worked. "Bearer token missing" or auth
errors mean the key did not land; re-check the `sed` inject step in `/hermes-mcp-add`.

## Definition of done

- [ ] `https://mcp.render.com/mcp` registered in `config.yaml` as `render` with
      `Authorization: Bearer ${MCP_RENDER_API_KEY}` (placeholder only in config, real key in `.env`).
- [ ] `MCP_RENDER_API_KEY` set in `/opt/data/.env`, `chmod 600`, real token **not** in `config.yaml` or chat.
- [ ] `hermes logs` shows `registered N tool(s)` for `render`.
- [ ] A workspace is selected and `using render, list my services` returns a valid response.
- [ ] See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
