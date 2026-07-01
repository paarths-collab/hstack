---
name: integration-wordpress
description: Connect self-hosted WordPress (posts, pages, media, users) to a self-hosted Hermes Agent over SSH using Application Passwords (WP 5.6+) with HTTPS Basic auth. Path A — REST (default). Path B — stdio MCP via mcp-adapter plugin. Refuses WordPress.com hosted MCP (OAuth-only). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-wordpress — connect WordPress to a remote Hermes (SSH-first)

You are the engineer connecting WordPress to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint an Application Password at `<WP_URL>/wp-admin/profile.php` → Application Passwords
   → name it `hermes-agent` → Add New → copy the 24-char secret (shown ONCE).
2. (Path B only) Install and activate the `mcp-adapter` plugin on the target site.

Everything else — credential storage, live auth verify, gateway reload, smoke test — runs
on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):**

- **Self-hosted WordPress core (5.6+)** ships **Application Passwords** — static per-app
  credentials for HTTPS Basic Auth against `/wp-json/wp/v2/*`. Perfect for headless. This
  skill uses this path by default.
- **First-party MCP Adapter plugin** (`WordPress/mcp-adapter`) exposes WordPress as MCP
  tools at `/wp-json/mcp/mcp-adapter-default-server`. Companion `Automattic/mcp-wordpress-
  remote` is a stdio proxy — supports Application Passwords in legacy mode. Path B here.
- **WordPress.com hosted MCP** at `https://public-api.wordpress.com/wpcom/v2/mcp/v1` is
  **OAuth-only (PKCE + dynamic client registration)**. Bearer/headless clients NOT
  supported. This skill refuses to wire it — WordPress.com sites need Path A against the
  WordPress.com REST API with an OAuth token, or a self-hosted install instead.

**HTTPS is mandatory:** Application Passwords refuse plain HTTP (auth silently fails).
Step 3 hard-rejects non-https URLs.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WP_URL` | Full HTTPS origin, no trailing slash (`https://example.com`) | The WordPress site URL |
| `$WP_USERNAME` | WordPress account to act as (Editor or Administrator role) | wp-admin → Users |
| `$WP_APP_PASSWORD` | 24-char Application Password (shown ONCE) | `<WP_URL>/wp-admin/profile.php` → Application Passwords → Add New |
| `$WIRE_PATH` *(optional)* | `A` (REST, default) or `B` (stdio MCP + mcp-adapter plugin) | B requires npx on VPS + plugin installed |

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
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(WP_URL|WP_USERNAME|WP_APP_PASSWORD)=' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci wordpress" || echo 0)
if [ "$COUNT" = "3" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    echo "WordPress credentials already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ] && [ "$ALREADY_MCP" -gt 0 ]; then
    echo "WordPress MCP already wired (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (HTTPS + refuse .com hosted + live auth probe + Path B prereqs)

```bash
# HTTPS mandatory
printf '%s' "$WP_URL" | grep -qE '^https://[^[:space:]]+[^/]$' \
  || { echo "ABORT: WP_URL must be 'https://<host>' (HTTPS, no trailing slash). Application Passwords refuse HTTP."; exit 1; }

# Refuse WordPress.com hosted (OAuth-only)
case "$WP_URL" in
  *wordpress.com*|*wp.com*)
    echo "WARN: WP_URL looks like WordPress.com hosted. The .com hosted MCP is OAuth-only (headless not supported)."
    echo "      This skill will attempt Path A REST — some endpoints may require an OAuth token instead."
    ;;
esac

# Username + password sanity
[ -n "$WP_USERNAME" ] && [ -n "$WP_APP_PASSWORD" ] \
  || { echo "ABORT: WP_USERNAME and WP_APP_PASSWORD required."; exit 1; }
# App passwords are 24 alphanumeric chars, optionally displayed with spaces every 4 chars
NORMALIZED=$(printf '%s' "$WP_APP_PASSWORD" | tr -d ' ')
[ "${#NORMALIZED}" = "24" ] \
  || { echo "ABORT: WP_APP_PASSWORD should be 24 chars (spaces optional). Got ${#NORMALIZED}."; exit 1; }

# Live auth probe via /users/me
AUTH=$(printf '%s:%s' "$WP_USERNAME" "$WP_APP_PASSWORD" | base64 -w0 2>/dev/null || \
       printf '%s:%s' "$WP_USERNAME" "$WP_APP_PASSWORD" | base64)
HTTP=$(curl -sS -o /tmp/wp.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Basic $AUTH" \
  "$WP_URL/wp-json/wp/v2/users/me" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    ROLE=$(grep -oE '"roles":\[[^]]*\]' /tmp/wp.json | head -1)
    echo "WordPress auth OK. Roles: $ROLE"
    if ! echo "$ROLE" | grep -qE 'administrator|editor'; then
      echo "WARN: user role is neither administrator nor editor. Writes may 401/403."
    fi ;;
  401) echo "ABORT: 401 — wrong username or Application Password."; exit 1 ;;
  403) echo "ABORT: 403 — user role too low OR 2FA plugin blocking REST."; exit 1 ;;
  404) echo "ABORT: 404 — pretty permalinks off, REST disabled, or security plugin blocking /wp-json/."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/wp.json | head -3; exit 1 ;;
esac
rm -f /tmp/wp.json

# Path B: require npx + verify mcp-adapter plugin
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path B requires npx on the VPS."; exit 1; }

  # Check plugin endpoint
  MCP_HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
    "$WP_URL/wp-json/mcp/mcp-adapter-default-server" 2>/dev/null) || MCP_HTTP=000
  [ "$MCP_HTTP" != "404" ] \
    || { echo "ABORT: mcp-adapter plugin not installed/active at $WP_URL. Install the WordPress/mcp-adapter plugin first."; exit 1; }
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
    1. Write WP_URL ($WP_URL)
    2. Write WP_USERNAME ($WP_USERNAME)
    3. Write WP_APP_PASSWORD (length ${#WP_APP_PASSWORD}) — NEVER plaintext-logged
    4. chmod 600 ~/.hermes/.env
    5. Verify all 3 landed (grep -c)

  Path A (REST — default):
    6. No MCP registered; generic HTTP tool reads env, uses HTTP Basic
    7. Reload gateway: stop + run
    8. Smoke test: GET /wp-json/wp/v2/users/me — expect 200

  Path B (stdio MCP via mcp-adapter):
    6. Register MCP: hermes mcp add wordpress --command npx --args -y,@automattic/mcp-wordpress-remote
       with WP_API_URL + WP_API_USERNAME + WP_API_PASSWORD env vars
    7. Reload gateway: stop + run
    8. Verify in logs: grep "registered.*wordpress"

HTTPS is mandatory. App password never plaintext-logged.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set WP_URL '$WP_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set WP_USERNAME '$WP_USERNAME'"
ssh "$VPS_USER@$VPS_IP" "hermes config set WP_APP_PASSWORD '$WP_APP_PASSWORD'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(WP_URL|WP_USERNAME|WP_APP_PASSWORD)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "3" ] || { echo "FAIL: env vars did not land (got $COUNT, need 3). Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter — app passwords contain spaces):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'WP_URL=$WP_URL' 'WP_USERNAME=$WP_USERNAME' 'WP_APP_PASSWORD=$WP_APP_PASSWORD'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the app password in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A (REST — default)

Generic HTTP tool layer reads env and calls:
- **Base URL:** `${WP_URL}/wp-json/wp/v2`
- **Auth:** `Authorization: Basic <base64("${WP_USERNAME}:${WP_APP_PASSWORD}")>`
- **Content-Type:** `application/json` (multipart for media uploads)

Common endpoints:
- `GET /wp-json/wp/v2/posts` — list/search
- `POST /wp-json/wp/v2/posts` — create draft
- `GET /wp-json/wp/v2/posts/{id}` — read
- `POST /wp-json/wp/v2/posts/{id}` — update
- `DELETE /wp-json/wp/v2/posts/{id}` — trash (add `?force=true` to hard-delete)
- `GET /wp-json/wp/v2/pages`, `POST /wp-json/wp/v2/pages`
- `POST /wp-json/wp/v2/media` — upload (multipart, `Content-Disposition: attachment; filename="..."`)
- `GET /wp-json/wp/v2/users/me` — auth probe

Reference: https://developer.wordpress.org/rest-api/reference/

### Path B (stdio MCP via mcp-adapter plugin)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add wordpress \
      --command 'npx' \
      --args '-y,@automattic/mcp-wordpress-remote' \
      --env 'WP_API_URL=$WP_URL/wp-json/mcp/mcp-adapter-default-server,WP_API_USERNAME=\${WP_USERNAME},WP_API_PASSWORD=\${WP_APP_PASSWORD}'
  "
  echo "Path B: uses proxy's legacy Application Passwords mode (headless-compatible)."
  echo "The proxy's default OAuth 2.1 mode requires a browser and is NOT what we want."
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

## Step 8 — verify

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*wordpress|MCP server.*wordpress|wordpress-remote"; then
      REGISTERED=1; echo "OK: wordpress MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: wordpress not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test for both paths
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  AUTH=\$(printf '%s:%s' \"\$WP_USERNAME\" \"\$WP_APP_PASSWORD\" | base64 -w0)
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Basic \$AUTH\" \
    \"\$WP_URL/wp-json/wp/v2/users/me\"
")
case "$HTTP" in
  200) echo "OK: WordPress REST reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove wordpress 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^WP_URL=/d;
            /^WP_USERNAME=/d;
            /^WP_APP_PASSWORD=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the Application Password at <WP_URL>/wp-admin/profile.php if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trying WordPress.com hosted MCP with bearer | OAuth 2.1 / PKCE / dynamic client registration only | This skill uses REST + Application Password (self-hosted) or warns on .com |
| 2 | HTTP instead of HTTPS | Application Passwords refuse HTTP; silent auth failure | Step 3 hard-rejects non-https |
| 3 | Wrong user role | Subscriber/Contributor 401/403 on writes | Use Editor or Administrator; Step 3 warns if role is neither |
| 4 | Pretty permalinks disabled | `/wp-json/...` 404s when permalinks are Plain | wp-admin → Settings → Permalinks → anything other than Plain, Save |
| 5 | Security plugin (Wordfence, iThemes) blocking REST or stripping `Authorization` | 401/403/404 despite valid creds | Allowlist `/wp-json/*`; verify Authorization header passes through host |
| 6 | 2FA plugin blocking REST writes | App password bypasses 2FA login but not all 2FA plugins' REST checks | Test with Step 3 probe; check 2FA plugin's REST settings |
| 7 | App password copied with mangled spaces | Password is 24 chars; spaces cosmetic | Step 3 strips spaces to check length; either form authenticates |
| 8 | Path B without mcp-adapter plugin | `/wp-json/mcp/...` 404s | Step 3 pre-checks plugin endpoint; aborts if missing |
| 9 | Path B proxy defaulting to OAuth 2.1 | Requires browser — breaks headless | Explicit legacy mode via `WP_API_URL` + username/password env |
| 10 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 11 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 12 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 13 | sed with `/` delimiter | URL contains `/`; app password contains spaces | Always `\|` delimiter |
| 14 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: URL is HTTPS (no trailing slash); WordPress.com warned; app password is 24 chars; live `/users/me` returned 200; role admin/editor (or warning); Path B → npx present + mcp-adapter plugin endpoint returns non-404
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: no MCP registered; generic HTTP tool documented
- [ ] Path B: MCP registered with mcp-adapter endpoint + legacy Application Passwords mode
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/wp-json/wp/v2/users/me` from inside container returned 200
- [ ] Path B: logs show `registered N tool(s)` within 30s
- [ ] Rollback function defined; app-password revocation URL included
- [ ] User informed of HTTPS requirement + role requirement + WordPress.com limitation

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, HTTPS,
REST-blocking-plugin, and Application-Passwords failure modes.
