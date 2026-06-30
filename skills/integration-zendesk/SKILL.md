---
name: integration-zendesk
description: Connect Zendesk (support tickets, users, organizations, macros) to a running Hermes agent using a static API token. Use when the user wants Hermes to read, search, create, comment on, or update Zendesk tickets.
---

# /integration-zendesk — connect Zendesk to Hermes

You are the engineer connecting Zendesk to a running Hermes agent. Zendesk is the agent's
support-ticket surface: search tickets, fetch a conversation, post internal/public comments,
update status, look up users and organizations. Work autonomously; stop only for the two
things a machine cannot do: minting the API token in Admin Center, and naming the subdomain.

**Honest auth picture (verified 2026-06):** Zendesk does **not** ship a first-party remote MCP
server with bearer-token auth. Their **MCP Client** (Hermes calling external MCP servers from
inside Zendesk) is in early access, and a first-party **MCP Server** is announced for EAP in
summer 2026 — not GA, no documented endpoint, no headless auth shape yet. So we wire the REST
API directly with a static **API token** (Basic auth, email + `/token` suffix). This is the
auth model Zendesk's own developer docs document for server-side automation.

## Before you start — gather (ask once)

1. **Zendesk subdomain** — the prefix in `https://<subdomain>.zendesk.com`. Example: if your
   help center is `https://acme.zendesk.com`, the subdomain is `acme`.
2. **Admin email** — the email of the account that owns the API token. Tokens authenticate
   as `<email>/token:<api_token>`; the email is part of the credential, not just a label.
3. **API token** — mint at **Admin Center** → **Apps and integrations** → **APIs** →
   **Zendesk API** → **Settings** tab → enable **Token access** → **Add API token** → copy
   the value (shown once). Requires an admin role.
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
ZENDESK_SUBDOMAIN=<subdomain>   # e.g. acme
ZENDESK_EMAIL=<admin-email>     # e.g. ops@acme.com
ZENDESK_API_TOKEN=<token>       # the secret; injected via sed, never echoed
```

---

## Step 1 — store the credentials in the Hermes runtime .env (chmod 600)

Write all three values to `/opt/data/.env` inside the container via `hermes config set` so
Hermes owns the write. Never `echo >>` (it can merge onto a prior line) and never put the
token in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set ZENDESK_SUBDOMAIN "$ZENDESK_SUBDOMAIN"
docker exec -i -u hermes "$AGENT" hermes config set ZENDESK_EMAIL "$ZENDESK_EMAIL"
docker exec -i -u hermes "$AGENT" hermes config set ZENDESK_API_TOKEN "$ZENDESK_API_TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `3`, never the values):
```bash
docker exec "$AGENT" sh -c "grep -cE '^(ZENDESK_SUBDOMAIN|ZENDESK_EMAIL|ZENDESK_API_TOKEN)=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add`. Use the `|` delimiter because email and token contain `/`, `+`, `=`:
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^ZENDESK_API_TOKEN=' /opt/data/.env || printf 'ZENDESK_API_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^ZENDESK_API_TOKEN=.*|ZENDESK_API_TOKEN=${ZENDESK_API_TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — wire Zendesk REST as a generic HTTP tool

No bearer-auth remote MCP exists for Zendesk yet (see top). Point a generic HTTP/tool
capability at the REST API directly. These are the values Hermes needs:

- **Base URL:** `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`
- **Auth header:** `Authorization: Basic <base64 of "${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}">`
- **Content type:** `Content-Type: application/json`

The literal `/token` suffix on the email is required — it tells Zendesk to treat the password
slot as an API token instead of an account password. Without it, requests 401 even with a
valid token.

Common endpoints:
- `GET /tickets/{id}.json` — fetch a ticket
- `GET /tickets/{id}/comments.json` — full conversation
- `PUT /tickets/{id}.json` — update status, assignee, tags, add a comment
- `POST /tickets.json` — create a ticket
- `GET /search.json?query=...` — search tickets, users, orgs (use `type:ticket status:open`)
- `GET /users/me.json` — cheap auth-check endpoint (used in Verify)
- `GET /users/search.json?query=...` — find a user by email or name

> When the official Zendesk MCP Server exits EAP (announced for summer 2026), swap this
> step for `/hermes-mcp-add` against the documented endpoint and pipe `placeholder` then
> `sed`-inject `MCP_ZENDESK_API_KEY`. Until then, REST is the verified headless path.

---

## Step 3 — reload the gateway so the new env is picked up

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
| 1 | Token used without the `/token` email suffix | Zendesk treats the password slot as an account password and 401s. | Credential string must be `<email>/token:<api_token>` then base64. |
| 2 | Trying to wire a Zendesk first-party remote MCP today | The MCP Server is announced for EAP summer 2026, not GA. No documented bearer endpoint. | Use REST until Zendesk publishes the endpoint and auth shape. |
| 3 | Token access disabled in Admin Center | The token exists but every call 401s. | In Admin Center → APIs → Zendesk API → Settings, toggle **Token access** on. |
| 4 | Wrong subdomain | `https://help.acme.com` (host-mapped) still calls the API as `acme.zendesk.com`. | Use the original `*.zendesk.com` subdomain, not the vanity domain. |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → not loaded by Hermes runtime, or world-readable. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 6 | Token owner role too low | Non-admin tokens can read but not modify tickets; some endpoints 403. | Mint the token under an admin account. |
| 7 | Rate limits | Zendesk throttles per-minute per-account; bursts return `429` with `Retry-After`. | Backoff on `429`; batch reads via `/search.json` and `include=` sideloads. |
| 8 | `Bearer` instead of `Basic` | Bearer is for OAuth access tokens, not API tokens. | API tokens use `Basic <base64>`; only OAuth uses `Bearer`. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Vars present:**
   ```bash
   docker exec "$AGENT" sh -c "grep -cE '^(ZENDESK_SUBDOMAIN|ZENDESK_EMAIL|ZENDESK_API_TOKEN)=' /opt/data/.env"
   ```
   Expect `3`.

2. **Auth check via REST** — run inside the container so the secret stays in the runtime env
   and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     CRED=$(printf "%s/token:%s" "$ZENDESK_EMAIL" "$ZENDESK_API_TOKEN" | base64 -w0)
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Basic $CRED" \
       -H "Content-Type: application/json" \
       "https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json"'
   ```
   `200` = subdomain + email + token all valid. `401` = bad credential (re-check step 1,
   confirm `/token` suffix, confirm Token access is on). `404` = wrong subdomain.

3. **Real ticket search:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     CRED=$(printf "%s/token:%s" "$ZENDESK_EMAIL" "$ZENDESK_API_TOKEN" | base64 -w0)
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Basic $CRED" \
       "https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/search.json?query=type:ticket+status:open"'
   ```
   `200` = read scope works.

4. **End-to-end from chat:** `@<agent> show me open Zendesk tickets` should return real
   results. An empty result on a quiet instance is still a pass for the wiring.

---

## Definition of done

- [ ] `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` are in `/opt/data/.env` with `chmod 600`; none are in `config.yaml` or chat.
- [ ] Token access is enabled in Admin Center and the token owner has admin role.
- [ ] `GET /users/me.json` from inside the container returns `200`.
- [ ] `GET /search.json?query=type:ticket+status:open` returns `200`.
- [ ] A chat-driven Zendesk ticket query returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload, base64 credential, and Basic-vs-Bearer auth failure modes.
