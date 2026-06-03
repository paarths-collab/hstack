---
name: hermes-mcp-add
description: Add a remote HTTP MCP server to a running Hermes agent. Probes the endpoint to discover the correct auth shape, registers it with Hermes, injects the token safely, reloads the gateway, and verifies tool registration. Use when the user wants to wire any external HTTP MCP server into their Hermes agent.
---

# /hermes-mcp-add — wire a remote HTTP MCP server into Hermes

You are the engineer adding a remote HTTP MCP server to a live Hermes agent. Work through the
6 steps **in order**. Do everything autonomously; stop and ask the user only for the token (a
machine cannot know it) and the MCP server URL/name if not provided.

## Gather before you start (ask once)

1. **MCP server URL** — the base MCP endpoint (e.g. `https://max-mcp.digitalcrew.tech/mcp`). Do NOT accept a URL with a token suffix — you will probe to find the right form.
2. **API token / bearer token** — the credential the server requires.
3. **Name** — short identifier for this MCP in Hermes (e.g. `max-mcp`). Used as the key in `config.yaml` and as the `MCP_<NAME>_API_KEY` env var.
4. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers:
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
URL=<mcp-base-url>              # e.g. https://max-mcp.digitalcrew.tech/mcp
TOKEN=<api-token>               # never log this; use placeholder trick in step 3
NAME=<mcp-name>                 # e.g. max-mcp  →  env var MCP_MAX_MCP_API_KEY
```

---

## Step 1 — probe the endpoint to find the correct auth shape

**Never trust user-supplied or docs-supplied URL forms.** Servers vary: some want the token in
the path (`/mcp/<token>`), some in a query param, some in a header, some nowhere. Run the
probe matrix and let the server tell you what works.

```bash
TOK="$TOKEN"
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -o /tmp/probe_a -w "A path-token  = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL/$TOK"
curl -sS -o /tmp/probe_b -w "B bare        = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL"
curl -sS -o /tmp/probe_c -w "C bearer      = %{http_code}\n" -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOK" -d "$INIT" "$URL"
curl -sS -o /tmp/probe_d -w "D x-api-key   = %{http_code}\n" -X POST -H "$H" -H "$C" -H "X-API-Key: $TOK" -d "$INIT" "$URL"
curl -sS -o /tmp/probe_e -w "E query-token = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL?token=$TOK"
```

- **200 + JSON-RPC `result` block** → that variant works for the handshake.
- **404 / HTML page** → path doesn't exist on the server; rule it out.
- **401 / 403** → route exists but auth is wrong.

⚠️ `initialize` succeeding is NOT enough — many servers accept the handshake unauthenticated
and only enforce auth on `tools/call`. Proceed to step 2.

---

## Step 2 — verify auth is enforced on tool calls (not just initialize)

Harvest the session ID from the handshake and make a real tool call **without** auth. The
server's error message is the authoritative answer on what it expects.

```bash
# Re-run initialize, capture session ID
curl -sS -D /tmp/probe_headers -o /tmp/probe_init \
  -X POST -H "$H" -H "$C" -d "$INIT" "$URL"

SID=$(grep -i mcp-session-id /tmp/probe_headers | tr -d '\r' | awk '{print $2}')

# Call any tool without auth — read the error
curl -sS \
  -X POST -H "$H" -H "$C" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$URL"
```

Then retry the call **with** `Authorization: Bearer $TOKEN` and confirm you get real data
(tool list, empty array, or live results). Only proceed once this works.

```bash
curl -sS \
  -X POST -H "$H" -H "$C" -H "Mcp-Session-Id: $SID" \
  -H "Authorization: Bearer $TOK" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' "$URL"
```

---

## Step 3 — register the MCP in Hermes (placeholder token first)

Use a **placeholder**, not the real token, in the `printf` pipe. Reason: interactive prompts
piped through `docker exec` can echo, mangle, or truncate special characters (`/`, `+`, `=`).
The placeholder guarantees the config block and env var name are generated correctly; the real
value is injected safely via `sed` in step 4.

```bash
# Answers piped in order: use-auth(y) → header-name → header-value(placeholder)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "$URL" \
      --auth header
```

This writes to the agent's `config.yaml`:
```yaml
max-mcp:
  url: https://max-mcp.digitalcrew.tech/mcp
  headers:
    Authorization: Bearer ${MCP_MAX_MCP_API_KEY}
  enabled: true
```

And sets `MCP_MAX_MCP_API_KEY=placeholder` in `/opt/data/.env` inside the container.

If the CLI reports `✓ Connected! Found N tool(s)` — registration succeeded (even with the
placeholder, since `initialize` is usually open). Continue to step 4 to inject the real token.

---

## Step 4 — inject the real token into `.env` directly

```bash
# Derive the env var name Hermes generated: MCP_<UPPER_NAME>_API_KEY
# e.g. max-mcp → MCP_MAX_MCP_API_KEY
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"

docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

**Use `|` as the sed delimiter** (not `/`) — tokens routinely contain `/`, `+`, `=` which
break `/`-delimited sed expressions.

`chmod 600` is mandatory — this file contains bearer credentials.

Verify the value landed correctly (prints the var name only, not the token value):
```bash
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
# Should print 1
```

---

## Step 5 — reload the gateway so the new env is picked up

The gateway reads `.env` once at startup. `hermes gateway restart` is not always reload-clean
for env changes (Hermes-specific quirk). Use **stop + run** instead:

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8   # allow gateway to start and register MCP tools
```

> If env changes still don't appear after stop+run (test: `docker exec $AGENT sh -c 'echo $ENV_VAR'`),
> the container's compose-level env is stale. Fix: `docker compose down && docker compose up -d`
> on the host. This is only needed if the var lives in the compose `.env`, not in `/opt/data/.env`.

---

## Step 6 — verify tool registration in logs

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server" | tail -5
```

Success looks like:
```
INFO tools.mcp_tool: MCP server 'max-mcp' (HTTP): registered 91 tool(s): mcp_max_mcp_list_campaigns, mcp_max_mcp_get_campaign, ...
```

For full end-to-end proof, trigger a real tool call from the chat interface:
```
@<agent> using <mcp-name>, list my campaigns
```

An empty result set (`{"data":[],"count":0}`) is a **pass** — every layer worked. A tool error
or "Bearer token missing" means the token didn't land correctly; re-check step 4.

---

## Minimal end-to-end command set (copy-paste version)

```bash
AGENT=hermes-agent-mxlc-hermes-agent-1
URL=https://max-mcp.digitalcrew.tech/mcp
NAME=max-mcp
TOKEN=<real-token>       # fill this in; never commit to git
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"

# 1. Register with placeholder
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" hermes mcp add "$NAME" --url "$URL" --auth header

# 2. Inject real token
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# 3. Reload gateway
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8

# 4. Verify
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool from .'${NAME}'" | tail -3
```

---

## Footguns (read before every run)

| # | Footgun | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trusting the supplied URL form | Docs said `/mcp/<token>`; server returned 404 (Next.js HTML). Path didn't exist. | Always run the probe matrix (step 1) |
| 2 | Stopping at `initialize` success | Handshake is often unauthenticated; auth is enforced on `tools/call` | Probe `tools/list` without auth (step 2) |
| 3 | Piping the real token through `printf \| docker exec` | Special chars (`/+= `) mangle or truncate in non-TTY pipes | Placeholder in CLI → `sed` for real value |
| 4 | Wrong sed delimiter | Token contains `/`; sed expression breaks | Always use `\|` as delimiter |
| 5 | Assuming `hermes gateway restart` reloads env | It doesn't always re-read `.env` for the running process | Use `gateway stop` + `gateway run` |
| 6 | Editing the wrong `.env` | Two files exist: host compose `.env` (platform config) and `/opt/data/.env` (Hermes runtime). MCP secrets must go in the Hermes one. | Confirm path is `/opt/data/.env` inside container |
| 7 | Skipping `chmod 600` | Bearer creds world-readable | Always `chmod 600 /opt/data/.env` after writing |

---

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for the new MCP server name.
- [ ] A real tool call from the chat interface returns data (or an empty valid response).
- [ ] `/opt/data/.env` has `chmod 600` on the host side (`ls -la <agent-dir>/data/.env`).
- [ ] The token is **not** in `config.yaml` — only `${MCP_..._API_KEY}` placeholder appears there.

See `reference/TROUBLESHOOTING.md` for gateway and platform failure modes.
