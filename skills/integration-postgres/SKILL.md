---
name: integration-postgres
description: Connect a PostgreSQL database (any provider — self-hosted, RDS, Cloud SQL, Neon, Supabase, PlanetScale-Postgres, DigitalOcean, etc.) to a self-hosted Hermes Agent over SSH. Uses the community postgres-mcp server (Crystal DBA, well-maintained) with a scoped read-only connection string. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-postgres — connect PostgreSQL to a remote Hermes (SSH-first)

You are the engineer connecting a PostgreSQL database to a self-hosted Hermes agent on the
user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any
of them) work over SSH as root against the VPS. The user does two things a machine cannot:

1. Create a **scoped, read-only database user** (or read-write if the agent needs writes)
   — never grant the agent a superuser or `postgres` user connection.
2. Copy the Postgres connection string (`postgres://user:pass@host:port/db`) for that user.

Everything else — connection-string storage, live psql-style verification, MCP registration
via stdio, gateway reload, smoke test — runs on the VPS via SSH, idempotently with a
rollback path.

**Honest auth picture (verified 2026-06):** PostgreSQL itself does NOT have a single
official hosted MCP; the ecosystem is fragmented:

- **Crystal DBA `postgres-mcp`** — community, well-maintained, stdio, connects to any
  Postgres via `DATABASE_URI`. Read/write configurable, performance-analysis tools.
  https://github.com/crystaldba/postgres-mcp — **this is what this skill wires**.
- **Anthropic reference implementation** — the original stdio MCP, less feature-rich than
  Crystal DBA's; read-only.
- **pgEdge Postgres MCP** — hosted, bearer-auth, only for pgEdge-hosted databases.
- **AWS Aurora Postgres MCP** — AWS-specific, requires AWS credentials + Aurora.
- **Supabase-hosted** — use `/integration-supabase` for its own management surface (this
  skill can layer on top for direct SQL if needed).

**Two paths in this skill:**

- **Path A (default) — Crystal DBA `postgres-mcp` via stdio.** Vet the source before
  trusting it with a write-capable connection string. Runs via `uvx` or `pipx`.
- **Path B (fallback) — generic SQL tool** documented against the same `DATABASE_URL`.
  No MCP registration; the agent uses whatever generic SQL/HTTP capability it has.

**Why the read-only default matters:** an agent with a write-capable Postgres connection
can `DELETE`, `DROP TABLE`, `TRUNCATE`, or even `DROP DATABASE` if the DB user has
permissions. This skill nags the operator into creating a scoped read-only user unless
`ALLOW_WRITES=1` is set explicitly.

**SSL:** modern managed Postgres (RDS, Cloud SQL, Neon, Supabase) requires
`?sslmode=require` (or `verify-full`). Self-hosted usually doesn't. Preserve whatever the
user's connection string specifies.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$POSTGRES_URL` | Full connection string `postgres://user:pass@host:port/db?sslmode=require` | Provider dashboard — CREATE A SCOPED USER FIRST, don't reuse admin |
| `$POSTGRES_ROLE` *(optional, informational)* | `read-only` / `read-write` — the role of the user in `$POSTGRES_URL` | For the DRY_RUN preview |
| `$ALLOW_WRITES` *(optional)* | `1` if the agent needs writes | Refuses to proceed if `$POSTGRES_URL` has superuser hints without this |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (generic SQL tool) | A requires `uvx` or `pipx` on the VPS |

### Creating a scoped read-only user (recommended)

Before running this skill, on the target Postgres server:

```sql
CREATE ROLE hermes_readonly WITH LOGIN PASSWORD '<strong-password>';
GRANT CONNECT ON DATABASE <dbname> TO hermes_readonly;
GRANT USAGE ON SCHEMA public TO hermes_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hermes_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO hermes_readonly;
```

Then use `postgres://hermes_readonly:<strong-password>@host:port/dbname` as `$POSTGRES_URL`.

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + required binaries on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    HERMES="docker exec $AGENT hermes"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
  echo "Using: $HERMES"
  $HERMES --version
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }

# Path A needs uvx (or pipx) to run postgres-mcp
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1 || command -v pipx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires uvx (or pipx) on the VPS. Install: pip install uv (or pipx)."; exit 1; }
fi

# psql binary (nice to have for smoke testing; not strictly required)
ssh "$VPS_USER@$VPS_IP" "command -v psql >/dev/null 2>&1" \
  || echo "WARN: psql not on VPS PATH. Smoke test will use raw connection instead."
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci postgres" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^POSTGRES_URL=postgres' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_URL" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Postgres already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (URL format + superuser refusal + live connect)

```bash
# URL format
printf '%s' "$POSTGRES_URL" | grep -qE '^postgres(ql)?://[^:]+:[^@]+@[^:/]+(:[0-9]+)?/[^?]+' \
  || { echo "ABORT: POSTGRES_URL must be postgres://user:pass@host[:port]/dbname[?opts]."; exit 1; }

# Superuser refusal — refuse `postgres` / `admin` / `root` users unless ALLOW_WRITES=1 is set
USER=$(printf '%s' "$POSTGRES_URL" | sed -E 's|^postgres(ql)?://([^:]+):.*|\2|')
case "$USER" in
  postgres|admin|root|superuser)
    if [ "${ALLOW_WRITES:-0}" != "1" ]; then
      echo "ABORT: connection string uses superuser-looking user '$USER'."
      echo "This is dangerous for an autonomous agent (can DROP TABLE, TRUNCATE, etc.)."
      echo "Create a scoped read-only user (see the CREATE ROLE snippet in the skill preamble)."
      echo "If you really want a privileged user, set ALLOW_WRITES=1 to override."
      exit 1
    fi
    echo "WARN: superuser-looking user '$USER' in use. Confirm this is intentional." ;;
  *) echo "User: $USER (looks scoped — proceeding)" ;;
esac

# Live connection test — use psql if available, else Python fallback
if ssh "$VPS_USER@$VPS_IP" "command -v psql >/dev/null 2>&1"; then
  LIVE=$(ssh "$VPS_USER@$VPS_IP" "PGCONNECT_TIMEOUT=10 psql '$POSTGRES_URL' -c 'SELECT current_user, current_database(), version()' -tA 2>&1" | head -1)
  case "$LIVE" in
    *"|"*)  echo "Postgres OK. Session: $LIVE" ;;
    *"authentication failed"*|*"password"*) echo "ABORT: password rejected."; exit 1 ;;
    *"does not exist"*) echo "ABORT: database or user does not exist."; exit 1 ;;
    *"could not connect"*|*"timeout"*) echo "ABORT: cannot reach Postgres server (network/firewall)."; exit 1 ;;
    *) echo "ABORT: unexpected psql response: $LIVE"; exit 1 ;;
  esac
else
  # Python psycopg2 fallback (usually available)
  LIVE=$(ssh "$VPS_USER@$VPS_IP" "python3 -c \"
import sys, urllib.parse
try:
  import psycopg2
except ImportError:
  print('NO_PSYCOPG2'); sys.exit(0)
try:
  conn = psycopg2.connect('$POSTGRES_URL', connect_timeout=10)
  cur = conn.cursor()
  cur.execute('SELECT current_user, current_database()')
  r = cur.fetchone()
  print(f'{r[0]}|{r[1]}')
except Exception as e:
  print(f'ERROR: {e}'); sys.exit(1)
\" 2>&1")
  case "$LIVE" in
    NO_PSYCOPG2) echo "WARN: cannot pre-verify (no psql, no psycopg2). Proceeding without live check." ;;
    *"|"*) echo "Postgres OK. Session: $LIVE" ;;
    *) echo "ABORT: $LIVE"; exit 1 ;;
  esac
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
# Redact password from URL for display
URL_REDACTED=$(printf '%s' "$POSTGRES_URL" | sed -E 's|(:)[^@]+(@)|\1***\2|')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write POSTGRES_URL ($URL_REDACTED) via 'hermes config set' — password NEVER printed
  2. chmod 600 ~/.hermes/.env
  3. Verify URL landed (grep -c)

  Path A (stdio MCP — Crystal DBA postgres-mcp):
    4. Register MCP: hermes mcp add postgres --command uvx --args postgres-mcp
       --env DATABASE_URI=\${POSTGRES_URL} (+ ACCESS_MODE=readonly unless ALLOW_WRITES=1)
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*postgres"

  Path B (generic SQL tool):
    4. No MCP registration; generic SQL tool reads POSTGRES_URL from env
    5. Reload gateway: stop + run
    6. Smoke test: SELECT 1 via psql or psycopg2

Password is NEVER printed in plaintext beyond the *** in the redacted URL.
Access mode: $([ "${ALLOW_WRITES:-0}" = "1" ] && echo "READ-WRITE (dangerous)" || echo "READ-ONLY (default)")
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the connection string (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set POSTGRES_URL '$POSTGRES_URL'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^POSTGRES_URL=postgres' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: POSTGRES_URL not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter — URL contains `:`, `/`, `@`, `?`, `=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^POSTGRES_URL=' ~/.hermes/.env || printf 'POSTGRES_URL=\n' >> ~/.hermes/.env
>   sed -i 's|^POSTGRES_URL=.*|POSTGRES_URL=$POSTGRES_URL|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the connection string in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

### Path A — Crystal DBA `postgres-mcp` via stdio (default)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ACCESS_MODE=$([ "${ALLOW_WRITES:-0}" = "1" ] && echo "unrestricted" || echo "readonly")
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add postgres \
      --command 'uvx' \
      --args 'postgres-mcp' \
      --env 'DATABASE_URI=\${POSTGRES_URL}' \
      --env 'ACCESS_MODE=$ACCESS_MODE'
  "
  echo "postgres-mcp registered with ACCESS_MODE=$ACCESS_MODE."
fi
```

### Path B — generic SQL tool (opt-in)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  cat <<'EOF'
Path B: no MCP server registered. The agent's generic SQL tool layer reads POSTGRES_URL
from env and executes queries via psql / psycopg2 / whatever the host tool provides.

Common patterns:
  - psql "$POSTGRES_URL" -c "SELECT ..."
  - Python: psycopg2.connect(os.environ["POSTGRES_URL"])
  - Go: sql.Open("postgres", os.Getenv("POSTGRES_URL"))

Read-only enforcement is the operator's responsibility (via the DB user's GRANTs).
EOF
fi
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify + smoke test

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*postgres|MCP server.*postgres.*(ok|ready)"; then
      REGISTERED=1; echo "OK: postgres MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: postgres not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test — SELECT 1 from inside the container
SMOKE=$(ssh "$VPS_USER@$VPS_IP" "
  if command -v psql >/dev/null 2>&1; then
    PGCONNECT_TIMEOUT=10 psql \"\$POSTGRES_URL\" -c 'SELECT 1' -tA 2>&1 | head -1
  else
    python3 -c 'import psycopg2,os; c=psycopg2.connect(os.environ[\"POSTGRES_URL\"],connect_timeout=10); cur=c.cursor(); cur.execute(\"SELECT 1\"); print(cur.fetchone()[0])' 2>&1 | head -1
  fi
")
case "$SMOKE" in
  "1"|"(1,)") echo "OK: Postgres SELECT 1 succeeded from VPS." ;;
  *) echo "WARN: unexpected smoke response: $SMOKE" ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove postgres 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^POSTGRES_URL=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. If the DB password leaked, ALTER ROLE <user> WITH PASSWORD '<new>' immediately."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using the `postgres` / `admin` / `root` superuser in the URL | Agent can DROP TABLE, TRUNCATE, DROP DATABASE — irreversible data loss | Step 3 hard-refuses these unless `ALLOW_WRITES=1`; recommend scoped `hermes_readonly` |
| 2 | Skipping `?sslmode=require` on managed Postgres | Provider refuses connection or MITM risk | Preserve `sslmode` in the URL; verify with `psql \conninfo` |
| 3 | Password with `@` or `:` characters not URL-encoded | URL parsing breaks; user gets 401-like errors | Use `urllib.parse.quote_plus(password)` when generating; test with psql first |
| 4 | Connecting to production DB from an agent that also does writes elsewhere | Blast radius = all writes on that user | Two connection strings if needed: `POSTGRES_URL_READONLY` for reads, `POSTGRES_URL_WRITE` scoped to just needed tables |
| 5 | Rate/connection limits | Bursty agent loops exhaust the DB's max_connections | Use pgbouncer or provider connection pooling; keep queries paginated |
| 6 | Community stdio MCP not audited | Crystal DBA `postgres-mcp` is community — vet the source | Pin the version (`uvx postgres-mcp@0.x.y`); read the code before granting write access |
| 7 | Connection string in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Password in `hermes logs` output | Some MCPs log the full DATABASE_URI on error | Redact in logs; rotate the password if you ever see it in a log |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | URL contains `/` | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Firewall blocks Hermes VPS → Postgres host | Live connect fails; smoke test hangs | Whitelist the Hermes VPS's outbound IP in the Postgres provider's firewall |
| 14 | Long-lived idle connections killed by provider | Errors like "server closed the connection unexpectedly" | Set `keepalives=1&keepalives_idle=60` in the URL for cloud providers |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `uvx` or `pipx` present on the VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: URL format valid; superuser refusal check triggered if applicable; live connect returned `current_user | current_database` shape
- [ ] Dry-run shown to user; access mode (read-only vs read-write) called out; user approved (or `AUTO_APPROVE=1`)
- [ ] `POSTGRES_URL` written to `~/.hermes/.env`, `chmod 600`, verified by grep (password NEVER printed)
- [ ] Path A: MCP registered with `DATABASE_URI=${POSTGRES_URL}` + `ACCESS_MODE=readonly` (unless ALLOW_WRITES=1)
- [ ] Path B: generic SQL tool documented
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'postgres'` within 30s
- [ ] Smoke test: `SELECT 1` from VPS returned `1`
- [ ] Rollback function defined; password-rotation instructions included
- [ ] User confirmed the DB user is scoped (not superuser) OR explicitly opted into `ALLOW_WRITES=1`

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, DB
connectivity, and Postgres role/grant failure modes.
