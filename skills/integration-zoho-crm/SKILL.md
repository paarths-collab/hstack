---
name: integration-zoho-crm
description: Connect Zoho CRM to a running Hermes agent so it can read and write leads, contacts, deals, and accounts. Use when an SMB user wants their Hermes agent to act on their Zoho CRM data.
---

# /integration-zoho-crm — connect Zoho CRM to Hermes

You are the engineer connecting Zoho CRM to a running Hermes agent. Zoho ships a first-party,
remote, hosted MCP server (the **Zoho MCP** product) whose per-server URL carries an embedded
secret key. That fits the hstack one-click promise: the user creates a server in the Zoho MCP
console, copies one URL, and you wire it via `/hermes-mcp-add`. Do everything autonomously; stop
only for the things a machine cannot do — creating the Zoho MCP server in the console, choosing
which CRM tools to enable, and the interactive OAuth approval if the user picks on-demand auth.

There is **no static API key for the raw Zoho CRM REST API** — that path is OAuth 2.0 only
(1-hour access tokens + a long-lived refresh token). Prefer the MCP path. Only fall back to the
REST API if the user cannot or will not use Zoho MCP.

## Before you start — gather (ask once)

1. **Zoho MCP Server URL** — the user creates this at <https://mcp.zoho.com>:
   - Create a server, add the **CRM** tools they want (records: create/read/update/delete across
     standard and custom modules), then open the **Connect** tab and copy the **MCP Server URL**.
   - This URL **contains the secure API key** ("Treat your MCP Server URL as you would your
     password"). It is regeneratable from the same screen if it ever leaks.
   - The URL is the credential. Never paste it into chat in full, never put it in `config.yaml`.
2. **Auth mode chosen in the console** — either:
   - **Authorization on demand** (each user logs in to Zoho via browser on first tool call), or
   - **Authorization via Connections** (admin shares OAuth access/refresh tokens org-wide so calls
     are pre-authorized — the better fit for an always-on agent).
   Pick **Connections** for an unattended Hermes agent so tool calls don't block on a browser login.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.
4. **Region** — Zoho is multi-DC (`.com`, `.eu`, `.in`, `.com.au`, `.jp`). The console hands you a
   region-correct URL automatically; just confirm the user copied it from the account that owns the CRM.

Set shell vars from the answers (run on the host):
```bash
AGENT=<container-name>           # e.g. hermes-agent-mxlc-hermes-agent-1
NAME=zoho-crm                    # env var becomes MCP_ZOHO_CRM_API_KEY
ZOHO_MCP_URL=<full-mcp-server-url-from-console>   # secret: contains embedded key
```

---

## Step 1 (happy path) — wire the Zoho MCP server via /hermes-mcp-add

The Zoho MCP URL is a remote HTTPS MCP endpoint with the key baked into the URL, so the auth shape
is **the URL itself** — there is usually no separate bearer header. Run the full **`/hermes-mcp-add`**
procedure; do not re-implement it. The only Zoho-specific deviations:

- **Probe form (mcp-add step 1):** the working variant is almost always **B — bare POST to the URL**
  (`-X POST "$ZOHO_MCP_URL"`), because the secret already lives in the path/query of the URL. Do not
  append a token; the URL is complete as copied. Confirm `initialize` returns a JSON-RPC `result`.
- **Auth enforcement (mcp-add step 2):** call `tools/list` against the URL. A valid tool list (CRM
  record tools) is the pass. If you instead get an OAuth/authorize prompt in the response, the server
  was created in **Authorization on demand** mode — see Pitfalls; switch the console to **Connections**
  or complete the one-time interactive auth, then re-probe.
- **Register (mcp-add step 3):** because the credential is in the URL, store it as a URL secret rather
  than a header. Register with `--auth none` and keep the secret out of `config.yaml` by referencing an
  env var for the URL:
  ```bash
  printf 'n\n' | \
    docker exec -i -u hermes "$AGENT" \
      hermes mcp add "$NAME" \
        --url '${MCP_ZOHO_CRM_URL}' \
        --auth none
  ```
  This writes a `config.yaml` block whose `url` is the `${MCP_ZOHO_CRM_URL}` placeholder, and seeds
  that var in `/opt/data/.env`. If your Hermes build does not expand env vars inside `url:`, fall back
  to header auth: register `--auth header` with header name `Authorization` and inject the **bearer
  form** of the key only if Zoho's Connect tab shows a separate header (most do not — the key is in the URL).
- **Inject the real secret (mcp-add step 4):** sed the real URL into `/opt/data/.env`, `|` delimiter
  (the URL contains `/`, `?`, `=`), then `chmod 600`:
  ```bash
  docker exec "$AGENT" sh -c \
    "sed -i 's|^MCP_ZOHO_CRM_URL=.*|MCP_ZOHO_CRM_URL=${ZOHO_MCP_URL}|' /opt/data/.env && chmod 600 /opt/data/.env"
  ```
  If you used the header fallback instead, the var Hermes generated is `MCP_ZOHO_CRM_API_KEY`; inject
  there with the same `|`-delimited sed.
- **Reload (mcp-add step 5):** `gateway stop` → `sleep 3` → `gateway run` → `sleep 8`. Not `restart`.
- **Verify (mcp-add step 6):** see Verify below.

---

## Step 2 (fallback) — no MCP: document the REST API for a generic tool

Use this only if the user refuses Zoho MCP. **No static-API-key path exists for the raw Zoho CRM
REST API as of 2026-06** — it is OAuth 2.0 only. A bare key in `.env` does **not** connect anything;
you must also stand up a tool/bridge that performs the OAuth refresh-token exchange per call.

1. Register an OAuth client in the Zoho API Console (<https://api-console.zoho.com>) → "Self Client"
   or "Server-based Application". Capture the **Client ID** and **Client Secret**. Generate a
   **refresh token** with scope `ZohoCRM.modules.ALL` (or narrower, e.g. `ZohoCRM.modules.leads.READ`).
2. Store the three secrets in `/opt/data/.env`, never `config.yaml`:
   ```bash
   docker exec -u hermes "$AGENT" hermes config set ZOHO_CRM_CLIENT_ID '<client-id>'
   docker exec -u hermes "$AGENT" hermes config set ZOHO_CRM_CLIENT_SECRET '<client-secret>'
   docker exec -u hermes "$AGENT" hermes config set ZOHO_CRM_REFRESH_TOKEN '<refresh-token>'
   docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
   ```
   (Use `hermes config set`, never `echo >>`.)
3. The bridge must, per call: exchange the refresh token for a 1-hour access token, then call the API.
   - Token exchange: `POST https://accounts.zoho.com/oauth/v2/token` with
     `refresh_token`, `client_id`, `client_secret`, `grant_type=refresh_token` (swap `.com` for the
     account's region DC, e.g. `accounts.zoho.eu`).
   - API base: the token response returns `api_domain` (production `https://www.zohoapis.com`;
     region variants `.eu`, `.in`, `.com.au`, `.jp`). Example call:
     `GET {api_domain}/crm/v8/Leads`.
   - **Auth header is `Authorization: Zoho-oauthtoken <access_token>` — NOT `Bearer`.** This is the
     single most common Zoho integration mistake.

A community MCP server exists (`junnaisystems/zoho-crm-mcp` on GitHub, OAuth-based) but it is not
first-party and not verified here for production use; only adopt it after you read its source. Prefer
Step 1.

---

## Pitfalls

- **`Zoho-oauthtoken`, not `Bearer`.** The REST API rejects `Authorization: Bearer ...`. The required
  value is literally `Zoho-oauthtoken <access_token>`. (Verified: Zoho CRM API v8 Access/Refresh docs.)
- **The MCP URL is the secret.** Zoho embeds the key in the server URL. Treat it like a password:
  never in `config.yaml`, never the full URL in chat. Regenerate it from the Connect tab if leaked.
- **On-demand auth blocks an unattended agent.** "Authorization on demand" opens a browser login on
  first tool use — a person must click. For a 24/7 Hermes agent choose **Authorization via Connections**
  in the console so tokens are pre-shared and calls don't hang.
- **Region mismatch (multi-DC).** A `.com` token/URL will not work against `.eu`/`.in`/`.com.au`/`.jp`
  data and vice-versa. Always use the URL/`api_domain` for the DC that owns the CRM org. Symptom:
  `INVALID_TOKEN` or empty results despite valid auth.
- **Access token is 1 hour.** If you cache a raw access token it dies in 60 minutes. Always drive from
  the refresh token (fallback path) or let the MCP server manage token lifecycle (happy path).
- **API credits / rate limits.** MCP tool calls consume the same Zoho API credits as direct API calls
  and are scoped to the authorizing user's CRM permissions. A low-privilege user yields empty reads,
  not errors — confirm the connected user can see the records you expect.
- **Scopes are operation-specific.** `...modules.leads.READ` cannot create. If writes fail with a
  permission error, the OAuth grant lacks `CREATE`/`ALL` scope; re-mint the refresh token with the
  right scope (e.g. `ZohoCRM.modules.ALL`).

## Verify

```bash
# 1. Tools registered after reload
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server '${NAME}'" | tail -5
```
Success looks like `MCP server 'zoho-crm' (HTTP): registered N tool(s): ...` listing CRM record tools.

```bash
# 2. Live tools/list against the MCP URL (proves auth + region are correct)
curl -sS -X POST \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  "$ZOHO_MCP_URL" | head -c 400
```

End-to-end from chat: `@<agent> using zoho-crm, list my 5 most recent leads`. A real record set is a
pass. An **empty but valid** result (`{"data":[]}`) is also a pass — every layer worked; the connected
user simply has no matching records. A `Zoho-oauthtoken`/`INVALID_TOKEN` error means region or auth is
wrong (re-check Pitfalls).

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for `zoho-crm` after `gateway stop`+`run`.
- [ ] The Zoho MCP Server URL lives only in `/opt/data/.env` (as `MCP_ZOHO_CRM_URL`), `chmod 600`; it is **not** in `config.yaml` and was never pasted in full into chat.
- [ ] A chat tool call returns CRM data (or a valid empty set) for the correct Zoho data center.
- [ ] If the REST fallback was used: client id/secret/refresh token are in `/opt/data/.env` (chmod 600) and the bridge sends `Authorization: Zoho-oauthtoken <token>`, not `Bearer`.
- [ ] See `reference/TROUBLESHOOTING.md` for gateway, region, and MCP auth failure modes.
