---
name: integration-sendbird
description: Connect Sendbird (in-app chat, voice, video — customer chat) to a running Hermes agent using a static Platform API token. Use when the user wants Hermes to send messages, manage users/channels, or moderate conversations in their Sendbird application.
---

# /integration-sendbird — connect Sendbird to Hermes

You are the engineer connecting Sendbird to a running Hermes agent. Sendbird is the agent's
customer-chat surface (group/open channels, users, messages, moderation). Work autonomously;
stop only for what a machine cannot do: minting the API token and confirming the Sendbird
Application ID.

**Honest auth picture (verified 2026-06):** No first-party Sendbird MCP server is verified.
Sendbird's own MCP blog post discusses the protocol conceptually and does not announce a
hosted endpoint. Third-party aggregators (Composio, Pipedream, viaSocket) wrap the Platform
API but are not maintained by Sendbird. We therefore wire Sendbird via its **Platform REST
API** with the static **master or secondary API token**. Sendbird auth uses the **`Api-Token`
header**, not `Authorization: Bearer` — this matters for both probing and any HTTP MCP
register flow.

## Before you start — gather (ask once)

1. **Application ID** — case-sensitive. Sendbird Dashboard → select application → **Settings**
   → **Application** → **General** → "Application ID". It is also embedded in the API base
   URL shown on the same page: `https://api-<APP_ID>.sendbird.com/v3`.
2. **API token** — master or secondary. Same Settings → **Application** → **General** → **API
   tokens** section. Master token cannot be revoked; prefer a **secondary token** scoped to
   this agent so you can rotate it. Mint a secondary token at:
   <https://sendbird.com/docs/chat/platform-api/v3/application/managing-api-tokens/generate-a-secondary-api-token>.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
APP_ID=<application-id>    # case-sensitive
TOKEN=<sendbird-api-token> # injected via sed, never echoed
```

---

## Step 1 — store the token and app ID in the Hermes runtime .env (chmod 600)

Write secrets to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put credentials
in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set SENDBIRD_APP_ID "$APP_ID"
docker exec -i -u hermes "$AGENT" hermes config set SENDBIRD_API_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify both vars landed (prints `1` each, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^SENDBIRD_APP_ID=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^SENDBIRD_API_TOKEN=' /opt/data/.env"
```

If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
from `/hermes-mcp-add` (note the `|` delimiter — Sendbird tokens are alnum but stay
consistent with the base procedure):
```bash
docker exec "$AGENT" sh -c \
  "grep -q '^SENDBIRD_API_TOKEN=' /opt/data/.env || printf 'SENDBIRD_API_TOKEN=\n' >> /opt/data/.env; \
   sed -i 's|^SENDBIRD_API_TOKEN=.*|SENDBIRD_API_TOKEN=${TOKEN}|' /opt/data/.env; \
   grep -q '^SENDBIRD_APP_ID=' /opt/data/.env || printf 'SENDBIRD_APP_ID=\n' >> /opt/data/.env; \
   sed -i 's|^SENDBIRD_APP_ID=.*|SENDBIRD_APP_ID=${APP_ID}|' /opt/data/.env; \
   chmod 600 /opt/data/.env"
```

---

## Step 2 — connect Sendbird. Pick the path that matches your Hermes build.

A token alone does not connect Sendbird — you must give the agent a tool surface.

### Path A (preferred) — generic HTTP tool against the Sendbird Platform REST API

This is the only path that is fully verified first-party as of 2026-06. Point a generic
HTTP/tool capability at the Sendbird REST API directly:

- **Base URL:** `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3`
- **Auth header:** `Api-Token: ${SENDBIRD_API_TOKEN}` (NOT `Authorization: Bearer`)
- **Content type:** `Content-Type: application/json; charset=utf8`

Common endpoints (Chat Platform API v3):
- `GET  /v3/users` — list users
- `POST /v3/users` — create user
- `GET  /v3/group_channels` — list group channels
- `POST /v3/group_channels` — create group channel
- `POST /v3/group_channels/{channel_url}/messages` — send a message
- `GET  /v3/group_channels/{channel_url}/messages` — list messages
- `PUT  /v3/group_channels/{channel_url}/freeze` — moderate (freeze) a channel

Reference: <https://sendbird.com/docs/chat/platform-api/v3/overview>

### Path B — third-party HTTP MCP server (community, not first-party)

If your Hermes build supports remote HTTP MCP and you want a tool surface instead of raw
REST, register a community MCP server via `/hermes-mcp-add`. **State plainly to the user
that this is not maintained by Sendbird** and may stop working without notice. Candidates:

- Composio: <https://composio.dev/toolkits/sendbird>
- Pipedream: <https://mcp.pipedream.com/app/sendbird>

These usually accept `Authorization: Bearer <composio_or_pipedream_key>` plus a connected
Sendbird account inside their dashboard — that key is **not** your Sendbird token. Probe per
`/hermes-mcp-add` step 1 before trusting any URL form. After registration, the env var
Hermes generates is `MCP_SENDBIRD_API_KEY` (the aggregator key, not `SENDBIRD_API_TOKEN`).

> Do not point `/hermes-mcp-add` at `https://api-<APP_ID>.sendbird.com/v3` — that is a REST
> API, not an MCP endpoint, and will fail the JSON-RPC handshake.

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
| 1 | Using `Authorization: Bearer <token>` | Sendbird rejects it; auth header is `Api-Token`. | Always send `Api-Token: ${SENDBIRD_API_TOKEN}`. |
| 2 | Wrong-case Application ID in base URL | Sendbird states the App ID is case-sensitive; mismatched case returns 404. | Copy verbatim from Dashboard → Settings → Application → General. |
| 3 | Using master token in production | Master token cannot be revoked or rotated, so a leak is permanent. | Mint a secondary token for the agent; rotate periodically. |
| 4 | Calling Platform API from a client/front-end | Exposes the token; Sendbird explicitly warns against this. | All calls go through Hermes (server-side); token stays in `/opt/data/.env`. |
| 5 | Trusting a third-party "Sendbird MCP" as first-party | Composio/Pipedream/viaSocket wrap the API but are not Sendbird. | State the source clearly; prefer Path A unless the user accepts the dependency. |
| 6 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 7 | Rate limits and 429s | Sendbird throttles aggressively per-application. | Back off on `429`; batch where possible; cache user/channel lookups. |

---

## Verify

Confirm the credential and a live call before declaring done. Run inside the container so the
token comes from runtime env and is never printed.

1. **Vars present:**
   ```bash
   docker exec "$AGENT" sh -c "grep -c '^SENDBIRD_API_TOKEN=' /opt/data/.env"
   docker exec "$AGENT" sh -c "grep -c '^SENDBIRD_APP_ID=' /opt/data/.env"
   ```
   Both should print `1`.

2. **Real API call returns data:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X GET "https://api-${SENDBIRD_APP_ID}.sendbird.com/v3/users?limit=1" \
       -H "Api-Token: ${SENDBIRD_API_TOKEN}" \
       -H "Content-Type: application/json; charset=utf8"'
   ```
   `200` = token valid and scoped to the right application. `401` = bad/empty token (re-check
   step 1). `400` with `"code":400108` = malformed App ID in the URL (re-check pitfall 2). A
   `200` with empty `users` array means the wiring works on a fresh application.

3. **End-to-end from chat:** `@<agent> list my Sendbird group channels` should return real
   channels (or an empty-valid response on a new app — both are a pass).

---

## Definition of done

- [ ] `SENDBIRD_API_TOKEN` and `SENDBIRD_APP_ID` are in `/opt/data/.env` with `chmod 600`; neither is in `config.yaml` or chat.
- [ ] A secondary token is used (not the unrotatable master token) when production-bound.
- [ ] `GET /v3/users?limit=1` from inside the container returns `200` with the `Api-Token` header.
- [ ] A chat-driven Sendbird call returns real (or empty-valid) data.
- [ ] If Path B was used, the user was told the MCP server is community-maintained, not first-party Sendbird.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
