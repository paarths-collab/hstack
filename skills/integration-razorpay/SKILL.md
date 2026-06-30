---
name: integration-razorpay
description: Connect Razorpay (India payments) to a running Hermes agent via Razorpay's official remote MCP server. Use when the user wants their Hermes agent to create payment links, fetch payments/orders/settlements, or issue refunds through Razorpay.
---

# /integration-razorpay — connect Razorpay to Hermes

You are the engineer connecting Razorpay to a running Hermes agent. Razorpay ships a
**first-party remote MCP server**, so the whole integration is the /hermes-mcp-add procedure
pointed at Razorpay's endpoint with the right header. Do everything autonomously; stop only for
the two things a machine cannot produce: the Razorpay API key and secret.

Razorpay's official remote MCP server: `https://mcp.razorpay.com/mcp`
(verified at https://razorpay.com/docs/mcp-server/remote/ and the official repo
https://github.com/razorpay/razorpay-mcp-server — the older `/sse` endpoint is deprecated.)

Auth is **HTTP Basic** with a merchant token = base64 of `key_id:key_secret`. This is a static
credential (no OAuth), which keeps the one-click promise.

## Before you start — gather (ask once)

1. **Razorpay Key ID** — starts with `rzp_live_` (production) or `rzp_test_` (sandbox).
2. **Razorpay Key Secret** — shown only once at generation time; cannot be re-read later.
   - Both are minted in the Razorpay Dashboard: **Settings > API Keys > Generate Key**
     (https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/). Pick Live or
     Test mode deliberately — they are different keys.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (never log the secret):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
KEY_ID=<rzp_live_or_test_id>
KEY_SECRET=<key-secret>         # never echo this into logs or git
NAME=razorpay                   # -> env var MCP_RAZORPAY_API_KEY, header name MCP_NAME
URL=https://mcp.razorpay.com/mcp
```

---

## Step 1 — mint the merchant token (base64 of key:secret)

Razorpay's remote MCP expects the credential as a single base64 blob, not the raw pair.

```bash
# -w 0 prevents base64 from wrapping long output across lines (busybox/GNU both honour it)
TOKEN="$(printf '%s:%s' "$KEY_ID" "$KEY_SECRET" | base64 -w 0)"
```

> `printf '%s:%s'` (not `echo`) avoids a trailing newline being folded into the token. A
> token with an embedded `\n` authenticates intermittently and is painful to debug.

This `TOKEN` is the value that goes into the `Authorization: Basic <TOKEN>` header.

---

## Step 2 — probe the endpoint with the real auth shape

Confirm the header form Razorpay enforces before you register anything. Run the relevant
slice of the /hermes-mcp-add probe matrix — the one that matters here is **Basic auth**:

```bash
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

# Basic auth — the documented shape
curl -sS -o /tmp/rzp_init -D /tmp/rzp_hdr -w "basic = %{http_code}\n" \
  -X POST -H "$H" -H "$C" -H "Authorization: Basic $TOKEN" -d "$INIT" "$URL"
```

- **200 + JSON-RPC `result`** → handshake good.
- **401 / 403** → token is wrong (most often the wrong mode's key, or a base64 with a stray newline — redo step 1).
- **404 / HTML** → wrong URL; confirm it is `/mcp`, not `/sse` (deprecated).

`initialize` succeeding is not proof auth is enforced. Harvest the session id and list tools
**with** the header to confirm you get real Razorpay tools back:

```bash
SID=$(grep -i mcp-session-id /tmp/rzp_hdr | tr -d '\r' | awk '{print $2}')
curl -sS -X POST -H "$H" -H "$C" -H "Mcp-Session-Id: $SID" \
  -H "Authorization: Basic $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$URL"
```

You should see payment tools (create payment link, fetch payment, fetch order, etc.). Only proceed once this returns a real tool list.

---

## Step 3 — register + inject via /hermes-mcp-add

Run the **/hermes-mcp-add** procedure rather than re-deriving it. Feed it exactly:

- **URL**: `https://mcp.razorpay.com/mcp`
- **Name**: `razorpay`  (Hermes derives env var `MCP_RAZORPAY_API_KEY` and the header reference)
- **Auth**: `header`, header name `Authorization`, header value `Basic ${MCP_RAZORPAY_API_KEY}`
- **Secret value**: the base64 `TOKEN` from step 1 (NOT the raw key/secret)

The note that bites here: the header **value** must be `Basic ${MCP_RAZORPAY_API_KEY}` (literal
`Basic ` prefix + the env reference), and the env var must hold only the base64 token. Register
with a placeholder, then sed-inject the real token using `|` as the delimiter (base64 contains
`/` and `+`):

```bash
# Register with placeholder header value (real token injected next)
printf 'y\nAuthorization\nBasic placeholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" --url "$URL" --auth header

# Inject the real base64 token into the env var Hermes generated
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_RAZORPAY_API_KEY
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Confirm `config.yaml` references the env var and the literal `Basic ` prefix is present:
```yaml
razorpay:
  url: https://mcp.razorpay.com/mcp
  headers:
    Authorization: Basic ${MCP_RAZORPAY_API_KEY}
  enabled: true
```

Secrets live only in `/opt/data/.env` (chmod 600), never in `config.yaml`, never in chat.

---

## Step 4 — reload the gateway

Env changes need a clean re-read; `restart` is not always reload-clean. Use stop + run:

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

- **Live vs Test keys are different credentials.** A `rzp_test_` key against live data (or
  vice versa) returns 401 from the MCP. Decide the mode with the user before minting the token.
- **Basic, not Bearer.** Razorpay uses `Authorization: Basic <token>`. Using `Bearer` fails
  auth silently with a generic 401. The header value must keep the literal `Basic ` prefix.
- **base64 newline.** `echo key:secret | base64` on some systems wraps or appends a newline;
  use `printf '%s:%s' ... | base64 -w 0`. A wrapped token authenticates only sometimes.
- **Secret is one-time.** The key secret is shown once on the Dashboard. If lost, regenerate
  the key pair (which invalidates the old one) — you cannot retrieve the old secret.
- **Write scope is real money.** Live keys can create payment links and issue refunds. If the
  agent only needs to read, prefer Test keys, or generate a key with restricted permissions in
  the Dashboard, before handing it to an autonomous agent.
- **Rate limits.** Razorpay enforces per-account API rate limits; a chatty agent can hit 429.
  Back off rather than retrying in a tight loop.

## Verify

```bash
# Tools registered in the gateway log
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|razorpay" | tail -5
```

Then trigger a real, read-only call from the chat interface:
```
@<agent> using razorpay, fetch my most recent payments
```
A valid empty result (e.g. `{"items":[],"count":0}` on a fresh test account) is a **pass** —
every layer worked. A 401 or "auth" error means the token didn't land; recheck step 1 (newline)
and step 3 (the `Basic ` prefix and `|`-delimited sed).

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for the `razorpay` MCP server.
- [ ] A read-only call (fetch payments/orders) from chat returns data or a valid empty result.
- [ ] `config.yaml` shows `Authorization: Basic ${MCP_RAZORPAY_API_KEY}` — no token in it.
- [ ] `/opt/data/.env` holds the base64 token and is `chmod 600`.
- [ ] The user confirmed Live vs Test mode matches their intent before going live.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
