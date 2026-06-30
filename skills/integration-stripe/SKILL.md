---
name: integration-stripe
description: Connect Stripe (payments, subscriptions, invoices, customers, refunds) to a self-hosted Hermes Agent over SSH via Stripe's official remote MCP server. Enforces restricted-key-only (refuses sk_), test/live mode confirmation, and a live API smoke test. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-stripe — connect Stripe to a remote Hermes (SSH-first)

You are the engineer connecting Stripe to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does one thing a machine cannot:

1. Mint a **restricted** API key (`rk_test_...` or `rk_live_...`) in the Stripe Dashboard
   with least-privilege per-resource scopes.

Everything else — token storage, MCP registration, gateway reload, verification, real API
smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Stripe ships a **first-party** remote MCP server
at `https://mcp.stripe.com` (https://docs.stripe.com/mcp). Auth is bearer-token via
`Authorization: Bearer <key>` — perfect for a headless agent. There IS an OAuth path for
user-based access; we don't use it (breaks the one-click promise). Always use a
**restricted key** (`rk_...`), never the unrestricted secret key (`sk_...`) — this skill
refuses to wire an `sk_` key because one leak = full account compromise.

**Test vs live:** `rk_test_...` touches only test data (no real money); `rk_live_...` makes
real charges. Step 3 prints which mode you're wiring and aborts if the user mis-pastes
between modes.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$STRIPE_TOKEN` | **Restricted** API key (`rk_test_...` or `rk_live_...`) | Test: https://dashboard.stripe.com/test/apikeys → Create restricted key. Live: https://dashboard.stripe.com/apikeys (requires 2FA) |
| `$STRIPE_ACCOUNT` *(optional)* | Connected account ID `acct_...` to act on behalf of | Stripe Connect → Connected accounts |
| `$MODE_EXPECT` *(optional)* | `test` or `live` — the mode you EXPECT the key to be | Used by Step 3 to abort on mismatch |

Recommended starter scopes on the restricted key (Stripe Dashboard → restricted key creation):
- **Write**: Charges, PaymentIntents, Customers, Invoices, Subscriptions, Products, Prices
- **Read**: everything else
- Tighten after auditing real request logs.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci stripe" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_STRIPE_API_KEY=rk_' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Stripe already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (restricted key only, mode confirmation, live API check)

```bash
# Refuse unrestricted secret keys outright
case "$STRIPE_TOKEN" in
  rk_test_*|rk_live_*) : ;;
  sk_test_*|sk_live_*)
    echo "ABORT: STRIPE_TOKEN is a SECRET key (sk_*). Refused for safety."
    echo "Use a RESTRICTED key (rk_*) with least-privilege scopes."
    echo "Mint at https://dashboard.stripe.com/test/apikeys (test) or /apikeys (live)."
    exit 1 ;;
  *)
    echo "ABORT: STRIPE_TOKEN does not look like a Stripe key (must start with rk_test_ or rk_live_)."
    exit 1 ;;
esac

# Mode self-check
case "$STRIPE_TOKEN" in
  rk_test_*) ACTUAL_MODE=test ;;
  rk_live_*) ACTUAL_MODE=live ;;
esac
if [ -n "${MODE_EXPECT:-}" ] && [ "$MODE_EXPECT" != "$ACTUAL_MODE" ]; then
  echo "ABORT: Expected $MODE_EXPECT-mode key, got $ACTUAL_MODE-mode. Did you paste the wrong one?"
  exit 1
fi
echo "Key mode: $ACTUAL_MODE."

# Live Stripe API check (proves the key works AND surfaces scope issues early)
ACCOUNT=$(curl -sS --max-time 10 \
  -H "Authorization: Bearer $STRIPE_TOKEN" \
  -H 'Stripe-Version: 2024-12-18.acacia' \
  https://api.stripe.com/v1/account 2>/dev/null) || true
ACCT_ID=$(printf '%s' "$ACCOUNT" | grep -oE '"id":"acct_[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$ACCT_ID" ]; then
  if printf '%s' "$ACCOUNT" | grep -q 'invalid_api_key'; then
    echo "ABORT: Stripe rejected the key (invalid_api_key). Re-check the value."
  elif printf '%s' "$ACCOUNT" | grep -q '"type":"permission_error"'; then
    echo "WARN: key valid but restricted from /v1/account. Continuing — most MCP tools will still work if their scopes are set."
  else
    echo "ABORT: could not reach Stripe API or unexpected response."
    echo "$ACCOUNT" | head -5
    exit 1
  fi
else
  echo "Stripe API OK. Account: $ACCT_ID ($ACTUAL_MODE)."
fi

# Connected account format check
if [ -n "${STRIPE_ACCOUNT:-}" ]; then
  printf '%s' "$STRIPE_ACCOUNT" | grep -qE '^acct_[A-Za-z0-9]+$' \
    || { echo "ABORT: STRIPE_ACCOUNT must be 'acct_<id>'."; exit 1; }
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_STRIPE_API_KEY (length ${#STRIPE_TOKEN}, prefix ${STRIPE_TOKEN:0:8}..., mode $ACTUAL_MODE) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add stripe --url https://mcp.stripe.com --auth-header Authorization --auth-scheme Bearer
  4. (if STRIPE_ACCOUNT supplied) Add static header Stripe-Account: $STRIPE_ACCOUNT in config.yaml
  5. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  6. Verify in logs: grep "registered.*stripe"
  7. Smoke test: GET https://api.stripe.com/v1/customers?limit=1 — expect 200 (empty list is OK)

The key is NEVER printed in plaintext beyond a length + prefix + mode.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_STRIPE_API_KEY '$STRIPE_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_STRIPE_API_KEY=rk_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: Stripe key not written. Rolling back."; rollback; exit 1; }
echo "Stripe key confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use the safe sed pattern. The `|` delimiter is
> mandatory — Stripe restricted keys are alphanumeric but the universal rule prevents
> future bugs:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_STRIPE_API_KEY=' ~/.hermes/.env || printf 'MCP_STRIPE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_STRIPE_API_KEY=.*|MCP_STRIPE_API_KEY=$STRIPE_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml` — only `Bearer ${MCP_STRIPE_API_KEY}`
indirection lives there.

---

## Step 6 — register the Stripe MCP server

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add stripe \
    --url 'https://mcp.stripe.com' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject real token reference with pipe delimiter
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_STRIPE_API_KEY}|g' ~/.hermes/config.yaml"
```

If `$STRIPE_ACCOUNT` is set, add the `Stripe-Account` header (non-secret, lives in
config.yaml):

```bash
if [ -n "${STRIPE_ACCOUNT:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    python3 -c \"
import yaml, sys
p='$HOME/.hermes/config.yaml'.replace('\\\$HOME','$HOME')
d=yaml.safe_load(open(p)) or {}
d.setdefault('mcp_servers', {})
d['mcp_servers'].setdefault('stripe', {})
d['mcp_servers']['stripe'].setdefault('headers', {})
d['mcp_servers']['stripe']['headers']['Stripe-Account'] = '$STRIPE_ACCOUNT'
yaml.safe_dump(d, open(p,'w'), sort_keys=False)
\"  || echo 'WARN: could not auto-add Stripe-Account header — edit config.yaml manually.'
  "
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

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE "registered .* tool.*stripe|MCP server.*stripe.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: stripe MCP registered."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: stripe not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live API smoke test (from inside the container, never logs the key)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$MCP_STRIPE_API_KEY\" \
    -H 'Stripe-Version: 2024-12-18.acacia' \
    'https://api.stripe.com/v1/customers?limit=1'
")
case "$HTTP" in
  200) echo "OK: Stripe API reachable and key has Customer:read." ;;
  401) echo "FAIL: token invalid (401). Re-check Step 5."; rollback; exit 1 ;;
  403) echo "WARN: 403 on /v1/customers — restricted key lacks Customer:read. Widen scopes in Dashboard." ;;
  *)   echo "WARN: unexpected HTTP $HTTP. Manual investigation needed." ;;
esac
```

A `200` with an empty result on a fresh/test account is a **pass** — every layer (URL,
bearer, scope, gateway) worked.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove stripe 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_STRIPE_API_KEY 2>/dev/null || \
    sed -i '/^MCP_STRIPE_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Stripe is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using an unrestricted secret key (`sk_...`) | Full account access; one leak = total compromise (real money at risk) | Step 3 hard-refuses any `sk_` prefix |
| 2 | Test vs live key confusion | `rk_test_` only touches test data; user wonders why real charges/invoices don't show — or worse, `rk_live_` makes real charges in dev | Step 3 prints the actual mode; aborts on `$MODE_EXPECT` mismatch |
| 3 | Too-narrow scopes on the restricted key | MCP tool calls 403 on resources the key can't read/write | Start with the documented starter set; tighten after auditing logs |
| 4 | Assuming OAuth is required | Stripe MCP supports both; OAuth breaks headless | Use restricted-key bearer flow (this skill) |
| 5 | Write actions are real money | MCP exposes write tools (create payment, refund, etc.) | Scope deliberately; start read-only when in doubt |
| 6 | Rate limits | Stripe enforces per-account API rate limits; bursty agent loops can 429 | Keep agent calls reasonable; back off on `429` |
| 7 | Token in `config.yaml` | Secret often checked into git | Only `~/.hermes/.env`, `chmod 600`; only `${MCP_STRIPE_API_KEY}` indirection in yaml |
| 8 | `Stripe-Account` header set but connected account not actually authorized | Account ID exists but the platform never authorized it | Confirm in Stripe Connect → Connected accounts before adding the header |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter on tokens | Universal rule for safety even though Stripe keys are alphanumeric | Always `\|` delimiter |
| 12 | Webhook signing secret confusion | Webhooks (sigs `whsec_...`) are a different flow — NOT used by this MCP | This skill only wires the API key; ignore webhook secrets |
| 13 | Stripe API version drift | Bumping `Stripe-Version` may break consumer code | Pin to the version verified for the integration (this skill uses `2024-12-18.acacia`) |
| 14 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired with `rk_` key, unless `FORCE=1`)
- [ ] HARD GATE passed: token starts with `rk_test_` or `rk_live_` (never `sk_`); mode matches `$MODE_EXPECT` if set
- [ ] Live `/v1/account` call returned an `acct_...` ID (or warned cleanly if key is restricted from `/account`)
- [ ] `$STRIPE_ACCOUNT` (if set) matches `acct_[A-Za-z0-9]+`
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_STRIPE_API_KEY` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `config.yaml` references `${MCP_STRIPE_API_KEY}` (no plaintext key)
- [ ] `Stripe-Account` header added if `$STRIPE_ACCOUNT` set
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'stripe'` within 30s
- [ ] Smoke test: `GET /v1/customers?limit=1` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP
failure modes.
