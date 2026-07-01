---
name: integration-clerk
description: Connect Clerk (auth + user management — users, sessions, organizations, invitations, roles) to a self-hosted Hermes Agent over SSH via Clerk's Backend API with a sk_test_ or sk_live_ secret key. Bearer auth; refuses to wire sk_live_ in dev without explicit acknowledgment. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-clerk — connect Clerk to a remote Hermes (SSH-first)

You are the engineer connecting Clerk (developer-focused authentication + user management)
to a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code,
Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against the VPS. The
user does one thing a machine cannot: create the API key at
https://dashboard.clerk.com → API Keys.

Everything else — key storage, live Backend API verification, gateway reload, live
user-list smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Clerk exposes a **Backend API** at
`https://api.clerk.com/v1/` with **Bearer authentication**:
`Authorization: Bearer sk_test_...` (test mode) or `Authorization: Bearer sk_live_...`
(production). Perfect for a headless agent.

Sources:
- https://clerk.com/docs/guides/development/machine-auth/api-keys
- https://clerk.com/docs/reference/backend-api

**MCP options:**

- **Path A (default) — direct REST via Backend API.** No first-party Clerk MCP server
  exists yet as a hosted HTTP endpoint. Clerk's `@clerk/agent-toolkit` and `@clerk/mcp-tools`
  are libraries for BUILDING MCP servers in your own app, not a ready-to-run server. The
  simplest headless path is generic HTTP tool against `api.clerk.com/v1/`.
- **Path B (opt-in) — self-hosted stdio MCP via `@clerk/agent-toolkit`.** Requires you to
  run a small Node.js wrapper on the VPS. Only useful if you specifically want MCP tool
  semantics over the API.

**Key mode:** `sk_test_` keys touch only test data (no real users). `sk_live_` keys hit
production. This skill refuses to wire `sk_live_` without `PROD_ACKNOWLEDGED=1`.

**Key format:** exactly `sk_(test|live)_<40+ alphanumeric>`. Never inline in URLs, never
in chat.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$CLERK_SECRET_KEY` | Secret key `sk_test_...` or `sk_live_...` | https://dashboard.clerk.com → API Keys → Show secret key |
| `$PROD_ACKNOWLEDGED` *(required if key is `sk_live_...`)* | Set to `1` to confirm you know this is production | Explicit gate to prevent accidental prod wire-ups |
| `$WIRE_PATH` *(optional)* | `A` (REST, default) or `B` (self-hosted stdio MCP) | B requires npm/npx and hosting overhead |

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
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CLERK_SECRET_KEY=sk_' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Clerk already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key format + prod acknowledgment + live Backend API)

```bash
# Key format
printf '%s' "$CLERK_SECRET_KEY" | grep -qE '^sk_(test|live)_[A-Za-z0-9]+$' \
  || { echo "ABORT: CLERK_SECRET_KEY must be sk_test_<alnum> or sk_live_<alnum>."; exit 1; }
[ "${#CLERK_SECRET_KEY}" -ge 40 ] \
  || { echo "ABORT: CLERK_SECRET_KEY looks too short (<40 chars)."; exit 1; }

# Detect mode
case "$CLERK_SECRET_KEY" in
  sk_test_*) MODE=test ;;
  sk_live_*) MODE=live ;;
esac
echo "Key mode: $MODE"

# Refuse live without explicit acknowledgment
if [ "$MODE" = "live" ] && [ "${PROD_ACKNOWLEDGED:-0}" != "1" ]; then
  echo "ABORT: sk_live_ key detected — this touches PRODUCTION user data."
  echo "Set PROD_ACKNOWLEDGED=1 to confirm you intend this and understand the blast radius."
  echo "  (An agent misuse can delete users, invalidate sessions, or mass-invite the wrong org.)"
  exit 1
fi

# Live Backend API verify — GET /v1/users?limit=1
HTTP=$(curl -sS -o /tmp/clerk.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  'https://api.clerk.com/v1/users?limit=1' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    USER_COUNT=$(grep -oE '"id":"user_' /tmp/clerk.json | wc -l | tr -d ' ')
    echo "Clerk Backend API OK. Sample query returned $USER_COUNT user(s) (limited to 1)."
    ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://dashboard.clerk.com → API Keys."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP from Backend API."; cat /tmp/clerk.json | head -3; exit 1 ;;
esac
rm -f /tmp/clerk.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write CLERK_SECRET_KEY (length ${#CLERK_SECRET_KEY}, mode=$MODE) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env

  Path A (REST — default, no MCP server):
    3. No MCP registration; generic HTTP tool reads CLERK_SECRET_KEY from env
    4. Reload gateway: stop + run
    5. Smoke test: GET /v1/users?limit=1 with Bearer header — expect 200

  Path B (self-hosted stdio MCP via @clerk/agent-toolkit):
    3. Register MCP: hermes mcp add clerk --command npx --args -y,@clerk/agent-toolkit
       --env CLERK_SECRET_KEY=\${CLERK_SECRET_KEY}
    4. Reload gateway: stop + run
    5. Verify in logs: grep "registered.*clerk"

Key is NEVER printed in plaintext beyond a length + mode.
Mode: $MODE $([ "$MODE" = "live" ] && echo "(PRODUCTION — REAL user data)" || echo "(test — sandbox data only)")
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set CLERK_SECRET_KEY '$CLERK_SECRET_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CLERK_SECRET_KEY=sk_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: Clerk key not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^CLERK_SECRET_KEY=' ~/.hermes/.env || printf 'CLERK_SECRET_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^CLERK_SECRET_KEY=.*|CLERK_SECRET_KEY=$CLERK_SECRET_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A — direct REST (default, no third-party wrapper)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  echo "Path A chosen: REST base https://api.clerk.com/v1"
  echo "Generic HTTP tool reads CLERK_SECRET_KEY and uses:"
  echo "  Authorization: Bearer \${CLERK_SECRET_KEY}"
  echo "  Content-Type: application/json"
fi
```

Common Backend API endpoints:

- `GET /v1/users` — list users (paginate with `limit` + `offset`)
- `GET /v1/users/{id}` — get user
- `POST /v1/users` — create user
- `PATCH /v1/users/{id}` — update user
- `DELETE /v1/users/{id}` — delete user
- `POST /v1/users/{id}/ban` — ban user
- `GET /v1/organizations` — list organizations
- `POST /v1/organizations` — create organization
- `POST /v1/invitations` — invite email
- `GET /v1/sessions/{id}` — inspect session
- `POST /v1/sessions/{id}/revoke` — revoke session

### Path B — self-hosted stdio MCP (opt-in)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path B requires npx on VPS."; exit 1; }
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add clerk \
      --command 'npx' \
      --args '-y,@clerk/agent-toolkit' \
      --env 'CLERK_SECRET_KEY=\${CLERK_SECRET_KEY}'
  "
  echo "Path B registered. Note: @clerk/agent-toolkit is a toolkit — audit the tools it exposes before granting write scope."
fi
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

## Step 8 — verify + smoke test

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*clerk|MCP server.*clerk.*(ok|ready)"; then
      REGISTERED=1; echo "OK: clerk MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: clerk not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test (both paths)
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$CLERK_SECRET_KEY\" \
    'https://api.clerk.com/v1/users?limit=1'
")
case "$HTTP" in
  200) echo "OK: Clerk Backend API reachable from VPS." ;;
  401) echo "FAIL: 401. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove clerk 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^CLERK_SECRET_KEY=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Rotate the key at https://dashboard.clerk.com → API Keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `sk_live_` in dev without PROD_ACKNOWLEDGED=1 | Accidentally connects agent to production user data | Step 3 hard-aborts sk_live_ without explicit ack |
| 2 | Test vs live confusion | Test key touches only test-mode users; agent looks broken because "your" real users don't appear | Match key mode to intent; live starts sk_live_ |
| 3 | Agent has DELETE/BAN permissions | Backend API secret key has FULL account access — can delete users, revoke sessions, ban accounts | Restrict via system prompt; if possible expose only read tools; Path A generic HTTP layer can be scoped by tool definitions |
| 4 | Secret exposed to frontend | Backend secret must NEVER touch client code | Only `~/.hermes/.env`, `chmod 600`; agent-only exposure |
| 5 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 6 | Not rotating key periodically | Long-lived credentials | Rotate quarterly; Clerk supports multiple active keys during rotation |
| 7 | Assuming Clerk ships a hosted MCP | Clerk provides libraries to BUILD MCP servers (@clerk/mcp-tools, @clerk/agent-toolkit) — no first-party hosted MCP as of 2026-06 | Path A (REST) is the honest path; Path B is self-hosted wrapper |
| 8 | Rate limits on Backend API | Bursty user-provisioning loops hit rate limits | Back off on 429; batch |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule; keys are alphanumeric but rule applies | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Publishable key vs secret key confusion | `pk_test_...` / `pk_live_...` are PUBLISHABLE — safe for frontend but wrong for Backend API | This skill only wires `sk_...`; refuses `pk_...` in Step 3 |
| 14 | Assuming Frontend API can be called with sk_ | Two APIs: Backend (sk_) and Frontend (pk_ + session token) | This skill only wires Backend API |
| 15 | Missing rate/webhook signing checks | Webhooks use separate signing secret — this skill doesn't wire webhooks | Wire webhooks separately if the agent needs to react to Clerk events |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if key present, unless `FORCE=1`)
- [ ] HARD GATE passed: key matches `sk_(test|live)_<alnum>` + ≥40 chars; `sk_live_` requires `PROD_ACKNOWLEDGED=1`; live `/v1/users?limit=1` returned 200
- [ ] Dry-run shown to user; mode called out plainly (test vs live); user approved (or `AUTO_APPROVE=1`)
- [ ] `CLERK_SECRET_KEY` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: REST surface documented (base URL + Bearer + common endpoints)
- [ ] Path B: stdio MCP `@clerk/agent-toolkit` registered with env indirection
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path B: logs show `registered N tool(s) for 'clerk'` within 30s
- [ ] Smoke test: `/v1/users?limit=1` from VPS returned 200
- [ ] User told about write-danger scope (agent can delete/ban users) and system-prompt restriction recommended
- [ ] Rollback function defined; key rotation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, sk-vs-pk
confusion, and Clerk Backend API failure modes.
