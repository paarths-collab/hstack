# Full connection catalogue

All 30 requested services have a disabled profile in `connections.example.json`.
Each now has a linked vendor-specific setup guide or a section in the shared OAuth guide.
The existing five social adapters remain available. Redis and MongoDB have real local database
and native Hermes tool evidence. Mailchimp has a pinned community runtime and
network-denied vendor-process checks; its account remains unverified. Other
expansion profiles are **setup templates**, not completed vendor integrations.

## Enable a connection

1. Keep your existing local `.env` values. Never replace that file with an example.
2. Use [offline batch setup](onboarding.md) to plan and prepare chosen disabled
   profiles without overwriting existing settings, or copy them manually into
   your private configuration. Set `enabled: true` only after completing vendor setup.
3. HTTP profiles reference credentials by environment-variable name. Put the real
   value in `.env`; never inline it into headers or command arguments.
4. Stdio profiles require an already installed, configured vendor MCP executable.
   Replace placeholder commands/arguments using the linked vendor instructions.
5. Native HTTP OAuth profiles use Hstack's explicit local `login` command and
   restricted plaintext token store; see [OAuth setup](oauth.md). These are disabled
   protocol templates, with vendor sign-in/operations still unverified. Typeform
   now has a [native regional CIMD candidate](../integrations/typeform/README.md);
   its public metadata passes, while account validation remains pending.
   [HubSpot](../integrations/hubspot/README.md) also uses native HTTP with a
   registered connector and PKCE. No bundled profile now launches an external
   bridge. No packages are auto-installed. A URL alone is insufficient for every provider.
6. Account-specific HTTP profiles use `urlEnv`; put the correct vendor endpoint
   in the referenced environment variable. For remaining generic local templates,
   confirm the vendor-recommended connection before replacing the command. Unknown
   endpoints are deliberately unset, and no private configuration is auto-migrated.
   Pipedrive now uses its documented hosted endpoint with registered-app references.
   Zoho CRM/Desk/Books use private generated URL references; their API key is in
   the complete vendor URL, so no extra Bearer header or Hstack OAuth login is added.
   Docusign's bundled profile is demo-only. Its production OAuth metadata currently
   fails issuer validation; changing the URL is not a supported migration.
7. Inspect discovered tools, then put only reviewed read-only tool
   names into `readTools`. With no write opt-in, an empty list blocks all calls
   while allowing discovery. Use `writeTools` for exact reviewed write/unreviewed
   names. `allowWrites: true` permits every operation; the default is false.
   Annotations alone do not bypass permissions.
   Redis includes five reviewed reads. The pinned Mailchimp profile includes four
   reviewed reads and a bounded result policy; see its setup guide below.
   BambooHR includes three documentation-reviewed metadata reads, not live tests.
8. Restart and validate a read before authorizing any writes.

## Check setup before connecting

```sh
npm run build
node --env-file=.env dist/manage.js doctor my-service
```

Replace `my-service` with a configured ID. `doctor` is offline: it reports missing
environment-variable names, invalid endpoints, placeholder/missing executables,
disabled entries and empty read allowlists. It never spawns a vendor program,
contacts a service, reads stored OAuth credentials or modifies configuration.
It exits nonzero for missing local prerequisites. A successful offline check does
**not** validate account eligibility, credentials, installed package versions,
arguments, OAuth login, vendor permissions or a working tool call.

Then use `login <id>` if native OAuth is configured, and `check <id>` for actual
MCP discovery. `check` consumes vendor requests but runs no tools. The separate
`verify redis` command performs a database read. `verify mailchimp` performs an
audience read; it requires a real account/key and consumes an API request.
`verify mongodb` validates a structured database-list read using the pinned
vendor's `preconfigured` connection handle. `verify google-analytics` reads
account summaries using native Google ADC; it does not prove access to a specific
property or a reporting query. Missing ADC can still pass schema discovery.
`verify mysql` reads schema metadata and supports Toolbox's per-row JSON format.
`verify zendesk` reads groups through the configured native vendor OAuth store;
successful discovery alone does not validate it.
`verify quickbooks` reads company information through Intuit's native token store;
it requires explicit foreground vendor authentication first. The reviewed profile
uses a pinned compatibility build; see [setup and limits](../integrations/quickbooks/README.md).
Other services do not yet have an operational verification command.

`check` explicitly reports discovery success separately from account operations.
Deel's [native candidate](../integrations/deel/README.md) can discover eight anonymous
tools before login. Its public SDK/gateway schemas are verified, but public tool
execution and protected account access remain unverified. The default candidate
requests four read scopes using native OAuth; an existing PAT configuration is
preserved, with a separate PAT alternative available. Review/restart after an
authenticated catalogue changes. `verify:deel-metadata` performs public discovery
and local gateway metadata checks only.

BigQuery uses the official SDK's verified legacy handshake. Its
[public metadata probe](../integrations/bigquery/README.md) reads the public
catalogue, compiles all 18 schemas and verifies gateway discovery without an
account. It exits zero when native legacy/gateway discovery passes, retaining
the unsupported modern comparison in a separate field. Google credential refresh,
real stdio calls and installed Hermes registry reads have synthetic coverage;
real account/IAM and model validation are pending. Direct Hermes also works in
that fixture. The disabled template permits five metadata reads and blocks SQL.

### Private endpoints and installed executables

Account-specific MCP URLs can contain private tenant identifiers or access keys.
Keep the full value in `.env` and reference its name instead of copying it into
JSON. Use exactly one of `url` or `urlEnv`:

```json
{
  "id": "my-service",
  "label": "My service",
  "enabled": false,
  "transport": "http",
  "urlEnv": "MY_SERVICE_MCP_URL",
  "headers": { "Authorization": { "env": "MY_SERVICE_TOKEN", "prefix": "Bearer " } },
  "readTools": [],
  "allowWrites": false
}
```

The same endpoint validation applies after resolution: HTTPS for remote servers,
no username/password or fragment; HTTP is allowed only for loopback development.
The example header applies only to a vendor that documents Bearer authentication.
For native OAuth use `oauth` instead of `headers`; login, refresh and disconnect
resolve the same URL and bind the local credential store to it. Changing the URL
requires a separate sign-in. Do not share URLs containing credentials.

An installed vendor executable can similarly use `commandEnv` instead of
`command`, with its absolute path in the referenced environment variable:

```json
{
  "id": "local-service",
  "label": "Local service",
  "enabled": false,
  "transport": "stdio",
  "commandEnv": "MY_SERVICE_MCP_EXECUTABLE",
  "args": [],
  "env": { "VENDOR_API_KEY": "MY_SERVICE_API_KEY" },
  "readTools": [],
  "allowWrites": false
}
```

Install and pin a reviewed vendor version first, then supply its documented
arguments and environment references. Neither field installs anything or runs a
shell. Never put credentials in arguments. Existing literal `url` and `command`
configurations still work; existing private files are not migrated automatically.

## Profiles

| Service | Category | Setup path | Live account evidence |
| --- | --- | --- | --- |
| [Brand24](https://help.brand24.com/en/articles/13011375-brand24-mcp) | listening | Native OAuth template (unverified) | Pending |
| [Brevo](../integrations/brevo/README.md) | email | Native HTTP; MCP-specific Bearer token | Header fixture passed; catalogue/account pending |
| [Kit](https://developers.kit.com/mcp/kit-mcp) | email | Native OAuth template (unverified) | Pending |
| [Mailchimp Marketing](../integrations/mailchimp/README.md) (community) | email | Pinned Python 3.12 runtime + API key | Real runtime/local metadata checked with network denied; account pending |
| [Readwise](https://docs.readwise.io/tools/mcp) | knowledge | Native OAuth template (unverified) | Pending |
| [Evernote](https://dev.evernote.com/mcp/quickstart) | knowledge | Native OAuth template (unverified) | Pending |
| [Typeform](../integrations/typeform/README.md) | forms | Native regional HTTP/CIMD; public client JSON required | Public OAuth metadata passed; account pending |
| [Cal.com](https://cal.com/docs/mcp-server) | scheduling | Native OAuth template (unverified) | Pending |
| [Trello](https://github.com/atlassian/trello-mcp-server) | planning | Native OAuth template (unverified) | Pending |
| [Pipedrive](https://support.pipedrive.com/en/article/mcp) | crm | Account/region-specific setup | Pending |
| [Zoho CRM](https://www.zoho.com/mcp/services/zoho-services.html) | crm | Account/region-specific setup | Pending |
| [HubSpot](../integrations/hubspot/README.md) | crm | Native HTTP; registered connector/secret-post PKCE | Public OAuth metadata passed; account pending |
| [Help Scout](https://docs.helpscout.com/article/1779-connect-your-ai-agent-with-help-scout-to-search-conversations-and-pull-reports) | support | Native OAuth template (unverified) | Pending |
| [Zendesk](../integrations/zendesk/README.md) (community) | support | Pinned Python runtime + dedicated native OAuth home; reads only | Real process/local OAuth/API/Hermes fixtures checked; account pending |
| [Zoho Desk](https://www.zoho.com/mcp/services/zoho-services.html) | support | Account/region-specific setup | Pending |
| [PandaDoc](https://developers.pandadoc.com/docs/getting-started-with-mcp) | documents | Native OAuth template (unverified) | Pending |
| [Docusign](https://developers.docusign.com/platform/mcp-server/) | documents | Account/region-specific setup | Pending |
| [QuickBooks](https://github.com/intuit/quickbooks-online-mcp-server) | accounting | Configured local vendor MCP | Pending |
| [Xero](../integrations/xero/README.md) | accounting | Official hosted MCP + registered public PKCE; Core+ or Starter demo | Public metadata checked; account pending |
| [Zoho Books](https://www.zoho.com/us/books/help/mcp/zoho-books-mcp.html) | accounting | Account/region-specific setup | Pending |
| [Google Analytics](../integrations/google-analytics/README.md) | analytics | Pinned official Python runtime + ADK compatibility build + native ADC | Real process/schemas/errors checked; account pending |
| [MongoDB](../integrations/mongodb/README.md) | data | Pinned npm runtime + private connection URI | Real disposable DB and native Hermes registry; hosted pending |
| [MySQL via Google Toolbox](../integrations/mysql/README.md) | data | Reproducible MySQL-only compatibility build + DB user/TLS setup | Real disposable MySQL/native Hermes checked; hosted/TLS pending |
| [Redis](../integrations/redis/README.md) | data | Pinned Python 3.12 runtime + Redis | Real local DB and native Hermes tool path; hosted pending |
| [BigQuery](https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp) | data | Native private Google credential file | Public discovery + synthetic auth/calls; live pending |
| [Snowflake](../integrations/snowflake/README.md) | data | Native HTTP; registered OAuth; account/server-object URL | Disabled; lifecycle/account validation pending |
| [PagerDuty](../integrations/pagerduty/README.md) | operations | Native HTTP; REST API token | One documented read; header fixture passed; account pending |
| [BambooHR](../integrations/bamboohr/README.md) | people | Native OAuth with registered app and private account URL | Pending |
| [Deel](../integrations/deel/README.md) | people | Native OAuth; PAT alternative | Eight public schemas/gateway verified; operations/account pending |
| [Greenhouse](../integrations/greenhouse/README.md) | hiring | Native OAuth with admin-approved callback and private endpoint | Pending |

## Limits and evidence

- Local tests include one synthetic transport/routing check per profile and native
  OAuth protocol fixtures, including cross-process refresh rotation.
  Those fixtures do not reproduce each vendor API, real scopes or subscription rules.
- Buffer remains the only live-account-validated integration. Native Hermes discovery
  and Buffer read smoke checks are separate from multi-provider fixture evidence.
  Redis separately passed real local database operations and native Hermes registry
  calls; this does not validate hosted account/TLS/cluster configurations.
- The 30 profiles are not activated by being listed. No vendor command, OAuth flow,
  subscription, paid API call or write runs until explicitly configured.
- Direct remote connections support Streamable HTTP, not legacy SSE. A configured
  local bridge can adapt a provider needing a different supported transport.
  HTTP custom connections negotiate modern/legacy protocols automatically; stdio
  keeps the legacy default. Set `protocol` to `auto`, `legacy` or `2026-07-28` when
  needed. See [protocol compatibility](protocol-compatibility.md).
- Local subprocesses receive default safe environment variables plus only explicit
  environment references. Their stderr is hidden from agent logs; diagnose setup
  by running the vendor executable separately without sharing tokens.
  Hstack also supplies PYTHON_DOTENV_DISABLED=1 unless explicitly overridden, to
  prevent compatible Python libraries from auto-loading unrelated .env files.
- Local processes are kept alive and calls serialized; downstream closure cleans
  them up. Discovery/schema failures are isolated per configured connection.
  Unexpected child exits can recover on a new request with bounded backoff;
  uncertain operations are never replayed. See [connection recovery](recovery.md).
- `connections.json` is private and ignored by Git. Commands in it execute local
  programs without a shell; this is trusted user configuration, not a sandbox.
- No upstream resources/prompts relay or browser setup UI yet. Local children
  have reconnection supervision; initially omitted providers still require a restart.
  HTTP connections, including native OAuth and BigQuery, reuse SDK clients with
  bounded recovery and catalogue review. OAuth reloads credentials under the shared
  lock and replaces sessions when external auth state changes. A foreground terminal
  login/callback flow is available; see its POSIX and
  credential-storage limitations in the OAuth guide.
- No claim of zero cost or missing native Hermes support applies to this whole list.
  HubSpot and Analytics have indirect Hermes catalogue overlap.
- Docusign production custom access may require approval. HR integrations can be
  beta/admin gated. QuickBooks production OAuth needs public HTTPS callback setup.
  Cloud warehouses and accounting subscriptions can incur charges.
- Mailchimp's pinned profile checks the known list-response contract instead of
  treating swallowed errors as an empty account. It also requires its child
  retry count to be zero, preventing the vendor retry loop from replaying writes.
  These checks apply to that reviewed profile/version, not all MCP tools. Its
  broken upstream ping remains blocked. See the integration guide for evidence
  and live-validation limits.

## Compatibility with the original social package

Existing social `.env` keys continue to work. Avoid duplicate IDs between those
adapters and connections.json: Hstack keeps the built-in connection and closes
the duplicate. A broken optional connection is omitted without disabling healthy
ones. Both connection mechanisms feed the same namespacing, validation and write
policy. The old global write flag still applies only to the Buffer social adapter.

## Connection health and compact discovery

Set HSTACK_TOOL_MODE=search to advertise two control tools and request relevant
schemas on demand. The same per-service read/write checks apply. Read the
hstack://connections MCP resource for health without account contents.
HTTP rate-limit failures carry typed code/service/retry/window metadata when
known, and further requests through the same process are blocked until the
reported retry time. Limits shared with other applications or Hstack processes
are not globally coordinated yet. Local queue waits now share the total call
time budget and can be cancelled before the queued operation is sent.
