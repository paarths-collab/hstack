---
name: integration-trello
description: Connect Trello (boards, lists, cards) to a self-hosted Hermes Agent over SSH using a static API key + user token. No first-party MCP — uses community stdio MCP (Path A) or generic REST (Path B). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-trello — connect Trello to a remote Hermes (SSH-first)

You are the engineer connecting Trello to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does two things a machine cannot:

1. Generate a Trello API key at https://trello.com/power-ups/admin (create or open a
   Power-Up → API key tab → Generate).
2. Authorize a user token by opening the `trello.com/1/authorize` URL in a browser, clicking
   **Allow**, and pasting back the token.

Everything else — credential storage, live API verification, MCP registration, gateway
reload, smoke test — runs on the VPS via SSH, idempotently with a rollback.

**Honest auth picture (verified 2026-06):** Trello has **NO first-party remote MCP server**.
The official Atlassian Remote MCP Server (`atlassian/atlassian-mcp-server`) covers Jira,
Confluence, JSM, Bitbucket, and Compass — but **not Trello**. Two practical paths:

- **Path A (community stdio MCP):** `@delorenj/mcp-server-trello` runs over stdio and reads
  `TRELLO_API_KEY` + `TRELLO_TOKEN` from env. Community-maintained — vet the source before
  enabling write scope.
- **Path B (generic REST tool):** Point the agent's HTTP/tool layer at
  `https://api.trello.com/1`, append `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` to every
  request. No third-party code in the trust path.

This skill wires Path B by default (zero third-party code) and documents Path A as opt-in.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TRELLO_API_KEY` | 32-char hex API key | https://trello.com/power-ups/admin → open/create Power-Up → API key tab |
| `$TRELLO_TOKEN` | User token (~64+ hex chars) | Open `https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=$TRELLO_API_KEY&name=Hermes` → Allow → copy token |
| `$TRELLO_SCOPE` *(optional)* | `read` or `read,write` (default the latter for kanban automation) | Used in the authorize URL above |
| `$TRELLO_EXPIRATION` *(optional)* | `never` / `30days` / `1day` (default `never`) | Tradeoff: convenience vs blast radius |
| `$WIRE_PATH` *(optional)* | `B` (REST, default) or `A` (community stdio MCP) | Path A pulls a third-party npm package; vet before enabling |

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
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TRELLO_API_KEY=[a-f0-9]' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TRELLO_TOKEN=[a-f0-9]' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Trello already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key + token format, live API verification)

```bash
# Key: Trello API keys are 32-char lowercase hex
printf '%s' "$TRELLO_API_KEY" | grep -qE '^[a-f0-9]{32}$' \
  || { echo "ABORT: TRELLO_API_KEY must be 32 lowercase hex chars."; exit 1; }

# Token: Trello user tokens are 60-100 char hex (varies by token type)
printf '%s' "$TRELLO_TOKEN" | grep -qE '^[a-f0-9]{40,128}$' \
  || { echo "ABORT: TRELLO_TOKEN doesn't look like a Trello user token (expected hex, 40-128 chars)."; exit 1; }

# Live API verify (catches wrong key OR wrong token; tells us the user identity too)
ME=$(curl -sS --max-time 10 \
  "https://api.trello.com/1/members/me?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" 2>/dev/null) || true
USERNAME=$(printf '%s' "$ME" | grep -oE '"username":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "$USERNAME" ]; then
  if printf '%s' "$ME" | grep -qi 'invalid key'; then
    echo "ABORT: TRELLO_API_KEY rejected (invalid key)."
  elif printf '%s' "$ME" | grep -qi 'invalid token\|unauthorized'; then
    echo "ABORT: TRELLO_TOKEN rejected (invalid or missing permissions)."
  else
    echo "ABORT: Could not reach Trello API. Response:"
    echo "$ME" | head -3
  fi
  exit 1
fi
echo "Trello API OK: authenticated as @$USERNAME"

# If scope=write is needed, do a permission check via /members/me?fields=idBoards
SCOPE_OK=$(curl -sS --max-time 10 \
  "https://api.trello.com/1/members/me?fields=username&key=$TRELLO_API_KEY&token=$TRELLO_TOKEN" 2>/dev/null \
  | grep -c "$USERNAME")
[ "$SCOPE_OK" -ge 1 ] || { echo "WARN: scope check inconclusive — write actions may 401."; }
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-B}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write TRELLO_API_KEY (32-char hex, ends ...${TRELLO_API_KEY: -4}) via 'hermes config set'
  2. Write TRELLO_TOKEN (length ${#TRELLO_TOKEN}, ends ...${TRELLO_TOKEN: -4}) — never plaintext-logged
  3. chmod 600 ~/.hermes/.env
  4. Verify both landed (grep -c)
  5. Wire path: $PATH_CHOSEN
       - A: register community stdio MCP @delorenj/mcp-server-trello (third-party — vet first)
       - B: no MCP registration; the generic HTTP/REST tool layer reads the env vars
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Smoke test: GET /1/members/me/boards from inside the container — expect 200

Authenticated user: @$USERNAME
Tokens are NEVER printed in plaintext beyond last 4 chars.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TRELLO_API_KEY '$TRELLO_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TRELLO_TOKEN '$TRELLO_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(TRELLO_API_KEY=[a-f0-9]{32}|TRELLO_TOKEN=[a-f0-9]+)$' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "2" ] || { echo "FAIL: secrets did not land (got $COUNT, need 2). Rolling back."; rollback; exit 1; }
echo "Trello secrets confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use the safe sed pattern (pipe delimiter — keys
> are hex but the universal rule applies):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'TRELLO_API_KEY=$TRELLO_API_KEY' 'TRELLO_TOKEN=$TRELLO_TOKEN'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path B (default — generic REST, no third-party code in trust path)

```bash
if [ "${WIRE_PATH:-B}" = "B" ]; then
  echo "Path B chosen: REST API base https://api.trello.com/1"
  echo "Generic HTTP/tool layer reads TRELLO_API_KEY + TRELLO_TOKEN from env."
  echo "No 'hermes mcp add' required — env vars alone suffice for REST-tool capability."
fi
```

Common calls (for documentation; the agent's REST tool layer makes these):
```bash
# List my boards
# GET https://api.trello.com/1/members/me/boards?fields=name,id,url&key=$TRELLO_API_KEY&token=$TRELLO_TOKEN

# List cards on a list
# GET https://api.trello.com/1/lists/<LIST_ID>/cards?key=$TRELLO_API_KEY&token=$TRELLO_TOKEN

# Create a card
# POST https://api.trello.com/1/cards?idList=<LIST_ID>&name=<TITLE>&key=...&token=...

# Move a card
# PUT https://api.trello.com/1/cards/<CARD_ID>?idList=<NEW_LIST_ID>&key=...&token=...
```

### Path A (opt-in — community stdio MCP)

```bash
if [ "${WIRE_PATH:-B}" = "A" ]; then
  echo "Path A chosen: community stdio MCP @delorenj/mcp-server-trello"
  echo "WARN: third-party package; vet the source at https://github.com/delorenj/mcp-server-trello before granting write scope."

  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add trello \
      --command 'bunx' \
      --args '-y,@delorenj/mcp-server-trello' \
      --env 'TRELLO_API_KEY=\${TRELLO_API_KEY},TRELLO_TOKEN=\${TRELLO_TOKEN}'
  "
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

## Step 8 — verify (poll logs for Path A; REST-ready for Path B)

```bash
if [ "${WIRE_PATH:-B}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE 'registered.*trello|MCP server.*trello'; then
      REGISTERED=1
      echo "OK: trello stdio MCP registered."
      break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: trello MCP not in logs after 30s. Rolling back."; rollback; exit 1; }
else
  echo "Path B: no MCP registration to verify. Smoke test next."
fi
```

---

## Step 9 — live API smoke test (from inside the container)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    \"https://api.trello.com/1/members/me/boards?key=\$TRELLO_API_KEY&token=\$TRELLO_TOKEN&fields=id,name\"
")
case "$HTTP" in
  200) echo "OK: Trello API reachable from VPS, credentials in env work." ;;
  401) echo "FAIL: token rejected (401). Re-check Step 5."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP. Check manually." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-B}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove trello 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^TRELLO_API_KEY=/d;
            /^TRELLO_TOKEN=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Trello unwired. Revoke the token at https://trello.com/<username>/account → Allowed accounts if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Token minted with `scope=read` when write actions needed | Card create/move return 401 `unauthorized token permissions` | Default `scope=read,write` in the authorize URL; document the tradeoff |
| 2 | `expiration=never` token leaked = forever-leak until manually revoked | Convenience vs blast radius | Use `30days` and re-mint via `/hermes-cron`; revoke at `trello.com/<username>/account` |
| 3 | Key without token | The 32-char API key alone authenticates almost nothing user-scoped | Step 3 requires BOTH and verifies via `/members/me` |
| 4 | Rate limits (300/10s per key, 100/10s per token) | Bursty card updates 429 | Batch reads; back off on 429 |
| 5 | Claiming Atlassian Remote MCP covers Trello | It doesn't — only Jira/Confluence/JSM/Bitbucket/Compass | Documented in the auth picture; this skill uses community stdio (A) or REST (B) |
| 6 | Trusting `@delorenj/mcp-server-trello` write scope without review | Community package; arbitrary code | Path A is opt-in (`WIRE_PATH=A`); default is Path B |
| 7 | Board / list IDs vs names | API calls take 24-char object IDs, not human names | Resolve via `/members/me/boards` first; cache IDs |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | Tokens in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 11 | sed with `/` delimiter | Universal rule — Trello tokens are hex but future fields may not be | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Webhook flow confused with API token flow | Trello webhooks (`POST /webhooks`) are a separate auth path | This skill only wires the polling/REST API; ignore webhook secret |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if both vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: `TRELLO_API_KEY` is 32-char hex; `TRELLO_TOKEN` is 40-128 char hex; live `/members/me` returned a username
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `TRELLO_API_KEY` + `TRELLO_TOKEN` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Wire path chosen: B (REST, default) or A (community stdio MCP) — A is opt-in via `WIRE_PATH=A`
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] If Path A: logs show `registered N tool(s) for 'trello'` within 30s
- [ ] Smoke test: `GET /1/members/me/boards` from inside the container returned `200`
- [ ] Rollback function defined (wipes both env vars, recommends revoking token via Trello UI)
- [ ] User informed that no first-party MCP exists and that any community server is unvetted

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP
failure modes.
