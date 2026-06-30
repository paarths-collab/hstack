---
name: integration-intercom
description: Connect Intercom (support inbox, conversations, contacts) to a running Hermes agent using the official remote MCP server with a static Access Token. Use when the user wants Hermes to search, read, or triage Intercom conversations and contact data.
---

# /integration-intercom — connect Intercom to Hermes

You are the engineer connecting Intercom to a running Hermes agent. Intercom is the agent's
support inbox and customer-comms layer: conversations, contacts, escalations, churn signals.
Work autonomously; stop only for what a machine cannot do: minting the Access Token in the
Intercom Developer Hub and confirming the workspace is US-hosted.

**Honest auth picture (verified 2026-06):** Intercom ships an official **remote MCP server**
at `https://mcp.intercom.com/mcp` that accepts both OAuth and Bearer-token auth (see
<https://developers.intercom.com/docs/guides/mcp>). Static Bearer is the headless-friendly
path, so we wire it through `/hermes-mcp-add` exactly like a normal remote MCP. Two real
constraints from Intercom's docs:

1. The MCP is **read-focused** (search and retrieval of conversations/contacts, not writes).
2. The MCP currently supports **US-hosted Intercom workspaces only**. EU and AU workspaces
   must fall back to the REST API path documented in Step 2B.

## Before you start — gather (ask once)

1. **Access Token** — an Intercom workspace Access Token. Mint it at
   <https://app.intercom.com/a/developer-signup> → Developer Hub → **Your Apps** → click the
   app → **Configure → Authentication** → copy the Access Token. Private/internal app is the
   right shape here. Treat it like a password.
2. **Workspace region** — US, EU, or AU. Check in Intercom Settings → Workspace → Data
   hosting. US unlocks the MCP path; EU/AU forces the REST path.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>      # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<intercom-access-token>
NAME=intercom               # MCP key; env var becomes MCP_INTERCOM_API_KEY
```

---

## Step 1 — probe the Intercom MCP endpoint (US workspaces only)

Skip to Step 2B if the workspace is EU or AU. For US workspaces, confirm the endpoint is
reachable and that auth is enforced on `tools/list`, per the `/hermes-mcp-add` probe pattern.

```bash
URL=https://mcp.intercom.com/mcp
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# Handshake with bearer
curl -sS -D /tmp/intercom_headers -o /tmp/intercom_init \
  -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOKEN" -d "$INIT" "$URL"

SID=$(grep -i mcp-session-id /tmp/intercom_headers | tr -d '\r' | awk '{print $2}')

# Tool list with bearer — expect a JSON-RPC result with tools array
curl -sS \
  -X POST -H "$H" -H "$C" -H "Mcp-Session-Id: $SID" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$URL"
```

A `result.tools` array (search_conversations, list_conversations, get_contact, etc.) means
the token works and the workspace is US-hosted. A 4xx or "unsupported region" error means
the workspace is not US — switch to Step 2B.

---

## Step 2A — register the MCP in Hermes (US workspace, preferred path)

Use the `/hermes-mcp-add` placeholder pattern: register with a placeholder, then inject the
real token via `sed` with the `|` delimiter (Intercom tokens can contain `/`, `+`, `=`).

```bash
# Register with placeholder so special chars in the real token cannot mangle the CLI pipe
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "https://mcp.intercom.com/mcp" \
      --auth header

# Inject the real Access Token into /opt/data/.env
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# Confirm the var landed (prints 1, never the value)
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
```

The resulting `config.yaml` block should read:
```yaml
intercom:
  url: https://mcp.intercom.com/mcp
  headers:
    Authorization: Bearer ${MCP_INTERCOM_API_KEY}
  enabled: true
```

Then reload the gateway (stop + run, not restart — env changes need a clean re-read):
```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Step 2B — REST fallback (EU or AU workspaces, or if MCP refuses)

Intercom's MCP does not yet serve EU/AU workspaces. Store the Access Token and document
the REST surface for a generic HTTP tool. Use `hermes config set` so Hermes owns the write;
never `echo >>` and never put secrets in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set INTERCOM_ACCESS_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^INTERCOM_ACCESS_TOKEN=' /opt/data/.env"
```

If your Hermes build has no `config set` subcommand, use the same sed injection shape:
```bash
docker exec "$AGENT" sh -c \
  "grep -q '^INTERCOM_ACCESS_TOKEN=' /opt/data/.env || printf 'INTERCOM_ACCESS_TOKEN=\n' >> /opt/data/.env; \
   sed -i 's|^INTERCOM_ACCESS_TOKEN=.*|INTERCOM_ACCESS_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

REST surface for a generic HTTP/tool capability:

- **Base URL:** `https://api.intercom.io`
- **Auth header:** `Authorization: Bearer ${INTERCOM_ACCESS_TOKEN}`
- **Version header:** `Intercom-Version: 2.11` (or the current stable version your account
  supports; pin it explicitly — unversioned calls drift on API changes)
- **Content type:** `Content-Type: application/json`
- **Accept:** `Accept: application/json`

Common endpoints:
- `GET /me` — token sanity check, returns the app/workspace
- `POST /conversations/search` — search conversations by state, assignee, tags, custom attrs
- `GET /conversations/{id}` — fetch a single conversation with parts
- `POST /contacts/search` — search contacts
- `GET /contacts/{id}` — fetch a contact
- `POST /conversations/{id}/reply` — only if your Access Token has write scope

Reload the gateway after writing the env var:
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
| 1 | Trying the MCP from an EU or AU workspace | Intercom MCP is US-only as of 2026-06; the endpoint rejects non-US tokens. | Check region in Settings, fall back to REST (Step 2B). |
| 2 | Expecting write tools from the MCP | The MCP is read-focused (search/retrieve). Replying/closing requires REST. | Use REST `POST /conversations/{id}/reply` if writes are needed. |
| 3 | Missing `Intercom-Version` header on REST | Intercom rolls API versions; unversioned calls drift silently. | Always send `Intercom-Version: 2.11` (or current). |
| 4 | Sharing the Access Token with a third-party app | Intercom explicitly forbids this — third-party apps must use OAuth. | Use the token only for your own Hermes agent. Rotate if leaked. |
| 5 | Token in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` or sed-inject. |
| 6 | `gateway restart` instead of `stop` + `run` | Restart does not always re-read `.env` for the live process. | Always `stop`, sleep 3, then `run -d`. |
| 7 | Bearer token piped raw through `printf \| docker exec` | Tokens can contain `/`, `+`, `=` that mangle in non-TTY pipes. | Register with `placeholder`, inject the real value via `sed` with `\|` delimiter. |
| 8 | Hitting Intercom rate limits | Default is 83 req/10s per workspace; bursts return `429`. | Backoff on `429`, prefer search over per-record loops. |

---

## Verify

1. **MCP path — tools registered (US):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*intercom|MCP server.*intercom" | tail -5
   ```
2. **REST path — token valid (any region):** runs inside the container so the secret never
   leaves the runtime env:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $INTERCOM_ACCESS_TOKEN" \
       -H "Intercom-Version: 2.11" \
       -H "Accept: application/json" \
       "https://api.intercom.io/me"'
   ```
   `200` = token valid and scoped. `401` = bad/empty token. `403` = wrong scope on the app.
3. **End-to-end from chat:** `@<agent> find open Intercom conversations from the last 24h`
   should return a list. An empty-but-valid response is still a pass for the wiring.

---

## Definition of done

- [ ] `INTERCOM_ACCESS_TOKEN` or `MCP_INTERCOM_API_KEY` is in `/opt/data/.env` with `chmod 600`; not in `config.yaml` or chat.
- [ ] US workspaces: MCP registered via `/hermes-mcp-add` at `https://mcp.intercom.com/mcp` and `hermes logs` shows tools registered.
- [ ] EU/AU workspaces: REST base URL, `Intercom-Version`, and Bearer header are documented and reachable via a Hermes HTTP tool.
- [ ] `GET https://api.intercom.io/me` from inside the container returns `200`.
- [ ] A chat-driven Intercom search returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
