# Hstack

A unified MCP gateway for Hermes with social adapters and a broader connection catalogue.

```text
Hermes → Hstack (local stdio) → Buffer / Pallyy / Metricool / Blotato / Ayrshare
```

[Social package](docs/social-package.md) · [Batch setup](docs/onboarding.md) · [Redis](integrations/redis/README.md) · [MongoDB](integrations/mongodb/README.md) · [30-service catalogue](docs/connections.md).

The official SDK 2.4.0 serves both MCP protocol generations over stdio and supports
modern HTTP discovery/routing. See [protocol compatibility and evidence](docs/protocol-compatibility.md).

All 30 additional profiles ship disabled. Redis and MongoDB have tested local setups;
Mailchimp has a pinned community runtime and network-denied process checks, with
account validation pending. The other expansion profiles remain setup templates. Hstack supports
configured local MCP subprocesses and remote HTTP upstreams. Native local OAuth
login/refresh is implemented for compatible HTTP connections; vendor validation
is pending. Profiles can still require registration or a pinned vendor runtime.
Native account setup guides are available for [BambooHR](integrations/bamboohr/README.md)
and [Greenhouse](integrations/greenhouse/README.md). [Xero](integrations/xero/README.md)
uses its official hosted endpoint with registered PKCE, requiring no vendor
subprocess. Its public OAuth metadata passed SDK discovery; all three still need
live account validation.
[Pipedrive](integrations/pipedrive/README.md) and
[Zoho CRM/Desk/Books](integrations/zoho/README.md) now have native disabled HTTP
profiles. Pipedrive's public OAuth metadata passed; app/callback acceptance and
all four services' account operations remain unverified.
[Docusign demo](integrations/docusign/README.md) has a native registered-app profile.
Demo public OAuth discovery passes; production currently fails the SDK's issuer
validation and remains blocked. No Docusign account operation is verified.
[Google Analytics](integrations/google-analytics/README.md) has a pinned local
runtime and tested schema/error/write-block paths using synthetic missing ADC.
It requires a documented ADK dependency compatibility build; real Google account
reads and refresh remain unverified.
[MySQL](integrations/mysql/README.md) also has a tested local setup: eight real
diagnostic reads and native Hermes schema calls, using a reproducible MySQL-only
Toolbox compatibility build. Its precise binary audit retains an unlinked
module advisory; hosted/TLS and other-platform validation are pending.
[Zendesk](integrations/zendesk/README.md) has a pinned community runtime, 14
reviewed JSON reads, safe error normalization and coordinated native token refresh.
The direct/Hstack comparison uses a local synthetic OAuth/API fixture; real
Zendesk account validation remains pending.
[BigQuery](integrations/bigquery/README.md) uses the official SDK's verified legacy
handshake, preserving all nine public schemas without result rewriting. Native
Google refresh, real Hstack stdio calls and installed Hermes registry reads pass
with synthetic data. Direct Hermes also works in that fixture; Hstack adds shared
setup, credential refresh and default SQL blocking. Real account/IAM and model
validation remain pending, so its candidate stays disabled.
[QuickBooks](integrations/quickbooks/README.md) now has a pinned Intuit compatibility
build, 70 permitted reads, explicit foreground sign-in and private native token-store
coordination. Installed-process tests use synthetic OAuth/API data; real account
validation remains pending. Native Hermes registry search/read/write-block passed
with that same fixture; model-driven acceptance remains pending.
[Snowflake](integrations/snowflake/README.md) has a disabled native HTTP setup
candidate with registered OAuth references. Its documented lifecycle limitations
need account validation before activation; no live Snowflake behavior is verified.
[Typeform](integrations/typeform/README.md) now uses native HTTP/CIMD instead of an
external bridge. Public OAuth discovery passes in three regions; 28 read names
are documentation-reviewed. You must host its public client metadata JSON first;
real login, tools and plan access remain unverified.
[HubSpot](integrations/hubspot/README.md) also uses native HTTP with registered
PKCE/secret-post OAuth, removing the last bundled external bridge. Public OAuth
metadata passes and 17 read names are documentation-reviewed; registration,
consent, schemas and account operations remain unverified.
The [remaining OAuth setup guide](integrations/oauth-batch/README.md) records eight
publicly checked discovery routes, documented Kit/Evernote/Cal.com read defaults
and an explicit PandaDoc registration-method candidate. Real registration and
account operations remain unverified; five of those eight profiles still block all operations
until actual tool names/schemas are reviewed.
[Deel](integrations/deel/README.md) now uses a native OAuth candidate with eight
observed anonymous read/noauth tool names; public schemas and gateway search pass,
while vendor tool execution and protected account access remain unverified.
[Brevo](integrations/brevo/README.md) and [PagerDuty](integrations/pagerduty/README.md)
have credential-specific setup guides and synthetic header tests. All 30 catalogue
entries now have setup guides; that does not make every account integration verified.
Buffer is live-read verified against an account; Redis and MongoDB passed real local database
operations and native Hermes tool calls. Four other social adapters are fixture-tested, with live
accounts pending. Metricool also needs read-tool review before default operation.

**Implemented:** configured provider tools discovered at server startup are exposed with
service namespacing, such as `buffer__` and `pallyy__`. Input schemas, annotations, outputs and quota
metadata are preserved. Hstack validates inputs before forwarding. Write tools
are blocked by default; built-in social adapters use per-provider
`HSTACK_ALLOW_<PROVIDER>_WRITES=true` environment flags. Custom connections can
permit exact `writeTools` names in private `connections.json`; `allowWrites: true`
permits every discovered operation. The legacy global flag affects Buffer
only. Keep client approval prompts enabled. The gateway does not
retry writes or enforce a human approval flow itself.

The catalogue is a startup snapshot: restart Hstack to refresh it. Static-credential
HTTP services, native OAuth and BigQuery reuse one SDK client per provider; local
stdio processes stay alive. Calls serialize, recover before a new request and
require review after a catalogue change. OAuth reloads credentials under its shared
filesystem lock for every operation and replaces sessions when external auth state changes.
Social adapters activate only with non-empty keys. Custom connections must be
explicitly enabled; discovery failures are isolated.

## Why use the gateway?

- One connection with per-service permissions and failure isolation.
- Offline batch planning and private configuration candidates preserve your
  existing settings. Review several service profiles together, then activate
  them explicitly; no account creation or automatic installation is implied.
- Reviewed vendor setup and bounded compatibility fixes: Mailchimp's pinned
  runtime avoids an SDK import failure, and its list-response policy prevents
  swallowed API errors from appearing as an empty account. Live account tests
  for that profile are still pending.
- Local MCP children recover on a new request after a crash, with bounded
  backoff and no replay of an operation whose result was lost. Catalogue changes
  require review. See [recovery behavior](docs/recovery.md).
- Optional search mode advertises two controls and returns relevant schemas on
  demand, rather than loading every connected tool into initial discovery.
- Inspect `hstack://connections` for availability, call counters, error codes and
  process-local rate-limit cooldowns, without exposing credentials/account bodies.
- HTTP 429 responses carry structured Hstack error metadata. Retry-After seconds
  and HTTP dates are supported. Exhausted policy windows are named only when
  headers identify one. Further calls through the same process wait out the
  cooldown; there is no automatic write retry.

These are implemented gateway features, not proof of production readiness across
all accounts. Vendor account validation, onboarding polish and recovery of
providers omitted during initial startup still need work.
See [production acceptance criteria](docs/production-readiness.md).

For other services, use [batch setup](docs/onboarding.md) and the
[OAuth guide](docs/oauth.md): prepare disabled candidates, run the offline
`doctor <id>` check, sign in explicitly,
inspect tools, then enable reviewed reads. Private endpoint/executable references
and OAuth registration references keep account-specific values out of JSON.
The offline doctor also shows bundled vendor prerequisites. Existing configuration is preserved.
`check` discovers tools without executing them; `verify redis` and
`verify mailchimp` / `verify mongodb` / `verify mysql` / `verify zendesk` /
`verify google-analytics` explicitly test
their reviewed database/API reads.

The [Hermes Desktop Connections preview](hermes-plugin/hstack-connections/README.md)
provides **save key → validate read → activate → use read tool**. Activation creates
one profile-specific MCP entry without overwriting other settings; active keys can
change without restarting that connection. Buffer passed the real-account backend
flow through Hermes's native registry, including the actual React component in
a test harness. Pallyy, Blotato and eligible Ayrshare flows
are fixture-tested, with real accounts pending; Metricool activation is blocked
until its safe read is reviewed. Plugin installation is still manual, and the
actual Desktop app and model-driven chat remain untested. OAuth and other service
screens remain unimplemented.

## Setup

Requires Node.js 22+ and npm.
Use a current patched release. The routine suite passes from a clean lockfile
installation on Node 22.23.4, 24.22.2 and 26.8.1 on macOS arm64; other runtime/platform
combinations still need the configured CI matrix. See [runtime evidence](docs/runtime-verification.json).

```sh
npm ci --ignore-scripts
npm run build
```

Copy `.env.example` to `.env` if it does not exist. Enter your personal key from
[Buffer API settings](https://publish.buffer.com/settings/api) locally:

```dotenv
BUFFER_API_KEY=your_key_here
```

Keep `.env` private (`chmod 600 .env`). It is ignored by Git. Never paste the key
into chat, arguments, source files or test fixtures. An existing environment
variable takes precedence over the file. Inspector's OAuth login is separate.
This legacy plaintext file is separate from the [encrypted credential vault](docs/credential-security.md) used by Desktop keys and native OAuth. Protect it separately.

## Run

```sh
npm run buffer:tools   # Discover upstream tool names; execute no tools
npm run smoke:buffer  # Start Hstack over stdio and read your real Buffer account
npm run audit:buffer  # Live reads + write-block checks for all discovered tools
npm run smoke:search  # Live Buffer read via compact search, then health check
npm run benchmark     # Synthetic discovery-size comparison; no network
npm test              # Local fixtures only; no live credentials required
```

MongoDB also has an opt-in `npm run verify:mongodb-local` test after installing
its separate runtime. It creates its own database, compares direct/Hstack reads,
checks wrong credentials and verifies exact write opt-ins using synthetic data.
See the MongoDB guide for installation and native Hermes evidence.

The smoke check prints validation results, not account details. It consumes real
Buffer requests. Unlike the smoke output, a real agent calling the tool receives
your account information and organization details.

For a repeatable test without creating an account, use the Redis guide's
`npm run verify:redis-local`. It runs the official MCP server against a new,
disposable local database and compares direct access with Hstack permissions,
compact discovery, operational verification and explicit write opt-in.

To connect Hermes, use its MCP settings to create a stdio connection:

```yaml
mcp_servers:
  hstack:
    command: /absolute/path/to/node
    args:
      - --env-file=/absolute/path/to/hstack/.env
      - /absolute/path/to/hstack/dist/server.js
    connect_timeout: 60
    timeout: 40
```

Use your actual absolute paths; `command -v node` locates Node. Merge this entry
into existing configuration without replacing other entries. Restart/reload MCP
using your Hermes version's supported flow, then ask:

> Use Hstack to show which Buffer organizations I can access.

Do not use `npm start` as the MCP command: npm's banner can pollute stdout. Launch
Node directly as shown above. Hstack reserves stdout for MCP protocol messages.

## Compact discovery

Set `HSTACK_TOOL_MODE=search` in your private `.env`, then restart the Hermes MCP
connection. Hermes discovers `hstack_search_tools` and `hstack_call_tool` instead
of every provider tool. Search returns exact names, schemas and restrictions; calls
still pass through normal validation and permission checks. Default mode remains
`forward` for compatibility. Use `npm run smoke:search` to verify the read path.

The [reproducible benchmark](docs/benchmarks/discovery.json) uses 30 synthetic
services with 12 tools each. Direct discovery is 155,483 JSON bytes, plain gateway
forwarding is 158,963, and compact initial discovery is 853 (plus 1,490 for the
first three-tool search response). This measures bytes, not model tokens, model
accuracy, task success, setup time or production latency. Compact discovery adds
a search step; the client/model must support using that pattern effectively.

## Validation and current limits

- 364 local tests cover batch setup, modern/legacy protocol paths, multi-service routing, auth headers, OAuth/CIMD/PKCE/refresh, explicit DCR authentication, warm OAuth disconnect/identity changes, native Google credentials, HTTP client reuse, lifecycle recovery, failure isolation and
  per-provider write settings, plus discovery, transport, metadata and error
  preservation, argument validation and default write blocking. Per-tool routing
  tests use synthetic schemas and responses; they are not vendor-operation proof.
- A clean public export and fresh private homes pass all 364 routine tests on
  Node 22, 24 and 26 without copied private configuration or ignored artifacts. All
  six workflow files pass actionlint. Linux/macOS CI is configured for Node
  22/24/26; those remote jobs remain unrun.
- The earlier Buffer audit compiled and exposed all 17 live Buffer schemas through Hstack.
- Live reads passed: get_account, list_channels, list_posts, list_ideas,
  list_idea_groups, list_post_templates, get_post_template and
  get_aggregated_post_metrics.
- get_channel and get_post were skipped: their list tools returned no existing
  records to use. No IDs were invented for live checks.
- Seven write tools passed local routing tests and live default-block checks.
  Their real Buffer operations have NOT been validated. Nothing was created,
  changed, published or deleted by the audit.
- Native Hermes discovery uses a disposable configuration; normal Hermes
  configuration remains unchanged. No model-driven chat was tested.
- Redis MCP 0.5.1 exposed 53 tools in a real local check: five reviewed reads and
  one explicitly permitted disposable write passed. Native Hermes registry
  search/read/write-block also passed. Other Redis operations, TLS, clusters and
  hosted account authentication remain unverified. The 54-package Python runtime
  had zero known vulnerabilities in its recorded pip-audit check.
- New-provider live account validation remains pending. Local OAuth is fixture-tested;
  hosted deployment, a unified browser sign-in screen for all services and comprehensive
  quota-window interpretation are not implemented. Desktop keys and native OAuth now use
  an [encrypted vault](docs/credential-security.md); storage support is POSIX only.
- HTTP 429 supports Retry-After seconds or dates and runtime cooldowns.
  Desktop saved-key cooldowns also survive a server restart.
  Policy windows remain unknown unless response headers identify them.
- Compact search and health reporting passed a live Buffer read check; this is
  still an SDK client check, not a model-driven Hermes conversation.
- No commits, pushes or GitHub CI runs are implied by local checks.

## Learn the code

| File | Purpose |
| --- | --- |
| `src/buffer-tools.ts` | Original discovery experiment |
| `src/discover-tools.ts` | Shared upstream connection, deadline and HTTP errors |
| `src/buffer-account.ts` | Forward a validated Buffer tool call |
| `src/gateway.ts` | Aggregate namespaced tools and route to the right service |
| `src/providers.ts` | Social endpoints and optional connections |
| `src/connections.ts` | Configured HTTP/local upstreams and isolated discovery |
| `src/local-connection.ts` | Persistent child, recovery/backoff, catalogue guard and cancellation |
| `src/oauth.ts` | Explicit SDK OAuth login, callback validation and refresh provider |
| `src/remote-connection.ts` | Reused SDK HTTP clients, scoped credentials, queue/deadline/reconnect/cooldown handling |
| `src/auth-store.ts` | Owner-only local state and cross-process credential locks |
| `src/vendor-lock.ts` | Private Zendesk/QuickBooks store checks and shared refresh/use coordination |
| `src/manage.ts` | Catalogue/plan/prepare/doctor/check/verify/login/disconnect |
| `src/prepare.ts` | Offline batch plans and private candidates; source preservation |
| `catalog/services.json` | 30 documented service candidates and setup requirements |
| `src/server.ts` | Run Hstack as a stdio MCP server |
| `src/smoke.ts` | Opt-in live account smoke check |
| `src/audit-buffer.ts` | All-tool schema, live read and write-block audit |

[Official SDK](https://ts.sdk.modelcontextprotocol.io/v2/) ·
[Buffer MCP](https://developers.buffer.com/guides/integrations/mcp.html) ·
[Buffer Bearer setup](https://developers.buffer.com/guides/integrations/n8n.html) ·
[Security](SECURITY.md) · [MIT licence](LICENSE)
