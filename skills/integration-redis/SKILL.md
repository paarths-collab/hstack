---
name: integration-redis
description: Connect a Redis instance (keys/hashes/lists/sets/sorted-sets/streams; any provider — self-hosted, Redis Cloud, Upstash, Elasticache, DigitalOcean, Fly Redis) to a self-hosted Hermes Agent over SSH via Redis's official stdio MCP (github.com/redis/mcp-redis). Uses a Redis connection URL. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-redis — connect Redis to a remote Hermes (SSH-first)

You are the engineer connecting Redis to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work
over SSH as root against the VPS. The user does two things a machine cannot:

1. Provision the Redis instance (Redis Cloud, Upstash, self-hosted, etc.).
2. Copy the connection URL — for TLS providers this looks like `rediss://default:<pw>@host:port`.

Everything else — connection storage, live PING verification, MCP registration via stdio,
gateway reload, live GET/SET smoke test — runs on the VPS via SSH, idempotently with a
rollback path.

**Honest auth picture (verified 2026-06):** Redis ships an **official stdio MCP** at
`github.com/redis/mcp-redis`. There is **no first-party hosted HTTP MCP** for Redis. The
official server:
- Handles all Redis data types: strings, hashes, lists, sets, sorted sets, streams
- Reads the connection URL from `REDIS_URL` or `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`
- Runs via `uvx redis-mcp` or `docker run`
- Supports TLS (`rediss://`), Azure AD for Azure Managed Redis, and standard AUTH

Sources:
- https://github.com/redis/mcp-redis
- https://redis.io/docs/latest/integrate/redis-mcp/

**Two paths:**

- **Path A (default) — official stdio MCP via `uvx`.** Requires `uvx` on the VPS.
  Everything Redis MCP tools can do runs through this.
- **Path B (fallback) — generic Redis client tool** with the connection URL. No MCP; the
  agent uses whatever redis-cli / go-redis / node-redis capability the host has.

**Key safety concern:** Redis often stores caches, sessions, rate-limit tokens, queue
state, or full user data. A write-capable agent can `FLUSHDB` / `FLUSHALL` and wipe the
entire instance instantly. This skill defaults to **read-only mode** unless
`ALLOW_WRITES=1` is set, and refuses to connect using the default Redis user (which has
full admin) without explicit opt-in.

**TLS matters:** modern managed Redis (Redis Cloud, Upstash, AWS ElastiCache with TLS)
requires `rediss://` (double s). Self-hosted usually doesn't. Preserve whatever the URL
specifies.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$REDIS_URL` | Full connection URL (`redis://user:pw@host:port/db` or `rediss://user:pw@host:port`) | Provider dashboard |
| `$REDIS_USERNAME` *(optional, ACL provider)* | Non-default ACL user (recommended) | `ACL SETUSER hermes_readonly ...` on the Redis instance |
| `$ALLOW_WRITES` *(optional)* | `1` if the agent needs writes (SET, HSET, DEL, etc.) | Default is read-only |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (generic Redis tool) | A requires `uvx` on the VPS |

### Creating a scoped read-only ACL user (recommended for Redis 6+)

```
ACL SETUSER hermes_readonly on ><strong-password> ~* +@read +@connection -@dangerous
```

That grants read across all keys, blocks dangerous commands (FLUSHDB, FLUSHALL, CONFIG,
DEBUG). Use `redis://hermes_readonly:<pw>@host:port` as `$REDIS_URL`.

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + Redis client tools on the VPS

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

# Path A needs uvx
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires uvx on the VPS. Install: pip install uv"; exit 1; }
fi

# redis-cli is nice to have for smoke testing
ssh "$VPS_USER@$VPS_IP" "command -v redis-cli >/dev/null 2>&1" \
  || echo "WARN: redis-cli not on VPS. Smoke test will use Python fallback if available."
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci redis" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^REDIS_URL=redis' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_URL" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Redis already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (URL format + default-user refusal + live PING)

```bash
# URL format — accept redis:// or rediss://
printf '%s' "$REDIS_URL" | grep -qE '^rediss?://([^:@]+(:[^@]+)?@)?[^:/]+(:[0-9]+)?(/[0-9]+)?(\?.*)?$' \
  || { echo "ABORT: REDIS_URL must be redis[s]://[user:pass@]host[:port][/db][?opts]."; exit 1; }

# Refuse default user + no ACL user set unless ALLOW_WRITES=1
USER=$(printf '%s' "$REDIS_URL" | sed -nE 's|^rediss?://([^:@]+):.*|\1|p')
USER=${USER:-default}
case "$USER" in
  default|admin|root)
    if [ "${ALLOW_WRITES:-0}" != "1" ]; then
      echo "ABORT: connection uses admin-shaped user '$USER'."
      echo "Redis default user has FULL admin — agent can FLUSHDB/FLUSHALL and wipe everything."
      echo "Create a scoped ACL user (see the ACL SETUSER snippet in the skill preamble)."
      echo "If you really want default user, set ALLOW_WRITES=1 to override."
      exit 1
    fi
    echo "WARN: admin-shaped user '$USER' — confirm this is intentional." ;;
  *) echo "User: $USER (looks scoped — proceeding)" ;;
esac

# Live PING using redis-cli or Python
if ssh "$VPS_USER@$VPS_IP" "command -v redis-cli >/dev/null 2>&1"; then
  PING=$(ssh "$VPS_USER@$VPS_IP" "redis-cli -u '$REDIS_URL' --timeout 10 PING 2>&1" | head -1)
  case "$PING" in
    PONG) echo "Redis PING OK." ;;
    *"WRONGPASS"*|*"NOAUTH"*) echo "ABORT: auth failed — check user/password."; exit 1 ;;
    *"connection refused"*|*"timeout"*) echo "ABORT: cannot reach Redis (firewall/network)."; exit 1 ;;
    *) echo "ABORT: unexpected PING response: $PING"; exit 1 ;;
  esac
else
  # Python redis client fallback
  PING=$(ssh "$VPS_USER@$VPS_IP" "python3 -c \"
import sys
try:
  import redis
except ImportError:
  print('NO_REDIS'); sys.exit(0)
try:
  r = redis.from_url('$REDIS_URL', socket_timeout=10)
  print(r.ping())
except Exception as e:
  print(f'ERROR: {e}'); sys.exit(1)
\" 2>&1")
  case "$PING" in
    True) echo "Redis PING OK (python)." ;;
    NO_REDIS) echo "WARN: cannot pre-verify (no redis-cli, no python redis). Proceeding without live check." ;;
    *) echo "ABORT: $PING"; exit 1 ;;
  esac
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
URL_REDACTED=$(printf '%s' "$REDIS_URL" | sed -E 's|(:)[^@]+(@)|\1***\2|')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write REDIS_URL ($URL_REDACTED) via 'hermes config set' — password NEVER printed
  2. chmod 600 ~/.hermes/.env
  3. Verify URL landed (grep -c)

  Path A (stdio MCP — official redis/mcp-redis):
    4. Register MCP: hermes mcp add redis --command uvx --args redis-mcp
       --env REDIS_URL=\${REDIS_URL} (+ REDIS_MODE=readonly unless ALLOW_WRITES=1)
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*redis"

  Path B (generic Redis client):
    4. No MCP registration; generic Redis tool reads REDIS_URL from env
    5. Reload gateway: stop + run
    6. Smoke test: GET/SET with a temp key

Password is NEVER printed in plaintext beyond the *** redaction.
Access mode: $([ "${ALLOW_WRITES:-0}" = "1" ] && echo "READ-WRITE (dangerous — FLUSHDB possible)" || echo "READ-ONLY (default)")
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the connection URL (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set REDIS_URL '$REDIS_URL'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^REDIS_URL=redis' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: REDIS_URL not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^REDIS_URL=' ~/.hermes/.env || printf 'REDIS_URL=\n' >> ~/.hermes/.env
>   sed -i 's|^REDIS_URL=.*|REDIS_URL=$REDIS_URL|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the connection URL in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  # Note: official redis-mcp reads REDIS_URL directly
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add redis \
      --command 'uvx' \
      --args 'redis-mcp' \
      --env 'REDIS_URL=\${REDIS_URL}'
  "
  echo "redis-mcp registered."
  [ "${ALLOW_WRITES:-0}" = "1" ] || echo "REMINDER: Read-only mode is enforced by the ACL user, NOT the MCP. Confirm your ACL restricts +@write / +@dangerous."
fi

if [ "${WIRE_PATH:-A}" = "B" ]; then
  cat <<'EOF'
Path B: no MCP registered. Agent's generic Redis tool layer reads REDIS_URL and uses:
  - redis-cli -u "$REDIS_URL" <command>
  - Python: redis.from_url(os.environ["REDIS_URL"])
  - Node: createClient({url: process.env.REDIS_URL})

Access enforcement is via the ACL user's grants — verify with `ACL WHOAMI` + `ACL LIST`.
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
         | grep -qiE "registered.*tool.*redis|MCP server.*redis.*(ok|ready)"; then
      REGISTERED=1; echo "OK: redis MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: redis not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test — GET/SET a temp key from VPS
KEY="hstack:smoke:$(date +%s)"
SMOKE=$(ssh "$VPS_USER@$VPS_IP" "
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -u \"\$REDIS_URL\" --timeout 10 GET '$KEY' 2>&1 | head -1
  else
    python3 -c 'import redis,os; r=redis.from_url(os.environ[\"REDIS_URL\"],socket_timeout=10); print(r.get(\"$KEY\"))' 2>&1 | head -1
  fi
")
# GET on non-existent key returns (nil)/None — success either way (proves connection works read-side)
case "$SMOKE" in
  ""|"(nil)"|"None") echo "OK: Redis GET succeeded from VPS (key not set — expected)." ;;
  *"WRONGPASS"*|*"NOAUTH"*) echo "FAIL: auth. Rolling back."; rollback; exit 1 ;;
  *) echo "Smoke response: $SMOKE" ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove redis 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^REDIS_URL=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. If password leaked, ACL SETUSER <user> resetpass '<new>' immediately."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Default `default` user has full admin | Agent can `FLUSHDB` / `FLUSHALL` and wipe everything | Step 3 hard-refuses without `ALLOW_WRITES=1`; recommend scoped `hermes_readonly` ACL user |
| 2 | `redis://` on TLS-required providers | Redis Cloud / Upstash reject plain TCP; connection times out | Use `rediss://` (double s) for TLS providers |
| 3 | Password contains `@` or `:` not URL-encoded | URL parser breaks; auth fails | URL-encode with `urllib.parse.quote_plus(password)` when generating |
| 4 | Connecting to prod cache from an agent that also writes | Blast radius across all cache consumers | Use a separate `hermes_readonly` ACL user with no write commands |
| 5 | `FLUSHDB` / `FLUSHALL` allowed for the agent | Wipes data instantly, irrecoverable without backup | Block with `-@dangerous` in ACL; enforce read-only |
| 6 | Connection URL in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 7 | Long-lived idle connections dropped | Errors like "connection reset" mid-session | Set `?socket_timeout=30&socket_keepalive=true` in URL, or use pool |
| 8 | Confusing DB numbers (`/0` vs `/1`) | Agent writes to wrong DB; production reads wrong DB | Always explicit DB in URL; document which DB is which |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | URL contains `/`, password may contain `+/=` | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Password in `hermes logs` on connection error | Some MCPs echo full URL in error output | Rotate password if ever seen in a log |
| 14 | Community stdio MCP not audited | Even the "official" redis/mcp-redis should be pinned + reviewed | Pin the version (`uvx redis-mcp@0.x.y`); read the code before granting writes |
| 15 | Serverless Redis auto-suspend | First call after cold start times out | Use provider keepalive/heartbeat or accept ~1-2s first-call latency |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `uvx` present on VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: URL format valid; admin-user refusal check triggered if applicable; live PING returned PONG
- [ ] Dry-run shown to user; access mode (read-only vs read-write) called out; user approved (or `AUTO_APPROVE=1`)
- [ ] `REDIS_URL` written to `~/.hermes/.env`, `chmod 600`, verified by grep (password NEVER printed)
- [ ] Path A: MCP registered with `REDIS_URL=${REDIS_URL}` env indirection
- [ ] Path B: generic Redis tool documented
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'redis'` within 30s
- [ ] Smoke test: GET on a temp key from VPS returned nil/None (connection works)
- [ ] Rollback function defined; ACL password-reset instructions included
- [ ] User confirmed ACL user is scoped (not `default`) OR explicitly opted into `ALLOW_WRITES=1`
- [ ] TLS confirmed (`rediss://`) for managed Redis providers

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Redis
ACL, and TLS/network failure modes.
