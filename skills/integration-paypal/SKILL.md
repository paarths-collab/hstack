---
name: integration-paypal
description: Connect PayPal (orders, payouts, invoicing, subscriptions, transaction search) to a self-hosted Hermes Agent over SSH. Mints OAuth2 client_credentials from a REST app's client_id/secret, wires either the first-party remote MCP or the REST API. Idempotent, rollback-safe, runnable from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI).
---

# /integration-paypal — connect PayPal to a remote Hermes (SSH-first)

You are the engineer connecting PayPal to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Create the REST app in the PayPal Developer Dashboard.
2. Copy the `client_id` and `client_secret` out.

Everything else — storing the credentials, minting an access token, MCP registration,
gateway reload, verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** PayPal ships a first-party **remote MCP
server** at `https://mcp.paypal.com/sse` (live) and `https://mcp.sandbox.paypal.com/sse`
(sandbox), documented at <https://docs.paypal.ai/developer/tools/ai/mcp-quickstart>. The
hosted server's intended UX is a browser-based OAuth login from clients like Claude
Desktop — headless-hostile. PayPal's published config form does show
`Authorization: Bearer <auth_header>`, but that bearer is a freshly minted **OAuth2
access token** (`expires_in` ~9 hours), not a long-lived API key. There is no static
PayPal API key.

So for a self-hosted, headless agent we:

1. Store the REST app's `client_id` and `client_secret` in `~/.hermes/.env`.
2. Mint a short-lived access token via `POST /v1/oauth2/token` (client_credentials grant).
3. Either (Path A) wire `https://mcp.paypal.com/http` with that bearer and accept that
   you must refresh it via cron, or (Path B — recommended) call PayPal's REST API
   directly with a generic HTTP tool, refreshing on `401`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PP_CLIENT_ID` | PayPal REST app client ID (`AY...` or `EA...` prefix) | <https://developer.paypal.com/dashboard/applications/> -> Apps & Credentials -> Create App -> Client ID |
| `$PP_SECRET` | PayPal REST app client secret | Same dashboard, Secret field (click Show) |
| `$PP_ENV` | `SANDBOX` or `LIVE` (default `SANDBOX` until user confirms real money) | User decision |

Sandbox creds only work against `api-m.sandbox.paypal.com` and `mcp.sandbox.paypal.com`;
Live creds only work against `api-m.paypal.com` and `mcp.paypal.com`. Do not mix.

Confirm SSH access before doing anything:

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci paypal" || echo 0)
HAS_CREDS=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^PAYPAL_CLIENT_ID=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY" -gt 0 ] || [ "$HAS_CREDS" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "PayPal already wired (MCP=$ALREADY, creds=$HAS_CREDS). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write PAYPAL_CLIENT_ID    (length ${#PP_CLIENT_ID}, prefix ${PP_CLIENT_ID:0:4}...) via 'hermes config set'
  2. Write PAYPAL_CLIENT_SECRET (length ${#PP_SECRET},    NEVER previewed)             via 'hermes config set'
  3. Write PAYPAL_ENVIRONMENT  = $PP_ENV
  4. chmod 600 ~/.hermes/.env
  5. Mint OAuth2 access_token via POST /v1/oauth2/token (proves creds)
  6. Path A: hermes mcp add paypal --url https://mcp.${PP_ENV,,}.paypal.com/http
     Path B (fallback): document REST base URL, no MCP wire
  7. Reload gateway: hermes gateway stop && hermes gateway run
  8. Verify in logs: grep -i "registered.*paypal"
  9. Smoke test: GET /v1/reporting/transactions (last 24h) -> expect 200

No secret is ever printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set PAYPAL_CLIENT_ID     '$PP_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set PAYPAL_CLIENT_SECRET '$PP_SECRET'"
ssh "$VPS_USER@$VPS_IP" "hermes config set PAYPAL_ENVIRONMENT   '$PP_ENV'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `3`, NEVER the values):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" \
  "grep -cE '^PAYPAL_(CLIENT_ID|CLIENT_SECRET|ENVIRONMENT)=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "3" ] || { echo "FAIL: PayPal creds not all written (got $WROTE/3). Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern.
> Use `|` as the sed delimiter — PayPal secrets contain `/`, `+`, and `=`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for kv in 'PAYPAL_CLIENT_ID=$PP_CLIENT_ID' 'PAYPAL_CLIENT_SECRET=$PP_SECRET' 'PAYPAL_ENVIRONMENT=$PP_ENV'; do
>     k=\${kv%%=*}
>     grep -q \"^\${k}=\" ~/.hermes/.env || printf '%s\n' \"\${k}=\" >> ~/.hermes/.env
>     sed -i \"s|^\${k}=.*|\${kv}|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Confirm the credentials by minting an access token (proves client_id/secret pair is valid
and selects the right base URL):

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  case "$PAYPAL_ENVIRONMENT" in
    LIVE) API_BASE=https://api-m.paypal.com ;;
    *)    API_BASE=https://api-m.sandbox.paypal.com ;;
  esac
  curl -sS -o /tmp/pp_tok.json -w "%{http_code}\n" \
    -X POST "$API_BASE/v1/oauth2/token" \
    -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials"
  grep -o "\"expires_in\":[0-9]*" /tmp/pp_tok.json || true
  rm -f /tmp/pp_tok.json
'
```

`200` plus a printed `"expires_in":3xxxx` (~9 hours) means the credentials are good.
`401` means the client_id/secret pair is wrong, or you minted against the wrong base URL
for the configured environment.

---

## Step 5 — register the PayPal MCP server (Path A) or document REST (Path B)

Pick the path that matches the Hermes build on the VPS.

### Path A — first-party remote MCP server (refresh-token responsibility on you)

PayPal documents a hosted remote MCP at
(<https://docs.paypal.ai/developer/tools/ai/mcp-quickstart>):

| Env | Streamable HTTP | SSE |
|-----|-----------------|-----|
| Sandbox | `https://mcp.sandbox.paypal.com/http` | `https://mcp.sandbox.paypal.com/sse` |
| Live    | `https://mcp.paypal.com/http`         | `https://mcp.paypal.com/sse`         |

The published config form is `Authorization: Bearer <auth_header>`. For self-hosted
Hermes, treat the bearer as an OAuth2 client_credentials access token you mint yourself,
and accept that it expires (~9 hours) and must be re-injected via cron. Wire it like
`/hermes-mcp-add`:

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  case "$PAYPAL_ENVIRONMENT" in
    LIVE) URL=https://mcp.paypal.com/http;          API_BASE=https://api-m.paypal.com ;;
    *)    URL=https://mcp.sandbox.paypal.com/http;  API_BASE=https://api-m.sandbox.paypal.com ;;
  esac

  # Mint token (never echoed)
  TOKEN=$(curl -sS -X POST "$API_BASE/v1/oauth2/token" \
    -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
    | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
  [ -n "$TOKEN" ] || { echo "FAIL: could not mint PayPal token"; exit 1; }

  # Add MCP with placeholder, then inject real token via sed (| delimiter — tokens contain /+=)
  printf "y\nAuthorization\nplaceholder\n" \
    | hermes mcp add paypal --url "$URL" --auth header
  sed -i "s|^MCP_PAYPAL_API_KEY=.*|MCP_PAYPAL_API_KEY=${TOKEN}|" ~/.hermes/.env
  grep -q "^MCP_PAYPAL_API_KEY=" ~/.hermes/.env \
    || printf "MCP_PAYPAL_API_KEY=%s\n" "$TOKEN" >> ~/.hermes/.env
  chmod 600 ~/.hermes/.env
'
```

Then reload (Step 6) and verify (Step 7). Schedule a refresh job (`/hermes-cron`) to
re-mint the token and re-run the `sed`+reload before `expires_in` lapses.

> If `/hermes-mcp-add`'s probe matrix returns `401` on every variant, the hosted server
> is rejecting the client_credentials token (it expects the interactive OAuth login
> flow). Fall back to Path B.

### Path B — generic HTTP tool against the PayPal REST API (recommended for headless)

Skip the hosted MCP and point a generic HTTP/tool capability at PayPal's REST API.
Refresh the access token on `401`. Safest pattern for a server-side agent.

- **Base URL (sandbox):** `https://api-m.sandbox.paypal.com`
- **Base URL (live):** `https://api-m.paypal.com`
- **Auth header:** `Authorization: Bearer <token from Step 4>`
- **Content type:** `application/json`
- **Idempotency:** send `PayPal-Request-Id: <uuid>` on any state-changing call.

Common endpoints:

| Capability | Endpoint |
|-----------|----------|
| Mint token | `POST /v1/oauth2/token` (Basic auth, `grant_type=client_credentials`) |
| Create order | `POST /v2/checkout/orders` |
| Capture order | `POST /v2/checkout/orders/{id}/capture` |
| Get order | `GET /v2/checkout/orders/{id}` |
| Create payout | `POST /v1/payments/payouts` |
| Create invoice | `POST /v2/invoicing/invoices` |
| List transactions | `GET /v1/reporting/transactions` |
| Subscriptions | `POST /v1/billing/subscriptions` |

> Webhooks, if used, must be verified via
> `POST /v1/notifications/verify-webhook-signature` before trusting any inbound event.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 7 — verify registration in logs (poll up to 30s)

Only meaningful for Path A (Path B has no MCP server to log). For Path B, skip to Step 8.

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*paypal|MCP server.*paypal.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: paypal registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: paypal not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

Read-only call: last 24h of transactions. Safe in sandbox AND live.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  case "$PAYPAL_ENVIRONMENT" in
    LIVE) API_BASE=https://api-m.paypal.com ;;
    *)    API_BASE=https://api-m.sandbox.paypal.com ;;
  esac
  TOK=$(curl -sS -X POST "$API_BASE/v1/oauth2/token" \
    -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
    | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
  START=$(date -u -d "-1 day" +%Y-%m-%dT%H:%M:%S-0000 2>/dev/null || date -u -v-1d +%Y-%m-%dT%H:%M:%S-0000)
  END=$(date -u +%Y-%m-%dT%H:%M:%S-0000)
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOK" \
    "$API_BASE/v1/reporting/transactions?start_date=$START&end_date=$END&fields=transaction_info"
')
case "$HTTP" in
  200) echo "OK: PayPal REST reachable, credentials valid, Transaction Search enabled." ;;
  401) echo "FAIL: credentials wrong for environment $PP_ENV. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: REST app missing Transaction Search feature. Toggle it in Dashboard -> App -> Features." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from PayPal REST. Check manually." ;;
esac
```

A chat-driven end-to-end check (sandbox only — moves no real money):
`@<agent> create a $1.00 USD sandbox PayPal order` should return an order ID.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove paypal 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    for k in PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET PAYPAL_ENVIRONMENT MCP_PAYPAL_API_KEY; do
      hermes config unset \$k 2>/dev/null || sed -i \"/^\${k}=/d\" ~/.hermes/.env
    done
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. PayPal is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating PayPal credentials as a static API key | PayPal has none; the bearer is a short-lived OAuth2 access token (`expires_in` ~9h) | Mint via `/v1/oauth2/token` and refresh on `401`; cron a refresh for Path A |
| 2 | Mixing sandbox creds with live URLs (or vice versa) | Returns `401 invalid_client` with no useful hint | Keep `PAYPAL_ENVIRONMENT` in `.env` and derive `API_BASE` from it every call |
| 3 | Pointing `/hermes-mcp-add` at `mcp.paypal.com/sse` and expecting OAuth-login UX to work | Hosted server's intended path is browser OAuth; headless bearer can be rejected | Prefer Path B (REST direct), or accept token-refresh duty for Path A |
| 4 | Missing `PayPal-Request-Id` on retries | A retried capture/payout double-charges without it | Generate a UUID per logical action and reuse on retries |
| 5 | `403` on `/v1/reporting/transactions` | The app does not have the Transaction Search feature enabled | Toggle it in the Dashboard app's features list |
| 6 | Echoing the access token in logs during the mint step | The token is a live bearer for the entire `expires_in` window | Capture into a shell var and pipe straight to `sed`; never `echo $TOK` |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline -> file silently broken | Always `hermes config set`, or `printf` + `sed` if no subcommand |
| 9 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 10 | sed with `/` delimiter on PayPal secrets/tokens | Secrets contain `/`, `+`, `=` -> sed pattern breaks | Always use `\|` delimiter |
| 11 | Container vs host confusion (SSH lands in container) | Keys/env added in wrong layer | Step 1 detects host vs container and routes via `docker exec` if needed |
| 12 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `POST /v1/oauth2/token` returned `200` with `access_token` + `expires_in`
- [ ] PayPal connected via Path A (MCP `paypal` registered + token-refresh cron planned) or Path B (REST base URL documented, no MCP wired)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'paypal'` within 30s (Path A only)
- [ ] Smoke test: `GET /v1/reporting/transactions` (last 24h) returned `200` (or `403` flagged with Transaction Search feature toggle)
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, MCP,
and OAuth token-refresh failure modes.
