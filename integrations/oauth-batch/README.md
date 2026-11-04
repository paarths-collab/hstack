# Remaining native OAuth connections

Public official SDK OAuth discovery passes for Brand24, Kit, Readwise, Evernote,
Cal.com, Trello, Help Scout and PandaDoc (global). This checks discovery documents,
not accounts. **No registration, consent, token, tool catalogue or account operation
was performed against any of these services.** Every bundled candidate is disabled.

Repeat the public-only review with:

```sh
npm run verify:remaining-oauth-metadata
```

The checker uses an explicit allowlist of reviewed origins and only well-known
OAuth GETs, omits credentials and refuses redirects. New IdP origins require review
before being fetched. Scoped issuers are preserved. The command never loads `.env`,
private configuration or OAuth state and never registers, signs in or calls tools.
See [public evidence](../../docs/oauth-catalogue-review.json).

## Current setup boundaries

| Service | Native OAuth route | Default reads | Account gate |
| --- | --- | --- | --- |
| Brand24 | DCR with public client; CIMD also advertised | None until catalogue review | Subscriber and active projects |
| Kit | DCR with public client | 38 documented names | Paid Creator/Creator Pro for tool calls |
| Readwise | DCR; scoped `readwise.io/o/` issuer | None until catalogue review | Eligible Readwise account; actual access unverified |
| Evernote | DCR only; loopback callback documented | 10 documented names; requested `read` scope | Individual/Business tool availability differs |
| Cal.com | DCR with public client; CIMD also advertised | 43 documented names | Role and feature permissions; broad team/org consent |
| Trello | DCR at a scoped Atlassian issuer; CIMD also advertised | None until catalogue review | One workspace per connection; admin/feature controls |
| Help Scout | DCR with public client | None until catalogue review | API access; reports require Plus/Pro |
| PandaDoc global | Explicit SDK secret-post DCR candidate | None until catalogue review | Actual registration, grant and account acceptance unverified |

An empty read list means every operation remains blocked. Passing metadata does
not make these empty-list profiles usable for account tasks yet. No exact names
were guessed from REST routes or prose capability labels.

## Prepare once, then authorize explicitly

Use [batch planning](../../docs/onboarding.md), for example:

```sh
node dist/manage.js plan kit evernote calcom pandadoc
node dist/manage.js prepare kit evernote calcom pandadoc
```

Preparation creates a new disabled private snapshot and preserves the source.
Already configured HTTP entries are retained, including older generic templates;
review the public plan and merge new settings manually if needed. No token store
or active connection is silently migrated. The individual native profiles are in
the `kit`, `evernote`, `calcom` and `pandadoc` integration directories.

After selecting your reviewed candidate with `HSTACK_CONNECTIONS_FILE`:

```sh
node --env-file=.env dist/manage.js doctor evernote
node --env-file=.env dist/manage.js login evernote
node --env-file=.env dist/manage.js check evernote
```

These account commands were not run in this review. Doctor is offline. Login is
foreground consent in your own browser; check discovers actual tools without
executing them. These DCR candidates register during explicit login, so you do not
need to paste pre-provisioned client credentials or host a CIMD document. Real
registration/callback acceptance remains unverified. Generated client information
uses the existing POSIX owner-only plaintext OAuth store.
Keep client approval prompts enabled and candidates disabled until a safe real
read and refresh have been verified. No operational `verify` command exists for
these eight services yet because their account response contracts are unvalidated.

## Kit

The [developer guide](https://developers.kit.com/mcp/kit-mcp) and
[connection guide](https://help.kit.com/en/articles/14827557-how-to-connect-the-kit-mcp-to-your-ai-tools)
distinguish paid tool execution from connection/discovery on Free accounts. The
38 read names come from Kit's [read/write tool table](https://help.kit.com/en/articles/15072804-kit-mcp-tools):
account context, subscribers, tags/segments, forms, sequences, broadcasts,
statistics, templates, snippets, posts, commerce data, domains and webhooks.
Sending, subscriber changes and all other writes are blocked. `list_prompt_suggestions`
is a tool; Hstack does not relay upstream MCP prompt resources/slash commands.
The advertised `public` OAuth scope is not a read-only grant. Documented request
limits are not proof of the rate-limit headers or actual quota behavior.

## Evernote

Evernote's [authentication guide](https://dev.evernote.com/mcp/authentication)
documents DCR as its registration route and allows HTTP loopback callbacks.
The candidate requests the advertised `read` scope and permits 10
[documented reads](https://dev.evernote.com/mcp/tools): note search/content,
notebooks, spaces, tags and tasks. Individual and Business task searches are not
interchangeable. Attachment download/upload tools and all mutations are blocked.
Actual read-only consent acceptance, schemas, result types and account operations
remain unverified; do not replace the requested grant with broad write scopes just
to make an unexplained failure disappear.

## Cal.com

The [official guide](https://cal.com/docs/mcp-server) documents native hosted DCR
and its tool catalogue. The 43 initial reads cover profile, event types, bookings,
availability, calendars, teams, organization metadata, routing-form reads, docs
search and API-operation descriptions. `call_api_operation` can execute arbitrary
API v2 operations and is blocked, along with booking changes, invitations and all
other mutations. Querying an API description does not authorize its execution.
The OAuth consent can include broad team/organization write permissions. Hstack's
read list limits gateway calls and does not narrow that grant or confer admin roles.

## PandaDoc global

The [official setup guide](https://developers.pandadoc.com/docs/getting-started-with-mcp)
describes automatic registration. Public metadata advertises only secret-post and
Basic token authentication. Hstack's default public DCR metadata requests `none`,
so assuming that route works would be premature.

The disabled candidate explicitly sets `dcrAuthMethod: "client_secret_post"`.
Hstack passes this through the native SDK's client metadata; the SDK still handles
registration, PKCE, token exchange and refresh. Hstack requires the method to be
advertised and the registration response to return the same method and a secret
before consent begins. A missing secret or method downgrade fails explicitly.
The generated client secret is stored only in the private OAuth state. This is
not evidence that PandaDoc actually accepts the registration or treats a local
client as confidential. No vendor approval or registration call was made.

The candidate requests `read documents:read`, but no tool names are allowed until
its actual catalogue is reviewed. Account/grant acceptance and result contracts
are unverified. EU accounts use a separate documented endpoint and issuer, outside
this public probe; do not send an EU account's authorization to the global server
or fall back between regions after a failure.

## Other four candidates

- [Brand24](https://help.brand24.com/en/articles/13011375-brand24-mcp) requires a
  subscriber account and active project data. Discovery advertises projects:read
  and refresh. Exact tool names still need the real catalogue.
- [Readwise](https://docs.readwise.io/tools/mcp) uses the current `mcp2` endpoint
  for both Reader and Readwise. The guide lists capabilities, not exact tool names;
  export and library mutations cannot be treated as reads by their prose label.
- [Trello](https://github.com/atlassian/trello-mcp-server) supports one workspace
  per connection and all plans, with feature/admin limits. The SDK discovers a
  scoped Atlassian issuer/DCR endpoint; generic `auth.atlassian.com` metadata alone
  would miss that route. API-token MCP authentication is not supported. Actual
  tool names and workspace access remain unverified.
- [Help Scout](https://docs.helpscout.com/article/1779-connect-your-ai-agent-with-help-scout-to-search-conversations-and-pull-reports)
  requires API access on Standard/Plus/Pro; Light Users cannot connect and reports
  require Plus/Pro. It documents DCR rather than ordinary My Apps API credentials.
  New connections are read-only, but some beta accounts retain write tools, so
  Hstack still requires exact read review. Docs access uses a separate key entered
  on the vendor authorization page. Local disconnect is not remote revocation.

A direct compatible MCP client can connect to these services. Hstack adds shared
planning, explicit permission lists, auth storage/lifecycle and tool search, while
actual account usability, real model acceptance and measured setup-time advantages
remain open. Public metadata and synthetic tests do not establish production
readiness across this catalogue.
