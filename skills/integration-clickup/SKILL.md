---
name: integration-clickup
description: Connect ClickUp (tasks, lists, docs, comments, time tracking) to a self-hosted Hermes Agent over SSH. Defaults to the static personal-token REST path; offers the OAuth-only MCP bridge as an opt-in. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, or any AI agent.
---

# /integration-clickup — connect ClickUp to a remote Hermes (SSH-first)

You are the engineer connecting ClickUp to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the personal API token in the ClickUp UI.
2. (Optional Path B) Complete the one-time OAuth browser login for the MCP bridge.

Everything else — token storage, MCP/REST registration, gateway reload, verification —
runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** ClickUp's official MCP server
(`https://mcp.clickup.com/mcp`) is **OAuth-only** and explicitly rejects API keys
(<https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server>:
"you cannot authenticate using your own API keys... We only support OAuth"). The reliable
static-token path is the ClickUp REST API v2 with a personal `pk_` token that never
expires. We default to the REST path (Path A below). If the user wants the full MCP
toolset and can complete a browser login, we wire the `mcp-remote` OAuth bridge (Path B).
MCP rate limits are also low without the paid add-on (50 calls/24h on Free, 300/24h on
Unlimited, rolling window, non-resettable).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$CLICKUP_API_TOKEN` | Personal API token (`pk_...`, never expires) | <https://app.clickup.com/settings/apps> → **API Token** → **Generate** → **Copy** |
| Workspace check | At least one ClickUp workspace ("team" in the API) | Default workspace is fine |

Docs: <https://developer.clickup.com/docs/authentication>

Confirm SSH access before doing anything:

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
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

> **Container vs host:** if Hermes runs inside a container, every later `hermes ...`
> command in this skill must be wrapped in `docker exec -u hermes "$AGENT" ...`. Set
> `AGENT` once and reuse it. Adding keys/config inside a container that you then expect
> on the host is the #1 source of "I configured it but nothing changed."

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci clickup" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CLICKUP_API_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY" -gt 0 ] || [ "$HAS_TOKEN" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "ClickUp is already wired (mcp=$ALREADY, token=$HAS_TOKEN). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Verify token via GET https://api.clickup.com/api/v2/user (token len=${#CLICKUP_API_TOKEN}, prefix=${CLICKUP_API_TOKEN:0:3}...)
  2. Write CLICKUP_API_TOKEN to ~/.hermes/.env via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register REST integration (Path A) OR mcp-remote OAuth bridge (Path B, opt-in)
  5. Reload gateway: hermes gateway stop && hermes gateway run --daemon
  6. Verify in logs: grep -i "registered.*clickup"
  7. Smoke test: GET https://api.clickup.com/api/v2/team -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

ClickUp's REST v2 takes the personal token as a **raw** `Authorization` header — NOT
`Bearer`-prefixed. We pre-flight against `/user` before wiring anything, so a bad token
never gets stored.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Authorization: $CLICKUP_API_TOKEN' \
  https://api.clickup.com/api/v2/user")
case "$HTTP" in
  200) echo "OK: token verified against /user." ;;
  401) echo "FAIL: token rejected (OAUTH_017). Re-mint at app.clickup.com/settings/apps."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from /user. Aborting before writing secret."; exit 1 ;;
esac

ssh "$VPS_USER@$VPS_IP" "hermes config set CLICKUP_API_TOKEN '$CLICKUP_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CLICKUP_API_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: CLICKUP_API_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; `pk_` tokens are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^CLICKUP_API_TOKEN=' ~/.hermes/.env || printf 'CLICKUP_API_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^CLICKUP_API_TOKEN=.*|CLICKUP_API_TOKEN=$CLICKUP_API_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```
>
> Never `echo "CLICKUP_API_TOKEN=..." >> ~/.hermes/.env` — if the previous line lacks a
> trailing newline, the variable glues onto it and the runtime ignores it.

---

## Step 5 — register the ClickUp integration

Pick the path that matches the user's needs. **Path A is the default.**

### Path A (preferred, default) — REST API v2 with the static personal token

No MCP server is registered. The agent reaches ClickUp through the REST API v2 via a
generic HTTP/REST tool. Settings the agent needs:

- **Base URL:** `https://api.clickup.com/api/v2`
- **Auth header:** `Authorization: ${CLICKUP_API_TOKEN}` (raw — **no** `Bearer` prefix)
- **Content type (POST/PUT):** `Content-Type: application/json`
- **Workspace endpoint:** `GET /team` (ClickUp's API calls workspaces "teams")
- **Common scopes:** `/team/{team_id}/space`, `/space/{space_id}/list`, `/list/{list_id}/task`

If your Hermes build supports declarative REST tools, register one:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add clickup \
    --type rest \
    --base-url 'https://api.clickup.com/api/v2' \
    --auth-header 'Authorization' \
    --auth-value '\${CLICKUP_API_TOKEN}' \
    --auth-scheme '' \
    2>/dev/null || true
"
```

If the build does not support declarative REST registration, leave the token in
`~/.hermes/.env` — generic HTTP skills and chat-driven `curl` will use it via
`${CLICKUP_API_TOKEN}` indirection.

### Path B (opt-in) — official OAuth MCP server via `mcp-remote` bridge

Only do this if the user explicitly wants the full MCP toolset AND can complete a one-time
browser login. The server is `https://mcp.clickup.com/mcp` and speaks OAuth 2.1 + PKCE
only — there is no static bearer token to inject, so `/hermes-mcp-add`'s probe + sed-inject
flow does NOT apply.

ClickUp's own headless-client guidance is to bridge with `mcp-remote`, which runs the
OAuth flow once and caches the grant
(<https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1>):

```bash
# Run inside the container if Hermes is containerized; opens a browser login URL on first run.
ssh -t "$VPS_USER@$VPS_IP" "
  if docker ps --format '{{.Names}}' | grep -q hermes; then
    AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
    docker exec -it -u hermes \"\$AGENT\" npx -y mcp-remote https://mcp.clickup.com/mcp
  else
    npx -y mcp-remote https://mcp.clickup.com/mcp
  fi
"
```

Stop here and let the user complete the browser login — a machine cannot do this for
them. Once the grant is cached, register the bridged **stdio** server with Hermes per
`/hermes-mcp-add` (stdio command form, not HTTP-header form):

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add clickup \
    --command npx \
    --args '-y,mcp-remote,https://mcp.clickup.com/mcp'
"
```

There is **no** `MCP_CLICKUP_API_KEY` to set — auth is the cached OAuth grant on disk.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*clickup|MCP server.*clickup.*(ok|ready)|REST.*clickup.*loaded"; then
    REGISTERED=1
    echo "OK: clickup registered in gateway logs."
    break
  fi
  sleep 5
done
if [ "$REGISTERED" = "0" ] && [ "${PATH_A_REST_ONLY:-1}" = "0" ]; then
  echo "FAIL: clickup not in logs after 30s. Rolling back."
  rollback
  exit 1
fi
# Path A with no declarative REST registration emits no log line; that's OK — Step 8 is the gate.
```

---

## Step 8 — live API smoke test (inside the VPS so the token stays there)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: \$CLICKUP_API_TOKEN\" \
    https://api.clickup.com/api/v2/team
")
case "$HTTP" in
  200) echo "OK: ClickUp REST reachable and token valid." ;;
  401) echo "FAIL: token invalid or Bearer-prefixed by mistake. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing scope. Re-mint with full access."; exit 1 ;;
  429) echo "WARN: rate-limited. ClickUp plan-based limits hit; back off and retry."; ;;
  *)   echo "WARN: unexpected HTTP $HTTP from ClickUp /team. Check manually." ;;
esac
```

`200` with a `teams` array (even with one workspace) is a pass. If Path B was chosen,
also trigger a real call from chat: `@<agent> using clickup, list my spaces`.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove clickup 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset CLICKUP_API_TOKEN 2>/dev/null || \
    sed -i '/^CLICKUP_API_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. ClickUp is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `https://mcp.clickup.com/mcp` with the `pk_` token | The official MCP is **OAuth-only**; bearer tokens are rejected | Use REST (Path A) or the `mcp-remote` OAuth bridge (Path B) |
| 2 | Sending `Authorization: Bearer pk_...` on REST v2 | Personal tokens take the **raw** value; `Bearer` prefix returns 401 `OAUTH_017` | `Authorization: $CLICKUP_API_TOKEN` with no prefix |
| 3 | Confusing personal tokens with OAuth access tokens | OAuth access tokens DO use `Bearer`; personal tokens do NOT | Personal = raw; OAuth = `Bearer` |
| 4 | Hitting the MCP rate limit | 50 calls/24h Free, 300/24h Unlimited+, rolling window, non-resettable | Budget calls; prefer REST for high-volume; buy the add-on if needed |
| 5 | Looking for "workspace" in the API | ClickUp's API calls workspaces **"teams"** | `/team` returns workspaces; ids feed space/folder/list lookups |
| 6 | MCP behavior changes mid-deploy | The MCP server is **public beta** — endpoint and tool set may shift | Re-verify against the docs if a tool stops resolving |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> ~/.hermes/.env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the `printf '\n%s\n'` + sed pattern) |
| 9 | Token in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env` (or `/opt/data/.env` in-container), `chmod 600` |
| 10 | sed with `/` delimiter on tokens | `pk_` is alnum but other ClickUp creds may include `/+=` | Always use `\|` delimiter |
| 11 | Container vs host confusion | Configured Hermes inside a container; host's hermes never sees it | `whoami; hostname` first; if containerized, wrap every `hermes ...` in `docker exec -u hermes "$AGENT" ...` |
| 12 | Skipping the verify step | "Silent success" — config written, never picked up | Step 8 hard-gates on a real 200 |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `CLICKUP_API_TOKEN` in `~/.hermes/.env` (or `/opt/data/.env` in-container), `chmod 600`, **not** in `config.yaml` or chat
- [ ] OAuth-only MCP limitation stated to the user; if they chose Path B, the `mcp-remote` browser login completed and the bridged stdio server registered
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs grepped for `registered.*clickup` (Path B) or smoke-test gate satisfies Path A
- [ ] Smoke test: `GET https://api.clickup.com/api/v2/team` returned `200` with a `teams` array
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, env-reload, and MCP failure modes.
