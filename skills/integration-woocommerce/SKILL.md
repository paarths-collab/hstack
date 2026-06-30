---
name: integration-woocommerce
description: Connect a WooCommerce store (WordPress ecommerce — products, orders, customers, coupons) to a self-hosted Hermes Agent over SSH using REST consumer key/secret pair. Path A — official stdio MCP proxy (@automattic/mcp-wordpress-remote). Path B — REST Basic over HTTPS. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-woocommerce — connect WooCommerce to a remote Hermes (SSH-first)

You are the engineer connecting WooCommerce to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint the REST API consumer key + secret in WP admin (WooCommerce → Settings → Advanced
   → REST API → Add key → pick `Read` or `Read/Write` → Generate; secret shown ONCE).
2. Confirm the store URL is HTTPS-reachable (real cert, not self-signed).

Everything else — credential storage, live API verification, MCP registration, gateway
reload, smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Automattic ships an **official MCP integration**
for WooCommerce — a **local stdio proxy** (`@automattic/mcp-wordpress-remote`) that translates
MCP calls into HTTPS requests against `https://<store>/wp-json/woocommerce/mcp`. Auth is NOT
OAuth and NOT a bearer — it's the consumer key+secret pair in the `X-MCP-API-Key: ck:cs`
header. Flagged developer preview ("may change in future releases").

Two paths:
- **Path A (preferred — stdio MCP):** the official Automattic proxy, registered as a stdio
  command MCP. Requires `npx` on the VPS.
- **Path B (fallback — REST):** generic HTTP tool hits `https://<store>/wp-json/wc/v3` with
  HTTP Basic (ck as username, cs as password — over HTTPS only; HTTP rejects Basic).

**Critical:** HTTPS is mandatory. Over HTTP, WooCommerce REST falls back to OAuth 1.0a
one-legged signing (timestamp-sensitive) — much more complex and not what this skill wires.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WOOCOMMERCE_URL` | Store base URL `https://<store>` (NO trailing slash, HTTPS only) | The store's URL |
| `$WOOCOMMERCE_CONSUMER_KEY` | `ck_...` consumer key | WP admin → WooCommerce → Settings → Advanced → REST API → Add key → Generate |
| `$WOOCOMMERCE_CONSUMER_SECRET` | `cs_...` consumer secret (shown ONCE) | Same flow — copy immediately on creation |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (REST) | A requires `npx` on the VPS |

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
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^WOOCOMMERCE_(URL|CONSUMER_KEY|CONSUMER_SECRET)=' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci woocommerce" || echo 0)
if [ "$COUNT" = "3" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY_MCP" -gt 0 ]; then
    echo "WooCommerce already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "WooCommerce credentials present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (HTTPS + format + live REST verify + npx for Path A)

```bash
# URL must be HTTPS, no trailing slash
printf '%s' "$WOOCOMMERCE_URL" | grep -qE '^https://[^[:space:]]+[^/]$' \
  || { echo "ABORT: WOOCOMMERCE_URL must be 'https://<host>' (HTTPS only, no trailing slash). HTTP rejected — WooCommerce Basic auth only works over HTTPS."; exit 1; }

# Key/secret prefixes
printf '%s' "$WOOCOMMERCE_CONSUMER_KEY" | grep -qE '^ck_[A-Za-z0-9]+$' \
  || { echo "ABORT: WOOCOMMERCE_CONSUMER_KEY must start with 'ck_'."; exit 1; }
printf '%s' "$WOOCOMMERCE_CONSUMER_SECRET" | grep -qE '^cs_[A-Za-z0-9]+$' \
  || { echo "ABORT: WOOCOMMERCE_CONSUMER_SECRET must start with 'cs_'."; exit 1; }

# Live REST verify (proves URL + ck/cs + HTTPS + WooCommerce enabled)
HTTP=$(curl -sS -o /tmp/wc.json -w '%{http_code}' --max-time 10 \
  -u "$WOOCOMMERCE_CONSUMER_KEY:$WOOCOMMERCE_CONSUMER_SECRET" \
  "$WOOCOMMERCE_URL/wp-json/wc/v3/products?per_page=1" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200) echo "WooCommerce REST OK." ;;
  401) echo "ABORT: 401 — credentials rejected or store falling back to OAuth (HTTPS required)."; exit 1 ;;
  403) echo "ABORT: 403 — security plugin blocking /wp-json/ ?"; exit 1 ;;
  404) echo "ABORT: 404 — WooCommerce REST not enabled at $WOOCOMMERCE_URL/wp-json/wc/v3."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/wc.json | head -3; exit 1 ;;
esac
rm -f /tmp/wc.json

# Path A: require npx on VPS
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires npx on the VPS. Install Node.js or pick Path B (WIRE_PATH=B)."; exit 1; }
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
    1. Write WOOCOMMERCE_URL ($WOOCOMMERCE_URL)
    2. Write WOOCOMMERCE_CONSUMER_KEY (prefix ck_)
    3. Write WOOCOMMERCE_CONSUMER_SECRET (length ${#WOOCOMMERCE_CONSUMER_SECRET}, prefix cs_)
    4. chmod 600 ~/.hermes/.env

  Path A (stdio MCP):
    5. Register MCP: hermes mcp add woocommerce --command npx --args -y,@automattic/mcp-wordpress-remote@latest
       --env WP_API_URL + CUSTOM_HEADERS containing X-MCP-API-Key
    6. Reload gateway: stop + run
    7. Verify in logs: grep "registered.*woocommerce"

  Path B (REST):
    5. No MCP registration; generic HTTP tool reads env, uses HTTP Basic
    6. Reload gateway: stop + run
    7. Smoke test: GET /wp-json/wc/v3/products?per_page=1 — expect 200

Secrets are NEVER printed in plaintext.
HTTP/non-HTTPS rejected. Self-signed certs rejected (Basic auth requires real TLS).
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set WOOCOMMERCE_URL '$WOOCOMMERCE_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set WOOCOMMERCE_CONSUMER_KEY '$WOOCOMMERCE_CONSUMER_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set WOOCOMMERCE_CONSUMER_SECRET '$WOOCOMMERCE_CONSUMER_SECRET'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^WOOCOMMERCE_(URL|CONSUMER_KEY|CONSUMER_SECRET)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "3" ] || { echo "FAIL: env vars did not all land (got $COUNT, need 3). Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter — secrets may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'WOOCOMMERCE_URL=$WOOCOMMERCE_URL' 'WOOCOMMERCE_CONSUMER_KEY=$WOOCOMMERCE_CONSUMER_KEY' 'WOOCOMMERCE_CONSUMER_SECRET=$WOOCOMMERCE_CONSUMER_SECRET'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the secret in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A (stdio MCP — default, preferred)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add woocommerce \
      --command 'npx' \
      --args '-y,@automattic/mcp-wordpress-remote@latest' \
      --env 'WP_API_URL=$WOOCOMMERCE_URL/wp-json/woocommerce/mcp' \
      --env 'CUSTOM_HEADERS={\"X-MCP-API-Key\":\"\${WOOCOMMERCE_CONSUMER_KEY}:\${WOOCOMMERCE_CONSUMER_SECRET}\"}'
  "
fi
```

### Path B (REST)

Generic HTTP tool layer reads env and uses HTTP Basic over HTTPS:

- **Base URL:** `${WOOCOMMERCE_URL}/wp-json/wc/v3`
- **Auth:** HTTP Basic — `username=${WOOCOMMERCE_CONSUMER_KEY}`, `password=${WOOCOMMERCE_CONSUMER_SECRET}`
- **Content-Type:** `application/json`

Common endpoints:
- `GET /products`, `GET /products/{id}`, `POST /products`, `PATCH /products/{id}`
- `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/notes`
- `GET /customers`, `GET /customers/{id}`
- `GET /reports/sales`
- Pagination: `per_page=100` (default 10); follow `X-WP-TotalPages` header

Do NOT try to register `${WOOCOMMERCE_URL}/wp-json/woocommerce/mcp` as a bearer-token MCP —
it expects `X-MCP-API-Key: ck:cs`, not `Authorization: Bearer ...`.

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
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*woocommerce|MCP server.*woocommerce|wordpress-remote"; then
      REGISTERED=1; echo "OK: woocommerce MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: woocommerce not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test for both paths
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -u \"\$WOOCOMMERCE_CONSUMER_KEY:\$WOOCOMMERCE_CONSUMER_SECRET\" \
    \"\$WOOCOMMERCE_URL/wp-json/wc/v3/products?per_page=1\"
")
case "$HTTP" in
  200) echo "OK: WooCommerce REST reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove woocommerce 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^WOOCOMMERCE_URL=/d;
            /^WOOCOMMERCE_CONSUMER_KEY=/d;
            /^WOOCOMMERCE_CONSUMER_SECRET=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the API key at WP admin → WooCommerce → Settings → Advanced → REST API if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | HTTP instead of HTTPS | WooCommerce rejects Basic auth over HTTP and falls back to OAuth 1.0a signing (timestamp-sensitive) | Step 3 hard-rejects non-https |
| 2 | Treating MCP endpoint as bearer-auth | The Automattic proxy uses `X-MCP-API-Key: ck:cs`, NOT `Authorization: Bearer` | This skill uses the proxy correctly via Path A; Path B uses Basic |
| 3 | Consumer secret lost | Shown ONCE in admin; reopening only shows the key | Mint, copy both, paste straight into env. If lost: revoke + regenerate |
| 4 | Key permissions too narrow | `Read` key → 401 on writes; agent looks broken | Pick `Read/Write` unless read-only by intent |
| 5 | Server clock skew (OAuth fallback) | OAuth 1.0a rejects timestamps outside 15-min window | Use Basic over HTTPS (no timestamp); sync NTP on the store |
| 6 | Self-signed TLS cert | Basic auth + TLS verify required | Use a real cert (Let's Encrypt is free) |
| 7 | Pagination missed | Default per_page=10; agents see partial data | Pass `per_page=100`; follow `X-WP-TotalPages` |
| 8 | Security plugin (Wordfence, iThemes) blocking /wp-json/ | 403 even with valid credentials | Whitelist agent egress IP OR /wp-json/ namespace |
| 9 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | URL contains `/`, secrets may contain `+/=` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Confusing the MCP "developer preview" with stable | Auto preview API may change | Pin `@automattic/mcp-wordpress-remote@<version>` not `@latest` in production |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: URL is HTTPS (no trailing slash); ck_/cs_ prefixes; live `/wp-json/wc/v3/products?per_page=1` returned 200; Path A → npx present
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP registered with X-MCP-API-Key header in CUSTOM_HEADERS env
- [ ] Path B: generic HTTP tool documented (Basic over HTTPS)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/wp-json/wc/v3/products?per_page=1` from inside container returned 200
- [ ] Path A: logs show `registered N tool(s)` within 30s
- [ ] Rollback function defined; key revocation instructions included
- [ ] User informed of HTTPS requirement, key permissions, and developer-preview status

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, HTTPS,
and WooCommerce REST permission failure modes.
