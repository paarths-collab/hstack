---
name: integration-auth0
description: Connect Auth0 (identity + access management — users, roles, apps, actions, logs, org management) to a self-hosted Hermes Agent over SSH via the official auth0/auth0-mcp-server stdio MCP with Client Credentials Flow. Path A stdio MCP with M2M app; Path B direct REST via Management API bearer token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-auth0 — connect Auth0 to a remote Hermes (SSH-first)

You are the engineer connecting Auth0 (enterprise identity provider — users, roles, apps,
actions, logs, tenants) to a self-hosted Hermes agent on the user's VPS. You (the AI agent
— Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root
against the VPS. The user does two things a machine cannot:

1. Create a **Machine-to-Machine (M2M) application** in Auth0 Dashboard → Applications →
   Applications → Create → M2M → authorize it for the Auth0 Management API with least-
   privilege scopes.
2. Copy the M2M app's Client ID + Client Secret from the Settings tab.

Everything else — credential storage, live Management API token exchange, MCP registration
via stdio, gateway reload, live user-list smoke test — runs on the VPS via SSH, idempotently
with a rollback path.

**Honest auth picture (verified 2026-06):** Auth0 ships an **official stdio MCP** at
`github.com/auth0/auth0-mcp-server`. Two auth modes:

- **Device authorization (interactive):** logs you into your Auth0 tenant via browser.
  **Not usable for Hermes** — headless.
- **Client Credentials Flow (M2M app, headless):** Auth0 domain + M2M client ID + M2M
  client secret. This is what this skill wires.

Sources:
- https://github.com/auth0/auth0-mcp-server
- https://auth0.com/blog/announcement-auth0-mcp-server-is-here/
- https://auth0.com/docs/api/management/v2

**Two paths:**

- **Path A (default) — official stdio MCP via `npx`.** Full Management API surface (users,
  roles, apps, actions, logs, connections, orgs).
- **Path B (fallback) — direct REST** against `https://<tenant>.auth0.com/api/v2` with a
  bearer token. Same permissions model; no MCP indirection.

**Scope minimalism:** the Auth0 Management API has ~50 scopes. Grant only what the agent
actually needs. `read:users` for a lookup agent. `create:users` + `update:users` for a
provisioning agent. NEVER grant `create:tenants` or `delete:tenants` to an agent.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$AUTH0_DOMAIN` | Tenant domain (`<name>.<region>.auth0.com` or custom domain) | Auth0 Dashboard → Applications → Settings → Domain |
| `$AUTH0_CLIENT_ID` | M2M app Client ID (32-char alphanumeric) | Same M2M app → Settings tab |
| `$AUTH0_CLIENT_SECRET` | M2M app Client Secret | Same page — copy immediately |
| `$AUTH0_MGMT_AUDIENCE` *(optional, auto-derived)* | Usually `https://<AUTH0_DOMAIN>/api/v2/` | Auth0 Dashboard → APIs → Auth0 Management API → Identifier field |
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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci auth0" || echo 0)
HAS_DOMAIN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^AUTH0_DOMAIN=' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_CLIENT=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^AUTH0_CLIENT_ID=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_DOMAIN" = "1" ] && [ "$HAS_CLIENT" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY" -gt 0 ]; then
    echo "Auth0 already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "Auth0 credentials present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (domain + client credentials + live token exchange)

```bash
# Domain format: <sub>.<region>.auth0.com or <custom>
printf '%s' "$AUTH0_DOMAIN" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z0-9.-]+$' \
  || { echo "ABORT: AUTH0_DOMAIN must be a domain (e.g. acme.us.auth0.com or auth.acme.com)."; exit 1; }

# Client ID: 32-char alphanumeric
printf '%s' "$AUTH0_CLIENT_ID" | grep -qE '^[A-Za-z0-9]{20,64}$' \
  || { echo "ABORT: AUTH0_CLIENT_ID must be alphanumeric (20-64 chars typically)."; exit 1; }

# Secret sanity
[ "${#AUTH0_CLIENT_SECRET}" -ge 30 ] \
  || { echo "ABORT: AUTH0_CLIENT_SECRET looks too short (<30 chars). Did you paste the right value?"; exit 1; }

# Derive audience if not supplied
MGMT_AUDIENCE=${AUTH0_MGMT_AUDIENCE:-https://$AUTH0_DOMAIN/api/v2/}

# Live Client Credentials Flow exchange
TOK_RESP=$(curl -sS --max-time 10 \
  -X POST "https://$AUTH0_DOMAIN/oauth/token" \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"$AUTH0_CLIENT_ID\",\"client_secret\":\"$AUTH0_CLIENT_SECRET\",\"audience\":\"$MGMT_AUDIENCE\",\"grant_type\":\"client_credentials\"}" \
  2>/dev/null) || TOK_RESP=""
ACCESS=$(printf '%s' "$TOK_RESP" | grep -oE '"access_token":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$ACCESS" ]; then
  if printf '%s' "$TOK_RESP" | grep -q 'access_denied\|Client is not authorized'; then
    echo "ABORT: M2M app not authorized for the Management API audience."
    echo "Fix: Dashboard → Applications → your M2M app → APIs tab → authorize Auth0 Management API → grant scopes."
  elif printf '%s' "$TOK_RESP" | grep -q 'invalid_client'; then
    echo "ABORT: invalid_client — CLIENT_ID or CLIENT_SECRET is wrong."
  else
    echo "ABORT: token exchange failed. Response:"
    echo "$TOK_RESP" | head -3
  fi
  exit 1
fi
echo "Auth0 M2M OK. Got Management API access token (expires in ~24h, agent must re-mint)."

# List scopes on the token (useful debug info)
SCOPES=$(printf '%s' "$TOK_RESP" | grep -oE '"scope":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$SCOPES" ] && echo "Granted scopes: $SCOPES" || echo "WARN: no explicit scope on token — token may have default access."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write AUTH0_DOMAIN ($AUTH0_DOMAIN)
    2. Write AUTH0_CLIENT_ID ($AUTH0_CLIENT_ID — public)
    3. Write AUTH0_CLIENT_SECRET (length ${#AUTH0_CLIENT_SECRET}) — NEVER plaintext-logged
    4. Write AUTH0_MGMT_AUDIENCE ($MGMT_AUDIENCE)
    5. chmod 600 ~/.hermes/.env

  Path A (official stdio MCP):
    6. Register MCP: hermes mcp add auth0 --command npx --args -y,@auth0/auth0-mcp-server,run
       --env AUTH0_DOMAIN + AUTH0_CLIENT_ID + AUTH0_CLIENT_SECRET
    7. Reload gateway: stop + run
    8. Verify in logs: grep "registered.*auth0"

  Path B (direct REST — no MCP):
    6. No MCP registered; generic HTTP tool re-mints Management token per call
    7. Reload gateway: stop + run
    8. Smoke test: token mint → GET /api/v2/users?per_page=1

Secrets are NEVER printed in plaintext beyond a length.
Granted scopes: ${SCOPES:-(default)}
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set AUTH0_DOMAIN '$AUTH0_DOMAIN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AUTH0_CLIENT_ID '$AUTH0_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AUTH0_CLIENT_SECRET '$AUTH0_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AUTH0_MGMT_AUDIENCE '$MGMT_AUDIENCE'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(AUTH0_DOMAIN|AUTH0_CLIENT_ID|AUTH0_CLIENT_SECRET|AUTH0_MGMT_AUDIENCE)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "4" ] || { echo "FAIL: Auth0 vars did not all land (got $COUNT, need 4). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the client secret in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

### Path A — official stdio MCP

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add auth0 \
      --command 'npx' \
      --args '-y,@auth0/auth0-mcp-server,run' \
      --env 'AUTH0_DOMAIN=\${AUTH0_DOMAIN},AUTH0_CLIENT_ID=\${AUTH0_CLIENT_ID},AUTH0_CLIENT_SECRET=\${AUTH0_CLIENT_SECRET}'
  "
fi
```

### Path B — direct REST

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  cat <<'EOF'
Path B: no MCP server registered. The agent's generic HTTP tool layer must, per call:
  1. POST https://$AUTH0_DOMAIN/oauth/token
     Body: {"client_id":"...","client_secret":"...","audience":"$AUTH0_MGMT_AUDIENCE","grant_type":"client_credentials"}
  2. Extract access_token (JWT, 24h TTL)
  3. Call REST: Authorization: Bearer <access_token>
     Base: https://$AUTH0_DOMAIN/api/v2/
     e.g. GET /users?per_page=10&page=0
  4. Re-mint on 401 (token expired) — NO refresh token in Client Credentials Flow

Common endpoints:
  - GET  /users        — list users
  - GET  /users/{id}   — get user
  - POST /users        — create user
  - PATCH /users/{id}  — update
  - DELETE /users/{id} — delete
  - GET  /roles        — list roles
  - GET  /logs         — tenant logs
  - GET  /clients      — list applications
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
         | grep -qiE "registered.*tool.*auth0|MCP server.*auth0.*(ok|ready)"; then
      REGISTERED=1; echo "OK: auth0 MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: auth0 not in logs after 30s. Rolling back."; rollback; exit 1; }
fi

# Smoke: token mint + GET /users?per_page=1 from VPS
RESULT=$(ssh "$VPS_USER@$VPS_IP" "
  set -e
  . ~/.hermes/.env 2>/dev/null || true
  TOK=\$(curl -sS --max-time 10 -X POST \"https://\$AUTH0_DOMAIN/oauth/token\" \
    -H 'Content-Type: application/json' \
    -d '{\"client_id\":\"'\"\$AUTH0_CLIENT_ID\"'\",\"client_secret\":\"'\"\$AUTH0_CLIENT_SECRET\"'\",\"audience\":\"'\"\$AUTH0_MGMT_AUDIENCE\"'\",\"grant_type\":\"client_credentials\"}' \
    | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')
  [ -z \"\$TOK\" ] && echo NO_TOKEN && exit 0
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$TOK\" \
    \"https://\$AUTH0_DOMAIN/api/v2/users?per_page=1\"
")
case "$RESULT" in
  200) echo "OK: Auth0 Management API reachable from VPS." ;;
  NO_TOKEN) echo "FAIL: token exchange failed on VPS. Rolling back."; rollback; exit 1 ;;
  403) echo "FAIL: 403 — M2M app lacks read:users scope. Add via Dashboard → APIs → Management API → Machine to Machine Applications."; rollback; exit 1 ;;
  *) echo "WARN: unexpected HTTP $RESULT." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove auth0 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^AUTH0_DOMAIN=/d;
            /^AUTH0_CLIENT_ID=/d;
            /^AUTH0_CLIENT_SECRET=/d;
            /^AUTH0_MGMT_AUDIENCE=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Rotate the M2M client secret in Dashboard → Applications → your M2M app → Settings → Rotate."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | M2M app not authorized for Management API | Token mint returns `access_denied` — bot silent | Dashboard → Applications → your M2M app → APIs → authorize Management API + grant scopes |
| 2 | Missing scopes on the M2M authorization | Token mints but API calls return 403 | Grant precise scopes (read:users, etc.); Step 8 detects 403 explicitly |
| 3 | Granting `create:tenants` / `delete:tenants` to an agent | Tenant nuke risk | NEVER grant these to an M2M app; principle of least privilege |
| 4 | Client Credentials returns NO refresh token | Access token expires in ~24h; caching breaks | Tool must re-mint on 401 or every ~23h; document contract |
| 5 | Confusing tenant domain with custom domain | Tokens issued for one domain can't be used against the other | Match `$AUTH0_DOMAIN` to whichever domain your M2M is registered under |
| 6 | Client secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 7 | Not rotating client secret periodically | Long-lived credentials = larger blast radius | Rotate quarterly; auto-mint new via Auth0 API |
| 8 | Rate limits on Management API | Bursty user-provisioning loops hit rate limits (esp. free/dev tenants) | Back off on 429; batch operations |
| 9 | Enterprise vs Bearer confusion | Auth0 uses `Authorization: Bearer <JWT>` — NOT `Basic` and NOT the M2M secret directly | The M2M secret is only used to EXCHANGE for a bearer JWT; never send secret directly on data-plane calls |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Domain and audience contain `/` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Custom domain not verified | Token mint returns error for unverified domains | Confirm domain shows "Verified" in Dashboard → Branding → Custom Domains |
| 15 | Log-out on the wrong tenant | If a person also has device-auth logged in via `auth0-mcp-server session`, agent uses stale creds | Don't mix device auth with M2M creds; wipe `~/.auth0` on the VPS if seen |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `npx` present on VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: domain format valid; client ID + secret shape check passed; live Client Credentials exchange returned an access_token
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 4 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP `auth0` registered with env indirection (AUTH0_DOMAIN + CLIENT_ID + CLIENT_SECRET)
- [ ] Path B: REST + token-exchange contract documented for the generic tool layer
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'auth0'` within 30s
- [ ] Smoke test: token mint + `/users?per_page=1` from VPS returned 200
- [ ] User informed of 24h token TTL + tool-must-remint contract
- [ ] Scope minimalism confirmed (agent grants only what it needs — never `create:tenants`)
- [ ] Rollback function defined; secret-rotation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, M2M
authorization, and Auth0 Management API failure modes.
