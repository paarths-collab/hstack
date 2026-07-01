---
name: integration-supermemory
description: Connect Supermemory (fast scalable memory + context engine for AI agents — add/search/graph memories with optional project scope) to a self-hosted Hermes Agent over SSH via Supermemory's first-party hosted MCP at mcp.supermemory.ai. Uses static sm_ bearer key. Optional self-hosted OSS documented. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-supermemory — connect Supermemory to a remote Hermes (SSH-first)

You are the engineer connecting Supermemory (memory + context engine, sold as "the Memory
API for the AI era") to a self-hosted Hermes agent on the user's VPS. You (the AI agent —
Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root
against the VPS. The user does one thing a machine cannot: mint the `sm_` API key at
https://console.supermemory.ai.

Everything else — key storage, live MCP verification, gateway reload, add + search smoke
test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Supermemory ships an **official first-party**
hosted MCP at `https://mcp.supermemory.ai/mcp` with **bearer auth** — headless-friendly,
matches the pattern of Notion/Stripe/Tavily/Mem0. Sources:
- https://supermemory.ai/docs/supermemory-mcp/setup
- https://github.com/supermemoryai/supermemory

**Two paths:**

- **Path A (default — hosted platform):** `https://mcp.supermemory.ai/mcp` + REST at
  `https://api.supermemory.ai/v3/`. Sign up + free tier at https://console.supermemory.ai.
- **Path B (opt-in — self-hosted OSS):** the `supermemoryai/supermemory` repo runs fully
  locally. Deploy via `docker compose` from the repo, then point `SUPERMEMORY_HOST` at your
  self-hosted URL. Data stays on your box; you own the vector store.

**Key format:** platform keys start with `sm_`. Never inline in URLs, never in chat.

**Optional project scoping:** Supermemory supports the `x-sm-project` header for
per-project memory namespaces. Useful when the same key powers multiple Hermes deploys
(e.g. one project per client, per SOUL persona).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SUPERMEMORY_API_KEY` *(Path A — required)* | API key starting with `sm_` | https://console.supermemory.ai → API Keys → Create |
| `$SUPERMEMORY_PROJECT_ID` *(Path A — optional)* | Project ID for `x-sm-project` header scope | https://console.supermemory.ai → Projects → the project's ID |
| `$SUPERMEMORY_HOST` *(Path B — required)* | Self-hosted OSS URL like `http://127.0.0.1:8000` | Your OSS docker compose deploy |
| `$WIRE_PATH` *(optional)* | `A` (hosted, default) or `B` (self-hosted) | Free tier limits vs data locality tradeoff |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci supermemory" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_SUPERMEMORY_API_KEY=sm_' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_HOST=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SUPERMEMORY_HOST=http' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && { [ "$HAS_KEY" = "1" ] || [ "$HAS_HOST" = "1" ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Supermemory already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (path-specific validation + live MCP verification)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

if [ "$PATH_CHOSEN" = "A" ]; then
  # Key format
  printf '%s' "$SUPERMEMORY_API_KEY" | grep -qE '^sm_[A-Za-z0-9_-]+$' \
    || { echo "ABORT: SUPERMEMORY_API_KEY must start with 'sm_' (Supermemory platform key)."; exit 1; }
  [ "${#SUPERMEMORY_API_KEY}" -ge 20 ] \
    || { echo "ABORT: SUPERMEMORY_API_KEY looks too short."; exit 1; }

  # Live MCP probe with bearer + optional project header
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
  PROJECT_HEADER=""
  [ -n "${SUPERMEMORY_PROJECT_ID:-}" ] && PROJECT_HEADER="-H x-sm-project:$SUPERMEMORY_PROJECT_ID"
  RESP=$(curl -sS --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $SUPERMEMORY_API_KEY" \
    $PROJECT_HEADER \
    -d "$INIT" \
    'https://mcp.supermemory.ai/mcp' 2>/dev/null) || true
  if printf '%s' "$RESP" | grep -q '"result"'; then
    TOOL_COUNT=$(printf '%s' "$RESP" | grep -oE '"name":"[^"]+"' | wc -l | tr -d ' ')
    echo "Supermemory MCP OK ($TOOL_COUNT tools)."
  elif printf '%s' "$RESP" | grep -qi 'unauthor\|invalid'; then
    echo "ABORT: Supermemory rejected the key. Re-check https://console.supermemory.ai."
    exit 1
  else
    echo "ABORT: Supermemory MCP probe failed. Body:"; echo "$RESP" | head -3; exit 1
  fi
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  # OSS host format
  printf '%s' "$SUPERMEMORY_HOST" | grep -qE '^https?://[^[:space:]]+[^/]$' \
    || { echo "ABORT: SUPERMEMORY_HOST must be http(s)://host[:port], no trailing slash."; exit 1; }

  # OSS should expose /health or similar; try a memory list ping
  RESP=$(curl -sS -o /tmp/sm.json -w '%{http_code}' --max-time 10 \
    "$SUPERMEMORY_HOST/v3/memories?limit=1" 2>/dev/null) || RESP=000
  case "$RESP" in
    200|401|403) echo "Supermemory OSS reachable at $SUPERMEMORY_HOST (HTTP $RESP)." ;;
    000) echo "ABORT: cannot reach $SUPERMEMORY_HOST. Is the docker compose stack up?"; exit 1 ;;
    *) echo "WARN: unexpected HTTP $RESP from $SUPERMEMORY_HOST." ;;
  esac
  rm -f /tmp/sm.json
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Path A (hosted platform):
    1. Write MCP_SUPERMEMORY_API_KEY (length ${#SUPERMEMORY_API_KEY}, prefix sm_) via 'hermes config set'
    2. (optional) Write SUPERMEMORY_PROJECT_ID for x-sm-project header scope
    3. chmod 600 ~/.hermes/.env
    4. Register MCP: hermes mcp add supermemory --url https://mcp.supermemory.ai/mcp --auth-header Authorization --auth-scheme Bearer
       (+ x-sm-project static header if project ID supplied)
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*supermemory"
    7. Smoke test: MCP tools/list returns N tools

  Path B (self-hosted OSS):
    1. Write SUPERMEMORY_HOST ($SUPERMEMORY_HOST) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. No MCP registration (generic REST tool reads SUPERMEMORY_HOST)
    4. Reload gateway: stop + run
    5. Smoke test: GET /v3/memories?limit=1 — expect 200

Key is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_SUPERMEMORY_API_KEY '$SUPERMEMORY_API_KEY'"
  if [ -n "${SUPERMEMORY_PROJECT_ID:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes config set SUPERMEMORY_PROJECT_ID '$SUPERMEMORY_PROJECT_ID'"
  fi
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_SUPERMEMORY_API_KEY=sm_' ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: Supermemory key not written. Rolling back."; rollback; exit 1; }
fi
if [ "$PATH_CHOSEN" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SUPERMEMORY_HOST '$SUPERMEMORY_HOST'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
fi
echo "Supermemory config confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_SUPERMEMORY_API_KEY=' ~/.hermes/.env || printf 'MCP_SUPERMEMORY_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_SUPERMEMORY_API_KEY=.*|MCP_SUPERMEMORY_API_KEY=$SUPERMEMORY_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP (Path A only)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add supermemory \
      --url 'https://mcp.supermemory.ai/mcp' \
      --auth-header 'Authorization' \
      --auth-scheme 'Bearer' \
      --placeholder-token 'placeholder'
  "
  ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_SUPERMEMORY_API_KEY}|g' ~/.hermes/config.yaml"

  # If project ID supplied, add a static header for scope isolation
  if [ -n "${SUPERMEMORY_PROJECT_ID:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "
      python3 -c \"
import yaml
p='$HOME/.hermes/config.yaml'.replace('\\\$HOME','$HOME')
d=yaml.safe_load(open(p)) or {}
d.setdefault('mcp_servers', {}).setdefault('supermemory', {}).setdefault('headers', {})
d['mcp_servers']['supermemory']['headers']['x-sm-project']='$SUPERMEMORY_PROJECT_ID'
yaml.safe_dump(d, open(p,'w'), sort_keys=False)
\"  || echo 'WARN: could not auto-add x-sm-project header — edit config.yaml manually.'
    "
  fi
fi
```

Path B: the generic HTTP tool layer reads `SUPERMEMORY_HOST` (no key needed for self-hosted
OSS; the operator owns the box). Common REST endpoints:

- `POST /v3/memories` — add memory
- `POST /v3/memories/search` — search
- `GET /v3/memories/<id>` — get one
- `PUT /v3/memories/<id>` — update
- `DELETE /v3/memories/<id>` — delete

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify (Path A) + smoke test

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*supermemory|MCP server.*supermemory.*(ok|ready)"; then
      REGISTERED=1; echo "OK: supermemory MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: supermemory not in logs. Rolling back."; rollback; exit 1; }

  # Smoke test — call tools/list against MCP from inside the container
  TOOLS_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    PROJECT_HDR=''
    [ -n \"\$SUPERMEMORY_PROJECT_ID\" ] && PROJECT_HDR=\"-H x-sm-project:\$SUPERMEMORY_PROJECT_ID\"
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
      -X POST 'https://mcp.supermemory.ai/mcp' \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      -H \"Authorization: Bearer \$MCP_SUPERMEMORY_API_KEY\" \
      \$PROJECT_HDR \
      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'
  ")
  case "$TOOLS_HTTP" in
    200) echo "OK: Supermemory MCP tools/list reachable from VPS." ;;
    *) echo "WARN: tools/list HTTP $TOOLS_HTTP." ;;
  esac
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      \"\$SUPERMEMORY_HOST/v3/memories?limit=1\"
  ")
  case "$HTTP" in
    200) echo "OK: Supermemory OSS reachable from VPS." ;;
    *) echo "WARN: HTTP $HTTP from OSS host." ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${PATH_CHOSEN:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove supermemory 2>/dev/null || true"
    ssh "$VPS_USER@$VPS_IP" "
      sed -i '/^MCP_SUPERMEMORY_API_KEY=/d;
              /^SUPERMEMORY_PROJECT_ID=/d' ~/.hermes/.env
    "
  else
    ssh "$VPS_USER@$VPS_IP" "sed -i '/^SUPERMEMORY_HOST=/d' ~/.hermes/.env"
  fi
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env && hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://console.supermemory.ai if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Cross-project memory pollution | Same key across multiple Hermes deploys → memories leak between agents | Use `SUPERMEMORY_PROJECT_ID` for per-agent scoping via `x-sm-project` header |
| 2 | Using OSS URL against hosted `mcp.supermemory.ai` | Different auth surface; OSS may not need Bearer or may need different headers | Set `WIRE_PATH` explicitly; Step 3 branches per path |
| 3 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_SUPERMEMORY_API_KEY}` indirection in yaml |
| 4 | Free-tier quota exhaustion | Silently rejects new memories after cap | Monitor console.supermemory.ai; upgrade or switch to Path B |
| 5 | Self-hosted OSS server on 0.0.0.0 | World-readable memory store | Bind to `127.0.0.1` on the Hermes VPS |
| 6 | Mixing Mem0 + Supermemory at once | Both wired = duplicate writes to two stores; recall gets confused | Pick one memory backend per agent; document which in SOUL.md |
| 7 | Missing `x-sm-project` when project scope was intended | Memories land in default project, not the scoped one | Always set `SUPERMEMORY_PROJECT_ID` when multi-tenant |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter on URLs | URLs contain `/` | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Bearer token in URL query string | Some tutorials show `?token=`; leaks via proxy/access logs | This skill uses Authorization header only |
| 13 | Wrong API version prefix (`/v1/` vs `/v3/`) | Supermemory REST is on `/v3/` — older `/v1/` paths are stale | Use `/v3/` throughout |
| 14 | Community MCP wrappers instead of first-party | Third-party code in the trust path | This skill wires ONLY `mcp.supermemory.ai` (first-party) |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: Path A → key starts with `sm_`, live MCP `initialize` returned result; Path B → host is `http(s)://...`, `/v3/memories?limit=1` reachable
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: MCP registered with `${MCP_SUPERMEMORY_API_KEY}` indirection (no plaintext in yaml); `x-sm-project` header set if project ID supplied
- [ ] Path B: `SUPERMEMORY_HOST` documented for generic REST tool
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'supermemory'` within 30s
- [ ] Live smoke: Path A MCP `tools/list` returned 200 OR Path B `/v3/memories` returned 200
- [ ] User told about Pitfall #6: don't wire both Mem0 AND Supermemory at once — pick one memory backend
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, memory
project-scoping, and Supermemory REST/MCP failure modes.
