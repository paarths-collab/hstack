# BigQuery

**Disabled native HTTP candidate.** Public discovery works through Hstack and
native Google credential refresh plus metadata calls pass synthetic tests.
The installed Hermes registry also passes search/read/SQL-block tests using those
synthetic responses. Real Google account/project/IAM operations and model-driven
acceptance remain unverified. This is not production approval or live query proof.

## What Hstack adds

Google documents stateless MCP 2026-07-28, but public endpoint testing also proves
that `https://bigquery.googleapis.com/mcp` accepts the standard legacy handshake
and negotiates **2025-11-25**. Modern `server/discover` currently returns -32601.
Hstack now explicitly selects `protocol: "legacy"` and uses the official SDK's
normal Client and HTTP transport. The earlier experimental Protocol subclass and
result-envelope rewriting were removed after this simpler path was verified.
Generic connections are unchanged; a pinned modern configuration is not silently
downgraded.

The connection preserves all nine public schemas and standard SDK results.
Unknown result kinds, schema changes requiring custom parameter headers,
duplicate tools and unfinished pagination fail closed. Exact Google uint64/int64
string bounds and protobuf duration formats are checked without changing exposed
schemas.

Hstack also supplies the same setup review, default tool restrictions, search
mode, connection health and safe error metadata as other services. A direct
integration can implement these controls too. The benefit here is reusing one
configuration and gateway with Google-native credential-file refresh.
No comparative setup-time, model-cost or production-reliability claim is proven.
Direct Hermes also connected and read the same synthetic dataset using its default
auto negotiation and a static synthetic Bearer header. Hstack is not required for
basic connectivity. This comparison proves transport/read compatibility and
Hstack's SQL gate; it does not benchmark Hermes's own OAuth setup or refresh.
For two synthetic reads, direct Hermes and each Hstack process now use **five MCP
POSTs**. Hstack previously used nine; it now reuses the same official SDK client
for discovery and calls. This removes the measured setup overhead but does not
prove lower latency, billing or model cost than a direct connection.

## Public check: no account needed

```sh
npm ci --ignore-scripts
npm run verify:bigquery-metadata
```

The check reads public schemas and checks them through the actual gateway's
local registry. It uses an empty credential environment and never loads `.env`,
requests a token, calls an account tool or executes SQL. It also retains the
modern SDK comparison separately. **Exit 0 requires standard legacy SDK and
gateway discovery to pass**; the known modern failure remains visible in its
own field. This command does not claim authenticated compatibility. See
[recorded public evidence](verification.json).

Run `npm run verify:bigquery-runtime` for an actual Hstack stdio process with
network-denied synthetic token/API responses. To include the installed Hermes
registry, explicitly set `HSTACK_TEST_HERMES_ROOT` and
`HSTACK_TEST_HERMES_PYTHON` to its source root and Python executable. The verifier
uses a temporary home, disables dotenv/model sampling, denies network, and
preserves normal Hermes configuration and credential files. See
[recorded runtime evidence](runtime-verification.json).

## Account setup, when ready

1. Create/select a Google Cloud project and enable the BigQuery remote MCP
   service using Google's setup guide below. Grant only required project access:
   `roles/mcp.toolUser` and appropriate BigQuery data access. SQL jobs additionally
   require job permissions and can incur charges.
2. Authenticate explicitly using Google's own foreground tooling outside Hstack,
   or provision an appropriate service account. Hstack never starts login,
   invokes gcloud, creates accounts, or searches metadata servers for an identity.
3. Put the native JSON credential in a dedicated owner-only directory outside
   the repository. Both directory and file must belong to the current user;
   use directory mode 700 and file mode 600. Symlinks, hard links, oversized
   files and Windows (without reviewed ACL support) are rejected.
4. Set `BIGQUERY_GOOGLE_CREDENTIALS_FILE` in Hstack's launch environment to the
   absolute file path. Do not paste credential JSON or a short-lived access
   token into `connections.json`.
5. Review the disabled [connection template](connection.json). Use `plan bigquery`
   and `prepare bigquery` through the management entry point described in
   [batch setup](../../docs/onboarding.md). Preparation preserves the original
   configuration and leaves the candidate disabled. Review it before activation.
   If you prepared an earlier experimental BigQuery candidate with
   `protocol: "2026-07-28"`, review and change that field to `"legacy"` manually.
   Existing private files are preserved, and incompatible pins fail before auth.
6. Run `doctor bigquery` for offline prerequisites and `check bigquery` for public
   MCP discovery. Neither proves authentication. After deliberate activation,
   request `bigquery__list_dataset_ids` with your explicit `projectId` through
   Hermes and verify the result against your project. No dedicated operational
   `verify bigquery` command is claimed yet.

Supported native files are `authorized_user` (refresh token) and `service_account`
(RSA private key). Google auth library **11.3.2** performs refresh/signing and
caches access tokens in memory. Service-account requests use the BigQuery scope;
authorized-user grants retain the scopes originally authorized by Google's
tooling. A supplied `quota_project_id` is validated and sent as
`x-goog-user-project`; review which project owns that quota/billing context.

Only the fixed Google token endpoint and BigQuery MCP endpoint may receive
credentials. Redirects and automatic request retries are disabled. Credential
rotation/removal/permission changes invalidate cached use; changes during token
refresh prevent dispatch with the old identity. Files are never rewritten or
copied into Hstack auth storage. External-account, federation, impersonation,
executable/URL credential sources and alternate universes are unsupported.

Credential headers are attached only to the individual account call. Public
discovery and reconnection carry no token. Newly advertised stateful session IDs
are rejected before credential loading until identity/session binding is reviewed.
An HTTP 401 clears the cached access token for the next explicit request; the
failed request is never replayed. Calls queue under independent deadlines, and
queued calls stop before dispatch during a known rate-limit cooldown.

## Permissions and errors

The default read list contains five metadata tools:
`list_dataset_ids`, `get_dataset_info`, `list_table_ids`, `get_table_info`, `get_job`.
SQL tools, `get_query_results` and `cancel_job` remain blocked until separately
reviewed. A vendor `readOnlyHint` does not imply a query is free: even
`execute_sql_readonly` can consume billable resources. No SQL was run in testing.

Input/output schemas are validated. Genuine empty dataset lists remain success;
native tool errors and malformed outputs do not become empty success. HTTP
401/403/429 failures retain safe codes; usable Retry-After values are preserved
without guessing which quota window was exhausted. Network/cancellation after
dispatch has unknown outcome and is never automatically replayed. Hstack's
tool-name policy does not enforce a per-project boundary; Google IAM must enforce
resource access. Human approval and per-project/cost budgets are not added here.

## Evidence and remaining gates

- Actual public endpoint: nine tool schemas discovered and preserved through the
  standard SDK legacy path and gateway, with no tokens or account calls. All 18
  input/output schemas compile. No result rewriting is used.
- Synthetic tests: native authorized-user refresh, signed service-account JWT,
  expiry/cache/rotation, concurrent cancellation, private-file checks, metadata
  reads in forward/search modes, schema bounds, empty results, safe errors and
  default SQL blocking. These responses are local fakes, not live Google proof.
- Actual process/native registry: Hstack stdio search/read/SQL blocking, one
  refresh reused across two reads, private source preservation and health privacy.
  Installed Hermes also read the synthetic dataset both directly and via Hstack;
  native source/runtime versions are recorded separately. No model was invoked.
- Still required: real account/IAM/quota/refresh tests, actual account response
  compatibility, live Hermes acceptance, model-driven behavior and release/CI
  validation. Keep the bundled candidate disabled until those gates are reviewed.

## Official references

- [BigQuery MCP setup](https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp)
- [Protocol and tool reference](https://docs.cloud.google.com/bigquery/docs/reference/mcp)
- [Google MCP authentication](https://docs.cloud.google.com/mcp/authenticate-mcp)
- [Google auth library and credential validation](https://googleapis.dev/nodejs/google-auth-library/latest/)
- [SDK protocol negotiation](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions.html)
