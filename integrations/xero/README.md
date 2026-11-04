# Xero through Hstack

Use Xero's official hosted MCP at `https://api.xero.com/mcp/v1`, with native
registered-client PKCE. No Xero MCP package, external OAuth bridge or separate
deployment is needed. This replaces the generic local-executable placeholder.
The older [official local server](https://github.com/XeroAPI/xero-mcp-server)
remains a separate alternative; its hyphenated tools are not this hosted profile's
underscore tool names.

**Account validation is pending.** Public OAuth metadata and local synthetic
login/refresh tests do not prove an eligible Xero account can complete login or
run a tool. Callback acceptance, consent, actual tool payloads, token refresh and
model-driven Hermes use still need live validation.

## Account and registration

According to the [official hosted MCP guide](https://developer.xero.com/documentation/guides/remote-mcp/overview/),
Commercial apps on **Core or above** can use real organisations. Starter apps
can try a **demo organisation**. Existing API rate limits, connection limits and
data-egress metering apply. This is not an unconditional free integration.
Check the current vendor terms before creating or upgrading anything.

1. Create your own Xero Developer Commercial app using **Auth Code with PKCE**.
   This is a public client: it has a client ID and no client secret. Hstack does
   not register a Xero application for you or use another app's identity.
2. Register Hstack's exact callback:

   ```text
   http://127.0.0.1:8678/callback
   ```

   Xero's [PKCE guide](https://developer.xero.com/documentation/guides/oauth2/pkce-flow/)
   permits HTTP for localhost. Acceptance of this exact loopback address has not
   been tested in the developer portal. If rejected, stop and resolve the callback
   requirement; substituting a different hostname will not match Hstack's listener.
3. Select an eligible organisation you are allowed to access. Prefer a demo
   organisation during initial testing. No organisation is selected automatically.

## Prepare and connect

```sh
npm run build
node dist/manage.js plan xero
node dist/manage.js prepare xero
```

Review the candidate privately, then select its absolute path through
`HSTACK_CONNECTIONS_FILE` in your existing private `.env`. See
[batch setup](../../docs/onboarding.md). A customized existing Xero connection is
preserved, so review it against [connection.json](connection.json) yourself.
New or replaced profiles remain disabled and no installation or login has run.

Add only your app's client ID to the same private environment:

```dotenv
XERO_MCP_CLIENT_ID=
```

The profile pins the official endpoint and issuer. It explicitly requests only
`openid offline_access accounting.contacts.read accounting.invoices.read`,
so broad advertised write scopes do not become default consent requests.
`offline_access` requests a refresh token. Xero decides what it actually grants.

```sh
node --env-file=.env dist/manage.js doctor xero
node --env-file=.env dist/manage.js login xero
node --env-file=.env dist/manage.js check xero
```

`doctor` is offline; `login` prints the link for your own browser; `check` performs
authenticated discovery but runs no tool. Never paste tokens into JSON, arguments
or chat. Native OAuth storage is POSIX owner-only plaintext, not an encrypted
keychain; see [storage and recovery](../../docs/oauth.md).

Review the actual discovered schemas. The three documentation-reviewed reads are
`get_connected_tenants`, `list_contacts` and `list_invoices`. Then explicitly
enable the profile, restart Hstack in Hermes, ask it to list connected tenants,
and choose the organisation by name before a contacts/invoices read. Calls to
every other tool remain blocked by default, including financial state changes
such as `authorise_invoice` and `void_invoice`. Hstack does not itself enforce a
human approval or tenant-selection dialogue; keep client approvals enabled.

Confirm an actual read and refresh after access-token expiry. There is no reviewed
`verify xero` operational probe yet because live tool response schemas are untested.
Discovery alone does not establish that a tenant operation works.

## Repeatable evidence

`npm run verify:xero-metadata` makes exactly two public unauthenticated GETs through
the official MCP SDK: protected-resource metadata and issuer metadata. It checks
the endpoint/issuer, PKCE, refresh and requested scopes. It never reads `.env` or
OAuth state, requests tokens, registers an app or calls a tool. It is opt-in and
is not part of routine offline tests.

The Xero-shaped local fixture tests registered public-client login and refresh
without DCR or a secret, including authorization-server metadata that advertises
only confidential authentication methods. It requests only the configured read
scopes and handles callbacks without an `iss` parameter when not advertised.
This is protocol coverage, not a live Xero account test.

Hstack adds shared setup, per-service permissions, focused discovery and connection
health when you use several services. For a single Xero connection, direct MCP
can still be simpler. Hosted eligibility and account sign-in remain Xero's job.
