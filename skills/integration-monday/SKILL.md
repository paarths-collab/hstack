---
name: integration-monday
description: Connect Monday.com to a running Hermes agent via Monday's official hosted MCP server so the agent can read and act on boards, items, and updates. Use when the user wants Hermes to run ops workflows in Monday.com (create/update items, query boards, post updates).
---

# /integration-monday — connect Monday.com to Hermes

You are the engineer connecting Monday.com to a running Hermes agent. Monday ships a
**first-party hosted MCP server** at `https://mcp.monday.com/mcp` that accepts a static
personal API token over a `Authorization: Bearer` header. That maps directly onto the
`/hermes-mcp-add` bearer-header flow, so the happy path is: mint a token, then wire the
hosted MCP. Do everything autonomously; stop only for the token (a machine cannot mint it).

Verified 2026-06 from the official repo `mondaycom/mcp` (README, master branch) and
`developer.monday.com`.

## Before you start — gather (ask once)

1. **Monday personal API token (V2)** — the user mints it in the Monday UI:
   profile picture (top-right) -> **Developers** -> **API token** -> **Show** -> copy.
   Admins can also use profile picture -> **Administration** -> **Connections** ->
   **Personal API token**. Token has no fixed length; its permissions mirror the user's UI
   permissions. Regenerating it immediately invalidates the old one.
   Docs: https://developer.monday.com/api-reference/docs/authentication
2. **Admin install (one-time, per account)** — an account admin must install the Monday MCP
   app from the marketplace so the hosted MCP is enabled for the account:
   https://monday.com/marketplace/listing/10000806/monday-mcp
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars:
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
NAME=monday               # MCP name in Hermes  ->  env var MCP_MONDAY_API_KEY
URL=https://mcp.monday.com/mcp
TOKEN=<monday-personal-api-token>   # never log; injected via sed in the mcp-add flow
```

---

## Step 1 — wire the hosted MCP via /hermes-mcp-add (the happy path)

The hosted server is a verified remote HTTP MCP with bearer auth, so do **not** reinvent the
wiring. Run the full `/hermes-mcp-add` procedure with these exact inputs:

- **URL:** `https://mcp.monday.com/mcp` (bare base — do not append the token to the path)
- **Auth shape:** header `Authorization: Bearer <token>` (the probe matrix in mcp-add step 1
  will confirm; for Monday this is variant **C bearer**)
- **Name:** `monday` -> Hermes generates env var `MCP_MONDAY_API_KEY`

Register with a placeholder, then sed-inject the real token (mcp-add steps 3-4):

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_MONDAY_API_KEY

# Register (placeholder token; never pipe the real one through docker exec)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" --url "$URL" --auth header

# Inject the real token (| delimiter — Monday tokens are JWT-like and contain / + = .)
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

The header value Hermes writes to `config.yaml` must be `Bearer ${MCP_MONDAY_API_KEY}`
(the literal word `Bearer` plus a space, then the placeholder). Confirm:

```bash
docker exec -u hermes "$AGENT" sh -c "grep -iA3 '^  ${NAME}:' \$(hermes config path 2>/dev/null || echo /opt/data/config.yaml)"
# Expect:  Authorization: Bearer ${MCP_MONDAY_API_KEY}
```

If the registered value is the raw `${MCP_MONDAY_API_KEY}` without the `Bearer ` prefix,
re-run `hermes mcp add` and supply the header value as `Bearer placeholder` (Monday's hosted
server rejects a bare token — it requires the `Bearer ` scheme).

---

## Step 2 — (optional) pin the Monday API version

Monday versions its API by date. The hosted MCP accepts an `Api-Version` header (e.g.
`2025-07`). Only add this if the user needs a specific version; otherwise the server uses its
default. If needed, add a second header to the same MCP entry in `config.yaml`:

```yaml
monday:
  url: https://mcp.monday.com/mcp
  headers:
    Authorization: Bearer ${MCP_MONDAY_API_KEY}
    Api-Version: "2025-07"
  enabled: true
```

Edit via `hermes config` / the same file Hermes wrote; do not hand-edit secrets here — only
the non-secret version string.

---

## Step 3 — reload the gateway

Env changes are read once at gateway startup. Use stop + run, not `restart` (mcp-add step 5):

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Step 4 — fallback: no hosted MCP, key-only REST access

The hosted MCP above **is** first-party and verified, so Step 1 is the recommended path. Use
this fallback only if the account cannot enable the marketplace MCP app (e.g. admin policy):

(a) Store the token so Hermes/tools can reach the REST API:
```bash
docker exec -u hermes "$AGENT" hermes config set MONDAY_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

(b) The credential alone does **not** connect Monday — it only authenticates direct API
calls. Two honest options:

- **Local stdio MCP (first-party):** Monday's official package
  `@mondaydotcomorg/monday-api-mcp` reads the token from env var `MONDAY_TOKEN` and exposes
  Monday tools over stdio. Run it as a sidecar/local MCP rather than the hosted HTTP server.
  Verified: https://github.com/mondaycom/mcp
- **Raw REST/GraphQL:** point a generic tool at base `https://api.monday.com/v2`, method
  `POST`, body `{"query":"..."}`, header `Authorization: <token>` (Monday's REST uses the
  **raw token, no `Bearer ` prefix** — this differs from the hosted MCP) plus
  `Content-Type: application/json`. Docs:
  https://developer.monday.com/api-reference/docs/authentication

Do not claim Step 4(a) by itself wires Monday into the agent — it does not.

---

## Pitfalls

- **Two different auth shapes.** The hosted **MCP** requires `Authorization: Bearer <token>`.
  The raw **REST API** (`api.monday.com/v2`) requires `Authorization: <token>` with **no**
  `Bearer ` prefix. Mixing them up yields 401s. Use Bearer for the MCP (Step 1), raw for REST
  (Step 4b).
- **Marketplace app must be installed.** Without an admin installing the Monday MCP app, the
  hosted endpoint will not authorize the account even with a valid token.
- **Token permissions mirror the user.** A V2 personal token can only see/do what that user
  can in the UI. If the agent can't see a board, the minting user lacks access — not a wiring
  bug. Use a service/ops user with the right board access.
- **OAuth is the other supported mode.** Monday's hosted MCP also supports per-user OAuth
  (each user authorizes individually). That breaks the one-click self-hosted promise for an
  unattended agent, so prefer the static personal token. Only fall to OAuth if policy forbids
  personal tokens.
- **Regeneration invalidates instantly.** If the user regenerates the token in Monday, the
  agent 401s until you re-inject the new value (re-run the sed step) and reload the gateway.
- **Rate limits / complexity budget.** Monday's GraphQL enforces a per-minute complexity
  budget; heavy board reads can return `ComplexityException`. Have workflows page results and
  request only needed columns rather than whole boards.

## Verify

1. Tools registered in logs:
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool.*'monday'|MCP server 'monday'" | tail -5
```
Success looks like `MCP server 'monday' (HTTP): registered N tool(s): ...`.

2. Real call from chat (empty-but-valid result is still a pass):
```
@<agent> using monday, list my boards
```

3. Token sanity check against the REST API directly (proves the token itself is live;
remember REST uses the raw token, no Bearer):
```bash
docker exec "$AGENT" sh -c \
  'curl -sS -X POST https://api.monday.com/v2 -H "Authorization: $MCP_MONDAY_API_KEY" -H "Content-Type: application/json" -d "{\"query\":\"{ me { id name } }\"}"'
# Expect JSON with your user id/name; an "error_code":"unauthenticated" means the token is wrong/expired.
```

## Definition of done

- [ ] Admin has installed the Monday MCP marketplace app for the account.
- [ ] `hermes logs` shows `registered N tool(s)` for MCP server `monday`.
- [ ] A real chat call (`using monday, list my boards`) returns data or a valid empty result.
- [ ] Token lives only in `/opt/data/.env` as `MCP_MONDAY_API_KEY` (chmod 600); `config.yaml`
      shows only `Bearer ${MCP_MONDAY_API_KEY}`, never the raw token.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
