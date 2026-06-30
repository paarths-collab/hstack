---
name: integration-woocommerce
description: Connect a WooCommerce store (WordPress ecommerce) to a running Hermes agent using a REST API consumer key and secret. Use when the user wants Hermes to read or update products, orders, customers, or coupons on a WooCommerce store.
---

# /integration-woocommerce — connect WooCommerce to Hermes

You are the engineer connecting WooCommerce to a running Hermes agent. WooCommerce is the
agent's product catalogue, order book, and customer record for WordPress-hosted stores.
Work autonomously; stop only for the two things a machine cannot do: minting the REST API
key pair inside the WordPress admin, and confirming the store URL is HTTPS-reachable.

**Honest auth picture (verified 2026-06):** Automattic ships an official MCP integration
for WooCommerce, but it is a **local stdio proxy** (`@automattic/mcp-wordpress-remote`) that
translates MCP calls into HTTPS requests against `https://<store>/wp-json/woocommerce/mcp`.
Auth is **not** OAuth and **not** a bearer token — it is a static `consumer_key:consumer_secret`
pair passed in the `X-MCP-API-Key` header. The endpoint is flagged a developer preview and
"may change in future releases." Because the proxy is stdio, we register it through the
Hermes stdio MCP path, not the HTTP `/hermes-mcp-add` probe flow. Path B (direct REST) is the
fallback for builds that cannot launch stdio MCP servers.

## Before you start — gather (ask once)

1. **Store base URL** — `https://<store-domain>` (HTTPS required; HTTP is rejected). The
   WooCommerce REST API lives at `<store>/wp-json/wc/v3` and the MCP endpoint at
   `<store>/wp-json/woocommerce/mcp`.
2. **REST API consumer key + secret** — mint at **WordPress admin → WooCommerce →
   Settings → Advanced → REST API → Add key**. Pick a WordPress user with the right caps
   (admin for full read/write), set **Permissions** to `Read/Write` (or `Read` for read-only
   agents), click **Generate API key**. Copy both values immediately — the secret is shown
   **once**. Keys look like `ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` and
   `cs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the secret):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
STORE_URL=https://<store>       # no trailing slash
CK=ck_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CS=cs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## Step 1 — store the credentials in the Hermes runtime .env (chmod 600)

Write all three values to `/opt/data/.env` inside the container via `hermes config set` so
Hermes owns the write. Never `echo >>` (it can merge onto a prior line) and never put
secrets in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set WOOCOMMERCE_URL "$STORE_URL"
docker exec -i -u hermes "$AGENT" hermes config set WOOCOMMERCE_CONSUMER_KEY "$CK"
docker exec -i -u hermes "$AGENT" hermes config set WOOCOMMERCE_CONSUMER_SECRET "$CS"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `3`, never the values):
```bash
docker exec "$AGENT" sh -c "grep -cE '^WOOCOMMERCE_(URL|CONSUMER_KEY|CONSUMER_SECRET)=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, use the sed-inject pattern from
> `/hermes-mcp-add`. Use the `|` delimiter — `ck_`/`cs_` tokens contain `/` and `+` in some
> WordPress generators:
> ```bash
> docker exec "$AGENT" sh -c "
>   for k in WOOCOMMERCE_URL WOOCOMMERCE_CONSUMER_KEY WOOCOMMERCE_CONSUMER_SECRET; do
>     grep -q \"^\$k=\" /opt/data/.env || printf '%s=\n' \"\$k\" >> /opt/data/.env
>   done
> "
> docker exec "$AGENT" sh -c "sed -i 's|^WOOCOMMERCE_URL=.*|WOOCOMMERCE_URL=${STORE_URL}|' /opt/data/.env"
> docker exec "$AGENT" sh -c "sed -i 's|^WOOCOMMERCE_CONSUMER_KEY=.*|WOOCOMMERCE_CONSUMER_KEY=${CK}|' /opt/data/.env"
> docker exec "$AGENT" sh -c "sed -i 's|^WOOCOMMERCE_CONSUMER_SECRET=.*|WOOCOMMERCE_CONSUMER_SECRET=${CS}|' /opt/data/.env"
> docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect WooCommerce. Pick the path that matches your Hermes build.

A static credential pair alone does **not** give the agent tools. Two verified options:

### Path A (preferred) — official stdio MCP proxy (`@automattic/mcp-wordpress-remote`)

The official proxy reads the consumer key/secret and exposes WooCommerce products / orders /
customers as MCP tools. It is a **local stdio** server (run with `npx`), so it is added to
Hermes as a command-based MCP, not via the HTTP probe flow in `/hermes-mcp-add`. The proxy
requires `WP_API_URL` and a `CUSTOM_HEADERS` JSON blob containing `X-MCP-API-Key`. Register
it if your Hermes supports stdio MCP servers:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add woocommerce \
    --command "npx" \
    --args "-y,@automattic/mcp-wordpress-remote@latest" \
    --env "WP_API_URL=${STORE_URL}/wp-json/woocommerce/mcp" \
    --env 'CUSTOM_HEADERS={"X-MCP-API-Key":"${WOOCOMMERCE_CONSUMER_KEY}:${WOOCOMMERCE_CONSUMER_SECRET}"}'
```

Use `${WOOCOMMERCE_CONSUMER_KEY}` / `${WOOCOMMERCE_CONSUMER_SECRET}` indirection so the
secrets stay only in `/opt/data/.env`.

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
> If your build is HTTP-MCP-only and cannot launch a stdio command, use Path B.

### Path B — generic HTTP tool against the WooCommerce REST API

If you cannot run the stdio proxy, point a generic HTTP/tool capability at the REST API
directly. WooCommerce REST supports HTTP Basic over HTTPS using the consumer key as
username and the consumer secret as password.

- **Base URL:** `${STORE_URL}/wp-json/wc/v3`
- **Auth:** HTTP Basic, `username=${WOOCOMMERCE_CONSUMER_KEY}` /
  `password=${WOOCOMMERCE_CONSUMER_SECRET}` (HTTPS only; over HTTP the API rejects Basic and
  requires OAuth 1.0a one-legged signing instead — do not use HTTP).
- **Content type:** `Content-Type: application/json`

Common endpoints: `GET /products`, `GET /products/{id}`, `POST /products`,
`GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/notes`, `GET /customers`,
`GET /reports/sales`.

> Do **not** try to register `${STORE_URL}/wp-json/woocommerce/mcp` through
> `/hermes-mcp-add` as if it were a bearer-token MCP — it expects the
> `X-MCP-API-Key: ck:cs` header, not `Authorization: Bearer ...`.

---

## Step 3 — reload the gateway so the new env / MCP is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new env is
re-read cleanly — same rule as `/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using HTTP instead of HTTPS | WooCommerce rejects Basic auth over plain HTTP and falls back to OAuth 1.0a signing. | Always use `https://`. Get a real cert; do not bypass. |
| 2 | Treating the MCP endpoint as bearer-auth | The proxy needs `X-MCP-API-Key: ck:cs`, not `Authorization: Bearer`. Probe flow misreads this as broken. | Use Path A stdio proxy, or Path B REST. |
| 3 | Consumer secret lost | The secret is shown **once** in the admin. Reopening the key only shows the key. | Mint, copy both, paste straight into `config set`. If lost, revoke and regenerate. |
| 4 | Permissions too narrow | A `Read` key returns `401` on writes; the agent looks broken. | Pick `Read/Write` unless the agent is intentionally read-only. |
| 5 | Server clock skew (OAuth path) | OAuth 1.0a rejects timestamps outside a 15-minute window. | Use Basic over HTTPS (no timestamp), or sync NTP on the store. |
| 6 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` / sed. |
| 7 | Pagination missed | WooCommerce REST paginates at 10 by default; agents see partial data. | Pass `per_page=100` and follow the `X-WP-TotalPages` header. |
| 8 | Security plugin blocking REST | Wordfence / iThemes can block `/wp-json/` for non-logged-in callers. | Whitelist the agent's egress IP or the REST namespace. |

---

## Verify

Confirm the credentials and a live call before declaring done.

1. **Tools registered (Path A):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*woocommerce|wordpress-remote" | tail -5
   ```
2. **Real API call returns data (works for both paths):** run inside the container so the
   credentials come from the runtime env and are never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -u "$WOOCOMMERCE_CONSUMER_KEY:$WOOCOMMERCE_CONSUMER_SECRET" \
       "$WOOCOMMERCE_URL/wp-json/wc/v3/products?per_page=1"'
   ```
   `200` = credentials valid and scoped. `401` = bad key/secret or HTTP-not-HTTPS (re-check
   step 1). `404` = WooCommerce REST not enabled on that site.
3. **End-to-end from chat:** `@<agent> list the last 3 orders in WooCommerce` should return
   real order IDs and totals.

---

## Definition of done

- [ ] `WOOCOMMERCE_URL`, `WOOCOMMERCE_CONSUMER_KEY`, `WOOCOMMERCE_CONSUMER_SECRET` are in `/opt/data/.env` with `chmod 600`; none are in `config.yaml` or chat.
- [ ] WooCommerce is connected via Path A (stdio MCP tools registered) or Path B (REST base documented and reachable).
- [ ] `GET /wp-json/wc/v3/products?per_page=1` from inside the container returns `200`.
- [ ] A chat-driven WooCommerce query (orders, products, or customers) returns real data.
- [ ] Key permissions match the agent's intended scope (`Read` vs `Read/Write`).

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
