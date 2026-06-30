---
name: integration-brevo
description: Connect Brevo (formerly Sendinblue) email and CRM marketing to a running Hermes agent via Brevo's first-party remote MCP server. Use when the user wants Hermes to send campaigns, manage contacts, run automations, or read marketing analytics.
---

# /integration-brevo — connect Brevo to Hermes

You are the engineer connecting Brevo to a running Hermes agent. Brevo is the agent's
marketing surface: transactional email, email campaigns, SMS, contacts/lists, and CRM deal
pipelines. Work autonomously; stop only for the two things a machine cannot do: minting the
MCP token in the Brevo UI, and confirming the sender identity/domain is already validated.

**Honest auth picture (verified 2026-06):** Brevo ships an official first-party **remote
HTTP MCP server** at `https://mcp.brevo.com/v1/brevo/mcp` that accepts a static **bearer
MCP token** (no OAuth required). That is the headless-friendly path and the one this skill
uses. See <https://developers.brevo.com/docs/mcp-protocol>.

## Before you start — gather (ask once)

1. **MCP token** — mint in the Brevo dashboard: **Account → SMTP & API → API Keys → Generate
   a new API key**, then **check the MCP option** before saving. Copy the token immediately;
   Brevo will not show it again. (Plain REST keys without the MCP flag will not authenticate
   against `mcp.brevo.com`.)
2. **Validated sender** — confirm the user already has at least one verified sender address
   or authenticated domain in Brevo. The MCP can send via unverified senders only as drafts.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://mcp.brevo.com/v1/brevo/mcp
NAME=brevo                 # → env var MCP_BREVO_API_KEY
TOKEN=<brevo-mcp-token>    # injected via sed, never echoed
```

---

## Step 1 — probe the endpoint and confirm bearer auth (per /hermes-mcp-add step 1-2)

Never trust a docs-supplied URL form blindly. Run the minimal probe matrix to confirm
`Authorization: Bearer` is what the server enforces.

```bash
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -o /tmp/brevo_a -w "bare         = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL"
curl -sS -o /tmp/brevo_b -w "bearer       = %{http_code}\n" -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOKEN" -d "$INIT" "$URL"
```

Expect `200` with a JSON-RPC `result` block on the bearer variant. Then re-run `tools/list`
without auth to confirm the server enforces auth on tool calls (not just `initialize`):

```bash
curl -sS -D /tmp/brevo_hdr -o /dev/null -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOKEN" -d "$INIT" "$URL"
SID=$(grep -i mcp-session-id /tmp/brevo_hdr | tr -d '\r' | awk '{print $2}')

curl -sS -X POST -H "$H" -H "$C" -H "Mcp-Session-Id: $SID" -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$URL"
```

A populated `tools` array confirms the token is valid and the MCP option is enabled on it.
A `401`/`403` here almost always means the API key was minted without the MCP checkbox —
re-mint it.

---

## Step 2 — register the MCP in Hermes with a placeholder, then inject the real token

Follow `/hermes-mcp-add` exactly. The placeholder pattern protects against `printf | docker
exec` mangling special characters in the real token.

```bash
# Register with placeholder. Answers: use-auth(y) → header-name → header-value(placeholder)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "$URL" \
      --auth header
```

This writes `brevo:` into the agent's `config.yaml` with header
`Authorization: Bearer ${MCP_BREVO_API_KEY}`, and sets `MCP_BREVO_API_KEY=placeholder` in
`/opt/data/.env`.

Inject the real token via `sed` with the `|` delimiter (Brevo tokens are alnum but stay
consistent with the base procedure — never `echo >>`, never `config.yaml`):

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # → MCP_BREVO_API_KEY

docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
```

---

## Step 3 — reload the gateway so the new env and MCP registration are picked up

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

`hermes gateway restart` does not always re-read `/opt/data/.env` cleanly. Stop + run does.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using a plain REST API key against `mcp.brevo.com` | Brevo keys must have the **MCP** option checked at creation; plain v3 keys return `401` on the MCP endpoint. | Re-mint with the MCP checkbox enabled. |
| 2 | Confusing the REST API header with the MCP header | REST uses `api-key: <key>` against `https://api.brevo.com/v3`; MCP uses `Authorization: Bearer <token>` against `https://mcp.brevo.com/v1/brevo/mcp`. | Use bearer header only for the MCP path. |
| 3 | Sending campaigns from an unverified sender | Brevo rejects sends from non-validated senders, even with a valid token. | Validate the sender / authenticate the domain in Brevo before first send. |
| 4 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via sed-inject from `/hermes-mcp-add`. |
| 5 | Rate limits | Brevo throttles per-account; bursts get `429`. | Backoff on `429`; chunk contact imports. |
| 6 | Treating `initialize` success as proof | Handshake is often open; auth is enforced on `tools/call`. | Always run the `tools/list` probe (step 1). |

---

## Verify

1. **Tools registered:**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*brevo|MCP server.*brevo" | tail -5
   ```
   Look for `MCP server 'brevo' (HTTP): registered N tool(s)`.
2. **Live MCP call returns data** (token comes from runtime env, never printed):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://mcp.brevo.com/v1/brevo/mcp" \
       -H "Accept: application/json, text/event-stream" \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $MCP_BREVO_API_KEY" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"verify\",\"version\":\"0\"}}}"'
   ```
   `200` = token valid and MCP option enabled. `401` = re-mint with the MCP checkbox.
3. **End-to-end from chat:** `@<agent> using brevo, list my recent email campaigns` should
   return campaign metadata (or an empty-but-valid list, which is still a pass for wiring).

---

## Definition of done

- [ ] `MCP_BREVO_API_KEY` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] `hermes logs` shows `registered N tool(s)` for the `brevo` MCP server.
- [ ] A live `initialize` POST to `https://mcp.brevo.com/v1/brevo/mcp` from inside the container returns `200`.
- [ ] A chat-driven Brevo call returns real (or empty-valid) data.
- [ ] The sender address or sending domain used for campaigns is validated in the Brevo UI.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
