---
name: integration-supabase
description: Connect Supabase (Postgres database + auth + storage + edge functions + realtime) to a self-hosted Hermes Agent over SSH via Supabase's first-party hosted MCP at mcp.supabase.com with a Personal Access Token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-supabase — connect Supabase to a remote Hermes (SSH-first)

You are the engineer connecting Supabase (open-source Firebase alternative — Postgres +
auth + storage + edge functions + realtime) to a self-hosted Hermes agent on the user's
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them)
work over SSH as root against the VPS. The user does one thing a machine cannot: mint the
Personal Access Token at https://supabase.com/dashboard/account/tokens.

Everything else — token storage, live MCP verification, gateway reload, live query smoke
test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Supabase ships an **official first-party**
hosted MCP at `https://mcp.supabase.com/mcp`. Two auth modes:

- **Dynamic Client Registration (default for interactive clients):** OAuth 2.1 flow, no
  PAT needed. The MCP client redirects to Supabase login in a browser. **Not usable for
  Hermes** — headless agent has no browser.
- **Personal Access Token (headless / CI):** `Authorization: Bearer <PAT>` header. This
  is what we wire.

Sources:
- https://supabase.com/docs/guides/getting-started/mcp
- https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication

**Scope options:** the MCP server supports `--project-ref <ref>` to limit access to one
project (recommended) and `--read-only` for safer defaults. Set these in the URL as query
parameters or via header options.

**PAT vs project API key:** the PAT authenticates YOU (the Supabase account owner) to the
MCP server. It is NOT a per-project anon/service_role key. Guard the PAT accordingly —
leak = full account access across ALL projects unless you scope with `--project-ref`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SUPABASE_PAT` | Personal Access Token (`sbp_...` prefix) | https://supabase.com/dashboard/account/tokens → Generate new token → name `hermes-agent` |
| `$SUPABASE_PROJECT_REF` *(strongly recommended)* | Project ref (20 lowercase chars) to scope this token | https://supabase.com/dashboard/project/<REF> — the ref is in the URL |
| `$SUPABASE_READ_ONLY` *(optional)* | `1` to force read-only mode | Set `1` unless the agent needs writes |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

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
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci supabase" || echo 0)
HAS_PAT=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_SUPABASE_API_KEY=sbp_' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_PAT" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Supabase already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (PAT format + project-ref shape + live REST verification)

```bash
# PAT format: sbp_<40 alphanumeric>
printf '%s' "$SUPABASE_PAT" | grep -qE '^sbp_[A-Za-z0-9]+$' \
  || { echo "ABORT: SUPABASE_PAT must start with 'sbp_' (personal access token)."; exit 1; }
[ "${#SUPABASE_PAT}" -ge 40 ] \
  || { echo "ABORT: SUPABASE_PAT looks too short."; exit 1; }

# Project ref format: 20 lowercase alphanumeric characters
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  printf '%s' "$SUPABASE_PROJECT_REF" | grep -qE '^[a-z0-9]{20}$' \
    || { echo "ABORT: SUPABASE_PROJECT_REF must be 20 lowercase alphanumeric chars (project ref from dashboard URL)."; exit 1; }
else
  echo "WARN: no SUPABASE_PROJECT_REF supplied — token has FULL account access across ALL projects."
  echo "      Strongly recommend re-running with SUPABASE_PROJECT_REF=<ref> to scope."
fi

# Live REST management API verify — GET /v1/projects with the PAT
HTTP=$(curl -sS -o /tmp/sb.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $SUPABASE_PAT" \
  'https://api.supabase.com/v1/projects' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    PROJ_COUNT=$(grep -oE '"id":"[a-z0-9]{20}"' /tmp/sb.json | wc -l | tr -d ' ')
    echo "Supabase Management API OK. Token has access to $PROJ_COUNT project(s)."
    if [ -n "${SUPABASE_PROJECT_REF:-}" ] && ! grep -q "\"id\":\"$SUPABASE_PROJECT_REF\"" /tmp/sb.json; then
      echo "ABORT: SUPABASE_PROJECT_REF=$SUPABASE_PROJECT_REF NOT visible to this PAT."
      rm -f /tmp/sb.json
      exit 1
    fi
    ;;
  401|403) echo "ABORT: PAT rejected ($HTTP). Re-mint at https://supabase.com/dashboard/account/tokens."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP from Management API."; cat /tmp/sb.json | head -3; exit 1 ;;
esac
rm -f /tmp/sb.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
READ_ONLY=${SUPABASE_READ_ONLY:-0}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_SUPABASE_API_KEY (length ${#SUPABASE_PAT}, prefix sbp_) via 'hermes config set'
  2. Write SUPABASE_PROJECT_REF (${SUPABASE_PROJECT_REF:-none}) if supplied
  3. Write SUPABASE_READ_ONLY ($READ_ONLY) — 1 forces read-only mode
  4. chmod 600 ~/.hermes/.env
  5. Register MCP at https://mcp.supabase.com/mcp with:
       Authorization: Bearer \${MCP_SUPABASE_API_KEY}
       ${SUPABASE_PROJECT_REF:+URL includes ?project_ref=$SUPABASE_PROJECT_REF}
       ${SUPABASE_READ_ONLY:+URL includes &read_only=true if 1}
  6. Reload gateway: stop + run (NOT restart)
  7. Verify in logs: grep "registered.*supabase"
  8. Smoke test: GET /v1/projects/{ref} via Management API — expect 200

Token is NEVER printed in plaintext beyond a length + prefix.
Token has FULL account access if SUPABASE_PROJECT_REF is empty — Step 3 warned.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_SUPABASE_API_KEY '$SUPABASE_PAT'"
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SUPABASE_PROJECT_REF '$SUPABASE_PROJECT_REF'"
fi
ssh "$VPS_USER@$VPS_IP" "hermes config set SUPABASE_READ_ONLY '${SUPABASE_READ_ONLY:-0}'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_SUPABASE_API_KEY=sbp_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: PAT not written. Rolling back."; rollback; exit 1; }
echo "Supabase config confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_SUPABASE_API_KEY=' ~/.hermes/.env || printf 'MCP_SUPABASE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_SUPABASE_API_KEY=.*|MCP_SUPABASE_API_KEY=$SUPABASE_PAT|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the PAT in `config.yaml`.

---

## Step 6 — register the Supabase MCP with scoped URL

```bash
# Build URL with query params for project scope + read-only
URL='https://mcp.supabase.com/mcp'
QUERY=""
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  QUERY="?project_ref=$SUPABASE_PROJECT_REF"
fi
if [ "${SUPABASE_READ_ONLY:-0}" = "1" ]; then
  [ -n "$QUERY" ] && QUERY="$QUERY&read_only=true" || QUERY="?read_only=true"
fi

ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add supabase \
    --url '${URL}${QUERY}' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_SUPABASE_API_KEY}|g' ~/.hermes/config.yaml"
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

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE "registered.*tool.*supabase|MCP server.*supabase.*(ok|ready)"; then
    REGISTERED=1; echo "OK: supabase MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: supabase not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (Management API from inside the container)

```bash
if [ -n "${SUPABASE_PROJECT_REF:-}" ]; then
  # Scoped: GET the specific project
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -H \"Authorization: Bearer \$MCP_SUPABASE_API_KEY\" \
      \"https://api.supabase.com/v1/projects/\$SUPABASE_PROJECT_REF\"
  ")
else
  # Unscoped: list all projects
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -H \"Authorization: Bearer \$MCP_SUPABASE_API_KEY\" \
      'https://api.supabase.com/v1/projects'
  ")
fi
case "$HTTP" in
  200) echo "OK: Supabase Management API reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  404) echo "FAIL: project ref not found. Re-check SUPABASE_PROJECT_REF."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove supabase 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^MCP_SUPABASE_API_KEY=/d;
            /^SUPABASE_PROJECT_REF=/d;
            /^SUPABASE_READ_ONLY=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the PAT at https://supabase.com/dashboard/account/tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | PAT without `SUPABASE_PROJECT_REF` | Token has full account access across ALL projects — huge blast radius | Step 3 WARNs; always supply project ref for production |
| 2 | Confusing PAT (`sbp_`) with project anon/service_role key | Different auth surface; anon/service_role are for direct Postgres/PostgREST calls, PAT is for Management API + MCP | This skill wires the MCP (PAT); anon/service_role are separate |
| 3 | Using OAuth dynamic client registration for headless | Requires browser redirect — Hermes has no browser | Use PAT path (this skill); OAuth is for interactive clients (Cursor, Claude Desktop) |
| 4 | Skipping `--read-only` when agent doesn't need writes | Agent can drop tables, delete rows, alter schema | Set `SUPABASE_READ_ONLY=1` unless writes are explicitly required |
| 5 | PAT in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_SUPABASE_API_KEY}` indirection in yaml |
| 6 | Assuming MCP covers direct Postgres access | Supabase MCP is Management API-focused; for direct SQL use pg_query tool or PostgREST | If direct SQL is needed, also wire `/integration-postgres` with the project's connection string |
| 7 | Free-tier project pausing | Inactive projects auto-pause; MCP calls return `project_paused` errors | Monitor project status; upgrade to Pro to prevent |
| 8 | Rate limits on Management API | Bursty MCP calls hit rate limits | Back off on 429; batch operations |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter on URLs | URL contains `/` | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Storing service_role key alongside PAT | service_role bypasses RLS — even more dangerous than PAT | Never store service_role in Hermes env; use per-project anon key + RLS |
| 14 | Assuming project ref auto-scopes ALL operations | Only Management API respects the header; edge functions / direct DB calls need separate scoping | Step 6 puts project_ref in the MCP URL so all MCP calls are scoped |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: PAT starts with `sbp_` + ≥40 chars; project ref (if set) is 20 lowercase alphanumeric; live `GET /v1/projects` returned 200; project ref found in response
- [ ] Warned user if no `SUPABASE_PROJECT_REF` (full account access risk)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] MCP registered with `${MCP_SUPABASE_API_KEY}` indirection (no plaintext in yaml)
- [ ] URL includes `?project_ref=...` if scoped and/or `&read_only=true` if read-only
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'supabase'` within 30s
- [ ] Smoke test: `GET /v1/projects` or `/v1/projects/<ref>` from inside container returned 200
- [ ] Read-only mode confirmed if requested (`SUPABASE_READ_ONLY=1`)
- [ ] Rollback function defined; PAT revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, PAT
scoping, and Supabase Management API failure modes.
