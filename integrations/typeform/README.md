# Typeform through Hstack

This disabled candidate connects directly to Typeform using native Streamable HTTP
and the official SDK's CIMD/PKCE OAuth flow. No `mcp-remote` process is required.
Public OAuth discovery passed in all three documented regions. Local fixtures pass
login, refresh, reused MCP reads and no-DCR behavior. **No real Typeform account,
consent, tool catalogue or account operation has been validated.**

## Choose the account's region

The [official core concepts](https://www.typeform.com/developers/mcp/core-concepts/)
document these pairs:

| Account stack | `TYPEFORM_MCP_URL` | `TYPEFORM_MCP_ISSUER` |
| --- | --- | --- |
| Default | `https://api.typeform.com/mcp` | `https://api.typeform.com` |
| EU data center 1 | `https://api.eu.typeform.com/mcp` | `https://api.typeform.com` |
| EU data center 2 | `https://api.typeform.eu/mcp` | `https://api.typeform.eu` |

The two EU stacks are not interchangeable. Confirm the account's hosting with
Typeform; do not infer one EU stack from an ambiguous `region: eu` value. Hstack
requires a documented endpoint/issuer pair for this CIMD profile, stores state
separately for each endpoint, and does not try another region after a failure.
EU data residency requires vendor eligibility; it is not a gateway feature.

## Publish a small public client document first

Typeform's [connector guide](https://www.typeform.com/developers/mcp/build-a-connector/)
requires a publicly reachable HTTPS Client ID Metadata Document. Its URL is your
client ID; there is no client secret in this public PKCE route. Start from
[client-metadata.example.json](client-metadata.example.json), change its `client_id`
to the exact URL where you will serve it, and include Hstack's exact callback:

```text
http://127.0.0.1:8678/callback
```

Serve the document directly with status 200 and a JSON content type, no redirect,
public IP resolution and a body no larger than 5 KB. The client ID URL must have
a non-root path and be at most 255 characters. It must exactly match the document's
`client_id`. The document contains no keys, tokens, passwords or client secret.
Typeform permits loopback callbacks; changing the port requires updating both the
document and the private profile. Document updates may be cached for up to an hour.

Only the JSON document needs public static hosting. Hstack and its callback run
locally; no Hstack HTTP server deployment is required. This repository supplies a
template, not an already hosted identity. Nothing was published or deployed.
If you cannot host the document, this candidate is not ready to sign in. The
public metadata also advertises DCR, but this reviewed profile deliberately uses
CIMD as documented. It fails when CIMD support disappears rather than silently
registering a different client.

## Prepare, inspect and sign in

Use [batch setup](../../docs/onboarding.md) with `plan typeform` / `prepare typeform`,
or copy [connection.json](connection.json) into your private configuration. An
untouched disabled old `mcp-remote https://api.typeform.com/mcp` template can be
replaced inside a new candidate; customized/active entries and the source are
preserved. Existing bridge credentials are not copied into Hstack's OAuth store.

Set the three references in your private launch environment:

```dotenv
TYPEFORM_MCP_URL=https://api.typeform.com/mcp
TYPEFORM_MCP_ISSUER=https://api.typeform.com
TYPEFORM_MCP_CLIENT_METADATA_URL=https://your-public-host.example/oauth/client-metadata.json
```

Keep the profile disabled while validating it. After selecting the reviewed
candidate with `HSTACK_CONNECTIONS_FILE`:

```sh
node --env-file=.env dist/manage.js doctor typeform
node --env-file=.env dist/manage.js login typeform
node --env-file=.env dist/manage.js check typeform
```

Doctor is offline and does not fetch or validate the hosted client document.
Login is explicit foreground consent. Check discovers tools and schemas without
executing an account operation. No Typeform sign-in or account call was performed
while building this candidate. Review your actual schemas and a safe account
read before enabling it. An operational `verify typeform` is not implemented yet.

## What is allowed and what still needs verification

The 28 default read names come from Typeform's [tool reference](https://www.typeform.com/developers/mcp/tools/):
account/workspace lookup, form reads and capabilities, themes, insights, automation
reads and contact/property/mapping reads. These names are documentation-reviewed,
not proof of live schemas or successful operations. Patch validation, form editing,
publishing, mutations and `submit_feedback` are blocked. Exact write opt-in is
separate and does not enforce human approval or Typeform's patch/publish order.

The vendor currently requires consent to its full MCP scope set, including write
scopes. The SDK obtains scopes from metadata and adds advertised `offline_access`
for refresh. Hstack's read allowlist restricts gateway calls; it does not reduce
the underlying OAuth grant. Review that consent before connecting.

Call `accounts-list_accounts` first, then explicitly choose the intended
`account_id`; a token does not identify one account. Before insights queries,
call `insights-public_discover` for that form's actual field vocabulary. MCP
insights reads do not provide full response-row export or every REST capability.
Hstack does not invent account IDs, field schemas, export tools or fallback APIs.

Typeform's [plan gates](https://www.typeform.com/developers/mcp/plans/) apply when a
tool is called, even when discovery succeeds. `FEATURE_UNAVAILABLE` and
`PAYMENT_REQUIRED` are documented plan errors, separate from HTTP 429 rate limits.
No account has verified their actual MCP envelope or response contract here;
Hstack has no vendor-specific rewriting policy for those results. Never treat
public metadata success as feature eligibility or successful account access.

## Evidence and value over a direct connection

```sh
npm run verify:typeform-metadata
```

This uses only nine public unauthenticated SDK metadata GETs (three per region),
including a 404 on each scoped resource path followed by a root metadata fallback.
It never loads `.env`, registers, signs in, requests tokens or discovers/calls
tools. Native issuer validation stays enabled. See [verification.json](verification.json).

Installed Hermes already supports a custom CIMD URL in its native OAuth setup;
Hstack is not necessary merely to connect Typeform. This candidate adds reviewed
regional pairs, 28 initial read permissions, a migration plan that preserves
existing settings, shared OAuth lifecycle/error handling and optional two-control
tool search alongside other services. A direct/Hstack account or model comparison,
setup-time measurement and live feature/refresh verification remain pending.
