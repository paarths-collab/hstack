# Production readiness acceptance criteria

Objective: all catalogue connections usable through Hermes, with demonstrated
setup/operation advantages over individual MCP connections. This is not achieved
by a catalogue entry, a fixture test or a green build alone.

- Every service: correct account/region endpoint, transport, auth flow and scopes;
  no placeholder command presented as ready. Provider eligibility documented.
- Credentials: usable login/reconnect/disconnect, restricted local storage, no
  token logging, concurrency-safe refresh and revocation handling.
- Lifecycle: persistent connections, bounded startup/call/queue times, cancellation,
  reconnect, clean shutdown and isolation of a broken upstream.
- Tool protocol: schema preservation/validation, explicit read/write permissions,
  upstream error preservation; no blind retry of writes.
- User recovery: actionable auth/permission/rate-limit failures with retry/reset
  details when supplied; unknown values must remain unknown.
- Usability advantage: connection status, focused tool discovery and reusable
  configuration. Compare equivalent direct and gateway paths with recorded inputs.
- Hermes: native discovery plus a real model-driven read and an approved disposable
  write. No paid model calls or external writes without specific authorization.
- Live evidence: real account operations for each claimed integration. Missing
  accounts, eligibility or data are recorded as unverified, not as passing.
- Release: reproducible build, relevant tests, dependency and secret scans,
  platform support evidence, accurate docs and no private test data in releases.

Current external constraint: only Buffer credentials are available. No other
service account exists yet. Work can proceed on software, fixtures, login and
setup, but all-service live validation cannot yet be claimed.
Redis can be validated locally without an account and now has that evidence below.

Work stages: runtime/recovery and discovery -> authentication/setup -> individual
service contracts -> live accounts -> Hermes acceptance and comparative benchmark.
Keep the objective open until all acceptance criteria have evidence; account-dependent
acceptance is blocked while the required accounts and authorization are absent.

## Credential and reliability hardening (2026-11-04)

- Hstack-owned Desktop keys and OAuth access/refresh tokens use AES-256-GCM with
  a macOS Keychain-held master key or explicit POSIX master-key file. No automatic
  plaintext fallback. Existing records require explicit atomic migration.
- Revoked Desktop keys deactivate and require replacement/revalidation; a late
  failure cannot revoke a replacement key revision. Transient outages preserve
  activation and recover on a later read. Reported rate-limit cooldowns persist.
- Discovery failures use bounded backoff; HTTP, stdio and Desktop operation queues
  are capped at 64. Excess requests fail before dispatch. No blind mutation replay.
- Regression tests cover encrypted OAuth refresh/revocation/reauthentication,
  corruption/tampering/identity swaps, missing or unsafe master keys, migration,
  burst backpressure, outage recovery and replacement races. Native macOS Keychain
  was separately exercised with a disposable synthetic item.
- The real Buffer plugin/backend/React/native-registry flow passed again using
  encrypted storage in a disposable profile. This is not a packaged Desktop app
  or model-driven conversation, and does not validate other vendor accounts.
- Third-party credential files and legacy environment configuration are outside
  this vault. There is no automatic vault-key rotation/portable backup, Windows
  support, multi-user isolation or automatic crashed-lock stealing. See the
  [operational recovery guide](credential-security.md) before deployment.

## Desktop social connection flow

- Buffer: the real-account read path passed through the plugin HTTP API, private
  key storage, profile-scoped native Hermes configuration, native Hermes registry,
  Hstack stdio and Buffer. Validation-before-activation, deactivation, blocked
  inactive reads, removal and preservation of an unrelated MCP entry passed in a
  disposable profile. No model call, public post or normal-profile modification.
- Fixed account-plus-quota MCP text blocks being combined by Hermes; regression
  tests cover that exact response shape, error handling and native worker cleanup.
- Pallyy get_me, Blotato blotato_get_user and Ayrshare list_profiles use reviewed
  schema-checked reads for validation. Their key/activation flow is fixture-tested;
  real accounts/plan access remain unverified. Metricool has no reviewed read and
  cannot activate. All other catalogue Desktop screens remain unimplemented.
- Dedicated Desktop entry excludes environment keys and writes, shares one entry
  across supported providers, refreshes active keys before calls, and preserves
  unchanged providers' cooldowns. Saving a replacement invalidates activation.
- The actual React component also passed the live Buffer flow under jsdom, with
  fixture Hermes routing atoms and real plugin backend calls. Password clearing
  and disabled activation/use buttons were checked.
- Actual Hermes Desktop is not installed, so renderer/app loading, authenticated
  plugin mount, profile selection in the UI and model-driven chat are NOT tested.
  The native read button uses a separate registry worker, not an active chat.
  Hstack-owned keys now use the encrypted vault described below; Windows remains unsupported.

## Current acceptance boundary

- The tagged Hermes source moves registration, naming and shutdown helpers out
  of tools.mcp_tool. Seven optional native verification scripts now delegate to
  the correct Hermes module in either layout; no Hermes code is patched. The
  BigQuery fixture also contains both host httpx and SDK httpx2 preflight traffic.
  [Pinned source review and limits](hermes-release-review.json).

- The same clean public export passes all 386 routine tests, without skips, on
  Node 22.23.4, 24.22.2 and 26.8.1 on macOS arm64. The downloaded Node 22/24
  archives were verified against official SHA256 files before execution.
  [Runtime evidence](runtime-verification.json) fingerprints the tested code.
- Anonymous native SDK initialization was checked for Brand24, Brevo, Readwise,
  Trello, Help Scout and PandaDoc. Each returned HTTP 401 before tool discovery.
  No auth provider, credentials, registration, token or tool call was used.
  Their empty read lists remain intentional until an authenticated catalogue is
  reviewed. A 401 here is not proof of a broken service.
  [Observed access boundaries](anonymous-catalogue-review.json).
- No additional hosted service accounts exist yet. Account signup, eligibility,
  consent, authenticated schema review, safe reads and refresh/revocation checks
  are required before claiming those integrations work for users. Account-specific
  endpoints and the documented Docusign/Snowflake compatibility gates also remain.
- Model-driven Hermes acceptance, an explicitly approved disposable write,
  an equivalent direct-versus-Hstack setup/task comparison, and remote CI remain
  release gates. Local fixtures and metadata byte counts do not satisfy them.
  No signup, paid model/API call, deployment or GitHub write was performed.

## Current header-auth and Deel public-catalogue stage

- Added setup guides for the final three entries, so all 30 now have concrete
  vendor-specific instructions. Brevo requires an MCP-option token. PagerDuty's
  native remote token header is documented and its single list_incidents read
  comes from the maintained hosted reference, not the archived local tool list.
  Both header routes pass synthetic native SDK tests; neither account was used.
- Deel's documented anonymous initialize/tools/list route exposed eight input
  schemas. The official SDK compiles all eight and preserves their definitions
  through Hstack's actual forward/search registry. Public OAuth metadata also
  passes two fixed GETs. No vendor tool invocation, credential, DCR, token or
  account data was used. [Evidence](../integrations/deel/verification.json).
- The disabled Deel default now uses native OAuth and four requested read scopes;
  eight exact public read/noauth names are permitted. Protected HR/contract/payroll
  tool names remain unverified and blocked. Existing PAT entries/source are
  preserved; a separate PAT alternative is provided, with no silent auth migration.
- New regressions cover public discovery, schema/search preservation, OAuth
  metadata drift, public-before-login behavior, no background registration after
  challenge, catalogue change after auth identity replacement, PAT preservation
  and both token-header formats. All 356 routine tests pass.
- Management check now says MCP discovery succeeded and explicitly leaves account
  operations unverified. Public catalogues can be discoverable without credentials.
  Recorded eight-tool/11,155-byte versus two-control/843-byte counts are SDK metadata
  measurements only, not model, billing, latency or native Hermes evidence.
- No real vendor read (public or protected), account authorization, feature/plan/
  quota response, native Hermes/model-driven account flow or measured setup-time
  advantage was established. Brevo still blocks all operations pending a real
  catalogue. Do not promote these candidates to production from schema tests.

## Remaining-OAuth catalogue stage

- Sixteen public metadata GETs pass native SDK discovery for Brand24, Kit,
  Readwise, Evernote, Cal.com, Trello, Help Scout and PandaDoc global. No external
  registration, sign-in, tokens or tools were requested. A reusable strict-origin
  metadata checker preserves scoped issuers and refuses to hide new IdPs behind
  a fallback. [Observed metadata](oauth-catalogue-review.json) is separate from
  account/production proof.
- Added 38 documentation-reviewed Kit reads, 10 Evernote reads with requested
  read scope and 43 Cal.com reads. Their standalone disabled profiles and shared
  guide record subscription/role restrictions and blocked writes. Brand24,
  Readwise, Trello, Help Scout and PandaDoc retain empty read lists until actual
  tool names/schemas are reviewed. Existing private HTTP settings are preserved.
- PandaDoc advertises only secret-post/Basic token authentication. The SDK's
  default public DCR request declares none. A new explicit dcrAuthMethod option
  passes the selected method through native SDK metadata and rejects unadvertised
  support, missing secrets and response downgrades. It does not alter SDK client
  classification or claim vendor acceptance. Generated secrets use private
  storage; previous default auth-state identities remain unchanged.
- Thirteen regressions cover metadata boundaries/isolation/issuer validation,
  candidate read limits, native secret-post/Basic PKCE and refresh, method/secret
  validation, identity isolation and ambiguous settings. All 348 routine tests pass.
- No real account, DCR acceptance, callback approval, tool catalogue, plan/quota
  response, native Hermes/model-driven account use or measured setup advantage
  was established. All candidates remain disabled. See the
  [shared setup guide](../integrations/oauth-batch/README.md).

## Clean-install and runtime baseline stage

- Official Node 22.23.4 macOS arm64 was downloaded to a disposable directory and
  verified against its published archive SHA256 before execution. It passes the
  normal build and all 335 routine tests with a fresh private home and no inherited
  service credentials.
- A second run exports only public/unignored files, excludes private `.env`, actual
  connections, dependencies, build output and vendor artifacts, then installs the
  root integrity lock with scripts disabled into the clean directory. All 335 tests
  pass again on Node 22 and on the existing Node 26.8.1 runtime, with no skipped
  tests. The executable/config files are compared to the current worktree and
  fingerprinted in [runtime-verification.json](runtime-verification.json).
- Routine CI now covers Linux/macOS with Node 22/24/26, fail-fast disabled and a
  bounded timeout. Setup/checkout action commits match their official v4 tag refs;
  checkout no longer persists repository credentials. All six workflow files pass
  checksum-verified actionlint 1.7.12 locally.
- This does not prove a remote CI run. Node 24, Linux/GitHub-hosted execution,
  earlier Node 22 patches, Windows guards, optional installed vendor builds and
  hosted account acceptance remain unverified by this stage. No source-runtime
  compatibility failure was found; no tests were weakened or skipped.

## HubSpot native registered-OAuth stage

- Replaced the last bundled external bridge with a disabled native HubSpot CRM
  HTTP profile. The native SDK handles registered PKCE and advertised secret-post
  authentication. No custom OAuth implementation or background registration was
  added. Actual private configuration and bridge credentials were preserved.
- Two public credential-free metadata GETs pass native SDK issuer validation.
  Empty scopes are observed in both documents; the profile leaves them unset
  because the vendor determines access during installation. Empty scope arrays
  are not a read-only/no-permission grant. The dedicated connector and exact
  loopback callback still need account validation.
- Seventeen read names were reviewed from the vendor's primary markdown guide.
  Mixed manage tools, CRM SQL queries, client-restricted UI/render tools and
  feedback stay blocked. These defaults are not live schemas or tool proof.
- Five added regressions cover fixed public discovery, drift/redirect rejection,
  private prerequisites and bridge migration, plus empty-scope PKCE/secret-post
  refresh without DCR. All 335 routine tests pass.
- No HubSpot account, connector creation, callback approval, live consent,
  catalogue, safe account read, refresh/revocation, model-driven flow or measured
  setup-time advantage was verified. This is a setup candidate, not production
  acceptance. See the [guide](../integrations/hubspot/README.md).

## Typeform native CIMD stage

- Removed Typeform's external `mcp-remote` template in favor of a disabled native
  HTTP/CIMD profile with explicit region/issuer references and 28 documented read
  names. No client secret is used. A public static client metadata document must
  still be hosted by the operator; none was deployed here.
- Public native SDK metadata discovery passes across all three documented regions,
  using nine unauthenticated metadata GETs. Root fallback, admin authorization
  endpoints, advertised DCR and issuer-specific offline_access were observed;
  DCR was not invoked. No tool discovery or account request ran.
- Local fixtures pass CIMD selection, PKCE, token exchange/refresh and reused MCP
  reads with no DCR/secret. Explicit CIMD refuses fallback registration when
  advertisement disappears. Ambiguous registered/CIMD identity settings and wrong
  regional endpoint/issuer pairs are rejected. Changing a region isolates state.
- Private preparation replaces only an untouched disabled default bridge and
  retains customized settings/source bytes. Seven new routine regressions cover
  those behaviors and metadata drift; all 330 routine tests pass.
- Installed Hermes source already supports CIMD. No claim is made that a direct
  Typeform connection requires Hstack. Curated setup/read permissions and shared
  management are implemented; live setup-time/model comparisons remain pending.
- No Typeform account, hosted document, callback approval, consent, native vendor
  schema, safe account read, plan/quota response or live refresh was verified.
  Keep this candidate disabled. See the [guide](../integrations/typeform/README.md).

## Snowflake setup stage

- The last generic executable placeholder is replaced by a disabled native HTTP
  candidate with private endpoint/registered OAuth references. All 30 profiles
  can now be prepared; this means a setup template exists, not that every service
  works. The actual private configuration was not changed.
- Official Snowflake docs require account/server objects, registered OAuth,
  callback approval, warehouse/role/tool grants, and SSE response handling. They
  also exclude lifecycle/version negotiation; actual SDK initialization needs
  an account check before activation. No metadata or account endpoint was probed.
- Four added regressions check private setup diagnostics, preparation preservation,
  safe rejection of a synthetic lifecycle-free upstream, and native SDK parsing
  of split SSE results. No initialization result or vendor parser was fabricated.
- All 323 routine tests pass. No Snowflake account, login, token, paid warehouse
  operation, native Hermes Snowflake session or model call was tested. Its read
  list remains empty and candidate disabled. See the [guide](../integrations/snowflake/README.md)
  and [evidence boundaries](../integrations/snowflake/verification.json).

## BigQuery native SDK and Hermes stage

- The disabled native HTTP candidate replaces BigQuery's executable placeholder.
  Public endpoint discovery preserves nine schemas through Hstack's actual
  gateway registry, and all 18 input/output schemas compile. Public legacy SDK
  initialization negotiates 2025-11-25. Only modern server/discover still fails.
  The experimental Protocol subclass/result rewriting was removed in favor of
  the verified standard SDK path. Existing pinned modern configs fail explicitly
  until reviewed; private files are never silently migrated.
- Native Google auth library 11.3.2 signs service-account JWTs and refreshes
  authorized-user credentials from an explicit private file. Local tests cover
  cached/expiring tokens, file rotation, concurrent cancellation, fixed endpoints,
  no retries, safe errors and rejected external credential sources. No real Google
  identity was read, authorized or used.
- Gateway fixtures verify schema preservation, metadata reads in forward/search
  modes, exact uint64/int64 bounds, protobuf duration, default SQL blocking, empty
  results, unknown outcomes after cancellation and safe quota/auth errors.
- A real Hstack stdio process passes search, native token refresh reused across
  two metadata reads, SQL blocking and health privacy with network denied.
  Installed Hermes also reads the same synthetic dataset directly (default auto
  negotiation, static synthetic header) and through Hstack. This is transport and
  registry evidence, not a benchmark of Hermes OAuth or proof Hstack is necessary
  for basic BigQuery access. Source/runtime hashes and limits are recorded in
  [runtime evidence](../integrations/bigquery/runtime-verification.json).
- The same two-read fixture now measures five MCP POSTs through either direct
  Hermes or Hstack, down from nine through Hstack. Static-credential HTTP services
  and BigQuery reuse one SDK client; native HTTP OAuth now does the same while
  reloading credentials under its shared lock. This proves removal of the measured setup overhead,
  not a latency, billing, model-cost or OAuth-setup advantage.
- HTTP regressions cover independent deadlines, scoped credential rotation,
  queued cancellation/rate limits, non-extending cooldowns with known windows,
  no-replay reconnects, catalogue review and shutdown. Google rejects new stateful
  sessions before credential loading; a rejected access token is cleared for
  the next explicit request without replaying the failed one.
  BigQuery tests and both vendor verifiers now use OS temporary paths rather
  than macOS-only /private/tmp; the Linux CI execution itself remains unrun.
- Warm native OAuth fixtures prove one setup for two reads, local disconnect,
  stateful session replacement after a new login, own-refresh reuse, lock ownership
  through the account response and cancellation while waiting for the lock.
  Two already-warm OS processes rotate a refresh token once with no stale-token
  attempt; the other process replaces its old MCP session before the next read.
- All **319 routine tests pass**. These tests and public discovery do not prove
  real Google account/IAM/quota/refresh, actual account result compatibility,
  live Hermes acceptance, model behavior or release/CI readiness. Keep the
  candidate disabled. See [setup and limits](../integrations/bigquery/README.md).

Earlier stage notes below retain their original test totals and describe the
evidence available at that stage; they do not override these current limits.

## Docusign demo and production issuer stage

- Replaced the Docusign executable placeholder with a disabled registered-app
  demo HTTP profile. Public SDK OAuth discovery passes, including fallback from
  the scoped metadata path (403) to the root metadata document. Only signature
  scope and two documentation-reviewed developer reads are selected.
- Production resource metadata identifies mcp.docusign.com as authorization
  server, while its AS metadata returns account.docusign.com as issuer. The
  official SDK rejects this under issuer validation. The public probe exits
  nonzero and no production profile or compatibility workaround is supplied.
- The vendor's production approval instructions conflict across guides. Integration
  key eligibility/callback acceptance, demo consent, actual tools and production
  acceptance remain unverified. No sign-in, tokens or documents were used.
- Added safe distinction between metadata issuer inconsistency (UNAVAILABLE) and
  callback issuer failure (AUTH_REQUIRED), preserving SDK validation and hiding
  issuer values. Local tests also exercise confidential PKCE/default Basic and
  refresh when metadata omits authentication methods.
- All 252 routine tests passed at this stage. These local successes do not make the production
  compatibility probe pass. See [Docusign evidence](../integrations/docusign/README.md).

## Native Pipedrive and Zoho setup stage

- Pipedrive's current official guide supplies its hosted endpoint. The official
  SDK fetched two public OAuth metadata documents without credentials, client
  registration or tool calls. Its disabled profile uses registered app references
  and 23 documentation-reviewed reads. Vendor app/callback acceptance is unverified;
  native public-client DCR is not assumed compatible with confidential-only methods.
- Zoho CRM/Desk/Books now use private account-generated URL references rather than
  placeholder executables. Their read lists stay empty until account-selected
  tools are reviewed. Local HTTP fixtures verify discovery, exact permission gates,
  private URL/error handling and batch preparation preserving the source file.
  No actual generated Zoho URL or account operation was tested.
- A regression reproduced unattended startup creating an OAuth client before
  asking for login. Startup now stops before DCR. Registered confidential Basic
  PKCE/refresh passes locally; incompatible native DCR fails explicitly.
- SDK negotiation wrapped typed HTTP errors and masked authentication/quota
  failures. Bounded cause inspection preserves safe 401/403/429/500 classification,
  including supplied retry/window metadata, without reflecting private bodies.
- 246 routine tests passed at this stage. Account operations, callback/key rotation,
  native vendor Hermes use and production acceptance remained incomplete. At
  this stage, BigQuery, Snowflake and Docusign had unresolved generic profiles;
  later native stages above supersede those profile statuses.

## QuickBooks compatibility stage

- Intuit source commit 31a1dd5c3e170e368dbff651abbaf61aabde6ed9 is integrity-locked;
  all 298 installed source files match its Git tree before compatibility edits.
  This is an Hstack compatibility build, not an official Intuit binary.
- Security-fixed Zod/URI decoder versions compile with bounded adapters. A
  captured original-process comparison confirms equivalent input constraints for
  all 142 tools. The profile permits 70 reads and suppresses native writes by
  default; local-file PDF download is excluded.
- Actual installed-process tests use only synthetic loopback OAuth/API traffic.
  All 70 reads fail explicitly without credentials; native refresh/persistence,
  company/report/empty-list results, operational verification and safe API failures
  pass. Native token-store metadata/lock tests and six build regressions are separate.
- Installed native discovery is 42,773 JSON bytes versus 853 initial Hstack search
  bytes plus 575 for the first company-schema search. A search-mode fixture read
  passes. These are metadata measurements, not model or setup-time savings.
- Native Hermes registry search/company read/download-block passed with the
  synthetic backend in a fresh temporary home, no Python egress/dotenv/model use.
  Real browser consent, account/company eligibility, production HTTPS callback,
  refresh/revocation, most successful tool operations, all writes and model-driven
  QuickBooks use remain unverified. See [setup/evidence](../integrations/quickbooks/README.md).
  The complete local gateway suite passes 232 tests; six separate build/decoder
  regressions pass. Both npm dependency graphs audit clean and the public-file
  secret scan has no findings at this check. The new manual GitHub workflow is unrun.

## BigQuery public protocol check

Public unauthenticated `tools/list` returned nine schemas, but native
`server/discover` returned JSON-RPC -32601. The pinned SDK modern connection
therefore fails before authentication. The first stage left the generic profile
unresolved and added a credential-free opt-in reproduction and four regression
tests, including a compatible SDK fixture so the probe can recognize a future
repair. Protocol negotiation errors now point to compatibility review rather
than credential replacement. This is a confirmed incompatibility, not live
account or query evidence. A follow-up restricted SDK Protocol adapter now reads
all nine public schemas with stateless framing and explicitly translates the
legacy-shaped catalogue into a complete/private/zero-TTL modern envelope.
Eight additional regressions covered schema preservation, malformed results,
pagination limits, cancellation, rate limits and request IDs. The current native
native SDK/Hermes stage above supersedes the earlier custom adapter. See
[details](../integrations/bigquery/README.md).

## Evidence from runtime stage

- 132 local tests pass after connection-health, rate-limit metadata/cooldown,
  compact search and cancellable queue changes.
- Search-mode live Buffer flow passed: discover two controls, locate account
  schema, perform read, observe successful health status.
- Runtime dependency audit reports zero known vulnerabilities.
- Reproducible discovery benchmark is in docs/benchmarks/discovery.json; scope
  is synthetic discovery bytes, not production model/cost/accuracy evidence.
- Whole-account cooldown coordination and 30-service live account tests remain
  incomplete. Local reconnection supervision was added in the lifecycle stage below.

## Evidence from authentication/setup stage

- 147 local tests pass, including local OAuth registration/PKCE/issuer validation,
  refresh-token rotation across two separate processes, credential storage and
  explicit setup commands. Native login is implemented; vendor OAuth remains unverified.
- At that stage, eight disabled example profiles used native OAuth; HubSpot/Typeform
  bridge templates remained pending registration-specific native validation. Existing private
  configuration is preserved rather than silently migrated.
- That historical stage used POSIX owner-only plaintext storage. The encrypted
  vault below supersedes it for Hstack-owned credentials. Windows ACL support,
  automatic stale-lock recovery and remote revocation remain absent.
- No additional vendor accounts are available. Real service operations, a model-driven
  Hermes session and an approved disposable write are still required for full acceptance.

## Evidence from local lifecycle stage

- 160 local tests pass, including real stdio child crashes, response loss after a
  fixture mutation, exponential cooldowns, concurrent recovery, queued cancellation,
  stale-catalogue rejection, tool-list notifications and stubborn-child termination.
- Real Hstack stdio launches preserve buffered initialization and close local
  children on downstream EOF and SIGTERM, including during hanging discovery.
- Failure metadata distinguishes requests not sent from unknown operation outcome;
  no dispatched operation is automatically replayed.
- Initial startup failures still omit a provider until restart. HTTP sessions,
  automatic catalogue refresh, OS hard-kill/descendant handling and platform/vendor
  validation remain separate acceptance work. See docs/recovery.md for boundaries.

## Evidence from Redis integration stage

- Official redis-mcp-server 0.5.1, source commit
  11e67e44358cd6410d5a7e615a29539ccd71a045, tested with a real disposable Redis
  8.10.1. Six installed source files match the official tag. Python 3.12 runtime
  dependencies are hash-locked; pip-audit 2.10.1 reports zero known vulnerabilities
  across 54 packages at this check.
- 53 tools discovered, five reviewed reads and set exercised, default write
  blocking checked against database state, explicit disposable write verified.
- Native Hermes registry search/read/write-block passed in a temporary home,
  separate from CLI discovery and without a model call. Model-driven acceptance
  remains incomplete.
- Discovery succeeds with bad DB credentials in the upstream server; Hstack's new
  explicit verify command catches this through a validated dbsize read. Local
  tests now total 163, separate from the opt-in real Redis test.
- Direct discovery measured 39,600 JSON bytes vs 853 initial Hstack search-mode
  bytes, plus 5,829 for the first search. No LLM accuracy/cost/setup-time inference.
- Hosted Redis, TLS, cluster and other advertised Redis operations remain
  unverified. Other vendor accounts, placeholder setup paths and full release
  acceptance still require work. The new manual vendor CI workflow is unrun.

## Evidence from current-protocol stage

- Migrated to exact-pinned official SDK 2.4.0 packages after confirming v1 cannot
  implement the current 2026-07-28 protocol. Both downstream stdio generations and
  modern upstream HTTP are tested, including per-tool routing headers.
- 171 local tests pass. Added issuer-callback and safe-warning regressions, kept
  strict pagination despite changed SDK aggregation, and preserved auth-server
  quota metadata and timeout/cancellation classification.
- Live Buffer read and real local Redis plus native Hermes registry checks passed
  after migration. Redis schemas/discovery-size evidence remained unchanged.
- Modern vendor account validation is still missing. This removes a protocol
  incompatibility, not the remaining account/setup/operation gates. Updated vendor
  findings are in docs/protocol-compatibility.md. Full acceptance remains open.

## Evidence from offline setup stage

- 178 local tests pass. New regressions cover endpoint/executable references,
  full HTTP and stdio fixture routing after resolution, OAuth management using
  the same endpoint binding, and safe offline diagnostics.
- `doctor <id>` reports missing environment references and executable problems,
  checks resolved endpoint restrictions, and makes disabled/empty permission
  settings visible without contacting services, spawning children, reading
  stored credentials or changing private configuration.
- `urlEnv` and `commandEnv` are optional alternatives to literal settings.
  Existing files are preserved; setup does not install vendor programs or
  authenticate accounts. Passing doctor is explicitly not live validation.
- Real disposable Redis verification and native Hermes registry discovery,
  search/read/write-block passed again after connection resolution changed.
  Public-source secret scanning and the runtime dependency audit report no
  findings. No new hosted account or model call was used.
- Generic vendor command templates still need reviewed vendor-specific setup.
  Hosted accounts beyond Buffer and model-driven Hermes acceptance remain absent.

## Evidence from Mailchimp contract stage

- Replaced its generic command with an environment-referenced Python 3.12
  entry point and a fully hash-locked community server 1.2.0 / Python MCP 1.30.0
  runtime. The reviewed release imports a module removed by MCP 2; its broad
  upstream dependency range alone is insufficient.
- The real installed vendor source matches the reviewed tag. With a synthetic
  key and a test-only network-denying bootstrap, 227 tools were discovered,
  local metadata reads passed through Hstack search mode, and schema preservation
  plus default write/broken-ping blocking passed. This is not a live API test.
- Reproduced the vendor's null-total/empty-list response on network failure.
  The explicit pinned result policy turns it into an MCP error while preserving
  valid lists, including valid empty accounts. Unknown HTTP status/limit headers
  discarded upstream are not reconstructed or guessed.
- `verify mailchimp` validates a one-audience read and rejects that malformed
  response. No Mailchimp account is available; successful real API authorization,
  operations and writes remain unverified. See integrations/mailchimp/README.md
  and its verification record for the exact evidence and boundaries.
- 184 local tests pass. The locked Python runtime audit reports zero known
  vulnerabilities across 40 packages. Other service setup, hosted accounts and
  model-driven Hermes acceptance remain open; the full objective is incomplete.

## Evidence from Xero hosted-setup stage

- Replaced Xero's generic local placeholder with its official hosted MCP endpoint
  and registered public-client PKCE. The profile requests explicit read/refresh
  scopes and permits three documentation-reviewed reads. No vendor subprocess,
  external sign-in bridge or client secret is needed for this route.
- The official SDK passed actual unauthenticated discovery of the public resource
  and issuer metadata. The opt-in checker permits only two fixed metadata GETs,
  does not load credentials and rejects issuer, scope or registration drift.
  Public metadata evidence is recorded in integrations/xero/verification.json.
- A Xero-shaped local fixture passes public-client PKCE login and refresh with
  pre-registration, no DCR or secret, confidential-only methods in metadata, no
  advertised callback issuer parameter and explicit read-only consent scopes.
- All 206 routine tests pass. Root dependency audit reports zero known
  vulnerabilities, public-source secret scanning finds zero secrets and the
  locked install dry-run passes. No live Xero account, app registration, callback
  acceptance, authenticated discovery or tenant operation was tested. Core+ or
  Starter-demo eligibility still applies. GitHub CI was not run.
- Eleven generic vendor profiles remain unresolved. Real account validation and
  model-driven Hermes acceptance are still required for the full objective.

## Evidence from Google Analytics runtime stage

- Replaced the generic command with a pinned official Analytics MCP 0.8.0
  runtime, nine source-reviewed reads, native ADC/project environment references
  and a reviewed get_account_summaries operational verifier. The bundled command
  omits --allow-write. Google libraries, not Hstack HTTP OAuth, own ADC refresh.
- Actual Python MCP 2.3.0 vendor process: all nine read schemas discovered and
  preserved through Hstack. Missing synthetic ADC returns errors through direct
  access and the gateway; operational verification rejects that failure without
  printing the credential path. An exposed optional annotation tool is blocked
  before dispatch. No successful Google API read is claimed.
- Native Hermes registry discovery/search/write-block passes with a temporary
  home and no model or real credentials. Five installed Analytics source files
  match the official tagged release. The test-only Python network guard and
  explicit nonexistent ADC avoid normal account configuration.
- Audit found GHSA-xcq7-p3pf-p88h in OpenTelemetry 1.44.0. Normal resolution cannot
  select the fixed package because published ADK bounds exclude it. A deterministic,
  upstream-hash-verified ADK 1hstack wheel changes only dependency bounds and wheel
  metadata, keeping vendor code/licences unchanged. API/SDK 1.45.1 now install in
  a consistent graph. This is an Hstack compatibility build, not official ADK
  support for this combination or evidence about unrelated ADK functionality.
- 207 routine tests and six separate packaging/tracing tests pass. The 64-package
  Python graph has zero known vulnerabilities and no audit skips. Root audit,
  install dry-run and source diff checks also pass. Compatibility evidence and
  limitations are in integrations/google-analytics/verification.json.
- Ten generic vendor setups remain unresolved. Real Google auth, property access,
  reporting, refresh, platform coverage and model-driven Hermes acceptance still
  need validation. GitHub CI is unrun and the full production objective is open.

## Evidence from MySQL compatibility stage

- MySQL's generic placeholder is replaced by an explicit disabled profile with
  eight reviewed diagnostic reads and native driver environment references.
  Arbitrary execute_sql stays blocked by default. An operational schema verifier
  handles the actual one-JSON-text-block-per-row result format and empty reads.
- Actual isolated MySQL 8.4.13: all eight direct/Hstack reads work, static schema
  output matches, schemas are preserved, wrong passwords fail, and the database
  read role rejects an insert. Exact Hstack SQL opt-in with a restricted writer
  performs one synthetic insert; the DB role still rejects DROP. Required sys
  function privileges were confirmed through a real failed/passing monitoring read.
- Native Hermes registry search/schema-read/write-block passes with a temporary
  home and no model. A random column absent from request arguments proves a real
  read. No existing database or normal agent configuration was used.
- The official monolithic Toolbox binary has dependency findings. The Hstack
  MySQL-only build keeps all native MySQL query code, uses locked patched modules
  and Go 1.27.3, and aligns one telemetry schema import to fix a proven startup
  failure. Original source hashes guard both transformed files. The build helper
  reproduces the recorded SHA256 and refuses mismatched or unvalidated artifacts.
- Precise symbol-enabled govulncheck finds no affected linked packages/symbols.
  GO-2026-5932 remains as a module-only OpenPGP advisory; affected packages are
  absent from the compiled inventory. The full source/module graph is not called
  vulnerability-free. The audit gate checks results rather than trusting JSON
  process exit zero, refuses missing symbol inventories and retains advisory notes.
- 212 routine tests and three separate source-build regressions pass. Nine generic
  vendor setups remain unresolved. MySQL hosted/TLS, Linux/Windows builds and
  model-driven acceptance are unverified. The original production objective is open;
  no GitHub CI run or publishing is implied.

## Evidence from native Zendesk integration stage

- Replaced the Zendesk placeholder with a disabled pinned community 0.1.6
  runtime and Python MCP 2.3.0. Fourteen JSON read names are reviewed. Native
  read-only mode is required before launch; 19 native read-mode tools are
  discovered. Attachment download and other unreviewed tools remain blocked.
- The actual tagged server returns missing-auth/API diagnostics as success text.
  An explicit result policy makes JSON-read failures typed errors while keeping
  valid ticket JSON unchanged. A reviewed group-read verifier rejects unconfigured
  responses; discovery is never called account validation.
- A private native HOME/config metadata guard and co-located cross-process lock
  protect refresh/use without opening or copying vendor credentials. Waiting is
  bounded/cancellable before dispatch. Graceful close cancels callers and drains
  locks; unsafe modes/symlinks fail before launch/use. Vendor state/cache paths
  are ignored if accidentally placed inside a checkout.
- Five installed vendor files match the tag. Actual vendor processes with a local
  synthetic HTTP fixture reproduce two direct refresh attempts, one rejected.
  Two Hstack processes perform one rotation and both group reads succeed. Native
  Hermes registry reads the fixture group and blocks attachment download. A
  damaged native config still leaves writes suppressed by the environment flag.
  These are fixture results, not live Zendesk account or OAuth proof.
- All 220 routine tests pass, including eight new policy, concurrency, cancellation,
  shutdown and verification regressions. The 45-package Python runtime audit has
  zero known vulnerabilities and no skips. Root audit and install checks pass.
- Native setup still requests read/write consent; Hstack does not narrow that
  grant. Standalone vendor clients/setup do not acquire Hstack's lock. Plaintext
  storage, manual crashed-lock recovery, lost quota headers, Windows and live
  account/model validation remain limitations. Eight generic vendor setups and
  the full production acceptance objective remain open; CI/publishing is unrun.

## Evidence from registered-account setup stage

- BambooHR and Greenhouse now have disabled native HTTP/OAuth profiles and
  source-linked account instructions instead of generic local commands.
  BambooHR includes three documentation-reviewed metadata reads; Greenhouse
  keeps calls blocked until exact discovered read names are reviewed.
- Private client IDs, issuers, scopes and client metadata URLs can use environment
  references. Values resolve and validate before management/runtime OAuth actions;
  unresolved registration references fail rather than falling back to DCR.
  Credential identity uses the resolved values, with regression checks for changes.
- Local OAuth fixtures verify a pre-registered confidential client against an
  authorization server with no registration endpoint and advertised secret-post
  authentication. Explicit login scopes survive narrower resource defaults, and
  refresh preserves the grant. An additional fixture verifies SDK augmentation
  of advertised offline_access. These are synthetic protocol tests, not vendor proof.
- The offline doctor displays bundled setup guides and vendor prerequisites.
  It still performs no network, credential-store read or vendor process launch.
  Bundled profiles and guides have a consistency regression check.
- 191 local tests pass. No real BambooHR/Greenhouse account, sign-in, operation,
  callback approval or model-driven Hermes session was tested. Snowflake still
  needs its documented lifecycle/handshake behavior checked before promotion.
  Other vendor setup and the original all-service production objective remain open.

## Evidence from MongoDB and exact-write stage

- The official MongoDB MCP 3.2.1 runtime is npm integrity-locked. A targeted
  get-uri/basic-ftp 6.2.4 override clears the confirmed dependency advisory;
  two actual local FTP/parser compatibility regressions pass. No forced server
  downgrade or audit suppression is used.
- Real disposable authenticated MongoDB 8.2.11: four direct/Hstack reads match,
  preconfigured connection IDs and discovered schemas work, bad credentials are
  rejected, and retargeting is blocked. Eighteen read-only tools are discovered;
  only the four selected reads were exercised.
- Exact writeTools permissions work in forward/search modes without unlocking
  other tools or providers. A real disposable insert passes only after opt-in,
  while drop remains blocked and database contents confirm both decisions.
  Vendor read-only settings and client approvals remain separate controls.
- Native Hermes registry discovery/search/read/write-block passed in a temporary
  home, without a model or normal configuration changes. The verifier accepts
  no existing database URI and removes its synthetic database after completion.
- 195 routine tests and two dependency compatibility tests pass. Runtime and root
  dependency audits and public-source secret scanning are clean. Manual Ubuntu
  vendor CI is prepared but unrun; Windows, hosted accounts, TLS, replicas,
  sharding and other MongoDB operations remain unverified.
- Remaining generic vendor profiles, real account validation and model-driven
  Hermes acceptance are still required. The original production objective is open.

## Evidence from batch onboarding stage

- Offline catalogue, plan and prepare commands support selecting multiple bundled
  profiles. Plans expose public defaults and change names, never private values.
  Owner-only ignored candidates preserve source bytes, other connections and
  customized entries; only unused disabled legacy placeholders can be replaced.
- New/replaced templates remain disabled, and candidates require explicit private
  review and selection. Nothing installs, signs in, contacts a vendor or executes
  tools during these commands. Unresolved vendor templates fail before writes.
- 202 routine tests pass, including seven onboarding regressions for privacy,
  concurrent preparation, invalid input, permission/symlink rejection and no
  vendor execution. A real disposable MongoDB test uses a prepared candidate,
  verifies source preservation and passes native Hermes registry calls.
- Snapshots do not automatically merge later edits. Windows private-candidate
  ACL handling is absent. Real vendor accounts, remaining setup contracts and
  model-driven Hermes acceptance remain open; the full objective is incomplete.
