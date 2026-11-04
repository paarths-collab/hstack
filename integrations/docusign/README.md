# Docusign demo through Hstack

The bundled profile targets the official **demo** endpoint,
`https://mcp-d.docusign.com/mcp`, using a registered integration key/secret and
native SDK OAuth with PKCE and refresh. It replaces the generic local executable
placeholder. It stays disabled. **No account login, consent, documents or vendor
tool operations have been tested.** See [public evidence](verification.json).

## Production is currently blocked

The public production resource metadata advertises `https://mcp.docusign.com`
as its authorization server, but the authorization-server metadata returned
`https://account.docusign.com` as its issuer. The pinned SDK rejects that mismatch
under RFC 8414 issuer validation. This was reproduced without credentials.
Hstack keeps that check; it does not substitute an issuer or fabricate discovery
state to make the connection appear compatible.

There is no bundled production profile. Recheck the public metadata and vendor
eligibility before considering production access. Changing the demo URL alone
does not resolve the incompatibility. OAuth state is bound to endpoint/issuer and
cannot silently reuse demo credentials in production.

The vendor's documentation also conflicts: the
[Claude Code walkthrough](https://developers.docusign.com/platform/mcp-server/anthropic-claude/claude-code/)
says no upfront approval is required, while the current
[overview](https://developers.docusign.com/platform/mcp-server/) and
[GA limitations](https://developers.docusign.com/platform/mcp-server/limitations-workarounds/)
describe production integration-key approval. Confirm the applicable requirement
with Docusign; no approval was requested or claimed here. Official hosted
connectors are the vendor's recommended production route. IAM-only tools require
the appropriate subscription and are outside the default allowlist.

## Prepare a demo account connection

1. Follow the vendor's [registered-app setup](https://developers.docusign.com/platform/mcp-server/github-copilot/)
   to create a demo/developer integration key and client secret. Register Hstack's
   exact callback rather than another client's callback:

   ```text
   http://127.0.0.1:8678/callback
   ```

   Acceptance of this exact callback and integration key has not been tested.
   The official VS Code guide documents loopback redirects, but that is not
   evidence that your Hstack registration is approved.
2. Add references to your existing private, owner-only `.env`:

   ```dotenv
   DOCUSIGN_DEMO_CLIENT_ID=your_demo_integration_key
   DOCUSIGN_DEMO_CLIENT_SECRET=your_demo_client_secret
   ```

3. Copy [connection.json](connection.json) into your private configuration or use
   `plan docusign` / `prepare docusign`. Keep it disabled and preserve other entries.
4. Check prerequisites, explicitly sign in with your own browser, then discover
   the account's actual tool schemas:

   ```sh
   node --env-file=.env dist/manage.js doctor docusign
   node --env-file=.env dist/manage.js login docusign
   node --env-file=.env dist/manage.js check docusign
   ```

   Doctor is offline. Login is foreground-only; no client is registered in the
   background. Check consumes discovery requests but executes no tool. Review
   consent and perform a real read before enabling the profile and restarting
   Hstack. There is no operational `verify docusign` command yet: an actual vendor
   tool response contract has not been validated.

The demo OAuth issuer is **`https://mcp-d.docusign.com`**, as discovered from its
metadata. Its authorization/token endpoints are hosted at account-d.docusign.com.
Those distinct roles are intentional in the published demo metadata; do not
replace the configured issuer with a guessed account-domain value.

The profile requests only the advertised `signature` scope. The metadata
advertises authorization-code, S256 PKCE and refresh support, but omits token
authentication methods. The registered-secret SDK path defaults to Basic;
local fixtures verify that login/read/refresh shape. This is not live consent or
refresh proof. The grant itself can permit eSignature writes; Hstack permissions
restrict tools, not the OAuth grant.

## Default permissions and what Hstack adds

Only `getUserInfo` and `searchDocusignDocs` are allowed initially, based on the
vendor's developer-tool reference. Their actual schemas and account behavior
remain unverified. Reads can consume vendor requests/usage. Envelope sending,
generic API tools, workflow changes and `generateAccessToken` stay blocked.
The latter's interactive token generation is unnecessary for the native login
path and is outside Hstack's verified input-required/UI support.

Docusign documents an overall MCP enable/disable switch but no granular admin
read/write tool controls. Hstack adds an exact tool allowlist alongside the other
services, compact discovery and safe connection diagnostics. It does not enforce
human approval, constrain the internals of a generic API-execution tool or certify
account permissions. Keep client approvals enabled and generic execution blocked
until its actions are reviewed.

## Reproduce public compatibility checks

```sh
npm run verify:docusign-metadata
```

This performs credential-free GETs to the official public metadata endpoints.
The SDK correctly falls back from the scoped resource-metadata path (403) to the
root metadata document. No integration key, sign-in, token or document is used.
The command exits **1 while production compatibility fails**, even though demo
metadata passes. It reports the typed issuer mismatch; local fixture tests also
verify that corrected metadata can pass. Green unit tests do not make this
production check green.

Hstack now reports inconsistent issuer metadata as an upstream compatibility
problem before consent/token exchange, rather than suggesting a credential reset.
Callback issuer mismatches still fail as authentication errors. Neither diagnostic
prints attacker-controlled issuer values.
