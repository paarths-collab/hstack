# Protocol compatibility

Hstack uses the exact-pinned official MCP SDK 2.4.0 client/server/core packages.
The Node HTTP test adapter is 2.1.2. The old combined v1 package is removed.
The SDK's [protocol guide](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)
describes the two protocol generations and their negotiation behavior.

## Connection behavior

| Connection | Default | Optional selection |
| --- | --- | --- |
| Agent to Hstack stdio | Accepts both the 2025 and 2026 protocol generations | Chosen by the calling client |
| Built-in social adapters | Existing legacy handshake preserved | Custom connection configuration can select another mode |
| Custom HTTP upstream | `auto`: try modern discovery, fall back when the SDK identifies a legacy endpoint | `legacy` or `2026-07-28` |
| Custom stdio upstream | `legacy`, avoiding speculative extra child processes | `auto` or `2026-07-28` |
| Native BigQuery connection | Official SDK legacy handshake, verified 2025-11-25; fixed endpoint | Explicit `googleBigQuery` configuration; modern pins rejected |

Set `protocol` in a custom connection to choose explicitly. A `2026-07-28` pin
does not silently downgrade. Automatic HTTP negotiation can add a discovery round
trip; select legacy for an endpoint you deliberately intend to keep on that path.
The stdio auto mode can create a short-lived probe sibling owned by the SDK, so
it is opt-in. Existing private configurations are preserved.

Modern HTTP uses `server/discover` and per-request metadata instead of the legacy
initialization exchange. Tools can also require `Mcp-Param-*` headers derived from
their `x-mcp-header` schema annotations. Hstack supplies the reviewed discovered
definition on each upstream call so the SDK can mirror headers and validate
outputs on reused static-credential and native OAuth clients. Header errors do not
cause an automatic call replay using a refreshed schema.

BigQuery's public endpoint also accepts legacy initialization, despite its modern
documentation. Hstack selects that supported mode explicitly and uses the standard
SDK Client without a custom Protocol subclass, invented capabilities or result
rewriting. Google-native refresh, stdio calls and installed Hermes registry reads
pass with synthetic data. Direct Hermes auto negotiation also passes that fixture.
Static-credential HTTP providers and BigQuery now reuse their SDK clients, with
per-call deadlines, scoped credentials, queue cooldown checks and catalogue
verification before reconnect recovery. Native HTTP OAuth also reuses clients,
reloading credentials under the shared lock and replacing sessions after external
auth-state changes. BigQuery's two-read fixture uses five MCP POSTs through
either path, down from nine through Hstack.
Actual account/IAM/model validation remains pending; future custom parameter-header
declarations fail closed until reviewed.

Discovery still rejects repeated cursors and more than 100 unfinished pages.
Hstack observes the SDK's public request seam during aggregation so its response
cache/header validation is retained while partial catalogue success is rejected.

## OAuth changes

Login passes the callback issuer (`iss`) to the SDK after validating host, path
and state. Missing required issuers and issuer mismatches are rejected before the
code is exchanged. Explicit login requests fresh authorization; runtime scope
step-up reports a permission error and requires deliberate sign-in.

Authorization-server error bodies are normalized before the SDK can log their
descriptions. Successful credential payloads and MCP tool results are preserved.
Authorization-server 429 errors retain known retry/window metadata; a cancelled
or expired request budget remains cancellation/timeout even if SDK refresh falls
back toward sign-in. See [OAuth setup](oauth.md) for storage and account limits.

## Evidence and limits

The [tagged Hermes interface review](hermes-release-review.json) records the
verification-only adapter for monolithic and split registry modules. Source
inspection of a tagged release is separate from executing that release; the
installed-source native probe uses synthetic responses and no model/account.

- 171 local tests pass, including modern-only HTTP, required routing headers on
  a fresh client, actual Hstack stdio serving both generations, callback issuer
  validation, strict pagination, safe OAuth warnings and auth-server quota errors.
- A live Buffer account read passed with its legacy handshake preserved.
- Official Redis MCP 0.5.1 and native Hermes registry search/read/write-block
  passed again after the SDK migration. Its schema fingerprint and recorded
  discovery byte counts remained unchanged.
- Modern HTTP evidence uses local protocol fixtures. It is not a live BigQuery,
  Snowflake or other vendor account test. There was no model-driven conversation.
- Hstack relays tools; upstream resources, prompts, sampling and interactive
  input-required flows are not fully relayed. Its health resource is local to
  Hstack. Full vendor/release acceptance remains incomplete.

The migration follows the official [SDK upgrade guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html)
and [2026 protocol guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28).

## Remaining vendor setup findings

These account requirements were rechecked while investigating compatibility.
They do not turn an untested profile into a validated connection.

Eight other native OAuth routes now pass [strict public SDK discovery](oauth-catalogue-review.json).
Readwise and Trello use scoped issuers that differ from origin-only metadata.
PandaDoc's secret-auth DCR requirement has an explicit SDK metadata option with
local PKCE/refresh tests; no registration request was sent to the vendor. Kit,
Evernote and Cal.com have documented read defaults, while actual schemas/account
operations and the other five exact read catalogues remain unverified. See the
[setup guide](../integrations/oauth-batch/README.md).

Typeform now has a [native regional CIMD profile](../integrations/typeform/README.md)
in place of its external bridge. Public SDK OAuth discovery passes in three regions
(nine unauthenticated GETs). Local CIMD/PKCE/refresh and region-isolation fixtures
pass, but a hosted public client document, account consent, native schemas and live
operations remain unverified. Hermes already supports CIMD; Hstack's value here is
reviewed shared setup and permissions, not unique protocol support.

[HubSpot's native candidate](../integrations/hubspot/README.md) also removes its
external bridge. Two public SDK metadata GETs pass. Empty advertised scope arrays
are preserved: registered PKCE/secret-post and refresh work in local fixtures
without a fabricated read-only grant. Actual registration, callback, consent,
catalogue schemas, permissions and account operations remain unverified.

| Service | Concrete remaining setup/evidence |
| --- | --- |
| BigQuery | Standard SDK legacy initialization negotiates 2025-11-25 and preserves nine public schemas through gateway discovery; all 18 schemas compile. Modern server/discover still returns -32601. Native Google refresh, real stdio and direct/Hstack Hermes registry paths pass with synthetic data. Five metadata reads are permitted; SQL is blocked by default. Keep disabled pending real account/IAM/response/model validation. [Evidence and reproduction](../integrations/bigquery/README.md) |
| BambooHR | Account subdomain endpoint, admin-enabled beta access and a developer-portal OAuth application are required. DCR is unsupported; use registered client details rather than assuming URL-only sign-in. [Official guide](https://documentation.bamboohr.com/docs/mcp-server) |
| Snowflake | Requires an account/server-object URL and a registered OAuth security integration; DCR is unsupported. Roles and each exposed tool need separate grants. [Official guide](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp) |
| Greenhouse | Requires an eligible tier and admin-approved scopes/client redirect. The documented custom MCP OAuth route also requires the loopback callback to be approved for Hstack. [Official setup](https://support.greenhouse.io/hc/en-us/articles/52096319906971) |
| Docusign | Native demo profile/public OAuth discovery added. Production resource metadata advertises mcp.docusign.com while AS metadata returns account.docusign.com as issuer; SDK discovery rejects it. Production approval docs also conflict. No production profile/account validation is claimed. [Evidence](../integrations/docusign/README.md) |
| Pipedrive | Official ChatGPT setup supplies https://mcp.pipedrive.ai/mcp. Public SDK OAuth metadata passes; native profile requires registered-client refs. Callback/vendor app acceptance and account tools remain unverified. [Setup/evidence](../integrations/pipedrive/README.md) |
| Zoho CRM/Desk/Books | Native disabled HTTP profiles reference account-generated key URLs. Zoho handles selected-app consent; Hstack initially blocks all calls until the account's tool names are reviewed. Real URL/handshake/key rotation remain unverified. [Setup/evidence boundary](../integrations/zoho/README.md) |

BambooHR and Greenhouse now have native disabled profiles and concrete account
instructions under `integrations/`. Registered OAuth configuration can reference
private environment values, and local fixtures exercise no-DCR login, advertised
secret-post authentication, explicit scopes and refresh without narrowing the
grant. Those fixtures are not evidence that either vendor account works.

Snowflake's [disabled native HTTP candidate](../integrations/snowflake/README.md)
needs an account handshake check before activation: its guide lists lifecycle phases and version negotiation as unsupported,
while Hstack's legacy SDK connection starts with `initialize`. This is a documented
interface question, not a confirmed live failure. Do not fabricate a successful
Snowflake connection or silently skip the required SDK handshake without a reviewed
adapter and matching evidence.
Local fixtures verify safe rejection of a lifecycle-free upstream and native SDK
SSE response handling; neither fixture establishes actual Snowflake behavior.

SDK negotiation may wrap a local typed HTTP/OAuth failure. Hstack now follows a
bounded Error-cause chain to preserve known auth/permission/quota failures, while
keeping unknown upstream messages opaque. An HTTP 401/403/429/500 is not rewritten
as a protocol incompatibility merely because it occurred during discovery.
