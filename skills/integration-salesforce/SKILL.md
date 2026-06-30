---
name: integration-salesforce
description: Connect Salesforce (enterprise CRM) to a self-hosted Hermes Agent over SSH. Wires the Salesforce REST API via OAuth 2.0 JWT Bearer flow (preferred) or refresh-token flow (fallback). No durable static-token MCP exists, so this skill prefers the REST path. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-salesforce — connect Salesforce to a remote Hermes (SSH-first)

You are the engineer connecting Salesforce to a self-hosted Hermes agent on the user's
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work
over SSH as root against the VPS. The user only does the things a machine cannot:

1. Create the Connected App (or External Client App) in Salesforce Setup as an admin.
2. Upload the x509 certificate, grant access via profile, and (for JWT) pre-authorize
   the integration user.
3. Approve the first OAuth consent if the refresh-token fallback is used.

Everything else — keypair generation, secret storage, MCP/REST registration, gateway
reload, verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Salesforce has no durable, official MCP
that accepts a static bearer token. Their hosted **Agentforce MCP** at
`api.salesforce.com/platform/mcp/v1/...` is **OAuth 2.0 + PKCE only** — bearer tokens
are rejected and a headless container cannot complete the interactive browser consent
without an out-of-band refresh token. Community stdio MCPs (e.g. `@salesforce/mcp` via
the Salesforce CLI) exist but vary in quality, depend on a logged-in `sf` CLI, and do
not fit a remote-HTTP wiring. The honest, headless-friendly path is the **Salesforce
REST API** with an OAuth flow that does not require a browser:

- **Preferred — JWT Bearer Token Flow.** Connected App + signed JWT exchanged for an
  access token. No user interaction after initial setup. Fully unattended.
- **Fallback — Refresh Token Flow.** One-time browser consent out-of-band, then a
  long-lived refresh token stored on the VPS and exchanged for access tokens.

The legacy Username-Password OAuth flow still works on older orgs but Salesforce has
deprecated it for new Connected Apps; do not recommend it.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` (production) or `https://test.salesforce.com` (sandbox) | User's org type |
| `$SALESFORCE_INSTANCE_URL` | My Domain URL, e.g. `https://acme.my.salesforce.com` | Setup -> My Domain |
| `$SALESFORCE_USERNAME` | Integration user's username (looks like an email) | Setup -> Users; create a dedicated integration user if possible |
| `$SALESFORCE_CONSUMER_KEY` | Connected App client_id | Setup -> App Manager -> New Connected App -> Enable OAuth -> save -> Manage Consumer Details |
| `$SALESFORCE_PRIVATE_KEY_PATH` | Absolute path to PEM private key file on the VPS (JWT flow) | Generated on the VPS in Step 0 |
| `$SALESFORCE_REFRESH_TOKEN` | Long-lived refresh token (fallback flow only) | Out-of-band web OAuth dance the user runs once |
| API version | e.g. `v60.0` or `v62.0` | Pin a recent stable version; this skill defaults to `v60.0` |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

Sanity-check the login URL matches the org type (catches sandbox/prod paste swaps
before they hit Setup):

```bash
case "$SALESFORCE_LOGIN_URL" in
  https://login.salesforce.com)  echo "OK: production login endpoint." ;;
  https://test.salesforce.com)   echo "OK: sandbox/scratch login endpoint." ;;
  *) echo "ABORT: SALESFORCE_LOGIN_URL must be https://login.salesforce.com or https://test.salesforce.com"; exit 1 ;;
esac
```

---

## Step 0 — generate the JWT keypair on the VPS (preferred flow only)

`openssl` is required on the VPS for both keypair generation and the JWT signing in
the smoke test. Install it if missing, then mint a 2048-bit RSA keypair and a
self-signed x509 cert (Salesforce only needs the public cert).

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  command -v openssl >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq openssl;
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q openssl;
    elif command -v apk >/dev/null 2>&1; then apk add --no-cache openssl;
    else echo "FAIL: install openssl manually on the VPS"; exit 1; fi
  }
  mkdir -p /opt/data/salesforce && chmod 700 /opt/data/salesforce
  if [ ! -f /opt/data/salesforce/server.key ]; then
    openssl req -x509 -nodes -newkey rsa:2048 \
      -keyout /opt/data/salesforce/server.key \
      -out    /opt/data/salesforce/server.crt \
      -days 3650 \
      -subj "/CN=hermes-salesforce-integration"
    chmod 600 /opt/data/salesforce/server.key
    chmod 644 /opt/data/salesforce/server.crt
  fi
  echo "--- copy this cert into the Connected App (Use Digital Signatures) ---"
  cat /opt/data/salesforce/server.crt
'
```

The user uploads `server.crt` to the Connected App: Setup -> App Manager -> (your
app) -> Edit -> Enable OAuth Settings -> **Use Digital Signatures** -> Choose File.
The private key `server.key` stays on the VPS and is referenced as
`SALESFORCE_PRIVATE_KEY_PATH=/opt/data/salesforce/server.key`.

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci salesforce" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Salesforce is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write SALESFORCE_LOGIN_URL, SALESFORCE_INSTANCE_URL, SALESFORCE_USERNAME,
     SALESFORCE_CONSUMER_KEY, SALESFORCE_PRIVATE_KEY_PATH via 'hermes config set'
     (and SALESFORCE_REFRESH_TOKEN if using the fallback flow)
  2. chmod 600 ~/.hermes/.env and chmod 600 \$SALESFORCE_PRIVATE_KEY_PATH
  3. Register REST endpoint as a Hermes tool against \$SALESFORCE_INSTANCE_URL/services/data/v60.0/
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*salesforce"
  6. Smoke test: mint a token (JWT or refresh) then
     GET \$SALESFORCE_INSTANCE_URL/services/data/v60.0/sobjects/Account/describe -> expect 200

Flow: ${SALESFORCE_FLOW:-jwt}    Org: ${SALESFORCE_LOGIN_URL}
Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_LOGIN_URL '$SALESFORCE_LOGIN_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_INSTANCE_URL '$SALESFORCE_INSTANCE_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_USERNAME '$SALESFORCE_USERNAME'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_CONSUMER_KEY '$SALESFORCE_CONSUMER_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_PRIVATE_KEY_PATH '${SALESFORCE_PRIVATE_KEY_PATH:-/opt/data/salesforce/server.key}'"
if [ -n "${SALESFORCE_REFRESH_TOKEN:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SALESFORCE_REFRESH_TOKEN '$SALESFORCE_REFRESH_TOKEN'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns counts, NEVER the values):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^SALESFORCE_(LOGIN_URL|INSTANCE_URL|USERNAME|CONSUMER_KEY|PRIVATE_KEY_PATH)=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "5" ] || { echo "FAIL: Salesforce secrets not all written ($WROTE/5). Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, fall back to the safe sed
> pattern. Salesforce consumer keys contain `.` and JWT-flow PEM paths contain `/`;
> always use the pipe delimiter:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in SALESFORCE_LOGIN_URL=\$SALESFORCE_LOGIN_URL SALESFORCE_INSTANCE_URL=\$SALESFORCE_INSTANCE_URL SALESFORCE_USERNAME=\$SALESFORCE_USERNAME SALESFORCE_CONSUMER_KEY=\$SALESFORCE_CONSUMER_KEY SALESFORCE_PRIVATE_KEY_PATH=\$SALESFORCE_PRIVATE_KEY_PATH; do
>     K=\${KV%%=*}; V=\${KV#*=}
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s=\n' \"\$K\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$K=\$V|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Salesforce REST endpoint

No first-party static-token MCP exists, so we wire a generic HTTP/REST tool against
the Salesforce REST API. The token used at runtime is minted on each call (or cached
briefly) from the JWT or refresh-token flow — never stored as a static bearer.

### Path A (preferred) — JWT Bearer Token Flow against the REST API

The Hermes REST tool calls `$SALESFORCE_INSTANCE_URL/services/data/v60.0/` with a
freshly-minted access token. The token comes from
`POST $SALESFORCE_LOGIN_URL/services/oauth2/token` with
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion=<signed JWT>`.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add salesforce \
    --url '\${SALESFORCE_INSTANCE_URL}/services/data/v60.0' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --token-endpoint '\${SALESFORCE_LOGIN_URL}/services/oauth2/token' \
    --token-grant 'jwt-bearer' \
    --token-issuer '\${SALESFORCE_CONSUMER_KEY}' \
    --token-subject '\${SALESFORCE_USERNAME}' \
    --token-private-key-path '\${SALESFORCE_PRIVATE_KEY_PATH}'
"
```

The exact flag names vary by Hermes version. If unsure, run `hermes mcp add --help`
first and match its OAuth/JWT syntax. The placeholder-token + sed-inject pattern from
`/hermes-mcp-add` does NOT apply here — there is no static bearer to inject.

### Path B (fallback) — Refresh Token Flow against the REST API

If JWT cannot be set up (e.g. user cannot upload a cert or "Use Digital Signatures"
is blocked by org policy), use a long-lived refresh token obtained out of band.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add salesforce \
    --url '\${SALESFORCE_INSTANCE_URL}/services/data/v60.0' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --token-endpoint '\${SALESFORCE_LOGIN_URL}/services/oauth2/token' \
    --token-grant 'refresh_token' \
    --token-client-id '\${SALESFORCE_CONSUMER_KEY}' \
    --token-refresh-token '\${SALESFORCE_REFRESH_TOKEN}'
"
```

The refresh token is the credential to protect. Treat it like a password: rotate by
revoking the session in Setup -> Session Management.

Do NOT try to register `https://api.salesforce.com/platform/mcp/v1/<server>` with a
bearer token — that endpoint is **OAuth 2.0 + PKCE only** and rejects static
credentials. A headless container cannot complete the PKCE browser handshake.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*salesforce|MCP server.*salesforce.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: salesforce registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: salesforce not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so secrets stay on the VPS)

Mint a token end-to-end and hit a side-effect-free describe call. This exercises
keypair, Connected App, profile grant, network egress, and REST scope at once.

### Path A — JWT Bearer flow smoke test

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -e
  . ~/.hermes/.env
  HEADER=$(printf "%s" "{\"alg\":\"RS256\"}" | openssl base64 -A | tr "+/" "-_" | tr -d "=")
  NOW=$(date +%s); EXP=$((NOW + 180))
  CLAIM=$(printf "{\"iss\":\"%s\",\"sub\":\"%s\",\"aud\":\"%s\",\"exp\":%d}" \
    "$SALESFORCE_CONSUMER_KEY" "$SALESFORCE_USERNAME" "$SALESFORCE_LOGIN_URL" "$EXP" \
    | openssl base64 -A | tr "+/" "-_" | tr -d "=")
  SIG=$(printf "%s.%s" "$HEADER" "$CLAIM" \
    | openssl dgst -sha256 -sign "$SALESFORCE_PRIVATE_KEY_PATH" \
    | openssl base64 -A | tr "+/" "-_" | tr -d "=")
  JWT="$HEADER.$CLAIM.$SIG"
  TOK=$(curl -sS -X POST "$SALESFORCE_LOGIN_URL/services/oauth2/token" \
    -d grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
    -d assertion="$JWT" \
    | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
  [ -n "$TOK" ] || { echo "TOKEN_MINT_FAIL"; exit 1; }
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOK" \
    "$SALESFORCE_INSTANCE_URL/services/data/v60.0/sobjects/Account/describe"
')
case "$HTTP" in
  200) echo "OK: Salesforce REST reachable, JWT flow works, Account describe returned." ;;
  400) echo "FAIL: JWT assertion rejected. Check cert upload, consumer key, username match."; rollback; exit 1 ;;
  401) echo "FAIL: token invalid or user not pre-authorized via profile. Check Connected App policies."; rollback; exit 1 ;;
  403) echo "FAIL: user lacks API Enabled / Account read perms. Fix the integration user profile."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Salesforce REST. Check manually." ;;
esac
```

### Path B — Refresh Token flow smoke test

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -e
  . ~/.hermes/.env
  TOK=$(curl -sS -X POST "$SALESFORCE_LOGIN_URL/services/oauth2/token" \
    -d grant_type=refresh_token \
    -d client_id="$SALESFORCE_CONSUMER_KEY" \
    -d refresh_token="$SALESFORCE_REFRESH_TOKEN" \
    | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
  [ -n "$TOK" ] || { echo "TOKEN_MINT_FAIL"; exit 1; }
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOK" \
    "$SALESFORCE_INSTANCE_URL/services/data/v60.0/sobjects/Account/describe"
')
case "$HTTP" in
  200) echo "OK: Salesforce REST reachable, refresh-token flow works." ;;
  400|401) echo "FAIL: refresh token rejected (revoked, expired, or wrong org). Re-mint out of band."; rollback; exit 1 ;;
  403) echo "FAIL: user lacks API Enabled / Account read perms."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Salesforce REST. Check manually." ;;
esac
```

A `200` from `/sobjects/Account/describe` is a hard pass — the call requires a valid
session and at least read access to the Account object. There is no "empty success"
ambiguity the way there is with list endpoints.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove salesforce 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    for K in SALESFORCE_LOGIN_URL SALESFORCE_INSTANCE_URL SALESFORCE_USERNAME SALESFORCE_CONSUMER_KEY SALESFORCE_PRIVATE_KEY_PATH SALESFORCE_REFRESH_TOKEN; do
      hermes config unset \"\$K\" 2>/dev/null || sed -i \"/^\$K=/d\" ~/.hermes/.env
    done
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Salesforce is no longer wired. Private key at /opt/data/salesforce/server.key is preserved; delete manually if rotating."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `api.salesforce.com/platform/mcp/v1/...` with a bearer token | Hosted Agentforce MCP is **OAuth 2.0 + PKCE only**; static tokens are rejected and a headless container cannot complete the browser handshake | Use the REST API path (Path A JWT or Path B refresh token) |
| 2 | Production vs sandbox login URL swap | Sandbox/scratch orgs require `https://test.salesforce.com`; production requires `https://login.salesforce.com`. Wrong choice returns `invalid_grant` | Sanity-check `SALESFORCE_LOGIN_URL` in Step 0; sandbox orgs also have separate Connected Apps |
| 3 | Classic Connected App used where ECA is required | Newer Salesforce features (e.g. hosted MCP) require an **External Client App**; classic Connected Apps authenticate but the MCP server rejects them | This skill targets REST, where classic Connected Apps still work; if a future MCP wire-up is added, switch to ECA |
| 4 | "Use Digital Signatures" not enabled in Connected App | JWT Bearer flow silently fails with `invalid_grant` because the cert was never bound | Confirm in Setup -> App Manager -> Edit -> Enable OAuth Settings -> **Use Digital Signatures** is ON and `server.crt` is uploaded |
| 5 | Integration user not pre-authorized for the Connected App | JWT flow requires the user to be allowed via profile/permission set; otherwise `user hasn't approved this consumer` | Setup -> App Manager -> Manage -> Edit Policies -> "Admin approved users are pre-authorized"; then assign profile or permission set |
| 6 | MyDomain required for OAuth | Newer Salesforce orgs require My Domain for OAuth; using a raw `login.salesforce.com` redirect can fail | Confirm Setup -> My Domain is deployed; use the My Domain host for `SALESFORCE_INSTANCE_URL` |
| 7 | Connected App IP allowlist set to "Enforce IP relaxation" | The VPS's egress IP isn't in the trusted IP ranges; flow returns `invalid_grant` from outside the office | Set Connected App OAuth policy to "Relax IP restrictions" for the integration user, or add the VPS egress IP to Trusted IP Ranges |
| 8 | API version drift | Hardcoding `v60.0` (or `v62.0`) in tools today; Salesforce retires versions ~3 years later. Endpoints can change shape per version | Pin the version in `~/.hermes/.env` (e.g. `SALESFORCE_API_VERSION=v60.0`) and audit annually; `GET /services/data/` (no auth) lists all live versions |
| 9 | API governor limits | Daily REST API call quotas vary by edition; a chatty agent burns through them and 503/429s the whole org | Use SOQL with selective WHERE clauses; batch via `/composite` endpoints; monitor `Sforce-Limit-Info` response header |
| 10 | Soft-deleted records hidden by default | `SELECT` queries exclude records in the Recycle Bin; agent reports "deleted" when records are recoverable | Use `queryAll` instead of `query` to include soft-deleted rows; warn before issuing hard deletes |
| 11 | Multi-currency org gotchas | Money fields return ISO codes plus values; record-level CurrencyIsoCode must be set on writes in multi-currency orgs | Read `CurrencyIsoCode` first; do not hardcode currency on inserts |
| 12 | Token caching across orgs | Reusing a cached access token after sandbox refresh or org migration causes 401 storms | Treat tokens as session-bounded; the JWT/refresh flow re-mints cheaply — do not cache beyond `expires_in` |
| 13 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 14 | sed with `/` delimiter on PEM paths or refresh tokens | Paths contain `/`; refresh tokens contain `/+=` | Always use `\|` delimiter |
| 15 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set`; private key at `/opt/data/salesforce/server.key` with `chmod 600` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `SALESFORCE_LOGIN_URL` matches org type (production vs sandbox)
- [ ] (Path A) Keypair generated on the VPS; `server.crt` uploaded to Connected App; "Use Digital Signatures" ON; integration user pre-authorized via profile
- [ ] (Path B) Long-lived refresh token obtained out of band and stored in `~/.hermes/.env`
- [ ] All `SALESFORCE_*` secrets in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat; private key at `/opt/data/salesforce/server.key`, `chmod 600`
- [ ] REST endpoint registered via `hermes mcp add salesforce` with the chosen OAuth token flow
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'salesforce'` within 30s
- [ ] Smoke test: token minted via JWT or refresh flow; `GET /services/data/v60.0/sobjects/Account/describe` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
