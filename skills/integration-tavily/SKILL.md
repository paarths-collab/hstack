---
name: integration-tavily
description: Connect Tavily (agentic web search, extract, crawl, research) to a self-hosted Hermes Agent over SSH via Tavily's first-party remote MCP server using a static tvly- API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-tavily — connect Tavily to a remote Hermes (SSH-first)

You are the engineer connecting Tavily to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does one thing a machine cannot: mint the `tvly-` API key
at https://app.tavily.com/home → API Keys → Create new key.

Everything else — key storage, MCP probe + registration, gateway reload, smoke test — runs
on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Tavily ships an official **first-party** remote
MCP at `https://mcp.tavily.com/mcp/` (note trailing slash). Three auth modes:

- **Query string** (`?tavilyApiKey=...`) — leaks via proxy/access logs. Don't use.
- **`Authorization: Bearer tvly-...`** — what this skill wires.
- **OAuth** — for desktop/interactive clients; breaks headless.

Source: https://docs.tavily.com/documentation/mcp

**Free tier:** monthly credit allowance, no card needed to start. Agent loops can drain it
fast — monitor `GET /usage` and cap `search_depth` to `basic` in agent prompts.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TAVILY_TOKEN` | API key starting with `tvly-` | https://app.tavily.com/home → API Keys → Create new key |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    HERMES="docker exec $AGENT hermes"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
  echo "Using: $HERMES"
  $HERMES --version
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci tavily" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_TAVILY_API_KEY=tvly-' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Tavily already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (token format + live API + MCP probe)

```bash
# Token format
printf '%s' "$TAVILY_TOKEN" | grep -qE '^tvly-[A-Za-z0-9_-]+$' \
  || { echo "ABORT: TAVILY_TOKEN must start with 'tvly-'."; exit 1; }

# Live REST API verify (also surfaces credit issues)
HTTP=$(curl -sS -o /tmp/tav.json -w '%{http_code}' --max-time 15 \
  -X POST 'https://api.tavily.com/search' \
  -H "Authorization: Bearer $TAVILY_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"hermes agent test","max_results":1,"search_depth":"basic"}' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200) echo "Tavily REST OK." ;;
  401) echo "ABORT: token rejected (401)."; exit 1 ;;
  429|432) echo "ABORT: out of credits or rate-limited ($HTTP). Wait or upgrade plan."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/tav.json | head -3; exit 1 ;;
esac
rm -f /tmp/tav.json

# MCP probe with bearer
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
RESP=$(curl -sS --max-time 15 \
  -X POST 'https://mcp.tavily.com/mcp/' \
  -H "Authorization: Bearer $TAVILY_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d "$INIT" 2>/dev/null) || true
printf '%s' "$RESP" | grep -q '"result"' \
  && echo "Tavily MCP OK." \
  || { echo "ABORT: Tavily MCP probe failed."; echo "$RESP" | head -3; exit 1; }
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_TAVILY_API_KEY (length ${#TAVILY_TOKEN}, prefix tvly-) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add tavily --url https://mcp.tavily.com/mcp/ --auth-header Authorization --auth-scheme Bearer
  4. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  5. Verify in logs: grep "registered.*tavily"
  6. Smoke test: MCP initialize from inside container + REST /search call — expect 200

Token is NEVER printed in plaintext beyond length + prefix.
URL note: trailing slash on /mcp/ is required (Tavily 404s without it).
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_TAVILY_API_KEY '$TAVILY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_TAVILY_API_KEY=tvly-' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_TAVILY_API_KEY=' ~/.hermes/.env || printf 'MCP_TAVILY_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_TAVILY_API_KEY=.*|MCP_TAVILY_API_KEY=$TAVILY_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in the URL query string. Never put it in `config.yaml`.

---

## Step 6 — register the Tavily MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add tavily \
    --url 'https://mcp.tavily.com/mcp/' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_TAVILY_API_KEY}|g' ~/.hermes/config.yaml"
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE "registered.*tool.*tavily|MCP server.*tavily.*(ok|ready)"; then
    REGISTERED=1; echo "OK: tavily MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: tavily not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (from inside the container)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST 'https://api.tavily.com/search' \
    -H \"Authorization: Bearer \$MCP_TAVILY_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"hermes agent self-hosted\",\"max_results\":1,\"search_depth\":\"basic\"}'
")
case "$HTTP" in
  200) echo "OK: Tavily REST reachable from VPS." ;;
  401) echo "FAIL: token rejected. Rolling back."; rollback; exit 1 ;;
  429|432) echo "WARN: out of credits / rate-limited ($HTTP)." ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove tavily 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^MCP_TAVILY_API_KEY=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://app.tavily.com/home → API Keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | API key in URL query string (`?tavilyApiKey=...`) | Leaks via proxy/access/history logs | Bearer header only; Step 3+6 both use header |
| 2 | Missing trailing slash on `/mcp/` | Tavily 404s without it | This skill uses `https://mcp.tavily.com/mcp/` literally |
| 3 | OAuth path on headless agent | OAuth needs browser handshake | Bearer header only; document OAuth as desktop-only |
| 4 | Free-tier credit drain from agent loops | Monthly cap; loops can blow through in minutes | Cap `search_depth=basic`; monitor `/usage`; alert on 429/432 |
| 5 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_TAVILY_API_KEY}` indirection in yaml |
| 6 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 7 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 8 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 9 | Real token on `mcp add` argv | Lands in shell history | This skill registers with placeholder, sed-injects env reference |
| 10 | Confusing Tavily REST vs MCP endpoints | Different paths; same token | This skill uses both: MCP for tool registration, REST for smoke test |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Hitting `/search` with `search_depth: advanced` everywhere | 4x credit cost per call | Default agent prompt to `basic`; reserve advanced for explicit asks |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: token starts with `tvly-`; live `/search` returned 200; MCP `initialize` returned a result
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_TAVILY_API_KEY` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `config.yaml` references `${MCP_TAVILY_API_KEY}` (no plaintext, never in query string)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'tavily'` within 30s
- [ ] Smoke test: `/search` from inside container returned 200
- [ ] Rollback function defined; key revocation URL included
- [ ] User informed of free-tier credit limits and `search_depth=basic` default

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, MCP,
and credit-exhaustion failure modes.
