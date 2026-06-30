---
name: integration-tavily
description: Connect Tavily (agentic web search, extract, crawl, research) to a running Hermes agent using a static tvly- API key against Tavily's first-party remote MCP server. Use when the user wants Hermes to do real-time web search and research.
---

# /integration-tavily — connect Tavily to Hermes

You are the engineer connecting Tavily to a running Hermes agent. Tavily is the agent's
real-time web search / extract / crawl / research surface. Work autonomously; stop only for
the one thing a machine cannot do: minting the `tvly-` API key in the Tavily dashboard.

**Honest auth picture (verified 2026-06):** Tavily ships an official first-party **remote**
MCP server at `https://mcp.tavily.com/mcp/`. It accepts three auth modes — query-string
(`?tavilyApiKey=...`), `Authorization: Bearer tvly-...` header, and OAuth. For a headless
self-hosted agent we use the **bearer header** path, which keeps the key out of the URL
(logs, proxies, history) and matches the `/hermes-mcp-add` flow exactly. Source:
<https://docs.tavily.com/documentation/mcp>.

## Before you start — gather (ask once)

1. **Tavily API key** — starts with `tvly-`. Mint it at <https://app.tavily.com/home> →
   **API Keys** → **Create new key**. Free tier includes a monthly credit allowance; no
   billing card needed to start.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<tvly-...>           # the Tavily key; injected via sed, never echoed
```

---

## Step 1 — probe the remote MCP endpoint (sanity check before wiring)

Confirm the endpoint is reachable and that bearer auth is the shape Tavily expects. Run the
probe from the host; expect a `200` or a JSON-RPC body when authed, and a `401` / auth-error
body when unauthed. Same matrix `/hermes-mcp-add` uses.

```bash
# unauthed initialize — should return an auth-required error, not a network failure
curl -sS -o /tmp/tavily-probe.json -w "%{http_code}\n" \
  -X POST "https://mcp.tavily.com/mcp/" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
head -c 400 /tmp/tavily-probe.json; echo
```

If the error message names a header (`Authorization`) or a query param (`tavilyApiKey`),
that is your spec. Bearer header is the path documented and the one we wire.

---

## Step 2 — store the API key in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container so it survives restarts and is
readable by the Hermes runtime. Use `hermes config set` so Hermes owns the write; never
`echo >>` (it can merge onto a prior line) and never put it in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set MCP_TAVILY_API_KEY "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^MCP_TAVILY_API_KEY=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add`. The `|` delimiter matters — bearer tokens are mostly alnum but the
> base procedure keeps `|` universally to avoid surprises:
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^MCP_TAVILY_API_KEY=' /opt/data/.env || printf 'MCP_TAVILY_API_KEY=\n' >> /opt/data/.env; \
>    sed -i 's|^MCP_TAVILY_API_KEY=.*|MCP_TAVILY_API_KEY=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 3 — register Tavily as a remote MCP server via /hermes-mcp-add

Follow the base procedure in `skills/hermes-mcp-add/SKILL.md`. Register the server with a
**placeholder** token through the CLI, then sed-inject the real value from the env. Never
pass the real token on the command line.

```bash
# 3a — register with a placeholder so the secret never hits argv / history
printf 'placeholder\n' | docker exec -i -u hermes "$AGENT" \
  hermes mcp add tavily \
    --url "https://mcp.tavily.com/mcp/" \
    --transport http \
    --header "Authorization: Bearer placeholder" \
    --header "Accept: application/json, text/event-stream"

# 3b — swap the placeholder for the env reference Hermes resolves at call time
docker exec "$AGENT" sh -c \
  "sed -i 's|Authorization: Bearer placeholder|Authorization: Bearer \${MCP_TAVILY_API_KEY}|' \
     /opt/data/mcp.json"
```

> Flag names (`--url` / `--transport` / `--header`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its remote-HTTP
> syntax. The config file path may be `mcp.json`, `tools.json`, or under
> `/opt/data/config/` — `find /opt/data -name '*.json' | xargs grep -l tavily` locates it.

---

## Step 4 — reload the gateway so the new env + MCP is picked up

The gateway reads `.env` and the MCP registry once at startup. Use stop + run (not
`restart`) so the new env is re-read cleanly — same rule as `/hermes-mcp-add`.

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
| 1 | API key in the URL query string | `?tavilyApiKey=...` leaks via proxy logs, gateway access logs, and shell history. | Use the `Authorization: Bearer` header path. |
| 2 | Real token on the `mcp add` command line | Lands in shell history and `ps` output. | Pipe `placeholder` through `docker exec -i`, sed-inject the real value. |
| 3 | `sed 's/.../.../'` for the header swap | Bearer values are usually fine but mixing slash delimiters with future Authorization shapes breaks silently. | Use `|` as the sed delimiter; matches the base mcp-add convention. |
| 4 | `hermes gateway restart` after env edit | Some builds keep the cached env; the new key is not re-read. | `gateway stop` + `gateway run`. |
| 5 | Trailing slash on the endpoint | Tavily's docs use `https://mcp.tavily.com/mcp/` with trailing slash; dropping it can 404. | Keep the trailing slash exactly as published. |
| 6 | Treating free-tier credits as unlimited | Free tier has a monthly credit cap; agent loops can drain it in minutes. | Monitor `GET /usage`; cap `search_depth` to `basic` or `fast` in agent prompts. |
| 7 | OAuth path on a headless agent | OAuth flow requires a human browser handshake; breaks autonomy. | Bearer header only. Ignore OAuth for self-hosted Hermes. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **MCP server registered and tools advertised:**
   ```bash
   docker exec -u hermes "$AGENT" hermes mcp list | grep -i tavily
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*tavily" | tail -5
   ```
2. **Real API call returns data (run inside the container so the token comes from the env
   and is never printed):**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://api.tavily.com/search" \
       -H "Authorization: Bearer $MCP_TAVILY_API_KEY" \
       -H "Content-Type: application/json" \
       -d "{\"query\":\"hermes agent self-hosted\",\"max_results\":1,\"search_depth\":\"basic\"}"'
   ```
   `200` = key valid and credits available. `401` = bad/empty key (re-check step 2).
   `432` / `429` = out of credits or rate-limited (upgrade plan or wait).
3. **End-to-end from chat:** `@<agent> search the web for "<a current event>"` should return
   a fresh result with sources. The agent's response should cite at least one URL Tavily
   returned.

---

## Definition of done

- [ ] `MCP_TAVILY_API_KEY` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml`, the URL, or chat.
- [ ] Tavily MCP is registered at `https://mcp.tavily.com/mcp/` with `Authorization: Bearer ${MCP_TAVILY_API_KEY}`.
- [ ] `hermes mcp list` shows `tavily` and gateway logs show its tools registered after `gateway stop` + `gateway run`.
- [ ] `POST https://api.tavily.com/search` from inside the container returns `200`.
- [ ] A chat-driven web search returns a fresh result with at least one cited URL.

See `reference/TROUBLESHOOTING.md` for gateway reload, header-injection, and MCP registration failure modes.
