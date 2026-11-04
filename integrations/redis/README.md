# Redis through Hstack

This integration uses the [official Redis MCP server](https://github.com/redis/mcp-redis)
0.5.1, pinned with a Python 3.12 dependency lock. It was exercised against a real,
disposable Redis 8.10.1 database. Hosted Redis, TLS, clusters and the remaining
advertised tools have not been validated.

## Set up an existing Redis connection

1. Install Python 3.12 and `uv` using their normal installers if needed. From the
   Hstack directory, create a dedicated environment and install the locked packages:

   ```sh
   uv venv --python 3.12 .hstack-tools/redis
   uv pip sync --python .hstack-tools/redis/bin/python --require-hashes --only-binary=:all: integrations/redis/requirements.lock
   npm run build
   ```

2. Copy the Redis entry from [connection.json](connection.json) into your private
   `connections.json`, or update that entry in your existing file. Set `command`
   to the **absolute** path of `.hstack-tools/redis/bin/python`. Preserve other
   connections. Leave `enabled: false` and `allowWrites: false` while checking setup.

3. Add your connection values to your existing private `.env` without replacing
   its other entries:

   ```dotenv
   REDIS_HOST=127.0.0.1
   REDIS_PORT=6379
   REDIS_DB=0
   REDIS_PWD=your_database_password
   REDIS_SSL=false
   ```

   For a named ACL user, also add `REDIS_USERNAME` and its environment reference
   to the connection's `env` mapping. Use a suitably restricted database account.
   If the database deliberately has no password, omit the `REDIS_PWD` reference;
   an empty required environment reference is rejected. Do not put credentials
   into `command`, `args` or a URL. Remote TLS connections need the vendor's
   certificate/CA environment settings; they are not covered by the local evidence.

4. Run discovery and then the separate operational read:

   ```sh
   node --env-file=.env dist/manage.js check redis
   node --env-file=.env dist/manage.js verify redis
   ```

   `check` lists tools without touching the database. `verify` calls the reviewed
   read `dbsize` through Hstack and validates its numeric result without printing
   account contents. This catches wrong database credentials that discovery alone
   misses. It consumes a database request and is explicitly invoked.

5. Set `enabled: true`, restart the Hstack MCP connection in Hermes and ask it to
   use `redis__get`, `redis__type`, `redis__scan_keys`, `redis__dbsize` or `redis__info`.
   Search mode locates their schemas on demand. Other operations remain blocked
   unless you deliberately review permissions; `set` is a write.

## Why this entry point

In [Redis MCP 0.5.1's CLI source](https://github.com/redis/mcp-redis/blob/11e67e44358cd6410d5a7e615a29539ccd71a045/src/main.py),
default CLI values overwrite environment host/port/database/TLS settings. The
profile uses `python -I -m src.main`, the vendor's environment-based entry point,
so those values are honored without passing secrets in arguments. `-I` also
isolates Python imports from the working directory and PYTHONPATH.

Hstack supplies `PYTHON_DOTENV_DISABLED=1` to local upstreams by default. This
prevents compatible python-dotenv versions, including the locked version, from
automatically importing unrelated project `.env` keys. This is a guard against
accidental loading, not a subprocess sandbox. Trusted programs still run as your
OS user and can read files they have permission to access.

## Repeat the real integration check

With `redis-server`, `redis-cli` and the prepared Python runtime available:

```sh
HSTACK_REDIS_PYTHON=/absolute/path/to/redis-venv/bin/python npm run verify:redis-local
```

The verifier creates its **own** empty loopback database, random password and
temporary configuration, then removes them. It never accepts an existing Redis
URL/account/password. It tests five reads, a blocked write, an explicitly permitted
local write, bad database credentials, schema validation and health. It writes
only synthetic data in the disposable database. It is separate from `npm test`.
Optional `HSTACK_REDIS_SERVER` and `HSTACK_REDIS_CLI` choose executable paths.

For native Hermes verification, optionally set:

- `HSTACK_TEST_HERMES`: absolute path to its CLI.
- `HSTACK_TEST_HERMES_PYTHON`: interpreter from the installed Hermes environment.
- `HSTACK_TEST_HERMES_ROOT`: installed Hermes source directory.

These use a disposable Hermes home. The CLI discovers tools; the registry probe
performs a real search/read/write-block through Hermes. No model is called and
normal Hermes configuration is unchanged. This proves the installed Hermes
tool path, not model-driven task success. Its source hash is recorded in
[verification.json](verification.json).

The manual `Redis vendor verification` GitHub workflow repeats the SDK/local
database path on Ubuntu. It has not been dispatched for these unpushed changes;
Linux/CI success is not inferred from the macOS run.

## Compared with connecting Redis MCP directly

The recorded test used the same official package, schemas and synthetic value:

| Check | Direct vendor MCP | Hstack |
| --- | --- | --- |
| Initial tool discovery | 53 tools / 39,600 JSON bytes | 2 controls / 853 JSON bytes |
| First schema search | Not required | 5,829 additional JSON bytes in this query |
| Read value | Returned | Preserved unchanged |
| `set` under compared defaults | Reaches the test database | Blocked by Hstack policy |
| Explicit write opt-in | Available directly | Works after deliberate connection-level opt-in |
| Operational check | Discovery alone succeeds with bad DB credentials | `verify redis` detects failed DB access |

This is a protocol/policy comparison, not evidence about LLM tokens, latency,
accuracy, model cost or human setup time. A direct MCP client can implement its
own permissions. Hstack provides the reviewed default read list and shared setup,
discovery, health and recovery controls across configured services.

The [upstream release](https://github.com/redis/mcp-redis/releases/tag/0.5.1),
[official installation documentation](https://redis.io/docs/latest/integrate/redis-mcp/install/)
and [recorded evidence](verification.json) identify the exact scope. The locked
54-package Python environment was audited with pip-audit 2.10.1 and had zero known
vulnerabilities at that check; this is not a permanent vulnerability guarantee.
