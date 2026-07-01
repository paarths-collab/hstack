---
name: integration-neon
description: Connect Neon (serverless Postgres with branching + point-in-time restore) to a self-hosted Hermes Agent over SSH via Neon's first-party hosted MCP at mcp.neon.tech with a Bearer API key. Manages Neon projects/branches/roles/databases and runs SQL through the Data API. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-neon — connect Neon Postgres to a remote Hermes (SSH-first)

You are the engineer connecting Neon (serverless Postgres — instant branching, autoscaling,
point-in-time restore) to a self-hosted Hermes agent on the user's VPS. You (the AI agent —
Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root
against the VPS. The user does one thing a machine cannot: create the Neon API key at
https://console.neon.tech/app/settings/api-keys.

Everything else — key storage, live Management API verification, gateway reload, live
project-list smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Neon ships an **official first-party** hosted
MCP at `https://mcp.neon.tech/mcp` with **Bearer auth** — perfect for a headless agent.
Sources:
- https://neon.com/docs/ai/neon-mcp-server
- https://github.com/neondatabase/mcp-server-neon

Two auth options at Neon's server:

- **Bearer API key (what this skill wires):** `Authorization: Bearer <NEON_API_KEY>`. Keys
  are 64-char random tokens, never expire until revoked. Perfect for headless.
- **OAuth (browser-based):** for interactive clients. Not usable for Hermes.

**Scope:** the API key is account-scoped — it can see and modify ALL projects in your
account. Neon does not currently support per-project API keys (as of 2026-06). If you want
tighter isolation, use a separate Neon account per client.

**Neon MCP vs direct Postgres:** the MCP covers *management* (create/list/delete projects,
branches, roles, databases, run SQL via the Data API). For high-frequency direct SQL from
inside the agent's normal flow, also wire `/integration-postgres` with a scoped
`hermes_readonly` role and the per-branch connection string. The two skills complement,
they don't overlap.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$NEON_API_KEY` | 64-char API key | https://console.neon.tech/app/settings/api-keys → Generate new API key |
| `$NEON_PROJECT_ID` *(optional but recommended)* | Project ID to scope MCP tool calls (documentation-only; key is still account-wide) | https://console.neon.tech/app/projects/<ID> — the ID is in the URL |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci neon" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_NEON_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Neon already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key sanity + live Management API + project-visibility check)

```bash
# Key sanity — Neon keys are 64 chars, alphanumeric
[ "${#NEON_API_KEY}" -ge 40 ] \
  || { echo "ABORT: NEON_API_KEY looks too short (<40 chars). Neon keys are typically 64-char alphanumeric."; exit 1; }
printf '%s' "$NEON_API_KEY" | grep -qE '^[A-Za-z0-9_-]+$' \
  || { echo "ABORT: NEON_API_KEY has unexpected characters."; exit 1; }

# Live GET /projects on the Neon Management API
HTTP=$(curl -sS -o /tmp/neon.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -H 'Accept: application/json' \
  'https://console.neon.tech/api/v2/projects' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    PROJ_COUNT=$(grep -oE '"id":"[a-z0-9-]+"' /tmp/neon.json | wc -l | tr -d ' ')
    echo "Neon Management API OK. Token has access to $PROJ_COUNT project(s)."
    if [ -n "${NEON_PROJECT_ID:-}" ] && ! grep -q "\"id\":\"$NEON_PROJECT_ID\"" /tmp/neon.json; then
      echo "ABORT: NEON_PROJECT_ID=$NEON_PROJECT_ID NOT visible to this key."
      rm -f /tmp/neon.json
      exit 1
    fi
    ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://console.neon.tech/app/settings/api-keys."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP from Neon Management API."; cat /tmp/neon.json | head -3; exit 1 ;;
esac
rm -f /tmp/neon.json

# Live MCP probe
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
RESP=$(curl -sS --max-time 15 \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $NEON_API_KEY" \
  -d "$INIT" \
  'https://mcp.neon.tech/mcp' 2>/dev/null) || true
printf '%s' "$RESP" | grep -q '"result"' \
  && echo "Neon MCP OK." \
  || { echo "ABORT: Neon MCP probe failed. Body:"; echo "$RESP" | head -3; exit 1; }
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_NEON_API_KEY (length ${#NEON_API_KEY}) via 'hermes config set'
  2. Write NEON_PROJECT_ID (${NEON_PROJECT_ID:-none}) if supplied
  3. chmod 600 ~/.hermes/.env
  4. Register MCP at https://mcp.neon.tech/mcp with Authorization: Bearer \${MCP_NEON_API_KEY}
  5. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  6. Verify in logs: grep "registered.*neon"
  7. Smoke test: GET /api/v2/projects from inside container — expect 200

Key is NEVER printed in plaintext beyond a length.
Scope reminder: Neon API keys are ACCOUNT-WIDE. NEON_PROJECT_ID is documentation-only
until Neon ships per-project keys.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_NEON_API_KEY '$NEON_API_KEY'"
if [ -n "${NEON_PROJECT_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set NEON_PROJECT_ID '$NEON_PROJECT_ID'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_NEON_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: Neon key not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_NEON_API_KEY=' ~/.hermes/.env || printf 'MCP_NEON_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_NEON_API_KEY=.*|MCP_NEON_API_KEY=$NEON_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the Neon MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add neon \
    --url 'https://mcp.neon.tech/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_NEON_API_KEY}|g' ~/.hermes/config.yaml"
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
       | grep -qiE "registered.*tool.*neon|MCP server.*neon.*(ok|ready)"; then
    REGISTERED=1; echo "OK: neon MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: neon not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (from inside the container)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$MCP_NEON_API_KEY\" \
    -H 'Accept: application/json' \
    'https://console.neon.tech/api/v2/projects'
")
case "$HTTP" in
  200) echo "OK: Neon Management API reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove neon 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^MCP_NEON_API_KEY=/d;
            /^NEON_PROJECT_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://console.neon.tech/app/settings/api-keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Assuming NEON_PROJECT_ID scopes the key | Neon API keys are ACCOUNT-WIDE — a compromised key exposes ALL projects | Use a separate Neon account per client/environment if you need isolation |
| 2 | Storing DB connection strings alongside the MCP key | Compounds blast radius | Direct-DB access is a separate skill (`/integration-postgres`); different creds |
| 3 | Assuming MCP replaces direct SQL | MCP is management-focused; high-volume queries should go direct via `/integration-postgres` | Wire both if the agent needs read-heavy SQL + branching |
| 4 | Neon compute suspends after idle | First MCP call after suspension can time out (~5s wake) | Warn user; use `?ssl=require` and keepalives on any direct connection strings |
| 5 | Deleting a project via MCP | Irreversible after retention window | Set project-level `deletion_protection` in Neon Console; agent respects it |
| 6 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_NEON_API_KEY}` indirection in yaml |
| 7 | Rate limits on Management API | Bursty branch-creation loops hit rate limits | Back off on 429; batch |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter | Key is alphanumeric, but universal rule | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Confusing Neon MCP with the older `mcp-server-neon` npm | Older npm package uses stdio; hosted MCP is HTTP | This skill wires the HOSTED HTTP MCP (mcp.neon.tech/mcp) |
| 13 | Free-tier compute limits | Free tier has 191h/month compute — bursty branch creation exhausts it | Monitor billing; upgrade if needed |
| 14 | Branch-per-agent-request antipattern | Creating a branch per agent call quickly exhausts quotas | Use one long-lived agent branch; only branch for schema migrations |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: key ≥40 alphanumeric chars; live `/api/v2/projects` returned 200; MCP `initialize` returned result; project ID (if supplied) visible in project list
- [ ] Dry-run shown to user; key-is-account-wide scope reminder acknowledged; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] MCP registered with `${MCP_NEON_API_KEY}` indirection (no plaintext in yaml)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'neon'` within 30s
- [ ] Smoke test: `/api/v2/projects` from inside container returned 200
- [ ] User warned about compute-suspension latency and free-tier limits
- [ ] Rollback function defined; key revocation URL included
- [ ] User told: direct SQL should go through `/integration-postgres` (separate scoped role) not the MCP

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Neon
suspension, and MCP registration failure modes.
