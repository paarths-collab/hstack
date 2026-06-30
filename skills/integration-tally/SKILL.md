---
name: integration-tally
description: Connect Tally Forms (simple forms — creation, editing, submission retrieval) to a running Hermes agent via Tally's official remote MCP server using a static `tly-` API key. Use when the user wants Hermes to build forms, edit live forms, or pull submission data from Tally.
---

# /integration-tally — connect Tally Forms to Hermes

You are the engineer connecting Tally Forms to a running Hermes agent. Tally is the agent's
form builder and submission store. Work autonomously; stop only for the one thing a machine
cannot do: minting the Tally API key in the Tally dashboard.

**Honest auth picture (verified 2026-06):** Tally ships an **official first-party remote MCP
server** at `https://api.tally.so/mcp`. It supports **two** auth modes: OAuth (interactive)
and a static **`tly-`-prefixed API key** sent as `Authorization: Bearer tly-...`. For a
headless self-hosted agent the API key path is the right one — wire it via `/hermes-mcp-add`.

Sources: <https://developers.tally.so/api-reference/mcp> and
<https://developers.tally.so/api-reference/api-keys>.

## Before you start — gather (ask once)

1. **Tally API key** — starts with `tly-`. Mint it at
   <https://tally.so/settings/api-keys> → **Create API key** → copy immediately (the key is
   shown once; if lost, generate a new one). The key inherits the permissions of the user
   who created it.
2. **MCP name** — short identifier used by Hermes (use `tally`). This becomes
   `MCP_TALLY_API_KEY` in `/opt/data/.env`.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>      # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://api.tally.so/mcp
NAME=tally
TOKEN=<tly-...>             # injected via sed in step 3; never echoed
```

---

## Step 1 — probe the Tally MCP endpoint (confirm bearer auth shape)

Follow the `/hermes-mcp-add` probe matrix. We expect variant **C (bearer header)** to be the
authoritative form for Tally — but probe anyway so the server tells us, not the docs.

```bash
TOK="$TOKEN"
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -o /tmp/probe_b -w "B bare   = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL"
curl -sS -o /tmp/probe_c -w "C bearer = %{http_code}\n" -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOK" -d "$INIT" "$URL"
```

A `200` with a JSON-RPC `result` block on variant C confirms the bearer shape. If only the
bare probe returns `200`, re-run `tools/list` without auth — many MCP servers open
`initialize` and only enforce auth on tool calls. The error message on an unauthenticated
`tools/list` is the spec.

---

## Step 2 — register the Tally MCP in Hermes (placeholder token first)

Use a placeholder, not the real key, in the interactive prompt pipe. Special characters in
real tokens can mangle through `docker exec` non-TTY pipes; the placeholder guarantees the
config block and env var name are generated correctly. The real value goes in via `sed` next.

```bash
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "$URL" \
      --auth header
```

This writes to the agent's `config.yaml`:
```yaml
tally:
  url: https://api.tally.so/mcp
  headers:
    Authorization: Bearer ${MCP_TALLY_API_KEY}
  enabled: true
```

And sets `MCP_TALLY_API_KEY=placeholder` in `/opt/data/.env` inside the container.

---

## Step 3 — inject the real `tly-` key into `/opt/data/.env`

Use `|` as the sed delimiter (Tally keys are alnum, but stay consistent with the base
procedure — never use `/`-delimited sed for secrets).

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_TALLY_API_KEY

docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

`chmod 600` is mandatory — `/opt/data/.env` now holds a bearer credential.

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
```

---

## Step 4 — reload the gateway so the new env is read

The gateway reads `.env` once at startup. Use `stop` + `run`, not `restart` — same rule as
`/hermes-mcp-add`.

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
| 1 | Using the OAuth flow on a headless agent | OAuth requires an interactive browser handoff; the agent has no user session. | Use the API-key path. OAuth is for desktop clients (Claude Desktop, Cursor). |
| 2 | Pasting the `tly-` key into `config.yaml` | World-readable; not the runtime env. | Only `/opt/data/.env` with `chmod 600`. `config.yaml` holds the `${MCP_TALLY_API_KEY}` placeholder. |
| 3 | Re-using a lost key | Tally shows the key once. If you didn't copy it, it is gone. | Mint a new key at `/settings/api-keys`. |
| 4 | Key stops working after a user leaves the org | Keys inherit the creator's permissions and are revoked when the user is removed. | Mint keys under a long-lived service-account user. |
| 5 | `hermes gateway restart` doesn't re-read env | Hermes-specific quirk. | `gateway stop` + `gateway run`. |
| 6 | Editing the wrong `.env` | Compose `.env` (platform) vs `/opt/data/.env` (Hermes runtime). MCP secrets belong in the runtime one. | Confirm path is `/opt/data/.env` inside container. |
| 7 | `echo >> /opt/data/.env` | Can merge onto a prior line without a trailing newline; the key becomes invalid. | Use `hermes config set` or the `sed` pattern above. |

---

## Verify

1. **Tools registered:**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*tally" | tail -5
   ```
   Expect a line like `MCP server 'tally' (HTTP): registered N tool(s): ...`.

2. **Live MCP `tools/list` from inside the container** (token comes from runtime env, never printed):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://api.tally.so/mcp" \
       -H "Accept: application/json, text/event-stream" \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer $MCP_TALLY_API_KEY" \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"verify\",\"version\":\"0\"}}}"'
   ```
   `200` = key valid and endpoint reachable. `401` = bad/empty key (re-check step 3).

3. **End-to-end from chat:** `@<agent> using tally, list my forms` should return the
   workspace's forms. An empty-but-valid result is still a pass for the wiring.

---

## Definition of done

- [ ] `MCP_TALLY_API_KEY` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] `config.yaml` has a `tally` block pointing at `https://api.tally.so/mcp` with the `${MCP_TALLY_API_KEY}` placeholder header.
- [ ] `hermes logs` shows `registered N tool(s)` for the `tally` MCP server.
- [ ] A live `initialize` POST from inside the container returns `200`.
- [ ] A chat-driven Tally call (`list forms` or `get submissions`) returns real data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
