---
name: integration-posthog
description: Connect PostHog (product analytics + feature flags + error tracking + HogQL + CDP) to a self-hosted Hermes Agent over SSH via PostHog's first-party hosted MCP at mcp.posthog.com with a personal API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-posthog — connect PostHog to a remote Hermes (SSH-first)

You are the engineer connecting PostHog (product analytics + feature flags + error tracking
+ CDP + HogQL SQL) to a self-hosted Hermes agent on the user's VPS. You (the AI agent —
Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root
against the VPS. The user does one thing a machine cannot: mint the personal API key at
https://us.posthog.com (or `eu.posthog.com`) → Account → Personal API Keys.

Everything else — key storage, live API verification, MCP registration, gateway reload,
live query smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** PostHog ships an **official first-party**
hosted MCP at `https://mcp.posthog.com/mcp` with **Bearer auth** — perfect for a headless
agent. Free to use.

Sources:
- https://posthog.com/docs/model-context-protocol
- https://github.com/PostHog/mcp

**What the MCP exposes:** feature flag CRUD, error/exception queries, HogQL SQL against
your PostHog data, CDP destinations, insight/dashboard creation, session-replay lookups,
person and cohort operations.

**Region matters:** PostHog Cloud runs in **US** (`us.posthog.com`) or **EU**
(`eu.posthog.com`). The MCP host stays the same (`mcp.posthog.com`), but your personal API
key is region-scoped. Self-hosted PostHog uses your own domain and its own MCP would need
custom hosting.

**Key scope:** personal API keys have configurable scopes at mint time. Default scope covers
read + write on most resources. For an agent, mint with the minimum scopes you need
(e.g. `feature_flag:read`, `query:read`, `error_tracking:read`).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$POSTHOG_API_KEY` | Personal API key (`phx_...` prefix, though older keys may be raw hex) | Account → Personal API Keys → Create → select scopes → copy ONCE |
| `$POSTHOG_HOST` *(optional)* | `us.posthog.com` (default) or `eu.posthog.com` or your self-hosted domain | Match wherever your PostHog org lives |
| `$POSTHOG_PROJECT_ID` *(optional)* | Project ID (numeric) to scope tool calls | Your PostHog project settings |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci posthog" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^POSTHOG_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "PostHog already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key sanity + live API verify)

```bash
# Key sanity — PostHog personal API keys are long random tokens
[ "${#POSTHOG_API_KEY}" -ge 30 ] \
  || { echo "ABORT: POSTHOG_API_KEY looks too short (<30 chars)."; exit 1; }

# Region check
HOST=${POSTHOG_HOST:-us.posthog.com}
printf '%s' "$HOST" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$' \
  || { echo "ABORT: POSTHOG_HOST must be a hostname (no scheme, no trailing slash)."; exit 1; }

# Live API verify — GET /api/organizations/@current
HTTP=$(curl -sS -o /tmp/ph.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  "https://$HOST/api/organizations/@current" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    ORG_NAME=$(grep -oE '"name":"[^"]+"' /tmp/ph.json | head -1 | cut -d'"' -f4)
    echo "PostHog API OK. Organization: $ORG_NAME (region: $HOST)"
    ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://$HOST/settings/user-api-keys."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/ph.json | head -3; exit 1 ;;
esac
rm -f /tmp/ph.json

# Optional project ID visibility check
if [ -n "${POSTHOG_PROJECT_ID:-}" ]; then
  PROJ_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $POSTHOG_API_KEY" \
    "https://$HOST/api/projects/$POSTHOG_PROJECT_ID" 2>/dev/null) || PROJ_HTTP=000
  [ "$PROJ_HTTP" = "200" ] || { echo "ABORT: POSTHOG_PROJECT_ID=$POSTHOG_PROJECT_ID not visible ($PROJ_HTTP)."; exit 1; }
  echo "Project $POSTHOG_PROJECT_ID visible."
fi

# Live MCP probe with bearer
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
RESP=$(curl -sS --max-time 15 \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d "$INIT" \
  'https://mcp.posthog.com/mcp' 2>/dev/null) || true
printf '%s' "$RESP" | grep -q '"result"' \
  && echo "PostHog MCP OK." \
  || { echo "ABORT: PostHog MCP probe failed. Body:"; echo "$RESP" | head -3; exit 1; }
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_POSTHOG_API_KEY (length ${#POSTHOG_API_KEY}) via 'hermes config set'
  2. Write POSTHOG_HOST (${POSTHOG_HOST:-us.posthog.com})
  3. Write POSTHOG_PROJECT_ID (${POSTHOG_PROJECT_ID:-none}) if supplied
  4. chmod 600 ~/.hermes/.env
  5. Register MCP: hermes mcp add posthog --url https://mcp.posthog.com/mcp
       --auth-header Authorization --auth-scheme Bearer
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Verify in logs: grep "registered.*posthog"
  8. Smoke test: MCP tools/list — expect result with feature-flag / query / error tools

Key is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_POSTHOG_API_KEY '$POSTHOG_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set POSTHOG_HOST '${POSTHOG_HOST:-us.posthog.com}'"
if [ -n "${POSTHOG_PROJECT_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set POSTHOG_PROJECT_ID '$POSTHOG_PROJECT_ID'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_POSTHOG_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: PostHog key not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add posthog \
    --url 'https://mcp.posthog.com/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_POSTHOG_API_KEY}|g' ~/.hermes/config.yaml"
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
       | grep -qiE "registered.*tool.*posthog|MCP server.*posthog.*(ok|ready)"; then
    REGISTERED=1; echo "OK: posthog MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: posthog not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (MCP tools/list from inside the container)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST 'https://mcp.posthog.com/mcp' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: Bearer \$MCP_POSTHOG_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'
")
case "$HTTP" in
  200) echo "OK: PostHog MCP tools/list reachable from VPS." ;;
  401) echo "FAIL: 401. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove posthog 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^MCP_POSTHOG_API_KEY=/d;
            /^POSTHOG_HOST=/d;
            /^POSTHOG_PROJECT_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://<region>.posthog.com/settings/user-api-keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Personal API key confused with Project API key | Two separate keys — the Personal (long-lived, user-scoped) is for API/MCP; the Project (starts `phc_`) is for event capture from clients | This skill only uses the Personal key |
| 2 | Wrong region (us vs eu) | US key hitting eu.posthog.com returns 401 | Match POSTHOG_HOST to the region where your org lives; Step 3 verifies |
| 3 | Missing scopes on the personal key | Feature-flag calls 403 with default scope only | At mint time, check the specific scopes you need (feature_flag, query, error_tracking, etc.) |
| 4 | Agent has feature-flag write access | Agent can create/toggle flags, potentially affecting real users | Restrict via key scopes at mint; use read-only scopes if experimenting |
| 5 | HogQL query drops sensitive PII | Ad-hoc SQL agents can query event/person data with PII | Row-level filtering in prompts; audit queries |
| 6 | Free-tier event limits | If agent creates events via `capture` tool, can exhaust free tier | Monitor billing; use read-only tools if concerned |
| 7 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_POSTHOG_API_KEY}` indirection in yaml |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Self-hosted PostHog missing MCP | Only PostHog Cloud has the hosted MCP; self-hosted needs custom deploy | Use PostHog Cloud (free tier); self-hosted users deploy `PostHog/mcp` themselves |
| 13 | Rate limits | Bursty HogQL loops hit rate limits | Back off on 429; batch queries |
| 14 | Key rotation without redeploy | Old key in .env keeps failing 401 | Rotate → re-run with FORCE=1 |
| 15 | Feature-flag toggle without approval | Agent can flip a feature flag for millions of users instantly | Add human-in-the-loop step for write-to-live-flag operations |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: key ≥30 chars; host format valid; live `/api/organizations/@current` returned 200 with an org name; MCP `initialize` returned result; project ID visible if supplied
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] MCP registered with `${MCP_POSTHOG_API_KEY}` indirection (no plaintext in yaml)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'posthog'` within 30s
- [ ] Smoke test: `tools/list` from VPS returned 200
- [ ] User informed about scope minimization + feature-flag write blast radius
- [ ] User understands Personal key vs Project (phc_) key distinction
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, region,
and PostHog scope failure modes.
