---
name: integration-shopify
description: Connect Shopify (products, orders, inventory, customers, fulfillment) to a self-hosted Hermes Agent over SSH. Wires a community Admin API MCP server (or REST/GraphQL fallback) with a static Custom App access token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-shopify — connect Shopify to a remote Hermes (SSH-first)

You are the engineer connecting Shopify to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Admin API access token in their Shopify admin (Custom App, scopes chosen).
2. Decide read-only vs write scopes (a `write_orders` leak is much worse than `read_orders`).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Shopify ships three MCP-shaped things, only
one of which is useful here, and none of which is a first-party Admin MCP:

- **Storefront MCP** at `https://<shop>.myshopify.com/api/mcp` — unauthenticated, covers
  catalog/cart/policies/order-tracking only. Use this for a shopping assistant, not for
  store ops. See Path C below.
- **Dev MCP** (`@shopify/dev-mcp`) — Shopify docs and dev-tools assistance only. Does
  not touch live store data. Ignore for integration work.
- **Admin API** (REST + GraphQL, `X-Shopify-Access-Token` header) — the full management
  surface. **No first-party Admin MCP exists.** We wire a vetted community stdio MCP
  (`@shopify/shopify-mcp` family) or fall back to the REST/GraphQL endpoints directly.

GraphQL is the modern primary; REST endpoints still work and use the same auth header.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SHOPIFY_STORE` | The `myshop` part of `myshop.myshopify.com` (no protocol, no `.myshopify.com`) | Shopify admin URL bar |
| `$SHOPIFY_ACCESS_TOKEN` | Admin API access token (`shpat_...`) | Shopify admin → **Settings → Apps and sales channels → Develop apps → Create an app → Configure Admin API scopes → Install app → API credentials → Reveal Admin API access token** (shown **once**) |
| `$SHOPIFY_API_VERSION` | Pinned API version (default `2025-01`) | <https://shopify.dev/docs/api/usage/versioning> — pick a current stable version |
| Scopes | Read-only vs write | Match to intent. `read_products,read_orders,read_inventory` for ops read; add `write_*` only if the agent will mutate |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

Sanity-check the token prefix and store form (catches the two most common paste errors
before they hit the VPS — wrong token type, and a full domain in `$SHOPIFY_STORE`):

```bash
case "$SHOPIFY_ACCESS_TOKEN" in
  shpat_*) echo "OK: Admin API token detected." ;;
  shpss_*) echo "ABORT: this is a Storefront API token (shpss_/shpsa_). Admin API needs an shpat_ token from a Custom App."; exit 1 ;;
  shpca_*) echo "ABORT: this is an OAuth client secret, not an access token."; exit 1 ;;
  *) echo "ABORT: token does not look like a Shopify Admin token (expected shpat_ prefix)."; exit 1 ;;
esac

case "$SHOPIFY_STORE" in
  *.myshopify.com|http*) echo "ABORT: SHOPIFY_STORE must be just the subdomain (e.g. 'acme-supply'), not a full URL or '.myshopify.com'."; exit 1 ;;
  *) echo "OK: store handle = $SHOPIFY_STORE" ;;
esac

: "${SHOPIFY_API_VERSION:=2025-01}"
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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci shopify" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Shopify is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write SHOPIFY_ACCESS_TOKEN (length ${#SHOPIFY_ACCESS_TOKEN}, prefix ${SHOPIFY_ACCESS_TOKEN:0:6}...) via 'hermes config set'
  2. Write SHOPIFY_STORE=$SHOPIFY_STORE and SHOPIFY_API_VERSION=$SHOPIFY_API_VERSION
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add shopify --command npx --args -y,@shopify/shopify-mcp
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*shopify"
  7. Smoke test: POST https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_ACCESS_TOKEN '$SHOPIFY_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_STORE '$SHOPIFY_STORE'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SHOPIFY_API_VERSION '$SHOPIFY_API_VERSION'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SHOPIFY_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: SHOPIFY_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with the
> pipe delimiter (`shpat_` tokens are alnum + `_`, but house style is `\|` regardless):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^SHOPIFY_ACCESS_TOKEN=' ~/.hermes/.env || printf 'SHOPIFY_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^SHOPIFY_ACCESS_TOKEN=.*|SHOPIFY_ACCESS_TOKEN=$SHOPIFY_ACCESS_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Shopify MCP server

Pick the path that matches the agent's job. Path A is preferred for ops work.

### Path A (preferred) — community Admin API stdio MCP server

There is no first-party Admin MCP. Pick a vetted community wrapper (verify the repo is
current and the maintainer is responsive before handing it a `shpat_` token). Common
choices distributed via npm:

- `@shopify/shopify-mcp` family / forks
- `shopify-mcp-server` (community)

The args below assume an npm-distributed stdio server that reads `SHOPIFY_ACCESS_TOKEN`,
`SHOPIFY_STORE`, and `SHOPIFY_API_VERSION` from env (the standard convention). Confirm
flag names with `npx -y <pkg> --help` before committing to a build.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add shopify \
    --command npx \
    --args '-y,@shopify/shopify-mcp' \
    --env 'SHOPIFY_ACCESS_TOKEN=\${SHOPIFY_ACCESS_TOKEN}' \
    --env 'SHOPIFY_STORE=\${SHOPIFY_STORE}' \
    --env 'SHOPIFY_API_VERSION=\${SHOPIFY_API_VERSION}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax. The token stays in `~/.hermes/.env` and is referenced via
`${SHOPIFY_ACCESS_TOKEN}` indirection — never inlined into `config.yaml`.

### Path B (fallback) — generic HTTP tool against the Admin GraphQL/REST API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command, or if no community
MCP is currently trustworthy, point a generic HTTP tool at the Admin API directly:

- **GraphQL endpoint:** `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json` (POST)
- **REST endpoint:** `https://${SHOPIFY_STORE}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/<resource>.json`
- **Auth header on every request:** `X-Shopify-Access-Token: ${SHOPIFY_ACCESS_TOKEN}`
  (NOT `Authorization: Bearer ...` — Shopify uses a custom header)
- **Content type (GraphQL):** `Content-Type: application/json`
- **Content type (REST writes):** `Content-Type: application/json`
- **Cost-based throttling:** GraphQL responses include `extensions.cost`; back off when
  `throttleStatus.currentlyAvailable` drops near zero. REST uses a leaky-bucket header
  `X-Shopify-Shop-Api-Call-Limit: used/cap` — back off near the cap.

### Path C (shopping assistants only) — first-party Storefront MCP

If the agent only needs catalog/cart/policies/order-tracking — not store ops — wire the
unauthenticated Shopify-hosted Storefront MCP instead. It needs no token:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add shopify-storefront \
    --url 'https://${SHOPIFY_STORE}.myshopify.com/api/mcp' \
    --auth none
"
```

Path C is exclusive with Paths A/B — if both are needed, register them under different
names (`shopify` for admin, `shopify-storefront` for catalog).

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
       | grep -qiE "registered.*tool.*shopify|MCP server.*shopify.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: shopify registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: shopify not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

A bare GraphQL `{ shop { name myshopifyDomain } }` query is side-effect-free, works on
any store regardless of catalog state, and exercises every layer: env vars, store handle,
API version, token validity, scope, and network egress.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://\${SHOPIFY_STORE}.myshopify.com/admin/api/\${SHOPIFY_API_VERSION}/graphql.json' \
    -H \"X-Shopify-Access-Token: \$SHOPIFY_ACCESS_TOKEN\" \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"{ shop { name myshopifyDomain } }\"}'
")
case "$HTTP" in
  200) echo "OK: Shopify Admin API reachable, token valid, basic shop read works." ;;
  401) echo "FAIL: token invalid, empty, or rotated. Re-check Step 4."; rollback; exit 1 ;;
  402) echo "FAIL: store is frozen or unpaid. User must resolve in Shopify admin."; exit 1 ;;
  403) echo "FAIL: token valid but scope missing. Reinstall Custom App with needed scopes (see Pitfall 4)."; exit 1 ;;
  404) echo "FAIL: 404 — wrong store handle or API version aged out. Check Pitfall 6."; exit 1 ;;
  423) echo "FAIL: store locked. User must resolve in Shopify admin."; exit 1 ;;
  429) echo "WARN: rate-limited at smoke test — retry in a few seconds." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Shopify Admin API. Check manually." ;;
esac
```

`200` with a valid `shop` object means wiring works. Note: GraphQL returns HTTP `200`
even on schema errors, with `errors[]` in the body — so a `200` confirms transport+auth,
not query correctness. For write tests, exercise one mutation in a development store
before pointing at production.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove shopify 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove shopify-storefront 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset SHOPIFY_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^SHOPIFY_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset SHOPIFY_STORE 2>/dev/null || \
    sed -i '/^SHOPIFY_STORE=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset SHOPIFY_API_VERSION 2>/dev/null || \
    sed -i '/^SHOPIFY_API_VERSION=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Shopify is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Storefront vs Admin token confusion (`shpsa_`/`shpss_` vs `shpat_`) | Different surfaces, different headers. Storefront tokens 401 on Admin endpoints and vice versa | Step 0 prefix check rejects non-`shpat_` tokens. Storefront MCP (Path C) needs no token at all |
| 2 | No first-party Admin MCP exists | Easy to assume one does and waste time hunting for it. The Dev MCP is docs-only; the Storefront MCP is catalog-only | Use a vetted community stdio MCP (Path A) or the REST/GraphQL fallback (Path B). Document the choice |
| 3 | Wrong auth header on REST/GraphQL | Shopify uses `X-Shopify-Access-Token`, not `Authorization: Bearer` — bearer-style calls get 401 | Path B explicitly shows the custom header; do not auto-translate |
| 4 | Custom App scopes set at install time | Changing scopes after install requires **reinstalling** the app — toggling scopes in the UI alone is silent | Pick scopes deliberately before install. To widen later: edit scopes → click **Install app** again → re-reveal the token (it rotates) → rerun this skill with `FORCE=1` |
| 5 | API version pinning | Without `${SHOPIFY_API_VERSION}` Shopify defaults to the oldest supported, which deprecates. Old versions return `404` after expiry (~12 months) | Pin to a current quarterly version (default `2025-01`). Plan to bump every 6–9 months |
| 6 | `SHOPIFY_STORE` paste errors | Users paste `https://acme.myshopify.com` or `acme.myshopify.com`; Step 5/8 URLs then double up and 404 | Step 0 rejects full URLs and the `.myshopify.com` suffix. Pass just the subdomain |
| 7 | Token shown once | The `shpat_` token is revealed a single time on install. If lost, you must reinstall the Custom App (token rotates) | Tell the user up-front to copy it the moment they reveal it. Never echo it back in chat |
| 8 | GraphQL cost-based rate limits | Unlike REST's leaky bucket, GraphQL charges per-query "cost points." A burst of expensive queries `THROTTLED`s with HTTP 200 + errors body | Read `extensions.cost.throttleStatus.currentlyAvailable`; back off when low. Use `bulkOperationRunQuery` for large reads |
| 9 | Bulk operations for big queries | Listing all orders/products inline blows the cost budget; a single bulk op runs async and writes a JSONL URL | For >250 records use `bulkOperationRunQuery` + poll → download the JSONL — do not paginate REST 250 at a time |
| 10 | Fulfillment vs orders permission split | `write_orders` does NOT include fulfillment. You need `write_fulfillments` (and often `write_assigned_fulfillment_orders`) to mark shipped | If the agent must mark shipped, include the fulfillment scopes at Custom App install time |
| 11 | Location-aware inventory | Inventory levels are per-location. A "stock" call without `locationId` is ambiguous and often returns nothing useful | Use `inventoryLevels(locationId: ...)`; list locations first via `locations` query |
| 12 | Deleted vs archived products | Archived products still exist and are queryable; deleted ones return null with no error. Easy to miss in audits | When auditing a SKU, check archived status (`status: ARCHIVED`) before assuming deletion |
| 13 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 14 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Token prefix is `shpat_` (Admin); store handle is the bare subdomain
- [ ] `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_STORE`, `SHOPIFY_API_VERSION` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Custom App scopes match agent intent (read vs write); fulfillment scopes included if marking shipped
- [ ] MCP registered via Path A (community stdio), Path B (REST/GraphQL fallback documented), or Path C (Storefront, shopping only)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'shopify'` (or `'shopify-storefront'`) within 30s
- [ ] Smoke test: GraphQL `{ shop { name myshopifyDomain } }` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
