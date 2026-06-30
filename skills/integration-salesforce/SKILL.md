---
name: integration-salesforce
description: Connect Salesforce (enterprise CRM) to a running Hermes agent — wire the official Salesforce-hosted MCP server (OAuth) or, for a headless static-credential path, store Client Credentials OAuth secrets for the REST API. Use when the user wants their Hermes agent to read or write Salesforce records, run SOQL, or trigger Flows and Apex actions.
---

# /integration-salesforce — connect Salesforce CRM to Hermes

You are the engineer connecting Salesforce to a running Hermes agent. Salesforce has a
**first-party hosted MCP server** (GA April 2026), but it is **OAuth-only** — there is no
static-token form for it. That breaks the usual one-click "paste a token" promise, so read
the two paths below and pick the honest one for the user before you touch anything.

Two real options:

- **Path A — official hosted MCP server (recommended, OAuth + PKCE).** Salesforce-managed
  endpoint, full permission enforcement. Requires a per-user browser OAuth consent. No static
  token. Wire it via `/hermes-mcp-add`.
- **Path B — headless REST API via Client Credentials (static secret).** No MCP server is
  involved. You store a connected-app client ID + secret in `/opt/data/.env` and let a generic
  HTTP tool call the Salesforce REST API. This preserves a fully-unattended setup but a bare
  secret alone does not "connect" anything — you still need a tool that speaks the REST API.

## Before you start — gather (ask once)

1. **Which path** — A (hosted MCP, OAuth, an interactive consent is acceptable) or B (headless
   REST, fully unattended, static secret).
2. **My Domain / instance URL** — `https://<mydomain>.my.salesforce.com`. Setup → My Domain.
3. **Org type** — production vs sandbox/scratch. This changes the MCP server URL prefix.
4. **Edition** — hosted MCP requires **Enterprise Edition or above**. Confirm before Path A.
5. **For Path A:** the **External Client App (ECA) consumer key + consumer secret**. Create the
   ECA at Setup → App Manager → New External Client App (classic Connected Apps are NOT
   supported for hosted MCP). Scopes: **Access MCP servers (`mcp_api`)** and **Perform requests
   at any time (`refresh_token`)**. Under Supported Authorization Flows, enable **Authorization
   Code with PKCE**; leave **Client Credentials Flow off**.
   Docs: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/create-external-client-app.html
6. **For Path B:** a **connected app / ECA consumer key + secret with Client Credentials Flow
   enabled** and an assigned **integration (run-as) user**. Mint at Setup → App Manager.
   Docs: https://help.salesforce.com/s/articleView?id=xcloud.connected_app_client_credentials_setup.htm

Never paste any secret into chat. Secrets go only in `/opt/data/.env` (chmod 600).

Set shell vars from answers:
```bash
AGENT=<container-name>                 # docker ps --format '{{.Names}}' | grep hermes
MYDOMAIN=<https://<mydomain>.my.salesforce.com>
SERVER=sobject-all                     # or sobject-reads, flows, invocable-actions, data-cloud-sql, tableau-next, prompt-builder
```

---

## Path A — official hosted MCP server (OAuth, recommended)

The hosted MCP endpoint pattern is **fixed by Salesforce** (do not run the probe matrix against
a My Domain URL — the MCP host is `api.salesforce.com`, not your org domain):

- **Production:** `https://api.salesforce.com/platform/mcp/v1/<SERVER-NAME>`
- **Sandbox / scratch:** `https://api.salesforce.com/platform/mcp/v1/sandbox/<SERVER-NAME>`

`<SERVER-NAME>` is one of the catalog servers: `sobject-all`, `sobject-reads`,
`sobject-mutations`, `sobject-deletes`, `flows`, `invocable-actions`, `data-cloud-sql`,
`tableau-next`, `prompt-builder`. Start with `sobject-reads` for least privilege; move to
`sobject-all` only when writes are required.
Reference: https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/servers-reference.html

### Step A1 — confirm the URL form for the org type

```bash
URL="https://api.salesforce.com/platform/mcp/v1/${SERVER}"           # production
# URL="https://api.salesforce.com/platform/mcp/v1/sandbox/${SERVER}" # sandbox/scratch
echo "$URL"
```

### Step A2 — wire it via /hermes-mcp-add

This server uses **OAuth 2.0 Authorization Code + PKCE**, not a bearer header with a static
token, so the standard probe-then-sed-inject flow only partly applies. Run `/hermes-mcp-add`
with these facts and let it drive registration + gateway reload:

- **MCP base URL:** the `$URL` from A1 (the `api.salesforce.com/platform/mcp/v1/...` form).
- **Auth shape:** OAuth (External Client App). Supply the **ECA consumer key** as the OAuth
  client ID and the **ECA consumer secret** as the client secret. Hermes/MCP performs the
  browser authorization-code exchange; a refresh token is stored, not a static bearer key.
- **Where the secret lives:** the ECA consumer secret is the credential to protect. If
  `/hermes-mcp-add` generates an env var for it, it will be `MCP_SALESFORCE_API_KEY` (or the
  client-secret slot of the OAuth config). Inject it with the sed-with-`|`-delimiter step from
  `/hermes-mcp-add` step 4; never `echo >>`.

The one step a machine cannot do: **the first OAuth consent is a browser redirect.** Salesforce
will prompt the run-as user to approve the ECA. Hand that URL to the user, have them approve
once, and the refresh token persists. After consent, finish with `/hermes-mcp-add` steps 5–6
(`gateway stop` + `gateway run`, then verify in logs).

---

## Path B — headless REST API (static secret, no MCP server)

No first-party MCP server supports static tokens. If the user needs a fully-unattended setup,
use the **OAuth 2.0 Client Credentials flow** against the Salesforce REST API. This is a real,
Salesforce-supported headless pattern: the connected app's client ID + secret are exchanged for
a short-lived access token at the org token endpoint; no browser, no user interaction.
Docs: https://help.salesforce.com/s/articleView?id=xcloud.remoteaccess_oauth_client_credentials_flow.htm

### Step B1 — store the client ID and secret in /opt/data/.env

```bash
docker exec "$AGENT" sh -c \
  'hermes config set SF_INSTANCE_URL "'"$MYDOMAIN"'" && \
   hermes config set SF_CLIENT_ID "<ECA-consumer-key>" && \
   hermes config set SF_CLIENT_SECRET "<ECA-consumer-secret>" && \
   chmod 600 /opt/data/.env'
```

If `hermes config set` is unavailable, fall back to the `/hermes-mcp-add` sed-inject pattern
(`sed -i 's|^SF_CLIENT_SECRET=.*|...|' /opt/data/.env`, `|` delimiter, then `chmod 600`).
Never `echo >>` — it can merge lines.

### Step B2 — confirm the credentials actually mint a token

```bash
docker exec "$AGENT" sh -c '
  . /opt/data/.env
  curl -sS -X POST "$SF_INSTANCE_URL/services/oauth2/token" \
    -d grant_type=client_credentials \
    -d client_id="$SF_CLIENT_ID" \
    -d client_secret="$SF_CLIENT_SECRET" | head -c 200
'
```

A JSON body with `"access_token"` and `"instance_url"` means the flow works. An
`invalid_client` or `inactive` error means the connected app has Client Credentials Flow
disabled or no integration user assigned — fix in Setup before continuing.

### Step B3 — state the honest gap

A stored secret does **not** by itself give the agent Salesforce tools. To act on the REST API
the agent needs either:
- a generic HTTP/REST MCP or tool pointed at `$SF_INSTANCE_URL/services/data/vXX.0/` using the
  token from B2 as `Authorization: Bearer <access_token>`, or
- a clearly-maintained community Salesforce MCP server.

**No first-party static-token MCP server is verified as of 2026-06.** Community local (stdio)
options exist — e.g. the official CLI-based `@salesforce/mcp` npm package
(https://github.com/salesforcecli/mcp), which runs locally via `npx -y @salesforce/mcp` and
relies on Salesforce CLI org auth rather than a header token, so it does not fit the remote-HTTP
`/hermes-mcp-add` wiring. Do not present a bare key as a finished connection.

---

## Pitfalls

- **The hosted MCP server is OAuth-only.** Client Credentials Flow is explicitly disabled for
  it; there is no static bearer token to paste. If the user insists on zero interaction, that is
  Path B (REST), not the MCP server.
- **MCP host is `api.salesforce.com`, not your My Domain.** A common 404/405 cause is pointing
  the client at `https://<mydomain>.my.salesforce.com/...mcp`. Use the
  `api.salesforce.com/platform/mcp/v1/...` form, with the `sandbox/` segment for non-production.
- **External Client App, not classic Connected App.** Hosted MCP requires an ECA. A classic
  Connected App will authenticate but the MCP server will reject it.
- **Missing scopes.** Without both `mcp_api` and `refresh_token`, OAuth completes but tool calls
  fail. Re-check the ECA OAuth scopes.
- **Client Credentials needs a run-as user.** Path B fails with `inactive`/`invalid_client` if
  no integration user is assigned to the connected app, or if that user lacks the object
  permissions you expect — the agent inherits exactly that user's FLS and sharing.
- **Token lifetime.** Client Credentials issues short-lived access tokens with **no refresh
  token**; the tool must re-POST to `/services/oauth2/token` when it expires (per Salesforce
  docs). Do not cache a token as if it were static.
- **API limits.** Salesforce enforces per-org daily API request limits; a chatty agent can
  exhaust them. Prefer SOQL with selective filters over broad record scans.
- **Least privilege.** Default to `sobject-reads` (Path A) before granting `sobject-all`.

## Verify

- **Path A:** after consent + gateway reload, `/hermes-mcp-add` step 6 — `hermes logs` shows
  `registered N tool(s)` for the Salesforce MCP. Then from chat: `@<agent> using salesforce,
  query the 5 most recent Accounts`. A populated or empty-but-valid result is a pass.
- **Path B:** Step B2 returns an `access_token`, and a real REST read returns rows, e.g.:
  ```bash
  docker exec "$AGENT" sh -c '
    . /opt/data/.env
    TOK=$(curl -sS -X POST "$SF_INSTANCE_URL/services/oauth2/token" \
      -d grant_type=client_credentials -d client_id="$SF_CLIENT_ID" \
      -d client_secret="$SF_CLIENT_SECRET" | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
    curl -sS -H "Authorization: Bearer $TOK" \
      "$SF_INSTANCE_URL/services/data/v60.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+5"
  '
  ```
  A JSON body with a `records` array is a pass.

## Definition of done

- [ ] Path chosen and the OAuth-vs-static tradeoff stated plainly to the user.
- [ ] Secrets live only in `/opt/data/.env` with `chmod 600`; nothing in `config.yaml` or chat.
- [ ] Path A: hosted MCP registered via `/hermes-mcp-add`, first OAuth consent completed, logs
      show registered tools; or Path B: token endpoint returns an `access_token` and a REST read
      returns rows.
- [ ] Least-privilege server/user confirmed (`sobject-reads` or a scoped integration user).
- [ ] A real call returns data (or a valid empty result) end to end.

See `reference/TROUBLESHOOTING.md` for gateway reload, OAuth consent, and MCP registration failure modes.
