# MongoDB through Hstack

This setup uses the official [MongoDB MCP server 3.2.1](https://github.com/mongodb-js/mongodb-mcp-server/releases/tag/v3.2.1),
an integrity-locked npm runtime and four reviewed reads. It was tested against a
real, disposable, authenticated MongoDB 8.2.11 with synthetic data, including
native Hermes registry calls. Hosted MongoDB/Atlas, TLS, replicas, sharding and
the other advertised operations remain unverified. No model was used.

## Install and configure

1. Use Node **22.13+ or 24+**, then install the locked vendor runtime separately:

   ```sh
   npm ci --ignore-scripts --omit=dev --prefix integrations/mongodb
   npm run build
   ```

   This does not install or start a MongoDB database. It installs the MCP program
   for connecting to a database you own. Lifecycle scripts remain disabled; the
   tested password/SCRAM path does not need optional native authentication addons.
2. Copy [connection.json](connection.json) into your private `connections.json`,
   preserving other entries. Keep it disabled while checking access. Add these
   names to your existing private `.env`:

   ```dotenv
   HSTACK_MONGODB_COMMAND=/absolute/path/to/hstack/integrations/mongodb/node_modules/.bin/mongodb-mcp-server
   MDB_MCP_CONNECTION_STRING="your_private_mongodb_connection_string"
   ```

   Use a database user with appropriate read permissions, not the synthetic root
   account used by the disposable test. Follow MongoDB's connection-string rules,
   including escaping credentials. Keep the URI out of arguments and JSON.
   The executable's Node runtime must also be available on the launch `PATH`.
3. Check prerequisites, discover schemas, then explicitly verify database access:

   ```sh
   node --env-file=.env dist/manage.js doctor mongodb
   node --env-file=.env dist/manage.js check mongodb
   node --env-file=.env dist/manage.js verify mongodb
   ```

   Doctor is offline. Check discovers MCP tools without querying your database.
   Verify executes `list-databases` with `connectionId: "preconfigured"`, validates
   the structured list/count response, and prints no database names or contents.
   It proves that read only; it does not prove permissions for every collection.
4. Enable the entry and restart Hstack in Hermes. Default reads are
   `list-databases`, `list-collections`, `count` and `find`. The vendor now requires
   a `connectionId`; use the documented **`preconfigured`** handle for the URI in
   the environment. For example, the arguments for `mongodb__count` are:

   ```json
   { "connectionId": "preconfigured", "database": "your_db", "collection": "your_collection" }
   ```

Search mode returns the actual schemas. Retargeting through `connect`, exports,
unreviewed reads and all writes are blocked by the Hstack default allowlist.
The vendor also runs with `--readOnly`; telemetry and disk logging are disabled
by the supplied arguments, and driver operations have a 10-second timeout.

## Permit a specific write deliberately

After reviewing database permissions and client approval behavior, a custom
connection can add an exact tool name:

```json
{ "writeTools": ["insert-many"], "allowWrites": false }
```

For MongoDB this also requires removing `--readOnly` from the vendor arguments.
Restart Hstack after changing either setting. The tested disposable insert works
with this exact opt-in while `drop-database` and retargeting remain blocked.
`allowWrites: true` is broader: it permits every discovered operation. Use raw
upstream names in these lists, without the `mongodb__` prefix.

Hstack does not implement human approval or relay upstream elicitation. The
vendor documents that optional confirmations may be skipped when the client has
no elicitation support. Do not rely on those prompts through Hstack; keep client
approvals enabled and review the exact allowlist. The test did not approve real
account writes or verify the other destructive operations.

## Dependency compatibility fix

The vendor dependency graph includes `get-uri` → `basic-ftp`. This lock overrides
that leaf to **6.2.4** to address
[GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r), rather than
downgrading the MCP server. The full installed graph audits clean at this check.
Local FTP retrieval/listing tests verify compatibility, and a bounded worker
tests the advisory's malformed-listing case. Other FTP/FTPS/proxy variants were
not validated. Preserve the manifest override when installing this runtime.

## Reproduce the disposable evidence

Install dev dependencies too for the test driver and database helper:

```sh
npm ci --ignore-scripts --prefix integrations/mongodb
npm run test:ftp-compat --prefix integrations/mongodb
npm run verify:mongodb-local
```

The opt-in test downloads the pinned official MongoDB Community binary if it is
not already cached under ignored `.hstack-tools/mongodb-binaries`. It creates a
new authenticated loopback database and temporary home, never accepts an existing
URI, reads only synthetic records, tests blocked writes, and performs one explicit
synthetic insert. It then stops its children and deletes its database files.
It does not read `.env` or load hosted credentials.

Optional `HSTACK_TEST_HERMES_ROOT` and `HSTACK_TEST_HERMES_PYTHON` point to an
already installed Hermes source tree and interpreter. The verifier then discovers,
searches and reads through its native registry in a temporary home, and confirms
an insert remains blocked. Normal Hermes configuration is untouched. This is
separate from a model-driven conversation. See [verification.json](verification.json)
for the recorded evidence and limits.

A manual Ubuntu workflow prepares this runtime and repeats the FTP/database
checks. It has not run; current evidence is macOS arm64 with Node 26.8.1.
