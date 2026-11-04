# HubSpot CRM through Hstack

The disabled native profile connects to `https://mcp.hubspot.com` over Streamable
HTTP with a registered OAuth client and PKCE. No `mcp-remote` executable or separate
bridge state is required. Public OAuth metadata passed official SDK discovery.
Local fixtures pass client-secret POST, PKCE and refresh with empty advertised
scope arrays. **No HubSpot account, connector registration, live consent, tool
catalogue or account operation has been validated.**

## Register the correct connector first

Follow HubSpot's [current CRM MCP guide](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server.md).
This is the remote CRM server, separate from its local Developer MCP/CLI server.
Create a dedicated MCP connector (called an MCP auth app in some UI/docs versions)
under your account's Development settings. Ordinary API apps, private-app tokens
and local developer credentials are not assumed interchangeable with this route.

Register Hstack's exact redirect URL:

```text
http://127.0.0.1:8678/callback
```

HubSpot's Inspector example uses a different localhost callback. Do not copy that
callback into Hstack's connector. Account eligibility and acceptance of this exact
loopback callback still need validation. Changing Hstack's callback port also
requires updating the connector. Registration and consent must be done explicitly
by the account owner/admin; Hstack never creates an app or signs in at startup.

Set your connector's values privately:

```dotenv
HUBSPOT_MCP_CLIENT_ID=your_mcp_connector_client_id
HUBSPOT_MCP_CLIENT_SECRET=your_mcp_connector_client_secret
```

No Hstack deployment or public client metadata document is needed for this
registered-client route. Keep the secret out of public profiles and command
arguments. The native SDK uses the advertised `client_secret_post` method and
S256 PKCE; Hstack does not hand-roll OAuth or invoke dynamic registration.

## Prepare and validate

Use [batch setup](../../docs/onboarding.md) with `plan hubspot` / `prepare hubspot`,
or copy [connection.json](connection.json) into private configuration. Preparation
can replace only an untouched disabled old `mcp-remote https://mcp.hubspot.com`
template, inside a new private snapshot. Customized or active entries and the
source remain intact. Existing bridge tokens are not imported into Hstack's store.

Keep the native candidate disabled while validating it. Select the reviewed
candidate with `HSTACK_CONNECTIONS_FILE`, then:

```sh
node --env-file=.env dist/manage.js doctor hubspot
node --env-file=.env dist/manage.js login hubspot
node --env-file=.env dist/manage.js check hubspot
```

Doctor checks references offline; it does not prove account eligibility, client
registration or callback acceptance. Login is foreground consent in your own
browser. Check discovers schemas without running an account tool. None of those
account interactions ran during this stage.

After inspecting actual tools/schemas, use `get_user_details` as the vendor's
documented first read to confirm the intended account and object/tool access.
This read requires the real account and permission to access user/account data.
No exact response contract has been validated here, so there is no operational
`verify hubspot` command yet. Do not promote discovery alone into account proof.

## Permissions and supported reads

Public metadata advertises empty scope arrays. That does **not** mean a grant
with no permissions or a read-only token. HubSpot determines available permissions
from its current tools and what the installing user grants. Hstack leaves scopes
unset, preserves the resulting grant and does not invent fixed scope strings.
Changing vendor scopes can require reinstalling the connector to approve them.

The 17 default read names are documentation-reviewed: user/account and organization
context, schema/property discovery, CRM search/fetch and owners, campaign reads,
conversation/channel reads, intent signals, marketing/content/AEO analytics and
`tool_guidance`. Live schemas, result shapes, feature eligibility and successful
operations remain unverified. The markdown guide exposes a fuller tool table
than the rendered page extraction; names were reviewed from that primary source.

Mixed read/write tools such as `manage_marketing_email`, CRM/content mutations,
custom pipelines, onboarding changes and feedback stay blocked. `query_crm_data`
also stays blocked until its actual schema and SQL behavior are reviewed. Merely
having a read sub-operation does not make an entire multi-operation tool safe.
Client-specific `render_asset`, website/blog editing and embedded UI capabilities
are not relayed by this gateway. Do not impersonate an approved client to expose
vendor-restricted capabilities. Exact write opt-in is separate and does not
enforce a human approval flow.

HubSpot user permissions, inbox/team restrictions, Sensitive Data settings and
subscription gates still apply. The vendor documents that Sensitive Data-enabled
accounts block activity/conversation access through MCP; AEO analytics requires
an eligible paid subscription. A missing tool or denied read does not prove a
broken OAuth key. Hstack does not bypass these account controls.

## Evidence and value

```sh
npm run verify:hubspot-metadata
```

This makes exactly two public SDK metadata GETs with credentials omitted and
redirects refused. It never loads `.env`, registers, signs in, exchanges/refreshes
tokens, discovers tools or calls accounts. It preserves native issuer validation
and checks the registered secret-post/PKCE/refresh contract. See
[verification.json](verification.json) for public evidence and limitations.

A compatible MCP client can connect directly to HubSpot. Hstack adds a reviewed
shared setup profile, 17 initial read permissions, private migration planning,
connection health/recovery and optional tool search alongside other services.
Real account refresh/revocation, native Hermes HubSpot use, model acceptance and
a measured setup-time advantage over a direct connection remain pending.
