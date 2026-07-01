---
name: integration-vercel
description: Connect Vercel (frontend deploys, project/deployment management, logs) to a self-hosted Hermes Agent over SSH via the REST API and a static bearer token. Refuses the official OAuth-only/allowlisted MCP (dead-end for Hermes). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-vercel — connect Vercel to a remote Hermes (SSH-first)

You are the engineer connecting Vercel to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does one thing a machine cannot: mint the access token at
https://vercel.com/account/tokens.

Everything else — token storage, live REST verification, team-scope detection, gateway
reload, smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Vercel ships an official remote MCP at
`https://mcp.vercel.com` (https://vercel.com/docs/agent-resources/vercel-mcp, updated
2026-06-11). It is **OAuth-only, read-only, and restricted to a Vercel-maintained allowlist
of approved clients** (Claude Code, Claude.ai, ChatGPT, Cursor, VS Code, etc.). A
self-hosted Hermes agent is **NOT** on that allowlist and there's no static-token path. So
the official MCP is a **dead end** for Hermes — this skill refuses to wire it.

The supported headless path is the **Vercel REST API** (`https://api.vercel.com`) with a
static Bearer token. That's what this skill wires.

**Team-scope footgun:** A valid personal-account token returns 200 from `/v2/user` AND an
empty project list when the projects live under a Team. Looks like success; isn't.
Step 3 detects this and prompts for `$VERCEL_TEAM_ID`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$VERCEL_TOKEN` | Personal access token (shown ONCE) | https://vercel.com/account/tokens → Create Token → choose Personal/Team scope → name `hermes-agent` |
| `$VERCEL_TEAM_ID` *(optional)* | Team ID or slug if projects live under a Team | Settings → General → Team ID |

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
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^VERCEL_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Vercel already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (token sanity + live /v2/user + team-scope detection)

```bash
# Token sanity
[ "${#VERCEL_TOKEN}" -ge 20 ] \
  || { echo "ABORT: VERCEL_TOKEN looks too short (<20 chars)."; exit 1; }

# Live /v2/user
HTTP=$(curl -sS -o /tmp/v.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  'https://api.vercel.com/v2/user' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    USERNAME=$(grep -oE '"username":"[^"]+"' /tmp/v.json | head -1 | cut -d'"' -f4)
    echo "Vercel API OK. Token belongs to: $USERNAME"
    ;;
  401|403) echo "ABORT: token rejected ($HTTP). Re-mint at https://vercel.com/account/tokens."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/v.json | head -3; exit 1 ;;
esac
rm -f /tmp/v.json

# Team-scope detection: list projects WITHOUT team scope first
PROJ_RESP=$(curl -sS --max-time 10 \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  'https://api.vercel.com/v9/projects?limit=1' 2>/dev/null) || true
PROJ_COUNT=$(printf '%s' "$PROJ_RESP" | grep -oE '"projects":\[[^]]*\]' | grep -oE '"id":"prj_' | wc -l | tr -d ' ')
if [ "$PROJ_COUNT" = "0" ] && [ -z "${VERCEL_TEAM_ID:-}" ]; then
  echo "WARN: token returned empty project list with no team scope."
  echo "      If projects live under a Team, set VERCEL_TEAM_ID to the team ID/slug."
  echo "      (Otherwise this may just be an empty personal account — acceptable.)"
fi

# If team scope supplied, verify it
if [ -n "${VERCEL_TEAM_ID:-}" ]; then
  TEAM_RESP=$(curl -sS --max-time 10 \
    -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v9/projects?limit=1&teamId=$VERCEL_TEAM_ID" 2>/dev/null) || true
  TEAM_PROJ_COUNT=$(printf '%s' "$TEAM_RESP" | grep -oE '"id":"prj_' | wc -l | tr -d ' ')
  echo "Team-scoped projects visible: $TEAM_PROJ_COUNT (sample limit 1)"
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write VERCEL_TOKEN (length ${#VERCEL_TOKEN}) via 'hermes config set'
  2. Write VERCEL_TEAM_ID (${VERCEL_TEAM_ID:-none}) if supplied
  3. chmod 600 ~/.hermes/.env
  4. Verify token landed (grep -c)
  5. No MCP server registered (mcp.vercel.com is OAuth-only/allowlisted, refused)
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Smoke test from VPS: GET /v9/projects?limit=3 — expect 200

Token is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set VERCEL_TOKEN '$VERCEL_TOKEN'"
if [ -n "${VERCEL_TEAM_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set VERCEL_TEAM_ID '$VERCEL_TEAM_ID'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^VERCEL_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^VERCEL_TOKEN=' ~/.hermes/.env || printf 'VERCEL_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^VERCEL_TOKEN=.*|VERCEL_TOKEN=$VERCEL_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the REST surface (no MCP to register)

There is NO first-party Vercel MCP usable from Hermes (see auth picture). Skill does NOT
attempt `hermes mcp add`. The agent's generic HTTP/tool layer reads env and calls:

**Base URL:** `https://api.vercel.com`
**Auth:** `Authorization: Bearer ${VERCEL_TOKEN}`
**Team scope (if applicable):** append `?teamId=${VERCEL_TEAM_ID}` to EVERY request

Common endpoints (the "frontend deploys" use case):

| Action | Method + path |
|---|---|
| List projects | `GET /v9/projects` |
| List deployments | `GET /v6/deployments?app=<project>` |
| Get one deployment | `GET /v13/deployments/{idOrUrl}` |
| Create a deployment (git-linked redeploy) | `POST /v13/deployments` with `deploymentId` of latest |
| Read build/runtime logs | `GET /v3/deployments/{id}/events` |

Non-git-linked projects need the full file manifest in `POST /v13/deployments` body — much
heavier flow; prefer git-linked.

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (from inside the container)

```bash
ME_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$VERCEL_TOKEN\" \
    'https://api.vercel.com/v2/user'
")
PROJ_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  TQ=\$([ -n \"\$VERCEL_TEAM_ID\" ] && echo \"&teamId=\$VERCEL_TEAM_ID\" || echo '')
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$VERCEL_TOKEN\" \
    \"https://api.vercel.com/v9/projects?limit=3\$TQ\"
")
echo "Smoke: /v2/user=$ME_HTTP /v9/projects=$PROJ_HTTP"
[ "$ME_HTTP" = "200" ] && [ "$PROJ_HTTP" = "200" ] \
  || { echo "FAIL: smoke test. Rolling back."; rollback; exit 1; }
echo "OK: Vercel REST reachable from VPS."
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^VERCEL_TOKEN=/d;
            /^VERCEL_TEAM_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at https://vercel.com/account/tokens if compromised. Vercel auto-revokes tokens detected as leaked."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trying to wire `mcp.vercel.com` for Hermes | MCP is OAuth-only + allowlisted (Hermes NOT on the list) — dead end | This skill refuses; uses REST only |
| 2 | Team-scope silent empty list | Personal-account token returns 200 + empty `projects` when projects live under a Team | Step 3 detects + warns; set `VERCEL_TEAM_ID` |
| 3 | Token shown once, lost | Cannot retrieve; must re-mint | Store immediately in `~/.hermes/.env` |
| 4 | Vercel auto-revokes leaked tokens | If pasted in chat/PR, Vercel may revoke without warning | Never paste; only `~/.hermes/.env` |
| 5 | Token expiry (`expiresAt`) | 403 after expiry with no warning | Set expiry + rotation reminder via `/hermes-cron` |
| 6 | Rate limits | Tight polling on `/v6/deployments` → 429 | Poll every few seconds, not hot |
| 7 | Mixing v9 / v6 / v13 endpoint versions | Different resources live on different API versions | Use the version per the endpoint table; don't guess |
| 8 | Non-git-linked deployment without file manifest | `POST /v13/deployments` requires the full file set | Prefer git-linked projects; document the heavier flow |
| 9 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Token may contain `/+=` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if token present, unless `FORCE=1`)
- [ ] HARD GATE passed: token ≥20 chars; `/v2/user` returned 200 with a username; team-scope detected if projects appeared empty
- [ ] Dry-run shown to user; user told plainly that `mcp.vercel.com` is NOT wired
- [ ] `VERCEL_TOKEN` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `VERCEL_TEAM_ID` written if supplied
- [ ] No MCP server registered (correctly — none exists for Hermes)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v2/user` AND `/v9/projects` from VPS both returned 200
- [ ] REST surface documented (base URL + auth + version-per-endpoint table)
- [ ] Rollback function defined; token revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, scope,
and Vercel team/personal-account failure modes.
