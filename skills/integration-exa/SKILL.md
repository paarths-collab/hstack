---
name: integration-exa
description: Connect Exa (semantic web search, company/person research, code context) to a running Hermes agent via Exa's official remote MCP server using a static x-api-key. Use when the user wants Hermes to run semantic searches, company/person research, LinkedIn lookups, or web crawls through Exa.
---

# /integration-exa — connect Exa to Hermes

You are the engineer connecting Exa to a running Hermes agent. Exa is the agent's
semantic-search and research surface: web_search, company_research, linkedin_search,
get_code_context, deep_researcher, crawling. Work autonomously; stop only for the one thing
a machine cannot do: minting the Exa API key in the user's dashboard.

**Honest auth picture (verified 2026-06):** Exa ships an official **remote** MCP server at
`https://mcp.exa.ai/mcp`. It authenticates with a **static API key** via the `x-api-key`
header (the REST API also accepts `Authorization: Bearer <key>`). No OAuth dance, no
session token rotation. This is the headless-friendly path, so we wire it through
`/hermes-mcp-add` with header auth.

Source: <https://exa.ai/docs/reference/exa-mcp> and <https://exa.ai/mcp>.

## Before you start — gather (ask once)

1. **Exa API key** — mint at <https://dashboard.exa.ai/api-keys> (sign up at
   <https://exa.ai> first). Copy the key from the dashboard; treat it as a bearer secret.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.
3. **MCP name in Hermes** — default `exa`. This becomes the env var `MCP_EXA_API_KEY`.

Set shell vars from answers (never log the key):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://mcp.exa.ai/mcp
NAME=exa
TOKEN=<exa-api-key>        # injected via sed, never echoed
```

---

## Step 1 — probe the endpoint to confirm auth shape

Before registering, run the `/hermes-mcp-add` probe matrix to confirm `x-api-key` is what
the server enforces and that `initialize` plus `tools/list` work end-to-end.

```bash
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -D /tmp/exa_h -o /tmp/exa_init \
  -X POST -H "$H" -H "$C" -H "x-api-key: $TOKEN" -d "$INIT" "$URL"

SID=$(grep -i mcp-session-id /tmp/exa_h | tr -d '\r' | awk '{print $2}')

curl -sS -X POST -H "$H" -H "$C" -H "x-api-key: $TOKEN" -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$URL"
```

A JSON-RPC `result` listing tools like `web_search_exa`, `company_research_exa`,
`linkedin_search_exa`, `get_code_context_exa`, `crawling_exa`, `deep_researcher_*` means the
key is valid and scoped. `401` means the key is bad — re-check step 1.

---

## Step 2 — register the MCP in Hermes (placeholder token first)

Follow `/hermes-mcp-add` exactly. Use a placeholder in the interactive pipe; real key goes
in via `sed` in step 3. Exa uses `x-api-key`, not `Authorization`, so feed that header name
to the prompt.

```bash
printf 'y\nx-api-key\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "$URL" \
      --auth header
```

This writes to the agent's `config.yaml`:
```yaml
exa:
  url: https://mcp.exa.ai/mcp
  headers:
    x-api-key: ${MCP_EXA_API_KEY}
  enabled: true
```

And seeds `MCP_EXA_API_KEY=placeholder` in `/opt/data/.env` inside the container. If the
CLI prints `Connected! Found N tool(s)`, registration succeeded even with the placeholder
because Exa's `initialize` accepts unauthenticated handshakes — the real value is
enforced on `tools/call`.

---

## Step 3 — inject the real key into /opt/data/.env

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"

docker exec "$AGENT" sh -c \
  "grep -q '^${ENV_VAR}=' /opt/data/.env || printf '${ENV_VAR}=\n' >> /opt/data/.env; \
   sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Use `|` as the sed delimiter — Exa keys are alphanumeric today but the base procedure stays
consistent. `chmod 600` is mandatory.

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
```

---

## Step 4 — reload the gateway so the new env is picked up

The gateway reads `.env` once at startup. Use stop + run, not `restart` — same rule as
`/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Step 5 — verify tool registration

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server.*exa" | tail -5
```

Success looks like:
```
INFO tools.mcp_tool: MCP server 'exa' (HTTP): registered N tool(s): mcp_exa_web_search_exa, mcp_exa_company_research_exa, ...
```

End-to-end from chat:
```
@<agent> using exa, search the web for "self-hosted Hermes agent" and give me 3 results
```

An empty result set is still a wiring pass. `401` or "missing api key" means the key didn't
land — re-check step 3.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Picking `Authorization` instead of `x-api-key` at the `mcp add` prompt | Exa's MCP enforces `x-api-key`; bearer also works on REST but the published MCP example uses `x-api-key`. Mixing them invites silent 401s on tool calls. | Type `x-api-key` exactly at the header-name prompt. |
| 2 | Pasting the real key into the `printf` pipe | Special chars in keys can mangle in non-TTY pipes; key gets logged in shell history. | Placeholder in CLI, `sed` for real value (step 3). |
| 3 | Secret in `config.yaml` or compose `.env` | Wrong file. Compose `.env` is not the Hermes runtime env. | Only `/opt/data/.env`, `chmod 600`. |
| 4 | `gateway restart` instead of stop + run | Hermes-specific: `restart` does not always re-read `.env`. | Always stop, sleep 3, run -d, sleep 8. |
| 5 | Treating `initialize` success as proof | Exa accepts unauthenticated handshakes; auth is enforced on `tools/call`. | Run `tools/list` with the key in step 1. |
| 6 | Rate limits and quota | Exa bills per search and per tool call; bursts can 429 or exhaust quota silently. | Watch `hermes logs` for 429; check usage at <https://dashboard.exa.ai>. |
| 7 | Wrong sed delimiter | If a future key format includes `/` or `+`, `/`-delimited sed breaks. | Always use `\|`. |

---

## Verify

1. **Tools registered:**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool from .'exa'" | tail -3
   ```
2. **Live call from inside the container** (key comes from runtime env, never printed):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://api.exa.ai/search" \
       -H "x-api-key: $MCP_EXA_API_KEY" \
       -H "Content-Type: application/json" \
       -d "{\"query\":\"hermes agent\",\"numResults\":1}"'
   ```
   `200` = key valid. `401` = bad/empty key (re-check step 3).
3. **End-to-end from chat:** `@<agent> using exa, search for "<topic>"` returns results.

---

## Definition of done

- [ ] `MCP_EXA_API_KEY` is in `/opt/data/.env` with `chmod 600`; not in `config.yaml`, not in chat.
- [ ] `config.yaml` references `${MCP_EXA_API_KEY}` under the `exa` entry with `x-api-key` header.
- [ ] `hermes logs` shows `registered N tool(s)` for `exa`.
- [ ] `POST https://api.exa.ai/search` from inside the container returns `200`.
- [ ] A chat-driven Exa search returns real (or empty-valid) results.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
