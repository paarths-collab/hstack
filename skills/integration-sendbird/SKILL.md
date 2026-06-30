---
name: integration-sendbird
description: Connect Sendbird (in-app chat, voice, video — Platform API) to a self-hosted Hermes Agent over SSH. No first-party MCP — uses REST API with the mandatory Api-Token header (NOT Bearer). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-sendbird — connect Sendbird to a remote Hermes (SSH-first)

You are the engineer connecting Sendbird to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint a **secondary** Platform API token (NOT the master — master is unrotatable) in
   Sendbird Dashboard → Settings → Application → General → API tokens.
2. Confirm the **case-sensitive** Application ID (mismatch = 404 silently).

Everything else — credential storage, live API verification, gateway reload, smoke test —
runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** **No first-party Sendbird MCP server is
verified.** Sendbird's own MCP blog post discusses the protocol conceptually and does not
announce a hosted endpoint. Third-party aggregators (Composio, Pipedream, viaSocket) wrap
the Platform API but are not Sendbird-maintained. So we wire the **Platform REST API**
directly with a static API token.

The single most common Sendbird integration mistake is **using `Authorization: Bearer`**.
Sendbird rejects it. The required header is `Api-Token: <token>`.

**Master vs secondary token:**
- Master token: cannot be revoked or rotated → permanent leak risk if exposed.
- Secondary token: scoped per agent, rotatable. **Always prefer secondary** for production.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SENDBIRD_APP_ID` | Case-sensitive Application ID | Sendbird Dashboard → Settings → Application → General → Application ID |
| `$SENDBIRD_API_TOKEN` | Master or secondary Platform API token (prefer secondary) | Same Settings page → API tokens → Generate secondary token |

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
HAS_APP=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SENDBIRD_APP_ID=' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SENDBIRD_API_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_APP" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Sendbird already wired (both vars present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (App ID + token sanity + live API check with Api-Token)

```bash
# App ID: Sendbird app IDs are 8-4-4-4-12 hex (UUID-like) — strict check
printf '%s' "$SENDBIRD_APP_ID" | grep -qE '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' \
  || { echo "ABORT: SENDBIRD_APP_ID does not look like a Sendbird UUID. Copy verbatim from Dashboard (case-sensitive)."; exit 1; }

# Token sanity
[ "${#SENDBIRD_API_TOKEN}" -ge 30 ] \
  || { echo "ABORT: SENDBIRD_API_TOKEN looks too short (<30 chars). Did you paste the right value?"; exit 1; }

# Live API: GET /v3/users?limit=1 with Api-Token header
HTTP=$(curl -sS -o /tmp/sb.json -w '%{http_code}' --max-time 10 \
  -H "Api-Token: $SENDBIRD_API_TOKEN" \
  -H 'Content-Type: application/json; charset=utf8' \
  "https://api-$SENDBIRD_APP_ID.sendbird.com/v3/users?limit=1" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200) echo "Sendbird API OK (Api-Token header accepted)." ;;
  401) echo "ABORT: 401 — token rejected. Did you mint it under the correct application?"; exit 1 ;;
  400)
    if grep -q '"code":400108' /tmp/sb.json 2>/dev/null; then
      echo "ABORT: App ID format issue in URL. Re-check SENDBIRD_APP_ID exact case."
    else
      echo "ABORT: 400 from Sendbird. Body:"; cat /tmp/sb.json | head -3
    fi
    exit 1 ;;
  404) echo "ABORT: 404 — application ID '$SENDBIRD_APP_ID' not found (check case)."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP"; cat /tmp/sb.json | head -3; exit 1 ;;
esac
rm -f /tmp/sb.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write SENDBIRD_APP_ID ($SENDBIRD_APP_ID) via 'hermes config set'
  2. Write SENDBIRD_API_TOKEN (length ${#SENDBIRD_API_TOKEN}) — never plaintext-logged
  3. chmod 600 ~/.hermes/.env
  4. Verify both landed (grep -c)
  5. No MCP server to register (no first-party Sendbird MCP exists)
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Smoke test: GET /v3/users?limit=1 with Api-Token header — expect 200

Auth header: Api-Token (NOT Bearer — the #1 Sendbird integration mistake)
Base URL: https://api-$SENDBIRD_APP_ID.sendbird.com/v3
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SENDBIRD_APP_ID '$SENDBIRD_APP_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SENDBIRD_API_TOKEN '$SENDBIRD_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(SENDBIRD_APP_ID|SENDBIRD_API_TOKEN)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "2" ] || { echo "FAIL: env vars did not land (got $COUNT, need 2). Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'SENDBIRD_APP_ID=$SENDBIRD_APP_ID' 'SENDBIRD_API_TOKEN=$SENDBIRD_API_TOKEN'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the REST surface (no MCP server to register)

Since no first-party MCP exists, the agent's generic HTTP tool layer reads the env vars and
calls the Platform REST API:

- **Base URL:** `https://api-${SENDBIRD_APP_ID}.sendbird.com/v3`
- **Auth header:** `Api-Token: ${SENDBIRD_API_TOKEN}` (NOT `Authorization: Bearer`)
- **Content type:** `Content-Type: application/json; charset=utf8`

Common endpoints (Chat Platform API v3):
- `GET /v3/users` — list users
- `POST /v3/users` — create user
- `GET /v3/group_channels` — list group channels
- `POST /v3/group_channels` — create group channel
- `POST /v3/group_channels/{channel_url}/messages` — send a message
- `GET /v3/group_channels/{channel_url}/messages` — list messages
- `PUT /v3/group_channels/{channel_url}/freeze` — moderate (freeze) a channel

Reference: https://sendbird.com/docs/chat/platform-api/v3/overview

**Opt-in (Path B):** community MCPs exist (Composio, Pipedream). They wrap the same API but
add a third-party dependency. Document only — this skill does not auto-wire them. If you
register one, do NOT point `/hermes-mcp-add` at `https://api-<APP_ID>.sendbird.com/v3` — it
is a REST API, not an MCP endpoint.

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
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Api-Token: \$SENDBIRD_API_TOKEN\" \
    -H 'Content-Type: application/json; charset=utf8' \
    \"https://api-\$SENDBIRD_APP_ID.sendbird.com/v3/users?limit=1\"
")
case "$HTTP" in
  200) echo "OK: Sendbird REST reachable from VPS with Api-Token header." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SENDBIRD_APP_ID=/d;
            /^SENDBIRD_API_TOKEN=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. If the SECONDARY token leaked, revoke + regenerate in Sendbird Dashboard. If MASTER leaked: you cannot revoke it (regenerate is the only option, which invalidates ALL existing tokens)."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `Authorization: Bearer <token>` | Sendbird rejects; auth header is `Api-Token` | Always `Api-Token: <token>`; Pitfalls and Step 3 explicit |
| 2 | Wrong-case Application ID | Sendbird app IDs are case-sensitive; mismatch = 404 | Step 3 validator + verbatim copy from Dashboard |
| 3 | Using master token in production | Master token is unrotatable — leak = permanent | Always mint a secondary token; this skill warns when token length matches master pattern |
| 4 | Calling Platform API from a client/front-end | Exposes the token; Sendbird explicitly warns | All calls go server-side through Hermes; token stays in `~/.hermes/.env` |
| 5 | Trusting a third-party "Sendbird MCP" as first-party | Composio/Pipedream/viaSocket wrap the API but are NOT Sendbird | This skill documents but does not auto-wire third-party MCPs |
| 6 | Pointing `/hermes-mcp-add` at the REST API URL | `api-<APP_ID>.sendbird.com/v3` is NOT an MCP — JSON-RPC handshake fails | Don't; use generic HTTP tool layer instead |
| 7 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Rate limits | Aggressive per-application throttling; bursts 429 | Back off; batch where possible; cache user/channel lookups |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Confusing Sendbird Chat with Sendbird Calls/Live | Different APIs, different scopes | This skill targets Chat Platform API v3 |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if both vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: App ID is UUID-shaped; token ≥30 chars; live `/v3/users?limit=1` returned 200 with `Api-Token` header
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Both env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] No MCP server registered (no first-party MCP exists); generic REST tool documented
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v3/users?limit=1` from inside container returned 200
- [ ] Rollback function defined; secondary-vs-master token revocation behavior explained
- [ ] User informed that ANY community MCP is third-party

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
Api-Token-vs-Bearer, and Sendbird application-ID failure modes.
