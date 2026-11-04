# QuickBooks through Hstack

This profile uses Intuit's official [QuickBooks Online MCP source](https://github.com/intuit/quickbooks-online-mcp-server/tree/31a1dd5c3e170e368dbff651abbaf61aabde6ed9),
pinned to commit `31a1dd5c3e170e368dbff651abbaf61aabde6ed9`, with a separately
labelled **Hstack compatibility build**. It is not an official Intuit binary.
The checked process exposes 142 tools, or 71 with native writes suppressed.
Hstack permits 70 reads; invoice PDF downloads are excluded because they write
local files. **No real QuickBooks account, browser consent or financial data has
been tested.** See [recorded evidence](verification.json).

## Install

Use Node **22.13+** on POSIX. Windows credential-file protection is unsupported.

```sh
npm ci --ignore-scripts
npm run build
npm ci --ignore-scripts --prefix integrations/quickbooks
npm run build --prefix integrations/quickbooks
chmod +x integrations/quickbooks/run.mjs
```

The separate runtime is integrity-locked. No vendor lifecycle scripts run.
Building verifies all 298 source files against the official Git tree, then
creates a compatibility copy in ignored `build/compat`. The installed Intuit
source stays unchanged. Build dependencies are needed for compilation.

## Authenticate explicitly

1. Create an Intuit developer application and sandbox company using the
   [official setup instructions](https://github.com/intuit/quickbooks-online-mcp-server/blob/31a1dd5c3e170e368dbff651abbaf61aabde6ed9/README.md).
   Register `http://localhost:8000/callback` for sandbox authentication. Accounting
   consent covers more than reads; native suppression and Hstack permissions do
   not make the OAuth grant itself read-only.
2. Create a dedicated private directory outside the repository, with mode 0700,
   and a native `.env` file there with mode 0600. Edit it locally; preserve an
   existing store. Supply `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET`,
   `QUICKBOOKS_ENVIRONMENT=sandbox` and
   `QUICKBOOKS_REDIRECT_URI=http://localhost:8000/callback`.
   Keep tokens in this native store, not in arguments or public connection JSON.
3. Stop all clients sharing that store, then deliberately run the vendor's
   foreground authentication command:

   ```sh
   QUICKBOOKS_TOKEN_STORE_PATH=/absolute/private/quickbooks/.env \
     node integrations/quickbooks/build/compat/dist/auth-server.js
   ```

   This opens browser consent and writes the native refresh token/company ID.
   Hstack does not perform this step automatically. No such login was run during
   local validation. Production requires the vendor's separate public HTTPS
   redirect procedure and an eligible company/application; the sandbox loopback
   flow cannot establish production access. No deployment-free production login
   or free production subscription is promised.
4. Add these references to your existing private Hstack `.env`:

   ```dotenv
   HSTACK_QUICKBOOKS_COMMAND=/absolute/path/to/hstack/integrations/quickbooks/run.mjs
   HSTACK_QUICKBOOKS_TOKEN_STORE_PATH=/absolute/private/quickbooks/.env
   ```

5. Use batch `plan`/`prepare` for `quickbooks`, or copy
   [connection.json](connection.json) into your private configuration. Preserve
   other entries and keep this one disabled while checking it:

   ```sh
   node --env-file=.env dist/manage.js doctor quickbooks
   node --env-file=.env dist/manage.js check quickbooks
   node --env-file=.env dist/manage.js verify quickbooks
   ```

   Doctor is offline. Check discovers schemas without accessing company data.
   Verify explicitly reads company information, checks the result and prints no
   account contents. It consumes a vendor request when configured. Enable the
   profile and restart Hstack after a real read succeeds.

The vendor nests tool inputs under `params`. For example:

```json
{ "name": "quickbooks__get_company_info", "arguments": { "params": {} } }
```

The allowed reads cover company/preferences, accounts, customers/vendors,
invoices and other transactions, taxes, metadata and reports. Search mode returns
the actual parameter schema. Listing schemas does not verify permissions or
operation correctness for every entity/report.

## Compatibility and safety changes

- Security-fixed Zod 4.6.7 and URI decoder 0.5.1 replace vulnerable transitive
  versions. Nine dictionary declarations, strict objects, optional opaque fields
  and tool registration are adapted for Zod 4. All 142 input schemas were compared
  with the original process: constraints remain equivalent after local reference
  expansion and equivalent draft-07 spelling normalization.
  The public [baseline fingerprints](schema-baseline.json) record the original
  SDK/Zod provenance and are checked on every synthetic runtime verification.
- The legacy OAuth query parser gets an ESM-default adapter for the new decoder.
  Actual callback-query decoding is regression-tested. This is separate from
  untested live browser consent.
- The compiler transformation propagates explicit handler errors through 144
  native error-return branches. Hstack hides failure diagnostics for the reviewed
  reads while preserving genuine JSON, report labels, per-row lists, counts and
  unsupported-parameter warnings. It does not inspect financial JSON fields for
  error-like words.
- The launcher captures noninteractive/read-only policy before the native token
  file can override environment values. Missing/expired sandbox authorization
  fails explicitly rather than opening an unattended browser/callback server.
- Hstack checks native-store permissions and serializes refresh/use across its
  clients sharing that file, without reading or copying credential contents.
  The vendor itself still reads and updates its store. Standalone vendor clients
  and foreground auth do not acquire Hstack's lock: stop them before reauth.
  Crashed locks need manual owner verification; they are not stolen automatically.

Default native writes remain suppressed. A reviewed write requires both an exact
Hstack `writeTools` entry and the explicit launcher argument
`--allow-native-writes`; any native disable flags in the token file still apply.
Restart after review. Write execution has not been validated and is outside this
profile's current evidence. Hstack does not provide human approval enforcement.

The native client does not retain HTTP quota headers in tool errors. Hstack
reports a safe upstream error here; it cannot identify the exhausted quota window
or invent a retry time from text. Tokens are POSIX-protected plaintext, not an
encrypted vault.

## Reproduce local evidence

```sh
node --test integrations/quickbooks/build.test.mjs
npm run verify:quickbooks-runtime
```

The opt-in verifier launches the actual compiled Intuit process with fresh fake
credentials and a loopback-only OAuth/API fixture. Browser processes and external
network targets are refused. It checks all 70 permitted missing-auth failures,
native refresh/persistence, direct/gateway company results, a balance-sheet read,
an empty customer list, safe API failures, default write/download blocking and
search-mode discovery/read. Fixtures are removed afterward.

The installed 71-tool catalogue was 42,773 JSON bytes. Hstack initially advertised
853 bytes of search controls; the first company-schema search returned 575 bytes.
These are measured catalogue JSON sizes, not model-cost, accuracy, latency or
setup-time evidence. Native Hermes registry search/read/download-block passed in
a fresh temporary home using the same fixture, with Python egress denied and
dotenv loading disabled. This used the installed Hermes source fingerprint in
the report; it does not certify an upstream release. No model was called.
Real consent/refresh, production eligibility, model-driven use, other platforms
and remaining tool operations still need separate validation. Local runtime
evidence was obtained on Node 26.8.1/macOS arm64; the Node 22 Linux CI path is unrun.

To include that optional native registry check, set `HSTACK_TEST_HERMES_ROOT` to a
reviewed installed Hermes source directory and `HSTACK_TEST_HERMES_PYTHON` to its
Python environment, then run the verifier. It creates its own temporary config
and uses no saved account credentials.

The manual `quickbooks-runtime.yml` workflow repeats installation, build,
regressions, synthetic process verification and audit on Linux. It has been
prepared locally and has not been run in GitHub CI.
