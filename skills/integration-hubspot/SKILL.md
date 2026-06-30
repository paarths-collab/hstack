---
name: integration-hubspot
description: Connect HubSpot CRM to a running Hermes agent so it can read and create contacts, companies, deals, and tasks. Use when the user wants their Hermes agent to work with their HubSpot sales CRM.
---

# /integration-hubspot — connect HubSpot to Hermes

You are the engineer connecting HubSpot to a running Hermes agent. HubSpot is a sales CRM; once
wired, the agent can list and create contacts, companies, deals, and tasks, and read associated
records from chat.

Read the honest constraint first: HubSpot ships a **first-party remote MCP server, but it is
OAuth-only** (`https://mcp.hubspot.com`, went GA 2026-04-13). It requires the OAuth 2.0 / 2.1
authorization-code flow with PKCE against a registered MCP auth app — there is no static-bearer
or API-key mode. A headless Hermes container cannot complete that browser-based handshake
unattended, so it breaks the one-click, paste-a-token promise. This skill therefore wires
HubSpot via its **REST API using a Private App access token** — a static, non-expiring,
scope-limited credential that needs no browser. If the user genuinely wants the OAuth MCP, that
is a manual client-side setup outside this skill (see Pitfalls).

## Before you start — gather (ask once)

1. **HubSpot Private App access token** — the static credential. The user mints it in the
   HubSpot UI: **Settings (gear icon, top right)** -> **Integrations** -> **Private Apps** ->
   **Create a private app** -> on the **Scopes** tab select the CRM scopes (least privilege:
   `crm.objects.contacts.read`/`.write`, `crm.objects.companies.read`/`.write`,
   `crm.objects.deals.read`/`.write` and add `crm.objects.tasks` scopes if the agent should
   manage tasks) -> **Create app** -> on the **Auth** tab click **Show token** and **Copy**.
   The token is shown once. Format is `pat-na1-...` (US data center) or `pat-eu1-...` (EU); treat
   it as opaque and store it like a password. Docs:
   `https://developers.hubspot.com/docs/guides/apps/private-apps/overview`
2. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers:
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<hubspot-pat>        # pat-na1-... or pat-eu1-...; never log or commit; injected via sed below
```

---

## Step 1 — validate the token against the live REST API

The HubSpot REST base is `https://api.hubapi.com`; the token goes in
`Authorization: Bearer <token>`. The token embeds the data center, so the same base host works
for both `pat-na1-` and `pat-eu1-` tokens. Confirm the credential works before storing it.

```bash
curl -sS -o /dev/null -w "contacts = %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false"
```

- `200` -> the token is valid and has at least contacts-read scope.
- `401` -> token is wrong, revoked, or pasted with stray whitespace.
- `403` -> token is valid but missing the scope for this object; add the scope in the Private
  App **Scopes** tab and re-copy the token (editing scopes does not change the token value, but
  re-confirm in the UI).

Optionally confirm the token's granted scopes (substitute the real token; this endpoint reports
the scopes attached to the token):
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.hubapi.com/oauth/v1/access-tokens/$TOKEN" | head -c 800
```

---

## Step 2 — write the token into the Hermes runtime env (no static-token MCP verified)

**No first-party static-token MCP server is verified as of 2026-06.** The official MCP server
(`https://mcp.hubspot.com`) is OAuth-only with PKCE, so we store the Private App token for
REST/tool use instead of running the /hermes-mcp-add procedure.

Write the secret into `/opt/data/.env` inside the container using `hermes config set`, then lock
the file down. The secret never goes in `config.yaml` and never into chat.

```bash
docker exec -i -u hermes "$AGENT" \
  hermes config set HUBSPOT_ACCESS_TOKEN "$TOKEN"

docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

If your Hermes build does not support `hermes config set` for arbitrary keys, fall back to the
safe sed-inject pattern from /hermes-mcp-add — append the key once, then set the value with `|`
as the sed delimiter (the token contains `-` and may contain other punctuation), and
`chmod 600`. **Never use `echo >>`** (it merges onto the previous line if that line lacks a
trailing newline):

```bash
docker exec "$AGENT" sh -c '
  grep -q "^HUBSPOT_ACCESS_TOKEN=" /opt/data/.env \
    || printf "\nHUBSPOT_ACCESS_TOKEN=\n" >> /opt/data/.env
'
docker exec "$AGENT" sh -c \
  "sed -i 's|^HUBSPOT_ACCESS_TOKEN=.*|HUBSPOT_ACCESS_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Confirm the key landed (prints the count, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^HUBSPOT_ACCESS_TOKEN=' /opt/data/.env"   # should print 1
```

---

## Step 3 — give the agent a way to call the API, then reload the gateway

The token alone does not connect anything — the agent needs a tool that reads
`HUBSPOT_ACCESS_TOKEN` and hits the REST API. Two honest options:

- **Option A — community remote MCP server.** No first-party static-token MCP exists (the
  official `https://mcp.hubspot.com` is OAuth-only). Community HubSpot MCP servers that accept a
  Private App token via env exist (e.g. the project listed at
  `https://www.pulsemcp.com/servers/hubspot` and similar npm/Glama-indexed servers). Most are
  stdio/Node servers, not hosted HTTP endpoints, so they are not a drop-in for /hermes-mcp-add
  (which wires remote HTTP MCP). Use one only if you self-host it behind an HTTP transport and
  have vetted the code; treat it as third-party.
- **Option B — generic REST tool (recommended default).** Point a generic HTTP/tool action at
  the documented REST API. Base URL `https://api.hubapi.com`, auth header
  `Authorization: Bearer ${HUBSPOT_ACCESS_TOKEN}`. Common endpoints:
  - `GET /crm/v3/objects/contacts?limit=10` — list contacts
  - `GET /crm/v3/objects/companies?limit=10` — list companies
  - `GET /crm/v3/objects/deals?limit=10` — list deals
  - `POST /crm/v3/objects/contacts` with `{"properties":{"email":"...","firstname":"..."}}`
  - `POST /crm/v3/objects/deals` with `{"properties":{"dealname":"...","pipeline":"...","dealstage":"..."}}`
  - `POST /crm/v3/objects/contacts/search` with a `filterGroups` body for lookups by property

If wiring a verified remote HTTP MCP later, run /hermes-mcp-add with `--auth header`,
`Authorization: Bearer ${MCP_HUBSPOT_API_KEY}`, and inject the Private App token into
`MCP_HUBSPOT_API_KEY` — but only after the probe matrix confirms that server accepts a static
bearer (the official one does not).

Reload the gateway so the new env is picked up (env is read once at startup; `restart` is not
reliably env-reload-clean in Hermes — use stop + run):

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

- **Official MCP is OAuth-only.** `https://mcp.hubspot.com` needs the OAuth 2.0 / 2.1
  authorization-code flow with PKCE and a registered MCP auth app; a headless container cannot
  complete the browser handshake. Do not configure it as a static-bearer MCP — the handshake
  will fail. Static API keys are not accepted by that server.
- **Legacy API keys are dead.** HubSpot deprecated account-level API keys; only OAuth and
  Private App access tokens work. Do not try to use an old `hapikey` query param.
- **Scope errors look like `403`, not `401`.** A `401` means a bad/revoked token; a `403` means
  the token is valid but lacks the scope for that object (contacts vs companies vs deals vs
  tasks). Fix by adding the scope in the Private App **Scopes** tab.
- **Token carries the app's full granted scope.** A Private App token acts with exactly the
  scopes you selected, account-wide. For least privilege, grant only the CRM objects the agent
  needs and create the app from an admin who should own that access.
- **Token is opaque; no expiry but revocable.** Private App tokens do not expire and need no
  refresh flow, but an admin can delete the app or rotate the token at any time — that shows up
  as `401`. Do not parse or pattern-match the token beyond the `pat-na1-`/`pat-eu1-` prefix.
- **Rate limits.** Private apps allow ~190 requests / 10s per app (burst), with daily caps that
  vary by subscription tier; a `429 Too Many Requests` includes a `Retry-After` header. Back off
  and retry; do not hammer.
- **Two `.env` files.** The Hermes runtime secret belongs in `/opt/data/.env` (inside the
  container), not the host compose `.env`. Putting it in the wrong file means the agent never
  sees it.

## Verify

```bash
# 1. Secret present and locked down (value never printed)
docker exec "$AGENT" sh -c "grep -c '^HUBSPOT_ACCESS_TOKEN=' /opt/data/.env"   # 1
docker exec "$AGENT" sh -c "ls -l /opt/data/.env"                              # -rw------- (600)

# 2. Live API call from inside the container using the stored token
docker exec -u hermes "$AGENT" sh -c '
  . /opt/data/.env
  curl -sS -o /dev/null -w "hubspot contacts = %{http_code}\n" \
    -H "Authorization: Bearer $HUBSPOT_ACCESS_TOKEN" \
    "https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false"
'   # expect 200
```

Then prove it end-to-end from chat:
```
@<agent> list my 5 most recent HubSpot contacts
```
A valid empty list is a pass — every layer worked. A `401` means the token did not land
(re-check Step 2); a `403` means a missing scope (add it in the Private App Scopes tab); a `429`
means rate-limited (back off).

## Definition of done

- [ ] Private App token validated against `https://api.hubapi.com/crm/v3/objects/contacts` (returns `200`).
- [ ] `HUBSPOT_ACCESS_TOKEN` stored in `/opt/data/.env` with `chmod 600`; not in `config.yaml`, not in chat.
- [ ] Gateway reloaded with stop + run; container can read `$HUBSPOT_ACCESS_TOKEN`.
- [ ] Agent returns real HubSpot CRM data (contacts/companies/deals) from a chat request, or a valid empty result.
- [ ] OAuth-only MCP caveat communicated to the user (no static-token first-party MCP as of 2026-06).

See `reference/TROUBLESHOOTING.md` for gateway reload and `.env` resolution failure modes.
