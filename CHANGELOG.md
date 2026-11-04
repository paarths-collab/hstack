# Changelog

## Unreleased

Added a native Docusign demo setup and a credential-free demo/production OAuth
metadata probe. Confirmed production issuer inconsistency rejected by the SDK;
production remains blocked, with no issuer-validation workaround. Added safe
metadata-vs-callback issuer diagnostics, registered OAuth default-Basic/refresh
coverage, profile/credential isolation and preparation regressions. Demo account
consent/tool calls and production eligibility remain unverified.

Replaced Pipedrive and Zoho CRM/Desk/Books executable placeholders with native
disabled HTTP setup profiles. Pipedrive's official endpoint/public OAuth metadata
are confirmed; registered-app/callback acceptance remains pending. Zoho uses
private generated URL-key references and no guessed read allowlist. Fixed
unattended OAuth startup creating a remote client before requesting login, and
SDK negotiation masking typed auth/permission/quota errors. Local regressions
cover those failures and the new setup/privacy boundaries; vendor accounts remain
unverified and existing private configurations are preserved.

Added an Intuit source-pinned QuickBooks compatibility runtime with 70 permitted
reads, private native token-store coordination and a company-read verifier. Fixed
swallowed native tool errors, unattended sandbox sign-in and vulnerable Zod/URI
decoder dependencies. Restored original schema constraints during the Zod upgrade;
all 142 input schemas compare equivalent. Installed-process synthetic refresh,
read/error/permission tests, search-mode discovery comparison and a native Hermes
registry fixture read/download-block pass. Live accounts, browser consent,
model-driven use, write operations and production eligibility remain unverified;
this is not an official Intuit binary.

Confirmed a BigQuery native protocol incompatibility: public tool discovery works,
but the endpoint rejects the pinned SDK's server/discover request. Added a
credential-free diagnostic probe, recorded evidence, four regressions and safe
actionable protocol-negotiation errors. Kept the unresolved profile disabled;
Google authentication, queries and native Hermes account validation are pending.

Added a pinned community Zendesk MCP 0.1.6 setup, 14 JSON reads and a group-read
verifier. Fixed native plaintext auth/API failures appearing successful through
an explicit result policy. Added private native-home checks, cross-process
refresh/use coordination and graceful lock cleanup, without copying vendor tokens.
Actual installed-process/local-HTTP comparison reproduces two direct refreshes
with one rejection; Hstack rotates once and both reads succeed. Native Hermes
fixture reads pass; no live account proof is claimed. Eight regressions were added;
220 routine tests pass and the 45-package Python graph audits clean. Native writes
and attachment downloads stay blocked. Vendor setup's broad consent, live account
validation, Windows and full catalogue production acceptance remain open.

Added a tested MySQL Toolbox setup with eight diagnostic reads, native DB/TLS
references and a per-row schema verifier. Actual disposable MySQL 8.4.13 checks
cover direct/gateway reads, credential failure, exact SQL opt-in and independent
DB grants; native Hermes schema read/write-block also pass. Found vulnerable
dependencies in the official all-database binary. Added a reproducible MySQL-only
build with locked patched dependencies and a telemetry-schema startup fix, keeping
native SQL implementations unchanged. The precise binary scan has no affected
linked packages/symbols; an unlinked OpenPGP module advisory remains explicit.
Added four scanner regressions, one operational-result regression and three
source-build tests. Hosted/TLS, other platforms and model-driven use are pending.

Added a pinned official Google Analytics MCP 0.8.0 setup, nine reviewed reads,
native ADC/project references and an account-summary operational verifier.
Actual installed-process checks cover all nine schemas, missing-ADC rejection,
default write blocking and native Hermes registry discovery without an account.
Found an OpenTelemetry advisory blocked by ADK's dependency ceiling; added a
hash-verified metadata-only ADK compatibility build, patched tracing packages and
six packaging/tracing regressions. The 64-package graph audits clean and passes
dependency consistency. Real account operations, refresh and reporting remain
unverified; the compatibility build is not an official Google ADK release.

Replaced Xero's generic local command with an official hosted MCP profile using
registered public-client PKCE, explicit read scopes and three documented read
tools. Added account/plan/callback instructions and an opt-in metadata checker.
Actual SDK discovery passed against two public metadata documents without
credentials. Four new regressions cover metadata drift, source preservation,
private client references and secret-free login/refresh without DCR. These tests
do not prove real Xero account login or operations; that validation is pending.

Added offline catalogue, batch planning and private candidate preparation. Source
configuration and customized entries are preserved; new/replaced profiles remain
disabled and unresolved vendor templates fail before writes. Seven regressions
cover privacy, merging, concurrent snapshots and unsafe directories. All 202
routine tests pass. The real disposable MongoDB/native Hermes test now uses a
prepared candidate and verifies source preservation. Account setup, automatic
activation and full-service production acceptance remain separate and incomplete.

Added a pinned official MongoDB MCP runtime, four reviewed reads, preconfigured
connection-handle guidance and an operational database-list verifier. Tested
actual reads, bad credentials, default write blocking, one explicit synthetic
insert and native Hermes registry calls against a new authenticated local MongoDB.
Added exact per-connection writeTools permissions, preserving the broad legacy
allowWrites flag. Patched one advisory leaf through a tested dependency override;
the vendor graph audits clean. Hosted MongoDB and other tools remain unverified.

Replaced the BambooHR and Greenhouse local-command placeholders with disabled
native HTTP/OAuth profiles and account-specific setup guides. Added private
registration references, explicit foreground scope requests, and bundled vendor
prerequisites in the offline doctor. Local registered-client fixtures verify
secret-post authentication, no-DCR login and refresh without narrowing the grant;
unresolved references fail before OAuth actions. Live vendor accounts remain
unverified. Added shipped-profile/guide consistency coverage.

Replaced the generic Mailchimp command template with a pinned community MCP
runtime, four reviewed reads and an operational audience-read verifier. Added
an explicit result policy for swallowed list errors, blocked the release's
broken ping by default and enforced zero vendor retries. The real vendor process
discovers 227 tools under a network-denied synthetic-key test; no live account
or write is claimed. Added source/hash evidence and a Python dependency lock.

Added an offline setup doctor and private endpoint/executable environment
references, including consistent OAuth management resolution. Diagnostics expose
missing setting names and permission state without running vendor software,
reading stored credentials or printing private values. Added seven regressions;
178 local tests pass. Vendor setup templates and account validation remain open.

Migrated to the official SDK 2.4.0 split packages and added dual-generation stdio
serving, modern HTTP negotiation and per-tool routing-header support. Added
callback issuer validation, authorization-error log normalization and auth-server
quota/timeout regressions. Kept strict pagination and existing social handshakes.
171 local tests pass; Buffer and real Redis/Hermes checks passed again. Modern
vendor account acceptance remains incomplete.

Added a pinned official Redis MCP setup, five reviewed read defaults, operational
database verification, a hash-locked Python runtime and an opt-in real local Redis
comparison. Verified native Hermes registry search/read/write-block without a
model. Added a manual vendor CI workflow; no CI run is claimed. Default Python
dotenv auto-loading is disabled for local upstreams unless explicitly overridden.
163 local fixture tests pass; hosted Redis and other vendor account acceptance
remain incomplete.

Added supervised local MCP recovery with bounded exponential cooldowns, serialized
reconnects and full catalogue comparison before reuse. Added unknown/not-sent
operation metadata, lifecycle health, queued cancellation and shutdown cleanup
during startup/EOF. Fixed custom write-permission guidance to reference the actual
connections.json setting. 160 local tests pass; vendor/account acceptance remains
incomplete, and failed initial startup discovery still requires a restart.

Added native SDK OAuth login/refresh, a state-checked loopback callback, issuer
validation and owner-only atomic credential storage with cross-process locks.
Added local init/list/check/login/disconnect commands and eight disabled native
OAuth templates. Protocol fixtures validate sign-in, refresh rotation and failure
recovery; vendor OAuth accounts remain unverified. Fixed startup cleanup and
timeout classification. POSIX storage is plaintext; Windows ACLs, remote
revocation and automatic stale-lock recovery remain unimplemented.

Added optional compact tool discovery, a connection-health resource, typed HTTP
failures, Retry-After date support, process-local rate-limit cooldowns and bounded
cancellable local queue waits. Added a reproducible synthetic discovery benchmark
and a live Buffer search-mode smoke check. 132 local tests pass; full production
acceptance and other provider account validation remain incomplete.

Added 30 disabled service setup profiles, private connections.json loading,
HTTP credential references and persistent local stdio upstreams with serialized
calls and cleanup. Added per-profile synthetic transport tests; 123 tests pass.
OAuth uses an independently configured bridge, not a new Hstack login flow.
Vendor account validation for the 30 profiles remains pending.

Added optional Pallyy, Metricool header-route, Blotato and Ayrshare adapters behind
one social MCP gateway, with vendor-specific authentication, isolated discovery
failures, namespacing and per-provider write switches. New adapters are fixture-
tested, not live-account verified. Metricool read-name review remains pending.

Expanded Buffer discovery/forwarding to all 17 tools, with schema validation,
write blocking by default, 74 local tests, and an opt-in read-only live audit.
Eight read operations passed live; two detail reads lacked records. Actual write
operations remain unverified; local fixture coverage is recorded separately.

Added a local stdio MCP gateway exposing buffer__get_account, shared upstream
connection cleanup/cancellation, a live read-only smoke check and gateway tests.
Verified a live Buffer read and native Hermes discovery in an isolated setup.
No model-driven conversation, second service or hosted deployment is claimed.

Added a TypeScript MCP client experiment for Buffer tool discovery, pinned SDK
and build dependencies, and local HTTP protocol tests. The standalone discovery experiment does not execute tools.

Removed the earlier Hermes CLI configuration helper, connection definitions,
packaging and tests. Previous source is preserved in local recovery archives;
published Git history has not been rewritten.
