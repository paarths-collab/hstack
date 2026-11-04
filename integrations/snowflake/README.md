# Snowflake setup candidate

**Disabled and unverified.** This profile describes Snowflake's native managed
HTTP route. It does not establish that the account endpoint accepts Hstack's SDK
initialization. No Snowflake account, OAuth metadata, login, token, warehouse or
tool operation has been accessed. No vendor runtime is installed.

## What must exist first

The [managed MCP guide](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp)
requires an account, a database/schema and a configured MCP server object. Its URL
has this shape:

```text
https://<account-host>/api/v2/databases/<database>/schemas/<schema>/mcp-servers/<server>
```

Tools are defined by that server's specification, not a universal Snowflake tool
catalogue. Each tool needs its own underlying object grants. A user's primary role,
secondary roles and default warehouse affect access; the vendor says a missing
default warehouse prevents initialization. Warehouse/Cortex use can incur charges.
Hstack has not provisioned any of these objects or purchased a service.

Snowflake does not support dynamic client registration. This candidate uses a
registered **confidential** OAuth client and secret, with PKCE through the native
SDK. An administrator must approve the exact callback:

```text
http://127.0.0.1:8678/callback
```

The [security integration reference](https://docs.snowflake.com/en/sql-reference/sql/create-security-integration-oauth-snowflake)
documents `OAUTH_ALLOW_NON_TLS_REDIRECT_URI` for an HTTP callback,
`OAUTH_ENFORCE_PKCE`, `OAUTH_ISSUE_REFRESH_TOKENS`, `ALLOWED_ROLES_LIST` and
`OAUTH_USE_SECONDARY_ROLES`. Have an administrator review those settings for a
dedicated integration and least-privileged MCP role. No SQL changes run
automatically. Changing the callback port also requires registering its exact URI.

The [custom-client guide](https://docs.snowflake.com/en/user-guide/oauth-custom)
documents `refresh_token session:role:<role_name>` scopes and Basic/Post client
authentication. Set the issuer to the exact issuer published for your account;
do not guess or weaken issuer validation. The candidate targets Snowflake OAuth.
An [external OAuth binding](https://docs.snowflake.com/en/release-notes/2026/other/2026-07-22-mcp-external-oauth)
needs its own issuer/client/scopes review; this profile is not validation of an
Okta/Entra configuration.

## Review a private candidate

Use `plan snowflake` or `prepare snowflake` as described in
[batch setup](../../docs/onboarding.md). Preparation writes a new disabled private
snapshot and preserves the original configuration. Customized profiles are kept.
Copy references from [.env.example](../../.env.example) into your private launch
environment; do not put account values or secrets in the public profile:

```dotenv
SNOWFLAKE_MCP_URL=https://your-account.snowflakecomputing.com/api/v2/databases/YOUR_DB/schemas/YOUR_SCHEMA/mcp-servers/YOUR_SERVER
SNOWFLAKE_MCP_ISSUER=https://your-account.snowflakecomputing.com
SNOWFLAKE_MCP_CLIENT_ID=your_registered_client_id
SNOWFLAKE_MCP_CLIENT_SECRET=your_registered_client_secret
SNOWFLAKE_MCP_SCOPES="refresh_token session:role:YOUR_MCP_ROLE"
```

`doctor snowflake` is offline. It checks references and reports prerequisites;
success does not prove callback approval, account access or protocol compatibility.
All `readTools` are empty and writes are disabled: no account tool is permitted.

## Compatibility gate before activation

The managed-server guide names MCP revision 2025-11-25 but lists lifecycle phases,
notifications and version negotiation as unsupported. Hstack's standard SDK legacy
path starts with `initialize`, then `notifications/initialized` and `tools/list`.
That documented mismatch is an **unresolved interface question**, not a confirmed
live failure. The BigQuery investigation showed why a documentation statement
alone cannot prove actual handshake behavior.

When an account and administrator-reviewed registration exist, explicit foreground
`login snowflake` and discovery-only `check snowflake` can investigate this gate.
These commands contact the account and may use credentials; they were not run in
this stage. Keep the profile disabled until initialization, metadata/issuer checks,
callback, consent and refresh pass. If initialization is rejected, retain the
failure evidence for a reviewed compatibility decision. Do not fabricate an
initialization result, bypass the SDK handshake or silently switch transports.

Since [August 20, 2026](https://docs.snowflake.com/en/release-notes/bcr-bundles/un-bundled/bcr-2405),
tool responses use SSE. Hstack already uses the native Streamable HTTP transport;
a local fixture verifies its Accept headers, split UTF-8/SSE chunks and result
preservation. This does not verify a live Snowflake stream or every vendor result
shape. Discovery must preserve and validate your actual tools' schemas before
an operation is allowed. Search, SQL, agent and custom tool names do not guarantee
read-only behavior; review their grants, side effects and possible charges.

No operational `verify snowflake` exists yet. A real safe account read, error/quota
behavior, refresh, native Hermes use and model acceptance remain unverified.
See [verification.json](verification.json) for the evidence boundary.
