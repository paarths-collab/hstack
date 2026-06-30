---
name: integration-microsoft-365
description: Connect a Hermes agent to Microsoft 365 (Outlook, Teams, OneDrive, SharePoint, Excel) via Microsoft Graph. Use when the user wants their agent to read or act on their M365 mail, calendar, files, or Teams chats.
---

# /integration-microsoft-365 — connect Microsoft 365 (Graph) to Hermes

You are the engineer connecting Microsoft 365 to a running Hermes agent. The user wants the
agent to reach Outlook mail/calendar, Teams, OneDrive, SharePoint, and Excel through the
Microsoft Graph API. Do everything autonomously; stop only for the things a machine cannot do:
registering the Microsoft Entra app, granting admin consent, and (for OAuth device-code login)
the one-time interactive sign-in.

**Be honest with the user up front about two facts you cannot engineer around:**

1. **Microsoft 365 / Graph is OAuth, not a static API key.** There is no "paste one key and
   you're connected" path. Every call rides a short-lived OAuth bearer token minted from an
   Entra app registration. You can make this near-set-and-forget with the client-credentials
   (app-only) flow + a client secret, but you cannot reduce it to a single static key.
2. **No first-party remote MCP server covers the M365 productivity surface as of 2026-06.**
   Microsoft ships an official remote MCP server, but it is preview, read-only, and limited to
   Entra identity/directory data — not Outlook, Teams, OneDrive, SharePoint, or Excel. See
   "Step 1 — pick the path" for the honest options.

## Before you start — gather (ask once)

You are registering (or reusing) a Microsoft Entra app. From the
[Microsoft Entra admin center → App registrations](https://entra.microsoft.com) the user (an
Application Administrator or Cloud Application Administrator) creates one app and hands you:

1. **Directory (tenant) ID** — GUID on the app's Overview page. Goes in `MS365_MCP_TENANT_ID`.
2. **Application (client) ID** — GUID on the app's Overview page. Goes in `MS365_MCP_CLIENT_ID`.
3. **Client secret** — minted under the app's **Certificates & secrets → New client secret**.
   This is the credential. Copy the secret **Value** (not the Secret ID) the moment it is shown;
   Entra never displays it again. Goes in `MS365_MCP_CLIENT_SECRET`.
4. **Graph permissions consented** — under **API permissions** add Microsoft Graph permissions
   and click **Grant admin consent**. For app-only (client-credentials) use **Application**
   permissions, e.g. `Mail.Read`, `Files.Read.All`, `Sites.Read.All`, `ChannelMessage.Read.All`.
   Token format: an opaque/JWT bearer string; never decode or validate it (it is not your API).

Docs the user mints these from:
- App registration + client credentials: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
- Graph permissions reference: https://learn.microsoft.com/en-us/graph/permissions-reference

Set shell vars (placeholders — never echo the secret to logs or chat):
```bash
AGENT=<container-name>           # docker ps --format '{{.Names}}' | grep hermes
TENANT_ID=<directory-tenant-id>
CLIENT_ID=<application-client-id>
CLIENT_SECRET=<client-secret-value>
```

---

## Step 1 — pick the path (state it plainly to the user)

**No first-party MCP server is verified for the M365 productivity surface as of 2026-06.**
Two honest options:

- **Path A (recommended) — community MCP server `@softeria/ms-365-mcp-server`.** Maintained,
  200+ tools mapping to Graph endpoints, covers Outlook, Teams, OneDrive, SharePoint, and Excel.
  Runs over HTTP (`--http`) so Hermes can wire it via /hermes-mcp-add. Source and docs:
  https://github.com/softeria/ms-365-mcp-server (package `@softeria/ms-365-mcp-server`).
  This is a community project, not Microsoft-published — say so to the user.
- **Path B — official Microsoft MCP Server for Enterprise** at
  `https://mcp.svc.cloud.microsoft/enterprise`. First-party and remote, but **preview**,
  **read-only**, and scoped to **Entra identity/directory data only** (users, groups, devices,
  sign-in/audit reports) — it does **not** expose mail, files, Teams messages, or Excel. Use
  this only if the user's real goal is identity/admin reporting, not productivity data. Docs:
  https://learn.microsoft.com/en-us/graph/mcp-server/overview

Do not pretend a credential alone connects M365 — a credential plus a tool layer (an MCP server)
is what makes the agent able to call Graph.

---

## Step 2 (Path A) — run the Softeria MCP server in HTTP mode with app-only auth

Run the community server next to Hermes so it exposes an HTTP MCP endpoint the agent can reach.
App-only (organization) mode uses the client secret you gathered — no interactive login, which
keeps it closest to set-and-forget.

```bash
# Write the three Entra values to the Hermes runtime env, then chmod 600.
# Use "hermes config set" (never "echo >>") so the file is written safely.
docker exec -u hermes "$AGENT" hermes config set MS365_MCP_TENANT_ID "$TENANT_ID"
docker exec -u hermes "$AGENT" hermes config set MS365_MCP_CLIENT_ID "$CLIENT_ID"
docker exec -u hermes "$AGENT" hermes config set MS365_MCP_CLIENT_SECRET "$CLIENT_SECRET"
docker exec "$AGENT" sh -c 'chmod 600 /opt/data/.env'
```

Start the server in HTTP + organization mode (port and host are yours to choose; bind to
localhost or the Docker network, never a public interface without a reverse proxy + TLS):

```bash
MS365_MCP_TENANT_ID="$TENANT_ID" \
MS365_MCP_CLIENT_ID="$CLIENT_ID" \
MS365_MCP_CLIENT_SECRET="$CLIENT_SECRET" \
  npx -y @softeria/ms-365-mcp-server --http 127.0.0.1:3789 --org-mode
```

The server's base MCP endpoint is then `http://127.0.0.1:3789/mcp` (confirm the exact path from
the startup banner — do not trust this form blindly; the /hermes-mcp-add probe matrix will tell
you the truth).

> If the user prefers delegated (per-user) access instead of app-only, the server's default is
> the OAuth **device-code** flow: run it once interactively, complete the
> `https://microsoft.com/devicelink` sign-in, and let it cache the token. That is the one step a
> machine cannot do for them. App-only is preferred here because it survives restarts unattended.

---

## Step 3 (Path A) — wire the MCP server into Hermes

Run **/hermes-mcp-add** against the endpoint from step 2. Do not re-implement its body; reuse it.
Give it:

- **URL**: `http://127.0.0.1:3789/mcp` (the base endpoint; let the probe matrix confirm the form)
- **NAME**: `ms365` → Hermes generates env var `MCP_MS365_API_KEY`
- **Auth shape**: the Softeria server in `--http` mode validates an **`Authorization: Bearer <token>`**
  header. Register with `--auth header`, header name `Authorization`, value `Bearer <token>`,
  using the placeholder-then-`sed` injection that /hermes-mcp-add already prescribes (placeholder
  in the `printf | docker exec` call, real value injected with `sed 's|...|...|'` using the `|`
  delimiter, then `gateway stop` + `gateway run`).

If you are using app-only mode (step 2), the bearer the agent presents to the MCP server is the
Graph access token the server itself manages from the client secret — in that setup there is no
separate per-call token to inject, and the MCP endpoint can run unauthenticated on localhost. Run
the probe matrix first (step 1 + 2 of /hermes-mcp-add) and let the server's response decide
whether a header is required.

---

## Step 2b (Path B) — official Microsoft Enterprise MCP server (identity/admin only)

Only if the user's goal is identity/directory reporting, not productivity data. This server is
delegated-OAuth only — **app-only is not supported** — so it cannot run unattended; it needs an
interactive admin sign-in. Provision once per tenant (the user runs this in elevated PowerShell):

```powershell
Install-Module Microsoft.Entra.Beta -Force -AllowClobber
Connect-Entra -Scopes 'Application.ReadWrite.All','Directory.Read.All','DelegatedPermissionGrant.ReadWrite.All'
Grant-EntraBetaMCPServerPermission -ApplicationId "<MCP_Client_Application_Id>" -Scopes "MCP.User.Read.All"
```

Then wire `https://mcp.svc.cloud.microsoft/enterprise` (HTTP MCP) via /hermes-mcp-add. Tell the
user plainly: read-only, preview, Entra data only, and it will require interactive consent.

---

## Pitfalls

- **OAuth-only, no static key.** Anyone promising a single paste-in key for M365 is wrong. The
  credential is a client secret that mints short-lived bearer tokens; tokens expire (~3600s) and
  must be refreshed. The MCP server handles refresh — do not hardcode a token.
- **Delegated vs application permissions are different worlds.** App-only (client-credentials)
  uses **Application** permissions and the `https://graph.microsoft.com/.default` scope; it cannot
  use delegated scopes because there is no signed-in user. If you add delegated permissions but
  run app-only, every call 403s. Match the permission type to the flow.
- **Admin consent is mandatory.** Application permissions do nothing until a tenant admin clicks
  **Grant admin consent**. Symptom of missing consent: `AADSTS65001` / "no permission" on first call.
- **Client secret expires.** Entra secrets have a max lifetime (commonly 6–24 months). When it
  expires, every call fails with an auth error — mint a new secret and re-inject; do not debug the
  MCP layer.
- **Graph throttling.** Graph enforces per-app and per-resource throttling (HTTP 429 with
  `Retry-After`). High-volume mailbox/file scans will hit it; the agent should back off, not retry-storm.
- **The official Enterprise server is read-only + identity-only + preview.** Do not point a user
  who wants to send mail or edit a OneDrive file at it; it physically cannot do that.
- **Never put the client secret in `config.yaml` or in chat.** It lives only in `/opt/data/.env`
  (container) or `~/.hermes/.env` (local), `chmod 600`.

## Verify

1. **Secret landed, not leaked** — confirm the var exists without printing its value:
   ```bash
   docker exec "$AGENT" sh -c 'grep -c "^MS365_MCP_CLIENT_SECRET=" /opt/data/.env'   # prints 1
   docker exec "$AGENT" sh -c 'ls -l /opt/data/.env'                                  # -rw------- (600)
   ```
2. **Token mints** — prove the Entra app + secret actually work end to end (run on the host;
   the secret is URL-safe for this body):
   ```bash
   curl -sS -X POST -H "Content-Type: application/x-www-form-urlencoded" \
     -d "client_id=${CLIENT_ID}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=${CLIENT_SECRET}&grant_type=client_credentials" \
     "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" | grep -o '"access_token"'
   ```
   A `"access_token"` in the response = credentials and consent are correct. A `400` with
   `invalid_scope`/`invalid_client` means the secret, tenant, or consent is wrong — fix before wiring.
3. **Tools registered** — after /hermes-mcp-add, confirm Hermes loaded the MCP tools:
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 | grep -iE "registered.*tool.*ms365|MCP server .ms365" | tail -5
   ```
4. **Real call returns data** — from the chat interface: `@<agent> using ms365, list my latest emails`.
   A non-error response (even an empty list) means every layer worked.

## Definition of done

- [ ] User chose Path A (Softeria community MCP, productivity surface) or Path B (official
      Enterprise MCP, identity-only), and was told the trade-offs honestly.
- [ ] Entra app registered, **Application** permissions added, and **admin consent** granted.
- [ ] `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET` written via `hermes config set` to
      `/opt/data/.env`, `chmod 600`, and absent from `config.yaml` and chat.
- [ ] Token-mint curl (Verify step 2) returns `"access_token"`.
- [ ] `hermes logs` shows `ms365` tools registered and a real chat call returns data.
- [ ] See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
