# Mailchimp Marketing through Hstack

This profile uses the **community** [Mailchimp MCP server](https://github.com/damientilman/mailchimp-mcp-server),
release [1.2.0](https://github.com/damientilman/mailchimp-mcp-server/releases/tag/v1.2.0).
It is not an official Intuit Mailchimp connector. The installed vendor source was
matched to commit `fcc130a3c42a426816711a5c0099331f1f3fa788`.

The real vendor process passed discovery and local metadata reads through Hstack,
using a synthetic key with network access denied by the test harness. **No real
Mailchimp account, API request, campaign write or model-driven chat was tested.**
Runtime evidence is in [verification.json](verification.json); it is not live proof.

## Install and connect

1. Use Python 3.12 and `uv` to install the pinned runtime separately from Hstack:

   ```sh
   uv venv --python 3.12 .hstack-tools/mailchimp
   uv pip sync --python .hstack-tools/mailchimp/bin/python --require-hashes --only-binary=:all: integrations/mailchimp/requirements.lock
   npm run build
   ```

   The lock pins the server, Python MCP 1.30.0 and the transitive dependencies
   for the tested Python 3.12 environment.
   Do not substitute `uvx mailchimp-mcp` or an unpinned install: the published
   release imports `mcp.server.fastmcp`, which MCP 2 removed. Newer upstream main
   has a compatibility import, but is not the release being tested here.

2. Copy [connection.json](connection.json) into your private `connections.json`,
   preserving other connections. Keep it disabled while checking access. Existing
   private files are never replaced or migrated automatically.

3. Add these settings to your existing `.env` without replacing its other keys:

   ```dotenv
   HSTACK_MAILCHIMP_PYTHON=/absolute/path/to/hstack/.hstack-tools/mailchimp/bin/python
   MAILCHIMP_API_KEY=your_marketing_api_key
   MAILCHIMP_READ_ONLY=true
   MAILCHIMP_MAX_RETRIES=0
   ```

   Use a Mailchimp Marketing account with API-key and audience read permissions.
   Review [Mailchimp API authentication](https://mailchimp.com/developer/marketing/guides/quick-start/)
   and your account's actual plan limits. This is not a universal free-plan claim.
   Keep keys in the private environment, never in arguments or JSON. An existing
   shell environment variable takes precedence over Node's `.env` file.

   Keep `MAILCHIMP_MAX_RETRIES=0`: the vendor's retry loop can retry writes too.
   Hstack does not replay dispatched writes, and this setting prevents hidden
   retries inside this vendor process. `MAILCHIMP_READ_ONLY=true` also blocks
   vendor writes independently of Hstack's default `allowWrites: false`.

4. Inspect setup, discover tools, then explicitly test an account read:

   ```sh
   node --env-file=.env dist/manage.js doctor mailchimp
   node --env-file=.env dist/manage.js check mailchimp
   node --env-file=.env dist/manage.js verify mailchimp
   ```

   `doctor` is offline. `check` contacts no Mailchimp API but launches the local
   MCP process and discovers tools. `verify` requests one audience using
   `list_audiences(count=1, offset=0)` through Hstack. It validates a numeric total
   and list payload without printing audience data. A genuine empty account can
   pass; a null total from a swallowed API failure cannot. This consumes an API
   request and reads account data; invoke it deliberately.

5. After successful account verification, enable the entry and restart Hstack in
   Hermes. Four default reads are allowed: `list_accounts`, `describe_tools`,
   `list_audiences` and `list_campaigns`. The first two inspect local configuration
   and risk metadata; they do **not** prove account access. Search mode returns
   the upstream input schemas on demand. Other tools remain blocked pending review.

## Why this profile differs from a direct connection

- It supplies a reproducible installation instead of the release's incompatible
  unconstrained SDK resolution.
- It keeps 227 tool schemas out of initial search-mode discovery and applies an
  explicit four-read allowlist. This is not a measured LLM cost or accuracy claim.
- The opt-in `resultPolicy: "mailchimp-1.2.0"` checks `list_audiences` and
  `list_campaigns`. This server can swallow API errors into `total_items: null`
  plus an empty list while reporting MCP success. Hstack makes those malformed
  responses explicit errors; valid empty lists and valid results are preserved.
  Other tools' result semantics have not been reviewed by this policy.
- The upstream `ping` reads `health_check`, but the official
  [API ping response](https://mailchimp.com/developer/marketing/api/ping/list)
  provides `health_status`. Hstack keeps this broken tool blocked by default and
  uses an operational audience read for verification. The vendor source is not patched.

The result policy belongs with this pinned vendor release; do not apply it to
unrelated MCP implementations. Upstream code can discard HTTP status/headers, so
Hstack cannot recover an unknown exhausted rate-limit window or retry time.
Do not infer those from empty fields. Other operations, named accounts, real
authorization failures and writes remain unverified. With `writeTools` or `allowWrites: true`,
the vendor's read-only flag must be deliberately changed before it permits writes;
keep client approval prompts enabled. Hstack does not add human approval itself.

## Reproduce the runtime-only evidence

```sh
HSTACK_MAILCHIMP_PYTHON=/absolute/path/to/hstack/.hstack-tools/mailchimp/bin/python npm run verify:mailchimp-runtime
```

This opt-in check does not read `.env`. It verifies the installed source/pins,
starts the real MCP process with a synthetic key, denies Python network access,
compares direct and Hstack metadata reads, checks default write/broken-ping
blocking, and reproduces the swallowed-error correction. The test-only Python
bootstrap replaces launch arguments to install the network guard; it does not
replace the vendor implementation. Account verification deliberately fails under
that guard. The runtime check is separate from routine fixture tests and does
not establish live vendor compatibility or Windows support.

A manual GitHub workflow repeats this runtime-only check on Ubuntu. It has been
prepared locally but has not run; the current evidence is macOS/Python 3.12.
