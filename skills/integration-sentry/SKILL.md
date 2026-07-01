---
name: integration-sentry
description: Connect Sentry (error tracking + performance monitoring — issues, events, transactions, releases, alerts) to a self-hosted Hermes Agent over SSH. Refuses the hosted MCP (OAuth-only). Wires the official getsentry/sentry-mcp stdio server with SENTRY_ACCESS_TOKEN + SENTRY_HOST, or direct REST as fallback. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-sentry — connect Sentry to a remote Hermes (SSH-first)

You are the engineer connecting Sentry (error tracking + performance monitoring + release
management) to a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes,
Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against
the VPS. The user does one thing a machine cannot: mint the auth token at
https://sentry.io → Settings → Account → Auth Tokens (User) OR org-level Auth Tokens
(`sntrys_...` for Org tokens, recommended).

Everything else — token storage, live API verification, MCP registration via stdio,
gateway reload, live issue-list smoke test — runs on the VPS via SSH, idempotently with a
rollback path.

**Honest auth picture (verified 2026-06):** Sentry ships a hosted MCP at
`https://mcp.sentry.dev/mcp`, but it is **OAuth 2.0 only** as of 2026-06 — bearer
authentication is a **pending feature request** (issue #833 in `getsentry/sentry-mcp`).
That breaks headless. So this skill wires the **official self-hosted stdio MCP**
(`getsentry/sentry-mcp` via npx), which reads `SENTRY_ACCESS_TOKEN` and `SENTRY_HOST` from
env. That's the headless-friendly path today.

Sources:
- https://github.com/getsentry/sentry-mcp
- https://github.com/getsentry/sentry-mcp/issues/833 (bearer auth feature request)
- https://docs.sentry.io/api/auth/

**Two paths:**

- **Path A (default) — official stdio MCP via `npx`.** Full Sentry API surface
  (issues, events, projects, releases, alerts, teams, sessions).
- **Path B (fallback) — direct REST** against `https://<host>/api/0/` with
  `Authorization: Bearer <token>`. No MCP; generic HTTP tool.

**Token types:**
- **User Auth Token** (`<random>`): scoped to your account. Convenient but personal.
- **Org Auth Token** (`sntrys_<random>`): scoped to an organization. Preferred for shared/
  service integrations because it's not tied to a person leaving the org.

**Region:** Sentry Cloud runs at `sentry.io` (default) or `us.sentry.io`/`de.sentry.io`
for region-pinned orgs. Self-hosted uses your own host.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SENTRY_ACCESS_TOKEN` | Auth token (`sntrys_...` for Org tokens; opaque for User tokens) | Sentry → Settings → Auth Tokens |
| `$SENTRY_HOST` *(optional)* | `sentry.io` (default) or region domain or self-hosted domain | Wherever your Sentry org lives |
| `$SENTRY_ORG` | Organization slug | Sentry → Settings → Organization Settings → slug |
| `$SENTRY_PROJECT` *(optional)* | Project slug to narrow smoke test | Any project in the org |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (direct REST) | A requires `npx` on the VPS |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + Path A prereqs

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

if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires npx on the VPS. Install Node.js or pick Path B (WIRE_PATH=B)."; exit 1; }
fi
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci sentry" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SENTRY_ACCESS_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY" -gt 0 ]; then
    echo "Sentry already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "Sentry credentials present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (token sanity + host + live API verification)

```bash
# Token sanity
[ "${#SENTRY_ACCESS_TOKEN}" -ge 30 ] \
  || { echo "ABORT: SENTRY_ACCESS_TOKEN looks too short (<30 chars)."; exit 1; }

# Token type detection
case "$SENTRY_ACCESS_TOKEN" in
  sntrys_*) TOKEN_TYPE="Org Auth Token" ;;
  *) TOKEN_TYPE="User Auth Token" ;;
esac
echo "Token type: $TOKEN_TYPE"

# Host format
HOST=${SENTRY_HOST:-sentry.io}
printf '%s' "$HOST" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$' \
  || { echo "ABORT: SENTRY_HOST must be a hostname (no scheme, no trailing slash)."; exit 1; }

# Org slug format
printf '%s' "$SENTRY_ORG" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$' \
  || { echo "ABORT: SENTRY_ORG must be a lowercase slug (from Settings → Organization Settings)."; exit 1; }

# Live API verify — GET /api/0/organizations/<org>/
HTTP=$(curl -sS -o /tmp/sentry.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $SENTRY_ACCESS_TOKEN" \
  "https://$HOST/api/0/organizations/$SENTRY_ORG/" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    ORG_NAME=$(grep -oE '"name":"[^"]+"' /tmp/sentry.json | head -1 | cut -d'"' -f4)
    echo "Sentry API OK. Organization: $ORG_NAME (slug: $SENTRY_ORG, host: $HOST)"
    ;;
  401|403) echo "ABORT: 401/403 — token rejected or wrong org."; exit 1 ;;
  404) echo "ABORT: 404 — organization slug '$SENTRY_ORG' not found at $HOST."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/sentry.json | head -3; exit 1 ;;
esac
rm -f /tmp/sentry.json

# Warn if project specified but not visible
if [ -n "${SENTRY_PROJECT:-}" ]; then
  PROJ_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $SENTRY_ACCESS_TOKEN" \
    "https://$HOST/api/0/projects/$SENTRY_ORG/$SENTRY_PROJECT/" 2>/dev/null) || PROJ_HTTP=000
  [ "$PROJ_HTTP" = "200" ] || echo "WARN: SENTRY_PROJECT=$SENTRY_PROJECT not visible ($PROJ_HTTP) — check slug or token scope."
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write SENTRY_ACCESS_TOKEN (length ${#SENTRY_ACCESS_TOKEN}, type=$TOKEN_TYPE) via 'hermes config set'
    2. Write SENTRY_HOST ($HOST)
    3. Write SENTRY_ORG ($SENTRY_ORG)
    4. Write SENTRY_PROJECT (${SENTRY_PROJECT:-none}) if supplied
    5. chmod 600 ~/.hermes/.env

  Path A (official stdio MCP):
    6. Register MCP: hermes mcp add sentry --command npx --args -y,@sentry/mcp-server
       --env SENTRY_ACCESS_TOKEN + SENTRY_HOST
    7. Reload gateway: stop + run
    8. Verify in logs: grep "registered.*sentry"

  Path B (direct REST — no MCP):
    6. No MCP registered; generic HTTP tool reads env
    7. Reload gateway: stop + run
    8. Smoke test: GET /api/0/organizations/<org>/issues/ — expect 200

Token is NEVER printed in plaintext beyond a length + type.
Note: hosted mcp.sentry.dev is OAuth-only (bearer support is issue #833) — not wired here.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SENTRY_ACCESS_TOKEN '$SENTRY_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SENTRY_HOST '${SENTRY_HOST:-sentry.io}'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SENTRY_ORG '$SENTRY_ORG'"
if [ -n "${SENTRY_PROJECT:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SENTRY_PROJECT '$SENTRY_PROJECT'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(SENTRY_ACCESS_TOKEN|SENTRY_HOST|SENTRY_ORG|SENTRY_PROJECT)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" -ge 3 ] || { echo "FAIL: env vars did not all land (got $COUNT, need ≥3). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

### Path A — official stdio MCP

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add sentry \
      --command 'npx' \
      --args '-y,@sentry/mcp-server' \
      --env 'SENTRY_ACCESS_TOKEN=\${SENTRY_ACCESS_TOKEN},SENTRY_HOST=\${SENTRY_HOST}'
  "
fi
```

### Path B — direct REST

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  cat <<'EOF'
Path B: no MCP server registered. Generic HTTP tool reads env and uses:
  - Base URL: https://$SENTRY_HOST/api/0/
  - Auth: Authorization: Bearer $SENTRY_ACCESS_TOKEN
  - Content-Type: application/json

Common endpoints:
  - GET  /organizations/{org}/issues/           — list issues
  - GET  /organizations/{org}/issues/{id}/      — get issue
  - PUT  /organizations/{org}/issues/{id}/      — resolve/ignore/assign
  - GET  /organizations/{org}/projects/         — list projects
  - GET  /projects/{org}/{project}/events/      — list events
  - POST /organizations/{org}/releases/         — create release
  - GET  /organizations/{org}/replays/          — session replays
EOF
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
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*sentry|MCP server.*sentry.*(ok|ready)"; then
      REGISTERED=1; echo "OK: sentry MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: sentry not in logs after 30s. Rolling back."; rollback; exit 1; }
fi

# Smoke test (both paths) — list issues from the org
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$SENTRY_ACCESS_TOKEN\" \
    \"https://\$SENTRY_HOST/api/0/organizations/\$SENTRY_ORG/issues/?limit=1\"
")
case "$HTTP" in
  200) echo "OK: Sentry REST reachable from VPS." ;;
  401) echo "FAIL: 401. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove sentry 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SENTRY_ACCESS_TOKEN=/d;
            /^SENTRY_HOST=/d;
            /^SENTRY_ORG=/d;
            /^SENTRY_PROJECT=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at Sentry → Settings → Auth Tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring hosted `mcp.sentry.dev` with a bearer token | Hosted MCP is OAuth-only as of 2026-06 (issue #833 pending) | This skill refuses; uses self-hosted stdio MCP or REST |
| 2 | User Auth Token instead of Org Auth Token for shared use | User token dies when the user leaves the org | Prefer `sntrys_` Org Auth Token; Step 3 detects and logs the type |
| 3 | Missing scopes on the token | API calls return 403 on some resources | Pick specific scopes at mint (project:read, event:read, org:read) |
| 4 | Agent has issue-modify permission | Can resolve/ignore/assign issues — potentially hiding real problems | Restrict to read scopes unless triage automation is intentional |
| 5 | Wrong org slug | 404 from Step 3 | Copy slug exactly from Settings → Organization → slug field |
| 6 | Rate limits (per-token, per-org) | Bursty issue-list polls 429 | Back off; use pagination cursors |
| 7 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Region-pinned org accessed via wrong host | `us.sentry.io` vs `de.sentry.io` mismatch → 404 | Match `SENTRY_HOST` to the region shown in Sentry URL bar |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Self-hosted Sentry missing MCP | The stdio MCP works fine; hosted MCP unavailable for self-hosted | Set SENTRY_HOST to your self-hosted domain; Path A still works |
| 14 | Community MCPs claiming Sentry support | Some third-party MCPs wrap Sentry — vet before trusting | This skill wires only the official `@sentry/mcp-server` package |
| 15 | `sntrys_` prefix leaking scope | The Org token secret embeds scope info; leak = broad access | Rotate immediately on suspected leak; Sentry supports multiple active tokens during rotation |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `npx` present on VPS
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: token ≥30 chars + type detected; host + org slug format valid; live `/api/0/organizations/<org>/` returned 200 with org name
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP `sentry` registered with env indirection
- [ ] Path B: REST surface documented (base + Bearer + common endpoints)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'sentry'` within 30s
- [ ] Smoke test: `/api/0/organizations/<org>/issues/?limit=1` from VPS returned 200
- [ ] User informed of Org Token preference over User Token for shared service integrations
- [ ] Rollback function defined; token revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, region,
and Sentry API scope failure modes.
