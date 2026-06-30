---
name: integration-clickup
description: Connect ClickUp (tasks, docs, project ops) to a running Hermes agent. Use when the user wants their agent to read or manage ClickUp tasks, lists, docs, and comments.
---

# /integration-clickup — connect ClickUp to Hermes

You are the engineer connecting ClickUp to a running Hermes agent. ClickUp is a project
management service: tasks, lists, docs, comments, time tracking. Your job is to give the agent
authenticated access to the user's ClickUp workspace and verify a real call returns data.

Read this before you start: **ClickUp's official MCP server is OAuth-only.** It explicitly does
NOT accept API keys. ClickUp states: "you cannot authenticate using your own API keys... We only
support OAuth for authentication" (https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server).
That breaks the headless one-click promise for the MCP path. The reliable static-token path is the
ClickUp REST API v2, which accepts a personal token that never expires. Default to the REST-token
path (Step 2). Offer the OAuth MCP bridge (Step 3) only if the user wants the full MCP toolset and
can complete a one-time browser login.

## Before you start — gather (ask once)

1. **ClickUp personal API token** — format `pk_...`, never expires. The user mints it at
   `https://app.clickup.com/settings/apps` → under **API Token** click **Generate** → **Copy**.
   Docs: https://developer.clickup.com/docs/authentication
2. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<pk_...>            # ClickUp personal token; never commit, never echo to chat
```

---

## Step 1 — verify the token works (before wiring anything)

The personal token goes in the `Authorization` header as a **raw string — NOT** `Bearer`-prefixed.
This is the #1 ClickUp gotcha. REST base is `https://api.clickup.com/api/v2/`.

```bash
curl -sS -H "Authorization: $TOKEN" https://api.clickup.com/api/v2/user
```

- 200 + a JSON `user` object → token is valid; note the user id.
- 401 `OAUTH_017` / `Token invalid` → wrong token, or it was sent with a `Bearer` prefix.

List the workspaces (ClickUp calls them "teams") the token can see:
```bash
curl -sS -H "Authorization: $TOKEN" https://api.clickup.com/api/v2/team
```

---

## Step 2 — store the token in `/opt/data/.env` (the static-key path)

Write the credential to the Hermes runtime env file inside the container, then lock it down.
Use `hermes config set` so the value is written through Hermes rather than hand-edited, and
**never** `echo >>` into the file (it merges lines and corrupts the env).

```bash
docker exec -u hermes "$AGENT" hermes config set CLICKUP_API_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Confirm it landed (prints the var name only, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^CLICKUP_API_TOKEN=' /opt/data/.env"   # expect 1
```

**No first-party MCP server is verified as key-authenticatable as of 2026-06.** The official MCP
endpoint `https://mcp.clickup.com/mcp` is OAuth-only and will reject `pk_` tokens. With the token in
`/opt/data/.env`, the agent reaches ClickUp through the REST API v2 (base
`https://api.clickup.com/api/v2/`, header `Authorization: <pk_token>` raw) via a generic HTTP/REST
tool or skill. If the user specifically wants the full MCP toolset, go to Step 3.

---

## Step 3 — (optional) wire the official OAuth MCP server via the mcp-remote bridge

The official server is `https://mcp.clickup.com/mcp` and speaks OAuth 2.1 + PKCE only. The standard
`/hermes-mcp-add` bearer-header flow does NOT apply here: there is no static header token to inject.
ClickUp's own headless-client guidance is to bridge with `mcp-remote`, which runs the OAuth browser
flow once and caches the grant
(https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1):

```bash
# Inside the agent container; opens a browser login on first run, then caches the OAuth grant.
docker exec -it -u hermes "$AGENT" npx -y mcp-remote https://mcp.clickup.com/mcp
```

The browser login is a step a machine cannot do for the user — stop and let them complete it. Once
the grant is cached, register the bridged stdio server with Hermes per `/hermes-mcp-add` (stdio
command form, not HTTP-header form). There is **no** `MCP_CLICKUP_API_KEY` to set, because auth is
the cached OAuth grant, not a header. Do not attempt the probe/sed-inject token steps from
`/hermes-mcp-add` against this endpoint — they assume a static bearer token and will fail.

---

## Pitfalls

- **MCP is OAuth-only.** `https://mcp.clickup.com/mcp` rejects `pk_` API keys outright. Do not try to
  wire it with the `/hermes-mcp-add` bearer-header flow; there is no static token to inject. Use the
  REST path (Step 2) or the `mcp-remote` OAuth bridge (Step 3).
- **No `Bearer` prefix for personal tokens.** REST v2 wants `Authorization: pk_...` raw. OAuth access
  tokens (not personal tokens) use `Authorization: Bearer ...`. Mixing these returns 401.
- **MCP rate limits are low without the add-on.** 50 calls / 24h on Free Forever, 300 / 24h on
  Unlimited and above, on a rolling 24h window that cannot be reset. The REST API has its own,
  separate plan-based limits. Budget calls accordingly.
- **Workspace = "team" in the API.** The `/team` endpoint returns workspaces; team/space/folder/list
  ids are required to scope most task calls.
- **Public beta.** The ClickUp MCP server is in public beta; endpoint behavior and the tool set may
  change. Re-verify against the docs if a tool stops resolving.

## Verify

REST path (Step 2): confirm the token in the env file produces live data.
```bash
docker exec -u hermes "$AGENT" sh -c \
  'curl -sS -H "Authorization: $CLICKUP_API_TOKEN" https://api.clickup.com/api/v2/team'
```
A JSON `teams` array (even with one workspace) is a pass. `401` means the token is wrong or the env
var did not load — re-check Step 2.

MCP path (Step 3): after the OAuth grant is cached and the server is registered, check logs.
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 | grep -iE "registered.*tool|clickup" | tail -5
```
Then trigger a real call from chat: `@<agent> using clickup, list my spaces`. An empty-but-valid
result set is a pass.

## Definition of done

- [ ] `https://api.clickup.com/api/v2/team` returns the user's workspace(s) with the supplied token.
- [ ] `CLICKUP_API_TOKEN` is set in `/opt/data/.env` and the file is `chmod 600`.
- [ ] The token appears only in `/opt/data/.env` — never in `config.yaml` and never in chat.
- [ ] The OAuth-only MCP limitation was stated to the user; if they chose Step 3, the `mcp-remote`
      OAuth login was completed and the server registered.
- [ ] A real ClickUp call (REST `/team` or an MCP tool) returns data or a valid empty response.

See `reference/TROUBLESHOOTING.md` for gateway, env-reload, and platform failure modes.
