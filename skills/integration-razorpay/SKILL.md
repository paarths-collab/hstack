---
name: integration-razorpay
description: Connect Razorpay (India payments) to a self-hosted Hermes Agent over SSH via Razorpay's official remote MCP server. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-razorpay — connect Razorpay to a remote Hermes (SSH-first)

You are the engineer connecting Razorpay to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot: mint the
Razorpay key pair in the Dashboard and decide Live vs Test mode.

Everything else — base64 minting, token storage, MCP registration, gateway reload,
verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Razorpay ships a first-party remote MCP at
`https://mcp.razorpay.com/mcp` (the older `/sse` endpoint is deprecated). Auth is
**HTTP Basic** with a merchant token = base64 of `key_id:key_secret`. Static credential,
no OAuth — perfect for headless agents. Verified at
<https://razorpay.com/docs/mcp-server/remote/> and the official repo
<https://github.com/razorpay/razorpay-mcp-server>.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$RZP_KEY_ID` | Razorpay Key ID (`rzp_live_...` or `rzp_test_...`) | Razorpay Dashboard → Settings → API Keys → Generate Key |
| `$RZP_KEY_SECRET` | Razorpay Key Secret (shown ONCE at generation) | Same screen; cannot be re-read later — regenerate if lost |
| Mode confirmed | Live vs Test — they are **different** credentials | Decide deliberately with the user before minting |

Mint URL: <https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/>

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci razorpay" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Razorpay is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

Mint the base64 token locally (in memory only) so the dry-run can print its length and
prefix without ever logging the secret:

```bash
RZP_TOKEN="$(printf '%s:%s' "$RZP_KEY_ID" "$RZP_KEY_SECRET" | base64 -w 0)"

cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_RAZORPAY_API_KEY (base64 token; length ${#RZP_TOKEN}, prefix ${RZP_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add razorpay --url https://mcp.razorpay.com/mcp --auth header
     Header: Authorization: Basic \${MCP_RAZORPAY_API_KEY}
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*razorpay"
  6. Smoke test: POST https://mcp.razorpay.com/mcp initialize → expect 200

Key mode: ${RZP_KEY_ID:0:9}...  (rzp_live_ = REAL MONEY; rzp_test_ = sandbox)
The token is NEVER printed in plaintext.
EOF
```

> `printf '%s:%s'` (not `echo`) avoids a trailing newline being folded into the token.
> `base64 -w 0` prevents wrapping. A wrapped or newline-glued token authenticates only
> intermittently and is painful to debug.

Wait for user confirmation (or skip if `AUTO_APPROVE=1`). Confirm Live vs Test mode
matches their intent before proceeding.

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_RAZORPAY_API_KEY '$RZP_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_RAZORPAY_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — base64 contains `/` and `+`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_RAZORPAY_API_KEY=' ~/.hermes/.env || printf 'MCP_RAZORPAY_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_RAZORPAY_API_KEY=.*|MCP_RAZORPAY_API_KEY=$RZP_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Razorpay MCP server

### Path A (preferred) — Razorpay's first-party remote MCP

Register with a placeholder header value, then let Hermes resolve `${MCP_RAZORPAY_API_KEY}`
from `.env` at runtime. The header **value** must keep the literal `Basic ` prefix:

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nBasic placeholder\n' | \
    hermes mcp add razorpay \
      --url 'https://mcp.razorpay.com/mcp' \
      --auth header
"
```

Then point the header at the env var (pipe delimiter — base64 has `/+=`):

```bash
ssh "$VPS_USER@$VPS_IP" "
  sed -i 's|Authorization: Basic placeholder|Authorization: Basic \${MCP_RAZORPAY_API_KEY}|' ~/.hermes/config.yaml
"
```

Confirm `config.yaml` looks like this — env var reference, **not** the literal token:

```yaml
razorpay:
  url: https://mcp.razorpay.com/mcp
  headers:
    Authorization: Basic ${MCP_RAZORPAY_API_KEY}
  enabled: true
```

### Path B (fallback) — Razorpay REST API directly

If the Hermes build cannot register HTTP MCP servers with headers, wire the REST API:

- **Base URL:** `https://api.razorpay.com/v1`
- **Auth header:** `Authorization: Basic ${MCP_RAZORPAY_API_KEY}` (same base64 token)
- **Content type:** `Content-Type: application/json`
- **Key endpoints:** `GET /payments`, `GET /orders`, `POST /payment_links`, `POST /payments/:id/refund`

Do NOT use `Bearer` — Razorpay rejects it with a generic 401.

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

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*razorpay|MCP server.*razorpay.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: razorpay registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: razorpay not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (MCP initialize handshake)

Probe the remote MCP with the real auth shape. Run from the VPS so the token stays there:

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://mcp.razorpay.com/mcp' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: Basic \$MCP_RAZORPAY_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"hermes-probe\",\"version\":\"0\"}}}'
")
case "$HTTP" in
  200) echo "OK: Razorpay MCP reachable and token valid." ;;
  401) echo "FAIL: token invalid. Most often: wrong mode (Live vs Test), or base64 has stray newline. Re-check Step 3."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but no scope. Confirm key permissions in Dashboard."; exit 1 ;;
  404) echo "FAIL: wrong URL. Must be /mcp, not deprecated /sse."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Razorpay MCP. Check manually." ;;
esac
```

For a deeper check, harvest the session id and call `tools/list` with the auth header —
you should see payment tools (create payment link, fetch payment, fetch order, refund).

A read-only call from chat (`@<agent> using razorpay, fetch my most recent payments`)
returning `{"items":[],"count":0}` on a fresh test account is a **pass** — every layer
worked end-to-end.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove razorpay 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_RAZORPAY_API_KEY 2>/dev/null || \
    sed -i '/^MCP_RAZORPAY_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 3; hermes gateway run --daemon"
  echo "Rolled back. Razorpay is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Live vs Test keys mixed up | A `rzp_test_` key against live data (or vice versa) returns 401 from the MCP | Decide mode with the user BEFORE minting; confirm in Step 3 dry-run |
| 2 | Using `Bearer` instead of `Basic` | Razorpay rejects Bearer with a generic 401 | Header value MUST keep the literal `Basic ` prefix |
| 3 | base64 newline / wrapping | `echo key:secret \| base64` may wrap or append `\n`; token authenticates only sometimes | Always `printf '%s:%s' ... \| base64 -w 0` |
| 4 | Key secret lost | Razorpay shows the secret ONCE; cannot be retrieved later | If lost, regenerate the key pair (old one invalidated) |
| 5 | Write scope on live keys = real money | Live keys can create payment links and issue refunds autonomously | Prefer Test keys; or use Dashboard-restricted permissions |
| 6 | Deprecated `/sse` endpoint | The old `/sse` URL returns 404 / HTML | Always use `https://mcp.razorpay.com/mcp` |
| 7 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 8 | sed with `/` delimiter on base64 token | base64 contains `/+=`; sed breaks silently | Always use `\|` delimiter |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | Rate limits (429) | Razorpay enforces per-account API limits; chatty agent gets throttled | Backoff on 429, don't tight-loop retry |
| 11 | `echo >> ~/.hermes/.env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 12 | Container vs host confusion | Skill assumed wrong layer; key landed in invisible place | Step 1 detects container automatically; verify with `whoami; hostname` if in doubt |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; Live vs Test mode confirmed; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_RAZORPAY_API_KEY` (base64 token) in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` shows `Authorization: Basic ${MCP_RAZORPAY_API_KEY}` — env reference, no literal token
- [ ] MCP registered via Path A (remote MCP) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'razorpay'` within 30s
- [ ] Smoke test: `POST /mcp initialize` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
