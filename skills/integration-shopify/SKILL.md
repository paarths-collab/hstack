---
name: integration-shopify
description: Connect a Shopify store to a running Hermes agent for ecommerce work (products, orders, inventory, customers). Use when the user wants their Hermes agent to read or manage a Shopify store.
---

# /integration-shopify — connect Shopify to Hermes

You are the engineer connecting Shopify to a running Hermes agent so it can power an ecommerce
agent: read catalog and orders, check inventory, look up customers, and (with write scopes)
update products or fulfill orders. Do everything autonomously; stop only for the one thing a
machine cannot do — the user minting the Admin API access token in their Shopify admin.

Two transports exist and they cover different surfaces. Pick the right one for the task:

- **Storefront MCP** (first-party, Shopify-hosted, unauthenticated): catalog, cart, policies,
  customer-facing order tracking. Good for shopping/assistant agents. Not for store management.
- **Admin API** (static `shpat_` token): the full management surface — products, orders,
  inventory, customers, fulfillment. This is what an "ecommerce ops" agent needs. No first-party
  remote MCP exists for it as of 2026-06; see Step 2.

## Before you start — gather (ask once)

1. **Store domain** — `<shop>.myshopify.com` (the permanent myshopify domain, not a custom domain).
2. **What the agent must do** — read-only catalog/orders, or write (update products, fulfill orders).
   This decides the Admin API access scopes the user grants.
3. **Admin API access token** — needed only for the Admin API path (Step 2). Format `shpat_...`.
   The user mints it in their Shopify admin:
   **Settings → Apps and sales channels → Develop apps → Create an app →
   Configuration → Admin API integration → select access scopes (e.g. `read_products`,
   `read_orders`, `write_products`) → Install app → API credentials → reveal the
   Admin API access token.** The token is shown **once** — copy it immediately.
   Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin

Set shell vars from the answers:
```bash
AGENT=<container-name>            # docker ps --format '{{.Names}}' | grep hermes
SHOP=<shop>.myshopify.com         # e.g. acme-supply.myshopify.com
TOKEN=<shpat_...>                 # Admin API token; never log it, never commit it
```

---

## Step 1 — (shopping agents) wire the first-party Storefront MCP

The Storefront MCP is a real, Shopify-hosted, **per-store, unauthenticated** endpoint:

```
https://<shop>.myshopify.com/api/mcp
```

Verified from https://shopify.dev/docs/apps/build/storefront-mcp/servers/storefront — it exposes
catalog, cart, store policies, and customer-facing order tracking. It does **not** expose admin
management surfaces.

Probe it the same way /hermes-mcp-add does, then register it. Because it needs no auth, skip the
token-injection steps:

```bash
URL="https://${SHOP}/api/mcp"
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -o /tmp/shopify_probe -w "init = %{http_code}\n" -X POST -H "$H" -H "$C" -d "$INIT" "$URL"
```

A `200` with a JSON-RPC `result` confirms the endpoint. Register it (no auth shape needed):

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add shopify-storefront --url "$URL" --auth none
```

Then reload the gateway and verify exactly as in **/hermes-mcp-add Steps 5–6**
(`gateway stop` + `gateway run`, then check `hermes logs` for `registered N tool(s)`).
If your Hermes build has no `--auth none`, register with `--auth header` and answer `n` to the
"use auth" prompt. Stop here if a shopping/assistant agent is all the user needs.

---

## Step 2 — (ops agents) wire the Admin API

**No first-party remote MCP server is verified for the Shopify Admin API as of 2026-06.** Shopify's
own MCP offerings are the Storefront MCP (Step 1) and the Dev MCP (docs/dev assistance only —
it does not touch live store data). So for product/order/inventory/fulfillment work there are two
honest options. Do **not** pretend that storing the token alone connects the store — a token with
no MCP/tool to call it is inert.

### Option A — community Admin API MCP server (run it yourself)

Several maintained community servers wrap the Admin GraphQL/REST API as MCP. None are Shopify
first-party; vet before trusting one with a store token. Examples seen in the ecosystem (verify the
repo is current before use): `GeLi2001/shopify-mcp` (https://github.com/GeLi2001/shopify-mcp),
`amir-bengherbi/shopify-mcp-server` (https://github.com/amir-bengherbi/shopify-mcp-server). These
are typically **stdio/local Node** servers, not hosted HTTP MCPs, so /hermes-mcp-add (which targets
remote HTTP MCPs) does not apply directly. If you self-host one behind an HTTP transport, register it
via /hermes-mcp-add and put the store token in the env var that server expects (commonly
`SHOPIFY_ACCESS_TOKEN` plus `SHOPIFY_SHOP_DOMAIN`), injected into `/opt/data/.env` per Step 3.

### Option B — store the token + document the REST/GraphQL base for a generic tool

Keep the token in Hermes' runtime env so any generic HTTP/tool layer (or the community MCP above)
can authenticate. Write it to `/opt/data/.env` with `hermes config set` — never `config.yaml`,
never `echo >>`:

```bash
docker exec -i -u hermes "$AGENT" hermes config set SHOPIFY_SHOP_DOMAIN "$SHOP"
printf '%s' "$TOKEN" | docker exec -i -u hermes "$AGENT" \
  sh -c 'read -r t; hermes config set SHOPIFY_ACCESS_TOKEN "$t"'
docker exec "$AGENT" sh -c 'chmod 600 /opt/data/.env'
```

If your Hermes build's `config set` writes elsewhere, fall back to the /hermes-mcp-add sed-inject
pattern against `/opt/data/.env` (use `|` as the sed delimiter; `shpat_` tokens are safe but stay
consistent), then `chmod 600`.

The Admin API itself (for the tool/MCP that will call it):

- GraphQL: `https://<shop>.myshopify.com/admin/api/<version>/graphql.json` (POST)
- REST: `https://<shop>.myshopify.com/admin/api/<version>/<resource>.json`
- Auth header on **every** request: `X-Shopify-Access-Token: <shpat_...>`
- Pick a recent stable `<version>` (e.g. `2025-01`); Shopify versions quarterly and deprecates old ones.

Reload the gateway after writing the env (per /hermes-mcp-add Step 5) so the new value is read.

---

## Pitfalls

- **Storefront MCP ≠ admin.** It cannot list real orders, edit products, or read customer PII.
  If the user asks for store management, you need the Admin API (Step 2), not Step 1.
- **No first-party Admin MCP.** Don't claim one exists. The Dev MCP is docs-only; community Admin
  MCPs are third-party — vet them before handing over a `shpat_` token.
- **Wrong header.** Admin API uses `X-Shopify-Access-Token`. The Storefront API's
  `X-Shopify-Storefront-Access-Token` is a different credential for a different surface — do not mix them.
- **Token shown once.** The `shpat_` token is revealed a single time on install. If lost, the user
  must rotate (uninstall/reinstall or regenerate) — there is no "view again."
- **Scope it tight.** Grant only the access scopes the agent needs. A leaked `read_orders` token is
  bad; a leaked `write_products` + `write_orders` token is worse. Match scopes to the task in Step 0.
- **API version drift.** Admin API versions expire ~12 months after release. Pin a current
  `YYYY-MM` version and revisit; a 404/deprecation error usually means the version string aged out.
- **Rate limits.** REST uses a leaky-bucket (per-store); GraphQL uses a points/cost budget. A burst
  of agent calls can hit `429` / `THROTTLED` — the calling tool should back off, not retry tight.

---

## Verify

- **Storefront MCP:** `hermes logs` shows `registered N tool(s)` for `shopify-storefront`; a chat
  prompt like `@<agent> using shopify-storefront, find products matching "shirt"` returns catalog data.
- **Admin token (sanity check from the host, not committed anywhere):**
  ```bash
  curl -s "https://${SHOP}/admin/api/2025-01/shop.json" \
    -H "X-Shopify-Access-Token: ${TOKEN}" | head -c 200
  ```
  A JSON `shop` object = token + scopes valid. `401` = bad/expired token; `403` = missing scope.
- **Admin via MCP/tool:** trigger one read (e.g. list 1 product or 1 order) through the agent and
  confirm real data or a valid empty result comes back.

---

## Definition of done

- [ ] Store domain and required scopes confirmed with the user before any token is minted.
- [ ] Either the Storefront MCP is registered (shopping agent) or the Admin token is stored in
      `/opt/data/.env` with `chmod 600` (ops agent) — never in `config.yaml`, never in chat.
- [ ] A live call returns real store data: Storefront tool call, the `shop.json` curl, or an
      Admin read through the chosen MCP/tool.
- [ ] If an Admin path is used, it is honest about transport — a verified community MCP or a
      documented REST/GraphQL base, not "token alone = connected."
- [ ] Gateway reloaded (`gateway stop` + `gateway run`) and tools/credentials picked up.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
