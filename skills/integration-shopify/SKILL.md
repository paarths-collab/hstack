---
name: integration-shopify
description: Connect a Shopify store to a self-hosted Hermes Agent over SSH. Two paths — Storefront MCP (first-party, unauthenticated, catalog/cart) and Admin API (shpat_ token, full ops surface, no first-party remote MCP). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-shopify — connect Shopify to a remote Hermes (SSH-first)

You are the engineer connecting Shopify to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does one thing a machine cannot:

1. Mint the Admin API access token in Shopify admin (Settings → Apps → Develop apps → Create
   app → Configuration → Admin API → select scopes → Install → reveal token, shown ONCE).
   Only needed for Path B (ops). Path A needs no token.

Everything else — store domain validation, MCP probe, token storage, gateway reload, smoke
test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Two transports cover different surfaces.

- **Path A — Storefront MCP (first-party, hosted, unauthenticated):** per-store endpoint at
  `https://<shop>.myshopify.com/api/mcp`. Catalog, cart, store policies, customer-facing
  order tracking. **Good for shopping/assistant agents. NOT for store management.**
- **Path B — Admin API (`shpat_` token):** full management surface (products, orders,
  inventory, customers, fulfillment). **No first-party remote MCP exists for Admin API as
  of 2026-06.** Shopify's Dev MCP is docs-only (does not touch live data). Options for
  Path B:
  - **B1:** community Admin MCP server (e.g. `GeLi2001/shopify-mcp`,
    `amir-bengherbi/shopify-mcp-server`) — vet the source before trusting a `shpat_` token
  - **B2:** generic HTTP/tool layer hitting Admin GraphQL/REST directly with the token

This skill wires Path A by default and Path B opt-in via `$WIRE_PATH=B`. The Admin token is
stored in env regardless (for Path B and for any community MCP that reads `SHOPIFY_ACCESS_TOKEN`).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SHOPIFY_SHOP_DOMAIN` | `<shop>.myshopify.com` (permanent myshopify domain, NOT vanity) | Open admin URL; use the `.myshopify.com` host |
| `$SHOPIFY_ACCESS_TOKEN` *(Path B)* | Admin API access token (`shpat_...`) | Settings → Apps → Develop apps → Create → API credentials → Reveal token |
| `$SHOPIFY_API_VERSION` *(optional)* | API version like `2025-01` (default `2025-01`) | Pin a current `YYYY-MM`; Shopify deprecates after ~12 months |
| `$WIRE_PATH` *(optional)* | `A` (default — Storefront) or `B` (Admin) | B requires `$SHOPIFY_ACCESS_TOKEN` |

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
HAS_DOMAIN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SHOPIFY_SHOP_DOMAIN=' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SHOPIFY_ACCESS_TOKEN=shpat_' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_A=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci shopify-storefront" || echo 0)
if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY_A" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Shopify Storefront MCP already wired. Set FORCE=1 to rewire."
  exit 0
fi
if [ "${WIRE_PATH:-A}" = "B" ] && [ "$HAS_DOMAIN" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Shopify Admin token already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (domain format + path-specific validation + live verification)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

# Domain must be permanent myshopify domain
printf '%s' "$SHOPIFY_SHOP_DOMAIN" | grep -qE '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$' \
  || { echo "ABORT: SHOPIFY_SHOP_DOMAIN must be '<shop>.myshopify.com' (lowercase, permanent — NOT a vanity domain)."; exit 1; }

if [ "$PATH_CHOSEN" = "A" ]; then
  # Live probe of the Storefront MCP
  URL="https://$SHOPIFY_SHOP_DOMAIN/api/mcp"
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
  RESP=$(curl -sS --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -d "$INIT" \
    "$URL" 2>/dev/null) || true
  printf '%s' "$RESP" | grep -q '"result"' \
    && echo "Shopify Storefront MCP OK at $URL." \
    || { echo "ABORT: Storefront MCP probe failed. Confirm $URL is reachable + the shop exists."; echo "$RESP" | head -3; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  printf '%s' "$SHOPIFY_ACCESS_TOKEN" | grep -qE '^shpat_[A-Za-z0-9]+$' \
    || { echo "ABORT: SHOPIFY_ACCESS_TOKEN must be a Shopify Admin token (starts with shpat_)."; exit 1; }
  V="${SHOPIFY_API_VERSION:-2025-01}"
  HTTP=$(curl -sS -o /tmp/shop.json -w '%{http_code}' --max-time 10 \
    -H "X-Shopify-Access-Token: $SHOPIFY_ACCESS_TOKEN" \
    "https://$SHOPIFY_SHOP_DOMAIN/admin/api/$V/shop.json" 2>/dev/null) || HTTP=000
  case "$HTTP" in
    200)
      SHOP_NAME=$(grep -oE '"name":"[^"]+"' /tmp/shop.json | head -1 | cut -d'"' -f4)
      echo "Shopify Admin OK. Shop: $SHOP_NAME (version $V)" ;;
    401) echo "ABORT: 401 — token wrong or expired."; exit 1 ;;
    403) echo "ABORT: 403 — token lacks required scopes."; exit 1 ;;
    404) echo "ABORT: 404 — API version '$V' may be deprecated."; exit 1 ;;
    *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/shop.json | head -3; exit 1 ;;
  esac
  rm -f /tmp/shop.json
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
V="${SHOPIFY_API_VERSION:-2025-01}"
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path chosen: $PATH_CHOSEN   (A = Storefront MCP, B = Admin REST/GraphQL)

  Always:
    1. Write SHOPIFY_SHOP_DOMAIN ($SHOPIFY_SHOP_DOMAIN) via 'hermes config set'
    2. Write SHOPIFY_API_VERSION ($V)
    3. chmod 600 ~/.hermes/.env

  Path A:
    4. Register MCP: hermes mcp add shopify-storefront --url https://$SHOPIFY_SHOP_DOMAIN/api/mcp --auth none
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*shopify-storefront"

  Path B:
    4. Write SHOPIFY_ACCESS_TOKEN (length ${#SHOPIFY_ACCESS_TOKEN}, prefix shpat_)
    5. No MCP server to register (use community MCP or generic REST tool)
    6. Reload gateway: stop + run
    7. Smoke test: GET /admin/api/$V/shop.json — expect 200

Token is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
V="${SHOPIFY_API_VERSION:-2025-01}"
ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_SHOP_DOMAIN '$SHOPIFY_SHOP_DOMAIN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_API_VERSION '$V'"
if [ "$PATH_CHOSEN" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_ACCESS_TOKEN '$SHOPIFY_ACCESS_TOKEN'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(SHOPIFY_SHOP_DOMAIN|SHOPIFY_API_VERSION|SHOPIFY_ACCESS_TOKEN)=' ~/.hermes/.env" || echo 0)
EXPECTED=$([ "$PATH_CHOSEN" = "B" ] && echo 3 || echo 2)
[ "$COUNT" = "$EXPECTED" ] || { echo "FAIL: env vars did not all land (got $COUNT, need $EXPECTED). Rolling back."; rollback; exit 1; }
echo "Shopify env confirmed."
```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — register MCP (Path A only)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add shopify-storefront \
      --url 'https://$SHOPIFY_SHOP_DOMAIN/api/mcp' \
      --auth none
  "
fi
```

Path B: the agent's generic HTTP tool layer (or a community MCP server you run separately)
reads `SHOPIFY_ACCESS_TOKEN` from env and sends:

- **Header on every request:** `X-Shopify-Access-Token: ${SHOPIFY_ACCESS_TOKEN}`
- **Admin GraphQL:** `POST https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
- **Admin REST:** `https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/<resource>.json`

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
if [ "$PATH_CHOSEN" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*shopify|MCP server.*shopify-storefront"; then
      REGISTERED=1; echo "OK: shopify-storefront registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: shopify-storefront not in logs. Rolling back."; rollback; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  V="${SHOPIFY_API_VERSION:-2025-01}"
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -H \"X-Shopify-Access-Token: \$SHOPIFY_ACCESS_TOKEN\" \
      \"https://\$SHOPIFY_SHOP_DOMAIN/admin/api/$V/shop.json\"
  ")
  case "$HTTP" in
    200) echo "OK: Shopify Admin reachable from VPS." ;;
    401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
    *)   echo "WARN: HTTP $HTTP." ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${PATH_CHOSEN:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove shopify-storefront 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SHOPIFY_SHOP_DOMAIN=/d;
            /^SHOPIFY_API_VERSION=/d;
            /^SHOPIFY_ACCESS_TOKEN=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Shopify unwired. If Admin token leaked, rotate by uninstalling/reinstalling the app in Shopify admin."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Storefront MCP used for store management | Storefront only sees catalog/cart, NOT orders/inventory/customer PII | Use Path B for ops; Step 3 doesn't probe Admin if Path A chosen |
| 2 | Claiming a first-party Admin MCP exists | Shopify's Dev MCP is docs-only; Admin MCP is community-only | This skill documents Path B options honestly (B1 community, B2 REST) |
| 3 | Wrong auth header | Admin uses `X-Shopify-Access-Token`; Storefront uses `X-Shopify-Storefront-Access-Token` (different credential) | Don't mix; this skill uses Admin token only for `X-Shopify-Access-Token` |
| 4 | API version expired (~12 months) | Endpoints 404 or deprecation-warn | Pin `SHOPIFY_API_VERSION` to a current `YYYY-MM`; revisit yearly |
| 5 | `shpat_` token shown once | If lost, must rotate (uninstall/reinstall app) | Store immediately; this skill writes to `.env` chmod 600 |
| 6 | Token scope too wide | Leaked `write_orders` token is dangerous | Grant only required scopes; document scope set in Step 0 |
| 7 | Vanity domain instead of `.myshopify.com` | Admin API only resolves the permanent domain | Step 3 validator requires `.myshopify.com` suffix |
| 8 | Rate limits | REST leaky bucket; GraphQL points budget; bursts → 429 / THROTTLED | Tool layer must back off, not retry tight |
| 9 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Universal rule even though shpat_ tokens are alphanumeric | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: domain matches `*.myshopify.com`; Path A → Storefront MCP probe returned a result; Path B → `shpat_` prefix + live `/shop.json` returned 200
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: `shopify-storefront` registered as MCP with `--auth none`
- [ ] Path B: token in env; generic HTTP tool layer / community MCP documented
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: Path A logs show `registered N tool(s)` OR Path B `/shop.json` returns 200
- [ ] Rollback function defined; token rotation instructions included
- [ ] User told that Storefront MCP cannot do store management (Path B required for ops)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, scope,
and Shopify API version failure modes.
