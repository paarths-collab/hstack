---
name: integration-stripe
description: Connect Stripe (payments, subscriptions, invoices, customers) to a self-hosted Hermes Agent over SSH. Wires Stripe's official open-source MCP server (@stripe/mcp) with a restricted API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-stripe — connect Stripe to a remote Hermes (SSH-first)

You are the engineer connecting Stripe to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the restricted API key in the Stripe Dashboard (requires 2FA).
2. Decide test vs live mode (real money is real money).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Stripe ships two MCP options:

- **Hosted remote MCP** at `https://mcp.stripe.com` — **OAuth-only** for end-user agents.
  Bearer tokens against this endpoint do not get you autonomous, headless operation.
- **Official open-source server** `@stripe/mcp` (npm, v0.3.x) — takes a static API key
  via `--api-key`. Perfect for headless self-hosted agents. This is what we wire.

We strongly recommend a **restricted key** (`rk_test_...` / `rk_live_...`) over a full
secret key (`sk_test_...` / `sk_live_...`). Restricted keys can be scoped per-resource,
so a leaked credential can't drain the account.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$STRIPE_API_KEY` | Restricted API key (`rk_test_...` or `rk_live_...`) | Test: <https://dashboard.stripe.com/test/apikeys> · Live: <https://dashboard.stripe.com/apikeys> → **Create restricted key** → name it `hermes-agent` → pick scopes (see Pitfall 3) → 2FA → copy once |
| Mode | `test` or `live` | Match the key prefix. `rk_test_` only sees test data; `rk_live_` touches real money |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

Sanity-check the key prefix (catches paste errors before they hit the VPS):

```bash
case "$STRIPE_API_KEY" in
  rk_test_*|rk_live_*) echo "OK: restricted key, mode=${STRIPE_API_KEY%%_*}_${STRIPE_API_KEY#rk_}" >/dev/null
                       echo "OK: restricted key detected." ;;
  sk_test_*|sk_live_*) echo "WARN: this is a FULL secret key. Strongly prefer a restricted key (rk_...). Proceeding only if you understand the blast radius." ;;
  *) echo "ABORT: token does not look like a Stripe API key (expected rk_/sk_ prefix)."; exit 1 ;;
esac
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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci stripe" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Stripe is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write STRIPE_API_KEY (length ${#STRIPE_API_KEY}, prefix ${STRIPE_API_KEY:0:8}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add stripe --command npx --args -y,@stripe/mcp,--tools=all
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*stripe"
  6. Smoke test: GET https://api.stripe.com/v1/customers?limit=1 → expect 200

Mode: ${STRIPE_API_KEY%%_*}_${STRIPE_API_KEY#??_} (rk_test_ = sandbox; rk_live_ = real money)
The key is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set STRIPE_API_KEY '$STRIPE_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^STRIPE_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: STRIPE_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, fall back to the safe sed pattern.
> Stripe keys are alphanumeric + `_`, but house style is the pipe delimiter regardless:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^STRIPE_API_KEY=' ~/.hermes/.env || printf 'STRIPE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^STRIPE_API_KEY=.*|STRIPE_API_KEY=$STRIPE_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Stripe MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with restricted key

`@stripe/mcp` (v0.3.x, bin `mcp`) accepts `--api-key=<key>` and `--tools=<list>`. Pass
`--tools=all` to expose every tool the key's scopes allow; the restricted key itself is
the security boundary.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add stripe \
    --command npx \
    --args '-y,@stripe/mcp,--tools=all,--api-key=\${STRIPE_API_KEY}' \
    --env 'STRIPE_API_KEY=\${STRIPE_API_KEY}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax. The key stays in `~/.hermes/.env` and is referenced via
`${STRIPE_API_KEY}` indirection — never inlined into `config.yaml`.

To restrict the tool surface explicitly (e.g. read-only first day), swap `--tools=all`
for a comma list: `--tools=customers.read,charges.read,paymentIntents.read`.

### Path B (fallback) — generic HTTP tool against the Stripe REST API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command:

- **Base URL:** `https://api.stripe.com/v1`
- **Auth header:** `Authorization: Bearer ${STRIPE_API_KEY}`
- **Recommended version header:** `Stripe-Version: 2025-09-30.acacia` (pin to an API
  version you tested against; without it Stripe uses the account's default, which can
  drift)
- **Content type:** `Content-Type: application/x-www-form-urlencoded` (Stripe REST is
  form-encoded, not JSON)
- **Idempotency on writes:** add `Idempotency-Key: <uuid>` to POST/DELETE so retries
  don't double-charge

Do NOT try to register `https://mcp.stripe.com` with a bearer token — that endpoint is
**OAuth-only** and rejects static keys.

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
       | grep -qiE "registered.*tool.*stripe|MCP server.*stripe.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: stripe registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: stripe not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the key stays on the VPS)

A bare `GET /v1/customers?limit=1` is side-effect-free, works on a brand-new account
(returns `{"data":[],"has_more":false}`), and exercises every layer: env var, key
validity, scope, and network egress.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -G 'https://api.stripe.com/v1/customers' \
    --data-urlencode 'limit=1' \
    -H \"Authorization: Bearer \$STRIPE_API_KEY\" \
    -H 'Stripe-Version: 2025-09-30.acacia'
")
case "$HTTP" in
  200) echo "OK: Stripe API reachable, key valid, customers.read scope present." ;;
  401) echo "FAIL: key invalid, empty, or wrong mode. Re-check Step 4."; rollback; exit 1 ;;
  402) echo "FAIL: 402 — typically restricted-key scope missing or account in a holding state."; exit 1 ;;
  403) echo "FAIL: key valid but lacks customers.read scope. Widen the restricted key."; exit 1 ;;
  429) echo "WARN: rate-limited at smoke test — retry in a few seconds."; ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Stripe API. Check manually." ;;
esac
```

`200` with an empty `data` array means the key works but the account has no customers
yet — that is a **pass** of the wiring, not a failure. Confirm read vs write capability
separately: a restricted key with `customers.read` only will 200 here but 403 on a
`POST /v1/customers`. Write tests cost real cycles on live mode — do them in test mode.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove stripe 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset STRIPE_API_KEY 2>/dev/null || \
    sed -i '/^STRIPE_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Stripe is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the hosted `mcp.stripe.com` MCP with a bearer token | It is **OAuth-only**; static keys are rejected | Use stdio `@stripe/mcp` (Path A) or REST (Path B) |
| 2 | Test vs live key confusion | `rk_test_` only sees test data; user wonders why real charges/invoices don't show. Worse: `rk_live_` in a sandbox setup will move real money | Match key prefix to intent. Confirm in Step 3 dry-run |
| 3 | Restricted key scopes too narrow | MCP tool calls 403 on resources the key can't touch | Starter scope for payments+subs+invoices: **Write** on Charges, PaymentIntents, Customers, Invoices, Subscriptions, Products, Prices; **Read** elsewhere. Tighten from there |
| 4 | Restricted key scopes too wide | A leaked key drains more than necessary; defeats the purpose of `rk_` | Begin **read-only**; widen only after auditing actual tool calls in `hermes logs` |
| 5 | Using a full secret key (`sk_...`) | Full account access; one leak = total compromise. No per-resource scoping | Always mint a restricted key. `sk_` should only appear in CI or server-to-server code you own |
| 6 | Confusing API key with webhook signing secret | `whsec_...` is for verifying webhook payloads, not API calls. Wiring it as `STRIPE_API_KEY` gives 401 everywhere | Webhook secrets stay in your webhook receiver, not the MCP key slot |
| 7 | No `Stripe-Version` header on REST (Path B) | Stripe defaults to the account's API version, which can shift under you and break parsers | Pin `Stripe-Version: 2025-09-30.acacia` (or current); upgrade deliberately |
| 8 | No `Idempotency-Key` on writes | Network retries can double-charge or double-create | Send a UUID `Idempotency-Key` on every POST/DELETE; Stripe dedupes for 24h |
| 9 | Rate limits (100 read / 100 write per sec, default) | Bursty agent loops 429 the whole account | Backoff on `429`; cache list results; batch via `expand[]` |
| 10 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 11 | sed with `/` delimiter on tokens | House style is `\|` — safe even though Stripe keys are alnum | Always use `\|` delimiter |
| 12 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Key prefix matches intended mode (test vs live)
- [ ] `STRIPE_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Restricted key (`rk_...`) used — NOT a full secret key (`sk_...`)
- [ ] MCP registered via Path A (stdio `@stripe/mcp`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'stripe'` within 30s
- [ ] Smoke test: `GET /v1/customers?limit=1` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
