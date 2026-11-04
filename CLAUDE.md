# Hstack development

Docusign has a disabled demo registered-client profile only. Public demo OAuth
discovery passes with root-metadata fallback; production fails a confirmed issuer
mismatch. Preserve RFC 8414/RFC 9207 checks and never replace metadata to hide it.
Report metadata issuer failures as compatibility problems without reflecting raw
issuer strings. The vendor's production approval docs conflict; no approval,
account login, tool operation or production compatibility is established.

Pipedrive's hosted endpoint and public OAuth metadata are verified. Its disabled
profile requires MCP-compatible registered-client refs and unverified callback
acceptance; do not infer native public DCR support from the advertised endpoint.
Zoho CRM/Desk/Books use private account-generated URL refs with initially empty
read allowlists; do not invent vendor tool IDs or add Bearer headers. Their
transport/privacy evidence is fixture-only, not live vendor validation.
Background OAuth startup must not register a client before requesting explicit
login. Preserve typed auth/permission/quota failures when SDK negotiation wraps
them; traverse bounded Error causes, never parse/log raw upstream diagnostics.

QuickBooks uses an Intuit source-pinned Hstack compatibility build, not an official
binary. Keep the original 298-file tree check, dependency overrides, equivalent
142-tool schema constraints, explicit error flags and noninteractive policy capture.
Its 70 permitted reads exclude invoice PDF downloads. Preserve labels, genuine empty
lists/counts and warnings; normalize only known native read failures. Credential
guards inspect metadata only and coordinate Hstack clients, not standalone auth.
Native Hermes registry search/read/download-block passed using the same synthetic
backend in a fresh home. This does not prove live accounts, browser consent,
model-driven use or official upstream release compatibility.

BigQuery uses the official SDK legacy handshake (2025-11-25) without result
rewriting. Its disabled native Google profile permits five metadata reads; SQL
stays blocked. Modern server/discover still returns -32601. Public metadata and
synthetic Google/Hermes registry tests are not real account/IAM/model evidence.
Preserve explicit protocol selection; do not fabricate capabilities or promote
the candidate before required live validation.

Zendesk pins the community 0.1.6 runtime with native read-only mode and 14 JSON
reads. Do not claim it is official or live-account tested. Its private child HOME
owns the native credential file; Hstack checks metadata but never copies/opens
tokens. Co-located locks coordinate Hstack clients across state roots and are
drained on graceful close. Standalone vendor clients/setup are outside this lock.
Keep native writes suppressed and attachment downloads blocked. Normalize only
reviewed JSON-read errors; never scan ticket JSON/Markdown for error keywords.
The actual vendor comparison uses local synthetic HTTP and network routing,
not live Zendesk OAuth/API proof. Native setup still requests read/write OAuth
scope. POSIX plaintext storage, crashed locks and quota-header limitations remain.

MySQL uses a reproducible MySQL-only Toolbox 1.15.0 compatibility build. Keep
native query code unchanged; registration filtering, locked dependency updates
and a hash-guarded telemetry schema import are the bounded changes. Retain symbols
for precise govulncheck review. JSON scanner exit zero is not a clean result:
the audit gate rejects linked package/symbol findings and reports module-only
matches. Do not erase the unlinked OpenPGP advisory or describe the full upstream
module graph as clean. Only macOS arm64 is validated. The real verifier accepts
binary paths only, creates/removes its own DB, uses generated users and executes
only a synthetic opt-in insert. Never point it at an existing database. SQL
writeTools permission allows arbitrary SQL within DB grants, not one statement.

Display the brand as Hstack; package and tool prefixes use hstack.

Hstack is a unified MCP gateway prototype for Hermes. It aggregates configured social providers over stdio using service__tool names.
Social endpoints are in src/providers.ts. Thirty disabled setup profiles are in
catalog/services.json and connections.example.json; configured HTTP/stdio
connections are loaded by src/connections.ts. Do not claim those templates are
live-verified integrations. Native local OAuth is implemented and fixture-tested;
vendor OAuth validation remains pending. Writes are disabled by default. Discovery is
also available as a standalone experiment. Do not recreate the removed Hermes CLI
wrapper, SSH toolkit or broad workflow catalogue.

The local setup utility has an offline doctor action. It must never spawn a
program, contact a service, inspect stored credentials or call tools. Passing it
only checks local prerequisites. urlEnv/commandEnv keep private endpoints and
executable paths out of JSON; resolve and validate them for runtime and OAuth
management, without printing their values. Preserve existing configuration.

catalog/plan/prepare are offline onboarding actions. Plans contain only public
defaults, fingerprints and change-key names, never private source values. Prepare
creates a new owner-only ignored snapshot, preserving the source and configured
entries. New/replaced templates stay disabled; only unused legacy placeholders
may be replaced. Never auto-select, install, sign in or activate a candidate.
Full candidate contents remain private. Unresolved vendor templates must fail
instead of being presented as usable integrations. See docs/onboarding.md.

OAuth clientIdEnv/issuerEnv/scopeEnv/clientMetadataUrlEnv are exclusive alternatives
to literal settings. Resolve them before any OAuth action; missing registered
client values must never fall back to dynamic registration. Explicit scopes are
requested in foreground login; preserve the original grant during refresh. The
BambooHR/Greenhouse profiles are documentation-reviewed, not live-validated.

Xero uses the official hosted endpoint, a registered public PKCE client and
explicit read scopes, not the older local package. Its underscore tool names
differ from the local server. The public metadata checker makes only two
unauthenticated GETs; never turn that evidence or synthetic secret-free OAuth
tests into an account compatibility claim. Core+ or Starter demo eligibility,
app registration and exact callback acceptance still need user/vendor setup.

Google Analytics pins the official 0.8.0 runtime with native Google ADC, not
Hstack HTTP OAuth. Its ADK 1hstack wheel changes only two dependency bounds and
wheel metadata to admit patched OpenTelemetry 1.45.1. Keep the original hash,
deterministic output, licences and source bytes intact; never bypass the builder
or audits. The runtime test uses missing synthetic ADC and a network guard;
successful schemas and rejected reads do not prove live account access. No
--allow-write flag belongs in the bundled profile. Quota-project references must
resolve privately, without opening ADC files during offline doctor checks.

Use the official MCP SDK. Reserve server stdout for protocol messages. Never
commit .env, account data, Inspector exports, credentials or private paths.
Preserve all existing local work and external recovery archives.

The official v2 packages are pinned; docs/protocol-compatibility.md records the
modern/legacy paths and evidence. Never replace strict discovery with a silently
truncated catalogue, print raw OAuth error bodies, or treat modern local fixtures
as a live vendor account test. Built-in social adapters keep their prior handshake.

npm test runs local HTTP and stdio fixtures with synthetic credentials.
npm run smoke:buffer and npm run audit:buffer perform live reads using .env; never run them
as an automatic CI test. Keep mocked, live gateway and native Hermes discovery
evidence distinct. Do not claim a model-driven chat or a second integration works
without actually verifying it. Never enable real writes as part of routine tests.
All-tool fixture coverage is not live write verification.

Custom connections can allow exact upstream writeTools names while keeping
allowWrites false. Enforce the same rule in forward and search modes; permitting
one write must not permit other tools or another provider. Vendor native read-only
settings remain separate. Hstack does not relay user confirmations or elicitation.

MongoDB has a pinned official npm runtime, a targeted get-uri/basic-ftp override
with separate compatibility tests, and opt-in real disposable database verification.
Its tools require connectionId: preconfigured. The native Hermes probe uses a
temporary home and no model. Never point the verifier at an existing database,
copy generated credentials into public evidence or claim the other tools/hosted
features were verified. The manual Linux workflow is unrun.

Mailchimp has a pinned community Python runtime and an opt-in real-process check.
That check uses a synthetic key and denies network access; it is not live API or
account validation. Its result policy is explicit and release-specific: reject
null-total list responses, preserve real empty lists, enforce no vendor retries,
and keep the broken upstream ping blocked by default. Do not label the other
advertised Mailchimp operations as verified.

Redis has a separately pinned official runtime and opt-in disposable local database
verification in integrations/redis and scripts/verify-redis-local.mjs. Its synthetic
local writes are confined to a newly created test database. Never point that test
at an existing database or turn real account writes into routine tests. A native
Hermes registry probe is still distinct from a model-driven conversation.
