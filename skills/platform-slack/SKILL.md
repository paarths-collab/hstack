---
name: platform-slack
description: Wire a remote Hermes Agent to Slack via Socket Mode (no public endpoint, no signing secret) over SSH. Enforces a hard allowlist gate before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-slack — wire Slack to a remote Hermes (SSH-first, Socket Mode)

You are the engineer connecting Slack to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does three things a machine cannot:

1. Create the Slack app and enable Socket Mode (one-time, in the Slack admin UI).
2. Copy the bot token (`xoxb-...`) and app token (`xapp-...`) and supply them once.
3. Invite the bot into the target channel (`/invite @YourBot`) — proactive delivery silently
   fails otherwise.

Everything else — token storage, allowlist gate, MCP wiring, gateway reload, verification —
runs on the VPS via SSH, idempotently with a rollback path.

**Honest picture (verified 2026-06):** Hermes uses Slack **Socket Mode**, NOT the HTTP Events
API. That means: no public URL, no request-signing secret, no inbound webhook reachable from
the internet. The agent holds an outbound WebSocket to Slack and receives events that way.
Trade-off: Socket Mode apps are easier to self-host but cannot be distributed to multiple
workspaces — they live in one workspace per install.

**Why the hard allowlist matters:** Without `SLACK_ALLOWED_USERS`, anyone in the workspace
the bot is invited to can DM it and burn tokens / leak memory. This skill refuses to enable
Slack until at least one Member ID (`U...`) is set.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SLACK_BOT_TOKEN` | Bot User OAuth Token, `xoxb-...` | Slack app → OAuth & Permissions → Install App → Bot User OAuth Token |
| `$SLACK_APP_TOKEN` | App-Level Token for Socket Mode, `xapp-...` | Slack app → Basic Information → App-Level Tokens → Generate, scope `connections:write` |
| `$SLACK_ALLOWED_USERS` | Comma-separated Slack Member IDs (`U...`) — NOT @handles | In Slack: click your name → 3-dot menu → Copy member ID |
| `$SLACK_HOME_CHANNEL` *(optional)* | Channel ID (`C...`) for cron pings / nightly summaries | In Slack: right-click channel → Copy link → ID is the last path segment |

Required scopes on the bot token (configured in Slack app → OAuth & Permissions):
`chat:write`, `channels:history`, `groups:history`, `im:history`, `im:write`, `files:read`,
plus event subscriptions for `message.im`, `message.channels`, `app_mention`.

If `$SLACK_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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

Expected: `0.15.x` or `0.17.x`. Prefer absolute `~/.local/bin/hermes` to dodge SSH PATH issues.

---

## Step 2 — idempotency check (skip if already wired and healthy)

```bash
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SLACK_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_BOT=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SLACK_BOT_TOKEN=xoxb-' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_APP=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SLACK_APP_TOKEN=xapp-' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^SLACK_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'SLACK_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_BOT" = "1" ] && [ "$HAS_APP" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Slack already wired (enabled, both tokens, allowlist set). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD ALLOWLIST + TOKEN-FORMAT GATE (refuse on bad input)

```bash
if [ -z "${SLACK_ALLOWED_USERS:-}" ]; then
  echo "ABORT: SLACK_ALLOWED_USERS is empty. Slack would fail OPEN — any workspace user could DM the bot."
  echo "Supply Member IDs (start with 'U'), comma-separated. Example: U012ABCDE,U034FGHIJ"
  exit 1
fi

# Validate every entry looks like a Slack Member ID: starts with U, 9-15 alphanum.
INVALID=$(printf '%s' "$SLACK_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && (!/^U[A-Z0-9]{8,14}$/) { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid Member IDs (must start with U, 9-15 alphanumerics):"
  echo "$INVALID"
  exit 1
fi

# Token-format check: bot must be xoxb-, app must be xapp-.
printf '%s' "$SLACK_BOT_TOKEN" | grep -q '^xoxb-' \
  || { echo "ABORT: SLACK_BOT_TOKEN must start with 'xoxb-'."; exit 1; }
printf '%s' "$SLACK_APP_TOKEN" | grep -q '^xapp-' \
  || { echo "ABORT: SLACK_APP_TOKEN must start with 'xapp-' (Socket Mode requires the app token, not signing secret)."; exit 1; }

# Home channel (if set) must be a channel ID, not a #name.
if [ -n "${SLACK_HOME_CHANNEL:-}" ]; then
  printf '%s' "$SLACK_HOME_CHANNEL" | grep -qE '^[CG][A-Z0-9]{8,}' \
    || { echo "ABORT: SLACK_HOME_CHANNEL must be a channel ID like C012ABCDE (right-click channel → Copy link), not '#name'."; exit 1; }
fi
echo "Allowlist + tokens OK."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$SLACK_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write SLACK_BOT_TOKEN (length ${#SLACK_BOT_TOKEN}, prefix xoxb-) via 'hermes config set'
  2. Write SLACK_APP_TOKEN (length ${#SLACK_APP_TOKEN}, prefix xapp-) via 'hermes config set'
  3. Write SLACK_ALLOWED_USERS ($USERS_N Member ID(s)) via 'hermes config set'
  4. Write SLACK_HOME_CHANNEL (${SLACK_HOME_CHANNEL:-none}) if supplied
  5. chmod 600 ~/.hermes/.env
  6. Verify all four landed (grep -c)
  7. ONLY NOW: SLACK_ENABLED=true (gated on allowlist + token verification)
  8. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  9. Verify Socket Mode connect in logs: grep -i "slack.*socket.*connected"
 10. Smoke test: live DM from an allowlisted Member; expect a reply within 5s

Tokens are NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets first (NOT enable yet)

Order matters: secrets + allowlist before enable, with a verification gate between.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_BOT_TOKEN '$SLACK_BOT_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_APP_TOKEN '$SLACK_APP_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_ALLOWED_USERS '$SLACK_ALLOWED_USERS'"
if [ -n "${SLACK_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_HOME_CHANNEL '$SLACK_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify all four (returns the count, NEVER the values):

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(SLACK_BOT_TOKEN=xoxb-|SLACK_APP_TOKEN=xapp-|SLACK_ALLOWED_USERS=.|SLACK_HOME_CHANNEL=[CG])' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 3 ] || { echo "FAIL: secrets did not land (got $COUNT, need ≥3). Rolling back."; rollback; exit 1; }
echo "Slack secrets confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, fall back to the safe sed pattern. The `|`
> delimiter is mandatory — Slack tokens contain `/` and `+`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN' 'SLACK_APP_TOKEN=$SLACK_APP_TOKEN' 'SLACK_ALLOWED_USERS=$SLACK_ALLOWED_USERS'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>` (merge risk). Never put tokens in `config.yaml`.

---

## Step 6 — enable Slack (only after Step 5 verification passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

BOTH=$(ssh "$VPS_USER@$VPS_IP" "
  grep -c '^SLACK_ENABLED=true' ~/.hermes/.env;
  grep -E '^SLACK_ALLOWED_USERS=.+' ~/.hermes/.env | grep -cv 'SLACK_ALLOWED_USERS=\$'
")
echo "$BOTH" | grep -q '^1$' || { echo "FAIL: enable + allowlist not both set. Rolling back."; rollback; exit 1; }
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify Socket Mode is connected (poll up to 30s)

```bash
CONNECTED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE 'slack.*(socket|connected|ready)|"team":"T[A-Z0-9]'; then
    CONNECTED=1
    echo "OK: Slack Socket Mode connected."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Slack did not connect within 30s. Check token scopes. Rolling back."; rollback; exit 1; }
```

Typical reasons connection fails:
- `not_authed` → bot token wrong / app uninstalled from workspace
- `invalid_auth` → app token wrong / missing `connections:write` scope
- `account_inactive` → workspace billing issue or app reinstall pending

---

## Step 9 — live smoke test (DM from an allowlisted member)

There is no agent-only smoke path for Slack — a real workspace member must send a DM.

```bash
FIRST_USER=$(printf '%s' "$SLACK_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Slack member $FIRST_USER:
  1. Open Slack in the workspace where the app is installed.
  2. Open a DM with the bot ("Apps" sidebar → find your app).
  3. Send "ping".
  4. The bot should reply within 5s.

If no reply:
  - Check 'hermes logs gateway -n 50' for Slack errors
  - Confirm the bot was invited to any channels you want it to post in (/invite @YourBot)
  - Confirm your Member ID is in SLACK_ALLOWED_USERS exactly (starts with U)
EOF

# Tail recent gateway log for the first incoming message:
ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -iE 'slack'" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set SLACK_ENABLED false 2>/dev/null || \
    sed -i 's|^SLACK_ENABLED=true|SLACK_ENABLED=false|' ~/.hermes/.env"
  # Keep tokens + allowlist — they're not the safety problem.
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Slack disabled. Tokens preserved for retry."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SLACK_BOT_TOKEN=/d;
            /^SLACK_APP_TOKEN=/d;
            /^SLACK_ALLOWED_USERS=/d;
            /^SLACK_HOME_CHANNEL=/d;
            /^SLACK_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. All Slack config wiped."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `SLACK_ENABLED=true` before allowlist | Bot fails OPEN — any workspace user can DM, burning tokens | Step 3 hard-gate; Step 6 only fires after Step 5 verification |
| 2 | Adding a signing secret | Signing secret is for HTTP Events API; Hermes uses Socket Mode | Don't set one. Only `xoxb-` + `xapp-` are needed |
| 3 | Missing `connections:write` scope on app token | Socket Mode WebSocket refuses to connect | Step 8 fail mode "invalid_auth" → regenerate app token with the scope |
| 4 | Bot not invited to a channel | Proactive `chat.postMessage` to that channel silently no-ops | `/invite @YourBot` in every target channel |
| 5 | Home channel set to `#name` instead of `C...` ID | Resolver fails; cron pings never arrive | Step 3 validator requires `C...` or `G...` prefix |
| 6 | Allowlist using `@handle` instead of Member ID | Allowlist matcher is exact-string on `U...` IDs | Step 3 validator requires Member ID format |
| 7 | Using `/sethome` slash command | Slack namespaces slash commands; conflicts with workspace commands | Use `/hermes sethome` instead |
| 8 | Reinstalling app without rotating tokens | New install invalidates old `xoxb-` | Always regenerate `xoxb-` after reinstall; re-run /platform-slack with `FORCE=1` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` instead of `config set` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the documented sed pattern |
| 11 | Tokens in `config.yaml` | Often checked into git; tokens exposed | Only `~/.hermes/.env`, `chmod 600` |
| 12 | Socket Mode app distributed to multiple workspaces | Socket Mode = single-workspace only | If you need multi-workspace, switch to HTTP Events API (different skill) |
| 13 | Container vs host confusion | `hermes` inside a container is invisible to host SSH | Step 1 detects both via `docker ps` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + both tokens + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty, every Member ID matches `U[A-Z0-9]{8,14}`, tokens have `xoxb-` / `xapp-` prefix
- [ ] Home channel (if set) matches `C...` or `G...` (not `#name`)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3-4 secrets written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `SLACK_ENABLED=true` set ONLY after secrets + allowlist verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Socket Mode connection confirmed in gateway log within 30s
- [ ] Live smoke: allowlisted member DM'd the bot and got a reply
- [ ] Bot invited to at least one channel where proactive delivery is needed (operator step)
- [ ] Rollback function defined (`rollback`: disable + keep tokens; `hard_rollback`: wipe everything)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, allowlist,
and Socket Mode failure modes.
