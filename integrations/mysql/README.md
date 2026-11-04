# MySQL through Hstack

This profile uses native MySQL tools from Google's
[MCP Toolbox 1.15.0](https://github.com/googleapis/mcp-toolbox/releases/tag/v1.15.0).
It replaces the generic command placeholder. Eight diagnostic reads are permitted;
`execute_sql` is discoverable but blocked by default.

**Experimental compatibility build; macOS arm64 validated.** Actual disposable
MySQL 8.4.13 tests cover all eight reads, credential failures, permissions and
native Hermes registry calls. Hosted databases, other platforms, TLS and a
model-driven conversation remain unverified. Do not treat these tests as a
general production certification.

## Why this uses a compatibility build

The official all-database binary's vulnerability scan reports affected dependencies.
Hstack builds from the exact official tag and module checksum, registers the
native MySQL source/tools, and uses locked patched dependencies with Go 1.27.3.
All native MySQL query implementations remain unchanged. One telemetry schema
import is aligned with the updated OpenTelemetry SDK to fix a confirmed startup
failure. The builder checks both modified source files against their original
Git blob hashes. Vendor licences remain in the source archive.

This is an **Hstack build**, not an official Google binary. It is dedicated to
MySQL and cannot stand in for the full Toolbox database catalogue. Symbols are
retained for precise security analysis; the original stripped binary's scan was
conservative about code presence. Do not substitute its release hash for this build.

The tested build has **no affected linked packages/symbols** in the recorded Go
scan. A module-only [OpenPGP advisory](https://pkg.go.dev/vuln/GO-2026-5932) remains
visible because `x/crypto` also contains unused deprecated code. OpenPGP packages
are absent from the compiled dependency/symbol inventory. This is not a claim
that every package in the full upstream source/module graph is vulnerability-free.
No advisory rule is disabled or removed from the audit output.

## Build explicitly

Install your own Go **1.27.3** compiler first. From the Hstack directory:

```sh
python3.12 -I -B integrations/mysql/build-toolbox.py --go /absolute/path/to/go
```

The command downloads checksum-verified public source/modules, uses the committed
`build/go.mod` and `build/go.sum`, builds without CGO, and verifies the resulting
platform SHA256. It writes only ignored `.hstack-tools/` artifacts. It does not
install a service, contact a database or read account credentials. A differing
existing executable is preserved. Only macOS arm64 currently has a validated
build hash; other platforms fail before installation and require their own tests.
Building is explicit and never happens during Hermes startup.

Separate source-transformation regressions:

```sh
python3.12 -I -B integrations/mysql/tests/test_build.py
```

For a fresh security check, install the official `govulncheck` **v1.9.0** into a
private tools directory, then set absolute `HSTACK_GOVULNCHECK` and
`HSTACK_MYSQL_TOOLBOX` executable paths in your terminal and run:

```sh
npm run audit:mysql-binary
```

This uses public advisory data. The wrapper requires a nonempty symbol inventory
and rejects linked package/symbol findings. It parses streamed JSON itself:
`govulncheck -json` can exit zero even when it reports findings. Module-only
matches are included in the output, never silently counted as zero advisories.

## Configure an existing database deliberately

Create a dedicated database user through your normal administration process.
Do not use root. At minimum, grant only the schema/table reads the workflow needs.
Several monitoring tools additionally need `PROCESS`, `SELECT` on appropriate
`performance_schema`/`sys` objects and `EXECUTE` for referenced `sys` functions.
The real test caught a missing function privilege in `list_table_stats`; schema
discovery alone would not have caught it. These permissions can expose instance
diagnostics. If inappropriate, narrow `readTools` to `list_tables` and
`get_query_plan` instead of granting broad monitoring access.

```sh
npm run build
node dist/manage.js plan mysql
node dist/manage.js prepare mysql
```

Review the private candidate and select it using `HSTACK_CONNECTIONS_FILE` in
your existing `.env`; see [batch setup](../../docs/onboarding.md). Existing
customized entries are preserved. Leave new profiles disabled until validation.
Add your real values locally, never in chat or public JSON:

```dotenv
HSTACK_MYSQL_TOOLBOX=/absolute/path/to/hstack/.hstack-tools/toolbox/toolbox-mysql-1.15.0
MYSQL_HOST=your-db-host
MYSQL_PORT=3306
MYSQL_DATABASE=your-database
MYSQL_USER=your-dedicated-user
MYSQL_PASSWORD=
MYSQL_QUERY_PARAMS='{"tls":"true"}'
```

`MYSQL_QUERY_PARAMS` is Toolbox's native driver-parameter map. Require verified
TLS for remote databases; do not use `skip-verify`. The disposable loopback test
explicitly disables TLS and proves nothing about hosted certificate setup.
Connection secrets stay in the private environment, not command arguments.
Version checks, reloads and verbose logs are disabled in the bundled arguments;
no telemetry exporter is enabled.

```sh
node --env-file=.env dist/manage.js doctor mysql
node --env-file=.env dist/manage.js check mysql
node --env-file=.env dist/manage.js verify mysql
```

`doctor` checks local prerequisites without connecting. `check` connects and
discovers nine tools but executes none. `verify` explicitly reads schema metadata
with `list_tables` and hides raw results. Toolbox emits one JSON text block per
row, not a single array; the verifier handles that format and valid empty reads.
Neither a schema read nor an empty result proves access to application rows.

After validation, enable the reviewed profile and restart Hstack in Hermes. Ask
for tables and an execution plan for an approved query. Hstack does not relay
upstream resource/UI extensions; its tool forwarding and focused search are the
tested interface here.

## SQL permissions and actual test boundaries

`execute_sql` accepts arbitrary SQL. Hstack does not parse it into a read-only
subset. Adding that exact name to `writeTools` permits every statement the
database role accepts, including reads and writes. Use a separate restricted role
and client approval prompts when intentionally allowing it. Database grants and
Hstack permissions are separate controls. Never interpret a read-only annotation
as a substitute for either control.

`npm run verify:mysql-local` requires absolute `HSTACK_TEST_MYSQLD`,
`HSTACK_TEST_MYSQL` and `HSTACK_MYSQL_TOOLBOX` binary paths. It accepts no existing
data directory or connection URL. It initializes a new private database, generates
credentials, compares eight native/Hstack diagnostics, checks an actual synthetic
row, rejects bad passwords and verifies default SQL blocking. One explicitly
permitted synthetic insert succeeds; the limited database role still denies DROP.
The owned database is shut down and removed. Installed binaries remain intact.

Optional `HSTACK_TEST_HERMES_ROOT` and `HSTACK_TEST_HERMES_PYTHON` enable a temporary
native registry test. A random column name absent from the request proves an
actual schema read; arbitrary SQL stays blocked. No model or normal Hermes
configuration is used. [verification.json](verification.json) records the exact
build, checks and limitations.
