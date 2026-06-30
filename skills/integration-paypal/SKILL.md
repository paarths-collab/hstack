---
name: integration-paypal
description: Connect PayPal (orders, payouts, invoicing, subscriptions) to a running Hermes agent using OAuth2 client_credentials minted from a PayPal REST app's client ID and secret. Use when the user wants Hermes to create or query PayPal orders, send payouts, or read transaction history.
---

# /integration-paypal — connect PayPal to Hermes

You are the engineer connecting PayPal to a running Hermes agent. PayPal is the agent's
global payments rail: orders, captures, payouts, invoicing, subscriptions, transaction
search. Work autonomously; stop only for the two things a machine cannot do: creating the
REST app in the PayPal Developer Dashboard and copying the client ID and secret out.

**Honest auth picture (verified 2026-06):** PayPal ships a first-party **remote MCP
server** at `https://mcp.paypal.com/sse` (production) and `https://mcp.sandbox.paypal.com/sse`
(sandbox), documented at <https://docs.paypal.ai/developer/tools/ai/mcp-quickstart>. The
hosted server's blog post describes it as connecting via "a simple PayPal login" — i.e.
browser-based OAuth — which is the same headless-hostile pattern other vendors ship.
PayPal's own published config example does show an `Authorization: Bearer <auth_header>`
form, but that bearer must be a freshly minted OAuth2 access token (it expires, typically
in ~9 hours), not a long-lived API key. There is no static PayPal API key.

For a self-hosted agent the clean, reproducible path is:

1. Store the PayPal REST app's `client_id` and `client_secret` in `/opt/data/.env`.
2. Mint a short-lived access token via `POST /v1/oauth2/token` (client_credentials grant).
3. Either (Path A) wire `https://mcp.paypal.com/http` through `/hermes-mcp-add` with that
   bearer and accept that you must refresh it, or (Path B) call the REST API directly with
   a generic HTTP tool, refreshing on `401`. Both paths are documented below.

## Before you start — gather (ask once)

1. **PayPal REST app credentials** — `client_id` and `client_secret`. Mint at
   <https://developer.paypal.com/dashboard/applications/> → **Apps & Credentials** → toggle
   **Sandbox** or **Live** → **Create App** → copy **Client ID** and **Secret**. Sandbox
   creds only work against `api-m.sandbox.paypal.com` and `mcp.sandbox.paypal.com`; Live
   creds only work against `api-m.paypal.com` and `mcp.paypal.com`. Do not mix.
2. **Environment** — `SANDBOX` or `LIVE`. Default to `SANDBOX` until the user confirms
   they want to move real money.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log secrets):
```bash
AGENT=<container-name>             # e.g. hermes-agent-mxlc-hermes-agent-1
PP_ENV=SANDBOX                     # or LIVE
PP_CLIENT_ID=<client-id>           # AY... or EA... prefix typical
PP_SECRET=<client-secret>          # injected via sed, never echoed
```

---

## Step 1 — store the PayPal credentials in /opt/data/.env (chmod 600)

Write the long-lived credentials to the Hermes runtime `.env` inside the container. Use
`hermes config set` so Hermes owns the write; never `echo >>` (it can merge onto a prior
line) and never put credentials in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set PAYPAL_CLIENT_ID "$PP_CLIENT_ID"
docker exec -i -u hermes "$AGENT" hermes config set PAYPAL_CLIENT_SECRET "$PP_SECRET"
docker exec -i -u hermes "$AGENT" hermes config set PAYPAL_ENVIRONMENT "$PP_ENV"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `3`, never the values):
```bash
docker exec "$AGENT" sh -c "grep -cE '^PAYPAL_(CLIENT_ID|CLIENT_SECRET|ENVIRONMENT)=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add`. Use `|` as the sed delimiter — PayPal secrets contain `/`, `+`,
> and `=`:
> ```bash
> docker exec "$AGENT" sh -c "
>   for kv in 'PAYPAL_CLIENT_ID=${PP_CLIENT_ID}' 'PAYPAL_CLIENT_SECRET=${PP_SECRET}' 'PAYPAL_ENVIRONMENT=${PP_ENV}'; do
>     k=\${kv%%=*}
>     grep -q \"^\${k}=\" /opt/data/.env || printf '%s\n' \"\${k}=\" >> /opt/data/.env
>     sed -i \"s|^\${k}=.*|\${kv}|\" /opt/data/.env
>   done
>   chmod 600 /opt/data/.env"
> ```

---

## Step 2 — confirm the credentials by minting an access token

Run inside the container so secrets come from the runtime env and are never printed. This
proves the client_id/secret pair is valid and selects the right base URL per environment.

```bash
docker exec -u hermes "$AGENT" sh -c '
  case "$PAYPAL_ENVIRONMENT" in
    LIVE)    API_BASE=https://api-m.paypal.com ;;
    *)       API_BASE=https://api-m.sandbox.paypal.com ;;
  esac
  curl -sS -o /tmp/pp_tok.json -w "%{http_code}\n" \
    -X POST "$API_BASE/v1/oauth2/token" \
    -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -H "Accept: application/json" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials"
  grep -o "\"expires_in\":[0-9]*" /tmp/pp_tok.json
  rm -f /tmp/pp_tok.json'
```

`200` plus a printed `"expires_in":3xxxx` (≈9 hours) means the credentials are good.
`401` means client_id/secret are wrong, or you are minting against the wrong base URL for
the environment.

---

## Step 3 — connect PayPal. Pick the path that matches your Hermes build.

A stored credential alone does not connect PayPal to the agent. You must give the agent a
tool surface. Two verified options.

### Path A — first-party remote MCP server (refresh-token responsibility on you)

PayPal documents a hosted remote MCP at the URLs below
(<https://docs.paypal.ai/developer/tools/ai/mcp-quickstart>):

| Env | Streamable HTTP | SSE |
|-----|-----------------|-----|
| Sandbox | `https://mcp.sandbox.paypal.com/http` | `https://mcp.sandbox.paypal.com/sse` |
| Live    | `https://mcp.paypal.com/http`         | `https://mcp.paypal.com/sse`         |

The published config form is `Authorization: Bearer <auth_header>`. The hosted server's
intended UX is browser OAuth login from MCP clients like Claude Desktop, which is not
viable for a headless agent. For self-hosted Hermes, treat the bearer as **an OAuth2
client_credentials access token you mint yourself** in step 2, and accept that it expires
(~9 hours) and must be re-injected. Wire it via `/hermes-mcp-add`:

```bash
# Pick the URL for your environment
URL=https://mcp.sandbox.paypal.com/http   # or https://mcp.paypal.com/http for LIVE
NAME=paypal

# 1. Mint a token inside the container and capture it on stdout (never logged)
TOKEN=$(docker exec -u hermes "$AGENT" sh -c '
  case "$PAYPAL_ENVIRONMENT" in
    LIVE) API_BASE=https://api-m.paypal.com ;;
    *)    API_BASE=https://api-m.sandbox.paypal.com ;;
  esac
  curl -sS -X POST "$API_BASE/v1/oauth2/token" \
    -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
  | sed -n "s/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p"')

# 2. Hand the bearer to /hermes-mcp-add (placeholder in CLI, real value via sed)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" --url "$URL" --auth header

ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Then reload (step 4) and verify (step 5). Schedule a refresh job (cron) to re-mint the
token and re-run the `sed`+reload before `expires_in` lapses; see `/hermes-cron`.

> If `/hermes-mcp-add`'s probe matrix returns `401` on every variant, the hosted server
> is rejecting the client_credentials token (likely because it expects the interactive
> OAuth login flow). Fall back to Path B.

### Path B — generic HTTP tool against the PayPal REST API (recommended for headless)

Skip the hosted MCP and point a generic HTTP/tool capability at PayPal's REST API. Refresh
the access token on `401`. This is the safest pattern for a server-side agent.

- **Base URL (sandbox):** `https://api-m.sandbox.paypal.com`
- **Base URL (live):** `https://api-m.paypal.com`
- **Auth header:** `Authorization: Bearer <token from step 2>`
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

> Webhooks, if used, must be verified via `POST /v1/notifications/verify-webhook-signature`
> before trusting any inbound event. Configure webhook URLs in the same Dashboard app.

---

## Step 4 — reload the gateway so the new env / MCP is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new env is
re-read cleanly — same rule as `/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Step 5 — verify a real call works

Confirm credentials, token mint, and one read-only REST call before declaring done.

1. **Tools registered (Path A only):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*paypal" | tail -5
   ```
2. **Live REST read with a freshly minted token (works for both paths):**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     case "$PAYPAL_ENVIRONMENT" in
       LIVE) API_BASE=https://api-m.paypal.com ;;
       *)    API_BASE=https://api-m.sandbox.paypal.com ;;
     esac
     TOK=$(curl -sS -X POST "$API_BASE/v1/oauth2/token" \
       -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
       -H "Content-Type: application/x-www-form-urlencoded" \
       -d "grant_type=client_credentials" \
       | sed -n "s/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p")
     # Last 24h of transactions — read-only, safe in any env
     START=$(date -u -d "-1 day" +%Y-%m-%dT%H:%M:%S-0000 2>/dev/null || date -u -v-1d +%Y-%m-%dT%H:%M:%S-0000)
     END=$(date -u +%Y-%m-%dT%H:%M:%S-0000)
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $TOK" \
       "$API_BASE/v1/reporting/transactions?start_date=$START&end_date=$END&fields=transaction_info"'
   ```
   `200` = credentials valid, token minted, REST reachable. `401` = credentials wrong for
   the configured environment. `403` = the REST app is missing the **Transaction Search**
   feature in the Dashboard; enable it under the app's **Live/Sandbox** features list.
3. **End-to-end from chat:** `@<agent> create a $1.00 USD sandbox PayPal order` should
   return an order ID. In sandbox this moves no real money.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating PayPal credentials as a static API key | PayPal has none; the bearer is a short-lived OAuth2 access token (`expires_in` ~9h). | Mint via `/v1/oauth2/token` and refresh on `401`; cron a refresh for Path A. |
| 2 | Mixing sandbox creds with live URLs (or vice versa) | Returns `401 invalid_client` with no useful hint. | Keep `PAYPAL_ENVIRONMENT` in `.env` and derive `API_BASE` from it every call. |
| 3 | Pointing `/hermes-mcp-add` at `mcp.paypal.com/sse` and expecting OAuth-login UX to work | The hosted server's intended path is browser OAuth; headless bearer can be rejected. | Prefer Path B (REST direct), or accept token-refresh duty for Path A. |
| 4 | Missing `PayPal-Request-Id` on retries | A retried capture/payout double-charges without it. | Generate a UUID per logical action and reuse on retries. |
| 5 | `403` on `/v1/reporting/transactions` | The app does not have the Transaction Search feature enabled. | Toggle it in the Dashboard app's features list. |
| 6 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` or sed-inject. |
| 7 | Echoing the access token in logs during the mint step | The token is a live bearer for the entire `expires_in` window. | Capture into a shell var and pipe straight to `sed`; never `echo $TOK`. |
| 8 | Using `echo >>` to append env vars | Can merge onto a prior line and silently break the file. | Use `hermes config set` or `sed -i 's|...|...|'` with `|` delimiter. |

---

## Definition of done

- [ ] `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT` are in `/opt/data/.env` with `chmod 600`; none appear in `config.yaml` or chat.
- [ ] `POST /v1/oauth2/token` from inside the container returns `200` with an `access_token` and `expires_in`.
- [ ] PayPal is connected via Path A (MCP tools registered for `paypal` and a token-refresh plan is in place) or Path B (REST base URL documented and reachable).
- [ ] `GET /v1/reporting/transactions` for the last 24h returns `200` (or `403` with the Transaction Search feature toggle clearly flagged to the user).
- [ ] A chat-driven action (sandbox order create, or transaction read) returns real data.

See `reference/TROUBLESHOOTING.md` for gateway reload, MCP registration, and OAuth token refresh failure modes.
