---
name: integration-zendesk
description: Connect Zendesk (tickets, users, organizations, macros) to a self-hosted Hermes Agent over SSH using a static API token + email Basic auth. No first-party MCP yet (EAP summer 2026) — uses REST API directly. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-zendesk — connect Zendesk to a remote Hermes (SSH-first)

You are the engineer connecting Zendesk to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint the API token in Admin Center (Apps and integrations → APIs → Zendesk API → Settings
   → Token access ON → Add API token).
2. Confirm the subdomain (the `acme` in `https://acme.zendesk.com`, NOT a vanity domain).

Everything else — credential storage, live API auth check, gateway reload, smoke test —
runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Zendesk does **NOT** ship a first-party remote
MCP server with bearer-token auth. Their MCP Client (EAP) is for calling external MCPs from
inside Zendesk; the MCP Server is announced for EAP **summer 2026** — not GA, no documented
endpoint, no headless auth shape yet. So we wire the REST API directly with a static API
token. Auth is **Basic** (NOT Bearer): `Authorization: Basic <base64 of "email/token:token">`.
The literal `/token` suffix on the email is **mandatory** — it tells Zendesk to treat the
password slot as an API token instead of an account password. The #1 silent-failure mode is
sending Bearer instead of Basic, or omitting the `/token` suffix.

When Zendesk's MCP Server exits EAP, swap this skill's wiring step for `/hermes-mcp-add`
against the documented endpoint.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ZENDESK_SUBDOMAIN` | The `<sub>` in `https://<sub>.zendesk.com` (NOT vanity domain) | Open the help center URL; use the original `*.zendesk.com` host |
| `$ZENDESK_EMAIL` | Admin email that owns the API token | Whichever account had admin role when minting the token |
| `$ZENDESK_API_TOKEN` | API token (shown once on creation) | Admin Center → Apps and integrations → APIs → Zendesk API → Settings → Token access ON → Add API token |

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
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(ZENDESK_SUBDOMAIN|ZENDESK_EMAIL|ZENDESK_API_TOKEN)=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$COUNT" = "3" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Zendesk already wired (all 3 vars present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (subdomain + email + token + live auth check)

```bash
# Subdomain: alphanumeric + hyphens, 1-63 chars
printf '%s' "$ZENDESK_SUBDOMAIN" | grep -qE '^[A-Za-z0-9-]{1,63}$' \
  || { echo "ABORT: ZENDESK_SUBDOMAIN must be alphanumeric+hyphens (the prefix in *.zendesk.com — NOT a vanity domain)."; exit 1; }

# Email shape
printf '%s' "$ZENDESK_EMAIL" | grep -qE '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
  || { echo "ABORT: ZENDESK_EMAIL must be a valid email address."; exit 1; }

# Token sanity
[ "${#ZENDESK_API_TOKEN}" -ge 20 ] \
  || { echo "ABORT: ZENDESK_API_TOKEN looks too short (<20 chars). Did you paste the right value?"; exit 1; }

# Live API verify (proves subdomain + email + token + /token suffix + Basic auth all correct)
CRED=$(printf '%s/token:%s' "$ZENDESK_EMAIL" "$ZENDESK_API_TOKEN" | base64 -w0 2>/dev/null || \
       printf '%s/token:%s' "$ZENDESK_EMAIL" "$ZENDESK_API_TOKEN" | base64)
HTTP=$(curl -sS -o /tmp/zd_me.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Basic $CRED" \
  -H 'Content-Type: application/json' \
  "https://$ZENDESK_SUBDOMAIN.zendesk.com/api/v2/users/me.json" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    USER_NAME=$(grep -oE '"name":"[^"]+"' /tmp/zd_me.json | head -1 | cut -d'"' -f4)
    ROLE=$(grep -oE '"role":"[^"]+"' /tmp/zd_me.json | head -1 | cut -d'"' -f4)
    echo "Zendesk auth OK. User: $USER_NAME (role: $ROLE)"
    if [ "$ROLE" != "admin" ]; then
      echo "WARN: token owner role is '$ROLE', not 'admin'. Some write endpoints may 403."
    fi ;;
  401) echo "ABORT: 401 from Zendesk. Common causes: wrong token, /token suffix missing, Token access disabled in Admin Center."; exit 1 ;;
  404) echo "ABORT: 404 from Zendesk. Subdomain '$ZENDESK_SUBDOMAIN' probably wrong."; exit 1 ;;
  000) echo "ABORT: could not reach Zendesk (network/DNS)."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP from /users/me.json."; cat /tmp/zd_me.json | head -3; exit 1 ;;
esac
rm -f /tmp/zd_me.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write ZENDESK_SUBDOMAIN ($ZENDESK_SUBDOMAIN) via 'hermes config set'
  2. Write ZENDESK_EMAIL ($ZENDESK_EMAIL)
  3. Write ZENDESK_API_TOKEN (length ${#ZENDESK_API_TOKEN}) — never plaintext-logged
  4. chmod 600 ~/.hermes/.env
  5. Verify all 3 landed (grep -c)
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Smoke test: GET /api/v2/users/me.json from inside container — expect 200
  8. Smoke test: GET /api/v2/search.json?query=type:ticket+status:open — expect 200

Auth model: Basic <base64 of "$ZENDESK_EMAIL/token:<TOKEN>">
NOT Bearer. The literal /token suffix is mandatory.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_SUBDOMAIN '$ZENDESK_SUBDOMAIN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_EMAIL '$ZENDESK_EMAIL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_API_TOKEN '$ZENDESK_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(ZENDESK_SUBDOMAIN|ZENDESK_EMAIL|ZENDESK_API_TOKEN)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "3" ] || { echo "FAIL: Zendesk vars did not all land (got $COUNT, need 3). Rolling back."; rollback; exit 1; }
echo "Zendesk credentials confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter — emails contain `@`, tokens may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'ZENDESK_SUBDOMAIN=$ZENDESK_SUBDOMAIN' 'ZENDESK_EMAIL=$ZENDESK_EMAIL' 'ZENDESK_API_TOKEN=$ZENDESK_API_TOKEN'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the REST surface (no MCP server to register)

Since no first-party MCP exists, there's no `hermes mcp add` call. The agent's generic HTTP
tool layer reads the 3 env vars and builds the Basic header per request.

REST parameters documented for the generic tool layer:
- **Base URL:** `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`
- **Auth header:** `Authorization: Basic <base64("${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}")>`
- **Content type:** `Content-Type: application/json`

Common endpoints:
- `GET /tickets/{id}.json` — fetch a ticket
- `GET /tickets/{id}/comments.json` — full conversation
- `PUT /tickets/{id}.json` — update status, assignee, tags, add a comment
- `POST /tickets.json` — create a ticket
- `GET /search.json?query=type:ticket+status:open` — search
- `GET /users/me.json` — auth check (cheap)
- `GET /users/search.json?query=...` — find a user

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (from inside the container)

```bash
ME_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  CRED=\$(printf '%s/token:%s' \"\$ZENDESK_EMAIL\" \"\$ZENDESK_API_TOKEN\" | base64 -w0)
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Basic \$CRED\" \
    \"https://\$ZENDESK_SUBDOMAIN.zendesk.com/api/v2/users/me.json\"
")
case "$ME_HTTP" in
  200) echo "OK: /users/me.json reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS-side auth. Re-check Step 5 + Step 7."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $ME_HTTP." ;;
esac

SEARCH_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  CRED=\$(printf '%s/token:%s' \"\$ZENDESK_EMAIL\" \"\$ZENDESK_API_TOKEN\" | base64 -w0)
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Basic \$CRED\" \
    \"https://\$ZENDESK_SUBDOMAIN.zendesk.com/api/v2/search.json?query=type:ticket+status:open\"
")
case "$SEARCH_HTTP" in
  200) echo "OK: /search.json reachable." ;;
  *)   echo "WARN: search returned $SEARCH_HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^ZENDESK_SUBDOMAIN=/d;
            /^ZENDESK_EMAIL=/d;
            /^ZENDESK_API_TOKEN=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Zendesk unwired. Revoke the API token at Admin Center → APIs → Zendesk API → Settings if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer ...` | Zendesk treats Bearer as OAuth access token, not API token | Always `Basic <base64>` for API tokens; Bearer only for OAuth |
| 2 | Forgetting the `/token` suffix on the email | Zendesk treats the password slot as account password → 401 | Credential string MUST be `<email>/token:<api_token>` (literal `/token`) |
| 3 | Trying to wire a Zendesk first-party MCP today | MCP Server announced for EAP summer 2026 — not GA, no endpoint | Use REST until Zendesk publishes the endpoint + auth shape |
| 4 | Token access disabled in Admin Center | Token exists but every call 401s | Admin Center → APIs → Zendesk API → Settings → Token access ON |
| 5 | Vanity subdomain (`help.acme.com`) instead of `*.zendesk.com` | API host is the original `*.zendesk.com`, not the host-mapped vanity | Step 3 validator rejects anything not matching `[A-Za-z0-9-]{1,63}` |
| 6 | Token owner role too low | Non-admin tokens read but 403 on writes | Mint under an admin account; Step 3 warns if role != admin |
| 7 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Rate limits | Per-account per-minute throttle; 429 with `Retry-After` | Back off on 429; batch reads via `/search.json` + sideloads |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Email contains `@.`, tokens may contain `/+=` | Always `\|` delimiter |
| 12 | Confusing email/token Basic with OAuth-only third-party MCPs | They are different auth models | This skill is REST + email/token Basic only |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if all 3 vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: subdomain matches `[A-Za-z0-9-]{1,63}`; email is email-shaped; token ≥20 chars; live `/users/me.json` returned 200; admin role (or warning printed)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3 vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/users/me.json` from inside container returned 200
- [ ] Smoke test: `/search.json` returned 200
- [ ] Generic HTTP tool layer documented (base URL + Basic auth + `/token` suffix)
- [ ] Rollback function defined; token revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Basic-vs-
Bearer, and `/token` suffix failure modes.
