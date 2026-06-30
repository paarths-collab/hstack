---
name: integration-stripe
description: Connect Stripe (payments, subscriptions, invoices) to a running Hermes agent via Stripe's official remote MCP server. Use when the user wants their agent to read or create Stripe payments, subscriptions, invoices, customers, or refunds.
---

# /integration-stripe — connect Stripe to Hermes

You are the engineer connecting Stripe to a running Hermes agent. Stripe ships a **first-party
remote MCP server** at `https://mcp.stripe.com`, so the happy path is the standard
`/hermes-mcp-add` wiring: register the URL, inject a restricted API key as a bearer header,
reload the gateway, verify tools registered. Do everything autonomously; stop only for the one
thing a machine cannot do — minting the restricted key in the Stripe Dashboard.

Verified 2026-06 against Stripe's official docs:
- Remote MCP endpoint: `https://mcp.stripe.com` (https://docs.stripe.com/mcp)
- Auth: `Authorization: Bearer <key>` — bearer token, restricted API key for autonomous agents.
- Key format: restricted key `rk_live_...` / `rk_test_...`; secret key `sk_live_...` / `sk_test_...`.
  Always use a **restricted key (`rk_`)**, never an unrestricted secret key. (https://docs.stripe.com/keys)

## Before you start — gather (ask once)

1. **Stripe restricted API key (`rk_...`)** — the agent's credential. Have the user mint it at
   the Dashboard API keys tab:
   - Test/sandbox: https://dashboard.stripe.com/test/apikeys
   - Live: https://dashboard.stripe.com/apikeys

   Click **Create restricted key**, name it (e.g. `hermes-agent`), set per-resource permissions
   (least privilege — see Pitfalls for a payments/subscriptions/invoices starter set), click
   **Create key**, complete 2FA, then copy the `rk_...` value. It is shown once.
   Full guide: https://docs.stripe.com/keys/restricted-api-keys
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.
3. **(Optional) connected account id** — if operating on behalf of a connected account
   (`acct_...`), Stripe supports a `Stripe-Account` header. Skip unless the user names one.

Set shell vars (never log `TOKEN`):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://mcp.stripe.com
NAME=stripe                     # -> env var MCP_STRIPE_API_KEY
TOKEN=<rk_...>                  # restricted key; injected via sed, never echoed
```

## Step 1 — wire it via /hermes-mcp-add

This is a standard remote HTTP MCP server with bearer auth. **Run the `/hermes-mcp-add`
procedure** rather than reinventing it. Use these exact parameters:

- **URL:** `https://mcp.stripe.com`
- **Auth shape:** `header` → header name `Authorization`, value `Bearer ${MCP_STRIPE_API_KEY}`
- **Name:** `stripe` → Hermes generates env var `MCP_STRIPE_API_KEY`

Register with a placeholder (so special chars in the key never go through the `printf | docker exec`
pipe), per /hermes-mcp-add step 3:

```bash
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" --url "$URL" --auth header
```

Resulting `config.yaml` block:
```yaml
stripe:
  url: https://mcp.stripe.com
  headers:
    Authorization: Bearer ${MCP_STRIPE_API_KEY}
  enabled: true
```

## Step 2 — inject the real restricted key into /opt/data/.env

Per /hermes-mcp-add step 4. Use `|` as the sed delimiter (Stripe keys are alphanumeric but the
`|` delimiter is the safe house style), and `chmod 600` because this file holds a live credential:

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_STRIPE_API_KEY

docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# confirm it landed (prints 1; does not print the key value)
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"
```

The key lives only in `/opt/data/.env` (chmod 600). It must never appear in `config.yaml` or chat.

## Step 3 — (optional) connected-account header

If the user named a connected account, add a second static header. Re-run `hermes mcp add` is not
needed; append the header in `config.yaml` under `stripe.headers`:
```yaml
    Stripe-Account: <acct_...>
```
`acct_...` is not a secret, so it may live in `config.yaml`. Skip this step otherwise.

## Step 4 — reload the gateway

Env changes need a clean re-read — use stop + run, not `restart` (per /hermes-mcp-add step 5):

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using an unrestricted secret key (`sk_...`) | Full account access; one leak = total compromise | Always mint a restricted key (`rk_...`) with least-privilege scopes |
| 2 | Test vs live key confusion | `rk_test_` only touches test data; user wonders why real charges/invoices don't show | Match the key mode to intent; live key starts `rk_live_` |
| 3 | Too-narrow scopes | MCP tool calls 403 on resources the key can't read/write | For payments+subscriptions+invoices start with **Write** on Charges, PaymentIntents, Customers, Invoices, Subscriptions, Products, Prices; **Read** elsewhere. Tighten after auditing request logs |
| 4 | Assuming OAuth is required | Docs list OAuth (user-based) and restricted key (autonomous agents) | For a headless agent use the restricted-key bearer flow — keeps the one-click promise; no OAuth round-trip |
| 5 | Write actions are real money | The MCP exposes write tools (create payment, refund, etc.) | Scope writes deliberately; consider a read-only key first, expand only when needed |
| 6 | Rate limits | Stripe enforces per-account API rate limits; bursty agent loops can 429 | Keep agent calls reasonable; back off on `429` |
| 7 | Token in the wrong `.env` | Two files exist; MCP secrets belong in `/opt/data/.env`, not the host compose `.env` | Confirm path inside the container |

## Verify

1. Tools registered in the gateway logs (per /hermes-mcp-add step 6):
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*stripe|MCP server 'stripe'" | tail -5
   ```
2. A real read call from the chat interface returns data:
   ```
   @<agent> using stripe, list my last 3 customers
   ```
   An empty but valid result (`{"data":[],"count":0}`) on a fresh/test account is a **pass** —
   every layer (URL, bearer key, scopes, gateway) worked. A `401`/`Invalid API Key` means the
   key didn't land; recheck Step 2. A `403`/permission error means the restricted key lacks the
   scope; widen it in the Dashboard.

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for the `stripe` MCP server.
- [ ] A real Stripe read call from chat returns data (or a valid empty set).
- [ ] `MCP_STRIPE_API_KEY` holds an `rk_...` restricted key in `/opt/data/.env` with `chmod 600`.
- [ ] No key in `config.yaml` — only `Bearer ${MCP_STRIPE_API_KEY}` appears there.
- [ ] Key scopes follow least privilege (writes only where the agent needs them).

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
