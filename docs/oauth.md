# Local OAuth setup

Hstack can act as the OAuth client for a configured Streamable HTTP MCP service.
It uses the pinned official MCP SDK for discovery, registration, PKCE, token
exchange and refresh. This removes the external bridge for compatible services.
Vendor account tests are still pending; a working local protocol fixture is not
proof that every vendor supports the same registration method or callback.

[Deel's candidate](../integrations/deel/README.md) now uses the vendor-recommended
native DCR/PKCE route and four advertised read scopes, while preserving an existing
PAT setup as a separate alternative. Anonymous catalogue discovery is allowed by
the vendor; it must not be mistaken for authenticated account access. No real
Deel registration, consent, token, refresh or account operation has been tested.

Client ID Metadata Documents are also supported using `clientMetadataUrl` or
`clientMetadataUrlEnv`. This route uses the public HTTPS document URL as the client
ID and PKCE without a client secret. Do not combine it with a registered client ID
or secret. The authorization server must advertise CIMD support; Hstack refuses
fallback registration when an explicit CIMD configuration loses that support.
You must host the public JSON yourself and register the exact callback in it;
offline doctor checks do not fetch that file. [Typeform's guide](../integrations/typeform/README.md)
records its document requirements, regional pairs and remaining validation gates.

For a vendor that explicitly advertises secret-auth dynamic registration, the
optional `dcrAuthMethod` selects `client_secret_post` or `client_secret_basic` in
the native SDK's registration metadata. It is mutually exclusive with registered
client credentials and CIMD. Hstack requires matching advertised support and a
registration response containing the requested method and a secret; it does not
silently switch methods. Generated secrets use the encrypted private
store. Selecting a method creates a separate state identity; existing default
profiles keep their original state paths. This is a compatibility option, not
vendor approval or proof of a confidential/attested local client. PandaDoc's
[disabled candidate](../integrations/oauth-batch/README.md#pandadoc-global) has
local PKCE/refresh coverage for this route; actual registration remains untested.

## Sign in, inspect, enable

Build first (`npm run build`). Preserve your existing `.env` and `connections.json`.
If no connections file exists, create disabled templates with:

```sh
node --env-file=.env dist/manage.js init
node --env-file=.env dist/manage.js list
```

An OAuth entry looks like this (substitute the documented real vendor endpoint):

```json
{
  "id": "my-service",
  "label": "My service",
  "enabled": false,
  "transport": "http",
  "url": "https://vendor.example/mcp",
  "oauth": { "type": "oauth", "callbackPort": 8678 },
  "readTools": [],
  "allowWrites": false
}
```

```sh
node --env-file=.env dist/manage.js doctor my-service
node --env-file=.env dist/manage.js login my-service
node --env-file=.env dist/manage.js check my-service
```

`doctor` only inspects local prerequisites and permission settings. It performs no
login, network request or credential-store read; success does not prove OAuth or
vendor access. Account-specific endpoints may use `urlEnv` instead of `url`; see
[private endpoint references](connections.md#private-endpoints-and-installed-executables).

`login` prints an authorization link for your own browser and waits up to three
minutes. Review the vendor permissions before approving. The callback binds only
to `127.0.0.1`, checks the host, path and random state, and keeps the PKCE verifier
in memory. The SDK also validates callback `iss`, including a required issuer
when advertised by the authorization server. Codes, tokens and client secrets
are never printed. Do not share the
authorization link either. Run login on the same computer as the browser; remote
SSH browser/port forwarding is not automated.

`check` explicitly connects even while the entry is disabled, lists tool names
and executes **no tool**. Review the actual tool schemas in an MCP inspector,
add only approved read names to `readTools`, then enable the entry and restart
Hstack. Without write opt-ins, empty `readTools` blocks all operations. Login does not enable writes.
No interactive sign-in starts automatically in the Hermes background process.
Missing saved client information also stops before dynamic registration: background
startup does not create an OAuth application merely to report that login is needed.
Issuer metadata mismatches are reported as upstream compatibility failures before
consent/token exchange; callback issuer mismatches remain authentication failures.
Raw expected/received issuer values are not printed, and validation is not bypassed.

`HSTACK_CONNECTIONS_FILE` selects an alternative absolute configuration path for
both the setup utility and server. Existing private files are never migrated or
overwritten by `init`; move individual example settings deliberately.

## Registration differences

- Dynamic registration: the SDK uses the service's advertised registration endpoint.
- Pre-registered clients: add `clientId`, the exact documented `issuer`, and,
  if required, `clientSecretEnv` inside `oauth`. Put the secret in `.env`, never
  JSON or arguments. Changing registration settings requires a new sign-in.
- Private registration references: use `clientIdEnv`, `issuerEnv`, `scopeEnv`
  or `clientMetadataUrlEnv` instead of the corresponding literal fields. Each
  must name an environment variable; specifying both forms is rejected. Required
  values resolve before login, refresh or disconnect. Missing registration values
  cannot silently fall back to dynamic registration. The credential-store binding
  uses the resolved client/issuer/scope, so changing them selects separate state.
- Client ID metadata documents: add `clientMetadataUrl`, an HTTPS URL with a
  non-root path serving a compliant public client metadata document and the exact
  loopback redirect. Hstack does not host this document for you.
- Configured `scope` (or resolved `scopeEnv`) is an explicit request during
  foreground login. Without it, the SDK selects defaults from server metadata and
  can add advertised `offline_access` for refresh. Review the actual consent screen;
  the vendor decides the granted access. Refresh does not initiate a new consent
  flow or approve broader scopes in the background.
- [HubSpot](../integrations/hubspot/README.md) uses registered connector credentials
  and installation-selected permissions; [Typeform](../integrations/typeform/README.md)
  needs a public CIMD document and the correct regional endpoint/issuer pair.
  Both bundled profiles now use native HTTP, with real account acceptance still
  pending. A URL alone is insufficient; review vendor-specific admin/plan gates.

See the official [SDK authorization migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html#auth)
for current discovery, issuer validation and registration behavior.

Concrete account prerequisites are in the [BambooHR](../integrations/bamboohr/README.md)
and [Greenhouse](../integrations/greenhouse/README.md) guides. They are disabled
documentation-reviewed profiles; real account acceptance remains pending.
[Pipedrive](../integrations/pipedrive/README.md) requires an MCP-compatible registered
client/secret and unverified callback acceptance; advertised DCR does not imply
support for Hstack's native public-client login. The Zoho URL-key profiles use
[vendor-managed server setup](../integrations/zoho/README.md), not this OAuth store.
[Docusign](../integrations/docusign/README.md) uses a registered demo integration
key/secret; its public production metadata currently fails SDK issuer validation.

## Storage and recovery

Hstack-owned credentials are **encrypted with AES-256-GCM**. macOS defaults to a
Keychain-held master key; headless POSIX hosts require a private master-key file.
See [vault setup, migration and recovery](credential-security.md). The default
directory is `~/.hstack-auth` (0700); files are 0600 and replaced atomically.
Set `HSTACK_STATE_DIR` to an absolute, private directory to choose another location.
Existing permissive directories/files, symlink state directories/files and
hard-linked credential files are refused. Protect this directory from backups
or synchronization that expose private files. Native storage is currently
supported on POSIX only; Windows ACL handling has not been implemented/tested.

State is bound to connection ID, endpoint and registration configuration. Issuer
binding is retained, discovered issuer metadata is checked, and OAuth network
requests reject redirects and non-HTTPS URLs (loopback HTTP is allowed only for
local fixture endpoints). No tokens are relayed between vendor connections.

Each connection holds a filesystem lock throughout credential loading, refresh
and use, including across Hstack processes. Lock waits count against the operation
deadline. The optional upstream notification GET stream is disabled for native
OAuth; subscriptions are not relayed. Tools use normal Streamable HTTP POST/SSE
responses. Operations are not automatically retried after network failures.

The official SDK HTTP client is now reused for discovery and subsequent calls.
Credentials are reloaded under the lock before **every** operation; missing or
invalid records clear the provider's in-memory state. A memory-only fingerprint
detects external token/client changes and retires the old MCP session before
reconnecting. The full tool catalogue is checked before the new request proceeds.
This prevents a new login from silently reusing a session bound to the old identity.
Own refresh updates the fingerprint at the end of the locked operation, avoiding
an unnecessary reconnect on the next call. Existing plaintext records require the explicit migration action before use;
there is no silent downgrade or automatic migration.

In the local legacy OAuth fixture, discovery plus two reads now use five
authenticated MCP POSTs, matching a reused client rather than repeating setup.
Login, authorization-server requests and denied authentication challenges are
separate from that count. The SDK's authentication challenge handling remains
native; Hstack adds no replay after a network failure or unknown operation outcome.

After normal shutdown locks are removed. A killed/crashed process can leave a
`.lock` directory. Stop **all** Hstack processes using this state directory,
verify none remain, then remove only the empty `.lock` directory; do not delete
credential JSON to clear a lock. Automatic stale-lock recovery is not implemented,
because stealing a live lock could reuse a rotating refresh token.

Refresh/revocation failures require explicit login. Local disconnect:

```sh
node --env-file=.env dist/manage.js disconnect my-service
```

A warm process reloads the removed record before its next operation and cannot
continue using cached credentials. Disconnect waits for an already-running
locked operation to finish; it does not roll back an account request already sent.

This removes the local saved registration/tokens, then requires a Hstack restart.
It does **not** revoke access remotely. Use the vendor's account settings to revoke
the grant as well. For header-auth/local bridge connections, use the corresponding
environment/vendor credential lifecycle instead.

## Evidence and remaining work

Local fixtures exercise registration, resource indicators, PKCE, bad/duplicate
callbacks, denial, timeout, occupied callback port, background AUTH_REQUIRED,
refresh rotation across two separate processes, revocation, restricted storage,
issuer mismatch and a tool call after sign-in. No vendor OAuth account was used.
macOS Keychain and encrypted keyfile storage now have separate vault tests.
Legacy SSE-only upstreams, public HTTPS-only callback requirements, automatic
stale-lock recovery and vendor-specific registration remain separate work.
