---
name: integration-mem0
description: Connect Mem0 (universal memory layer for AI agents — add/search/update/delete persistent memories scoped by user_id/agent_id/run_id) to a self-hosted Hermes Agent over SSH. Uses Mem0's official first-party hosted MCP at mcp.mem0.ai with a static m0- bearer key. Optional self-hosted OSS fallback documented (no /v1/ prefix, port 8888). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-mem0 — connect Mem0 memory to a remote Hermes (SSH-first)

You are the engineer connecting Mem0 (a persistent memory layer that lets any AI agent
remember users, conversations, preferences, and code across sessions) to a self-hosted
Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor,
Gemini, OpenClaw, any of them) work over SSH as root against the VPS. The user does one
thing a machine cannot: mint the `m0-` API key at https://app.mem0.ai.

Everything else — key storage, live MCP + REST verification, gateway reload, live add +
search smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Mem0 ships an **official first-party** remote
MCP at `https://mcp.mem0.ai/mcp` with **bearer auth** (headless-friendly — perfect for
Hermes). Sources:
- https://docs.mem0.ai/platform/mem0-mcp
- https://github.com/mem0ai/mem0-mcp

**Two paths:**

- **Path A (default — hosted platform):** `https://mcp.mem0.ai/mcp` + `https://api.mem0.ai/v1/`
  REST. Free tier includes a monthly memory quota; check current pricing at
  https://mem0.ai/pricing. Data lives on Mem0's infrastructure.
- **Path B (opt-in — self-hosted OSS):** stand up the Mem0 OSS server at
  `http://<vps>:8888` (or bind to `127.0.0.1:8888` on the Hermes VPS). No `/v1/` prefix
  on the OSS endpoints (`POST /memories`, `POST /search`, ...). Data stays on your box.
  Fully documented at https://docs.mem0.ai/open-source/features/rest-api.

**Memory scoping:** Mem0 memories are keyed by `user_id`, `agent_id`, and/or `run_id`. For
Hermes, `user_id` is typically the messaging-platform user (Telegram numeric ID, Slack
Member ID, etc.); `agent_id` is `hermes` or the SOUL persona name; `run_id` is a
conversation/session ID. Set a sane convention up front — mixing schemes across sessions
fragments memory recall.

**Key format:** Mem0 platform keys start with `m0-`. Never inline in URLs, never in chat.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MEM0_API_KEY` *(Path A — required)* | API key starting with `m0-` | https://app.mem0.ai → Settings → API Keys → Create |
| `$MEM0_ORG_ID` *(Path A — optional)* | Org ID for team-scoped memories | https://app.mem0.ai → Org settings |
| `$MEM0_PROJECT_ID` *(Path A — optional)* | Project ID to scope this agent's memories | https://app.mem0.ai → Project settings |
| `$MEM0_HOST` *(Path B — required)* | Self-hosted OSS host `http://127.0.0.1:8888` | Your Mem0 OSS deploy (docker compose from https://github.com/mem0ai/mem0) |
| `$WIRE_PATH` *(optional)* | `A` (hosted, default) or `B` (self-hosted OSS) | Free tier limits vs data locality tradeoff |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci mem0" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_MEM0_API_KEY=m0-' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_HOST=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MEM0_HOST=http' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && { [ "$HAS_KEY" = "1" ] || [ "$HAS_HOST" = "1" ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Mem0 already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (path-specific validation + live API verification)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

if [ "$PATH_CHOSEN" = "A" ]; then
  # Key format
  printf '%s' "$MEM0_API_KEY" | grep -qE '^m0-[A-Za-z0-9_-]+$' \
    || { echo "ABORT: MEM0_API_KEY must start with 'm0-' (Mem0 platform key)."; exit 1; }
  [ "${#MEM0_API_KEY}" -ge 20 ] \
    || { echo "ABORT: MEM0_API_KEY looks too short."; exit 1; }

  # Live REST /v1/memories/ HEAD-style check: search with empty query, expect 200 or 400 (never 401)
  RESP=$(curl -sS --max-time 10 -o /tmp/mem0.json -w '%{http_code}' \
    -X POST 'https://api.mem0.ai/v1/memories/search/' \
    -H "Authorization: Token $MEM0_API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"query":"ping","user_id":"hstack-preflight","limit":1}' 2>/dev/null) || RESP=000
  case "$RESP" in
    200|400) echo "Mem0 platform REST OK." ;;
    401|403) echo "ABORT: Mem0 rejected the key ($RESP). Re-check https://app.mem0.ai → Settings → API Keys."; exit 1 ;;
    *) echo "ABORT: unexpected HTTP $RESP from Mem0 REST."; cat /tmp/mem0.json | head -3; exit 1 ;;
  esac
  rm -f /tmp/mem0.json

  # Live MCP initialize with bearer
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
  MCP_RESP=$(curl -sS --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $MEM0_API_KEY" \
    -d "$INIT" \
    'https://mcp.mem0.ai/mcp' 2>/dev/null) || true
  printf '%s' "$MCP_RESP" | grep -q '"result"' \
    && echo "Mem0 hosted MCP OK." \
    || { echo "ABORT: Mem0 MCP probe failed. Body:"; echo "$MCP_RESP" | head -3; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  # OSS host format
  printf '%s' "$MEM0_HOST" | grep -qE '^https?://[^[:space:]]+[^/]$' \
    || { echo "ABORT: MEM0_HOST must be http(s)://host[:port], no trailing slash."; exit 1; }

  # OSS uses no /v1/ prefix — POST /search direct
  RESP=$(curl -sS --max-time 10 -o /tmp/mem0.json -w '%{http_code}' \
    -X POST "$MEM0_HOST/search" \
    -H 'Content-Type: application/json' \
    -d '{"query":"ping","user_id":"hstack-preflight"}' 2>/dev/null) || RESP=000
  case "$RESP" in
    200|400) echo "Mem0 OSS REST OK at $MEM0_HOST." ;;
    404) echo "ABORT: 404 — is your OSS server on /v1/? OSS does NOT use /v1/ (use POST /search, POST /memories). Re-check server."; exit 1 ;;
    *) echo "ABORT: unexpected HTTP $RESP from $MEM0_HOST/search."; cat /tmp/mem0.json | head -3; exit 1 ;;
  esac
  rm -f /tmp/mem0.json
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Path A (hosted platform):
    1. Write MCP_MEM0_API_KEY (length ${#MEM0_API_KEY}, prefix m0-) via 'hermes config set'
    2. (optional) Write MEM0_ORG_ID + MEM0_PROJECT_ID for team/project scoping
    3. chmod 600 ~/.hermes/.env
    4. Register MCP: hermes mcp add mem0 --url https://mcp.mem0.ai/mcp --auth-header Authorization --auth-scheme Bearer
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*mem0"
    7. Smoke test: add + search a memory round-trip

  Path B (self-hosted OSS):
    1. Write MEM0_HOST ($MEM0_HOST) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. No MCP registration (OSS server is REST-only); generic HTTP tool reads MEM0_HOST
    4. Reload gateway: stop + run
    5. Smoke test: POST /memories then POST /search — expect 200 both

Key is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_MEM0_API_KEY '$MEM0_API_KEY'"
  if [ -n "${MEM0_ORG_ID:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes config set MEM0_ORG_ID '$MEM0_ORG_ID'"
  fi
  if [ -n "${MEM0_PROJECT_ID:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes config set MEM0_PROJECT_ID '$MEM0_PROJECT_ID'"
  fi
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_MEM0_API_KEY=m0-' ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: Mem0 key not written. Rolling back."; rollback; exit 1; }
fi
if [ "$PATH_CHOSEN" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MEM0_HOST '$MEM0_HOST'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
fi
echo "Mem0 config confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_MEM0_API_KEY=' ~/.hermes/.env || printf 'MCP_MEM0_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_MEM0_API_KEY=.*|MCP_MEM0_API_KEY=$MEM0_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP (Path A only)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add mem0 \
      --url 'https://mcp.mem0.ai/mcp' \
      --auth-header 'Authorization' \
      --auth-scheme 'Bearer' \
      --placeholder-token 'placeholder'
  "
  ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_MEM0_API_KEY}|g' ~/.hermes/config.yaml"
fi
```

Path B has no MCP to register. The agent's generic HTTP/tool layer reads `MEM0_HOST` and
uses these endpoints (OSS — no `/v1/` prefix):

- `POST /memories` — add memory (body: `{"messages":[...],"user_id":"...","agent_id":"..."}`)
- `POST /search` — search (body: `{"query":"...","user_id":"...","limit":10}`)
- `GET /memories/<id>` — get one
- `PUT /memories/<id>` — update
- `DELETE /memories/<id>` — delete
- `POST /reset` — nuke all memories

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify registration (Path A) + smoke test

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*mem0|MCP server.*mem0.*(ok|ready)"; then
      REGISTERED=1; echo "OK: mem0 MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: mem0 not in logs after 30s. Rolling back."; rollback; exit 1; }
fi
```

---

## Step 9 — live add + search round-trip (from inside the container)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ADD_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST 'https://api.mem0.ai/v1/memories/' \
      -H \"Authorization: Token \$MCP_MEM0_API_KEY\" \
      -H 'Content-Type: application/json' \
      -d '{\"messages\":[{\"role\":\"user\",\"content\":\"hstack smoke test\"}],\"user_id\":\"hstack-smoke\"}'
  ")
  SEARCH_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST 'https://api.mem0.ai/v1/memories/search/' \
      -H \"Authorization: Token \$MCP_MEM0_API_KEY\" \
      -H 'Content-Type: application/json' \
      -d '{\"query\":\"hstack\",\"user_id\":\"hstack-smoke\",\"limit\":1}'
  ")
  echo "Smoke: add=$ADD_HTTP search=$SEARCH_HTTP (both should be 200)"
  { [ "$ADD_HTTP" = "200" ] && [ "$SEARCH_HTTP" = "200" ]; } \
    || { echo "FAIL: smoke test. Rolling back."; rollback; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  ADD_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST \"\$MEM0_HOST/memories\" \
      -H 'Content-Type: application/json' \
      -d '{\"messages\":[{\"role\":\"user\",\"content\":\"hstack smoke test\"}],\"user_id\":\"hstack-smoke\"}'
  ")
  SEARCH_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST \"\$MEM0_HOST/search\" \
      -H 'Content-Type: application/json' \
      -d '{\"query\":\"hstack\",\"user_id\":\"hstack-smoke\"}'
  ")
  echo "Smoke: add=$ADD_HTTP search=$SEARCH_HTTP"
  { [ "$ADD_HTTP" = "200" ] && [ "$SEARCH_HTTP" = "200" ]; } \
    || { echo "FAIL: smoke test. Rolling back."; rollback; exit 1; }
fi
echo "OK: Mem0 add + search round-trip succeeded."
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${PATH_CHOSEN:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove mem0 2>/dev/null || true"
    ssh "$VPS_USER@$VPS_IP" "
      sed -i '/^MCP_MEM0_API_KEY=/d;
              /^MEM0_ORG_ID=/d;
              /^MEM0_PROJECT_ID=/d' ~/.hermes/.env
    "
  else
    ssh "$VPS_USER@$VPS_IP" "sed -i '/^MEM0_HOST=/d' ~/.hermes/.env"
  fi
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env && hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://app.mem0.ai → Settings → API Keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using OSS endpoints with `/v1/` prefix | OSS server has NO `/v1/` prefix; only the hosted platform does | Path B uses `POST /memories`, `POST /search` (no /v1/); Step 3 catches 404s |
| 2 | Using platform endpoints without `/v1/` | Hosted platform requires `/v1/`; drops otherwise 404 | Path A uses `/v1/memories/`, `/v1/memories/search/` |
| 3 | Confusing `Authorization: Token` (REST) with `Authorization: Bearer` (MCP) | Mem0 REST uses `Token`, MCP uses `Bearer` — mixing them causes 401s | Step 3 uses correct scheme per surface; Step 9 verifies both |
| 4 | Mixing user_id / agent_id / run_id schemes across sessions | Memories fragment — recall returns partial data | Set convention up front: `user_id`=platform user, `agent_id`=SOUL name, `run_id`=session |
| 5 | Free-tier quota exhaustion | Adds start failing silently after monthly cap | Monitor at https://app.mem0.ai; upgrade or switch to Path B (self-hosted OSS) |
| 6 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_MEM0_API_KEY}` indirection in yaml |
| 7 | Self-hosted OSS server on 0.0.0.0 | World-readable memory store — private conversations exposed | Bind to `127.0.0.1:8888` on the Hermes VPS; use SSH tunnel for external access |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter on URLs | URLs contain `/` | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | POST /reset on production data | Wipes ALL memories for the org/user — irreversible | Never call /reset from the agent; only from a manual scripted context |
| 13 | Missing user_id on add/search | Memories get global scope, mixed across users | Always pass user_id (and agent_id if multi-agent) |
| 14 | Cross-DC memory expectations | Platform memories are stored where the org is provisioned | For multi-region latency, use Path B on the same continent as the VPS |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: Path A → key starts with `m0-`, live `/v1/memories/search/` returned 200/400 (not 401), MCP `initialize` returned result; Path B → host is `http(s)://...`, live `/search` returned 200/400 (not 404)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: MCP registered with `${MCP_MEM0_API_KEY}` indirection (no plaintext in yaml)
- [ ] Path B: `MEM0_HOST` documented for generic REST tool; no MCP registration
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'mem0'` within 30s
- [ ] Live add + search round-trip returned 200 both
- [ ] `user_id` / `agent_id` / `run_id` convention agreed with user
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, memory
scoping, and Mem0 REST/MCP failure modes.
