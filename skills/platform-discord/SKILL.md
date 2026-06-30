---
name: platform-discord
description: Wire a remote Hermes Agent to Discord (bot token + the two required privileged intents + allowlist) over SSH. Enforces a hard allowlist gate and verifies both intents are toggled before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-discord — wire Discord to a remote Hermes (SSH-first)

You are the engineer connecting Discord to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does four things a machine cannot:

1. Create the application + bot in the Discord Developer Portal and copy the token.
2. Toggle the **two** Privileged Gateway Intents (Message Content + Server Members).
3. Invite the bot to their server via the OAuth2 URL with the `bot` scope.
4. Copy their Discord User ID (Developer Mode → right-click self → Copy ID) for the allowlist.

Everything else — token storage, intent self-check, allowlist gate, gateway reload,
verification — runs on the VPS via SSH, idempotently with a rollback path.

**Honest picture (verified 2026-06):** Discord bots silently misbehave when intents are
wrong: the bot connects, shows green, but cannot read message content (no `Message Content
Intent`) or resolve usernames (no `Server Members Intent`). Both must be toggled in the
Developer Portal AND requested by the client. This skill verifies the toggle via a
Discord API call BEFORE enabling, so failures surface in setup, not at first message.

**Why the hard allowlist matters:** Without `DISCORD_ALLOWED_USERS`, anyone in any server
the bot is invited to can DM/mention it and burn tokens. This skill refuses to enable
Discord until at least one User ID is set.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$DISCORD_BOT_TOKEN` | Bot token | Discord Developer Portal → Your App → Bot → Reset Token |
| `$DISCORD_ALLOWED_USERS` | Comma-separated Discord User IDs (17-19 digit snowflakes) | In Discord: Settings → Advanced → Developer Mode ON → right-click your name → Copy ID |
| `$DISCORD_HOME_CHANNEL` *(optional)* | Channel ID (snowflake) for cron pings | Right-click channel → Copy ID (Developer Mode) |
| `$DISCORD_AUTO_THREAD` *(optional)* | `true` / `false` (default `false`) — replies in a thread vs in-channel | Set to `false` if user wants replies in the same channel |
| `$DISCORD_REQUIRE_MENTION` *(optional)* | `true` / `false` (default `false`) — only reply when @-mentioned | Set to `true` for shared servers |

If `$DISCORD_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^DISCORD_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^DISCORD_BOT_TOKEN=.' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^DISCORD_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'DISCORD_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Discord already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + token + intent verification via Discord API)

```bash
if [ -z "${DISCORD_ALLOWED_USERS:-}" ]; then
  echo "ABORT: DISCORD_ALLOWED_USERS is empty. Discord would fail OPEN — anyone in any invited server could talk to the bot."
  exit 1
fi

# Discord User IDs are 17-19 digit snowflakes.
INVALID=$(printf '%s' "$DISCORD_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^[0-9]{17,19}$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid Discord User IDs (must be 17-19 digit snowflakes):"
  echo "$INVALID"
  exit 1
fi

# Token sanity: Discord bot tokens have the pattern <base64>.<base64>.<base64>
[ "${#DISCORD_BOT_TOKEN}" -ge 50 ] \
  || { echo "ABORT: DISCORD_BOT_TOKEN looks too short (<50 chars). Did you paste the right token?"; exit 1; }

# Intent self-check: call GET /users/@me with the token, then GET /applications/@me
# to read flags. Bit 19 (=524288) = GATEWAY_MESSAGE_CONTENT_LIMITED is set only when
# the intent toggle is OFF in the Portal; bit 18 (=262144) similarly for Members.
APP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS --max-time 10 -H \"Authorization: Bot \$DISCORD_BOT_TOKEN\" \
    -H 'User-Agent: hstack-platform-discord/1.0' \
    'https://discord.com/api/v10/applications/@me' 2>/dev/null
" 2>/dev/null) || true
FLAGS=$(printf '%s' "$APP" | grep -oE '"flags":[0-9]+' | head -1 | cut -d: -f2)
NAME=$(printf '%s' "$APP" | grep -oE '"name":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$NAME" ] || { echo "ABORT: Discord API rejected the token. Did you paste a USER token instead of a BOT token? Or is the bot deleted?"; exit 1; }
echo "Token OK: $NAME (flags=$FLAGS)"
# The unprivileged intent flags (bit 19=524288 message content, bit 18=262144 members)
# being SET means the bot is in unverified/limited mode — i.e. intent toggle is OFF.
if [ -n "$FLAGS" ]; then
  if [ $(( FLAGS & 524288 )) -ne 0 ]; then
    echo "WARN: Message Content Intent appears DISABLED (limited flag set). Toggle it in Developer Portal."
  fi
  if [ $(( FLAGS & 262144 )) -ne 0 ]; then
    echo "WARN: Server Members Intent appears DISABLED (limited flag set). Toggle it in Developer Portal."
  fi
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$DISCORD_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write DISCORD_BOT_TOKEN (length ${#DISCORD_BOT_TOKEN}) via 'hermes config set'
  2. Write DISCORD_ALLOWED_USERS ($USERS_N user(s))
  3. Write DISCORD_HOME_CHANNEL (${DISCORD_HOME_CHANNEL:-none}) if supplied
  4. Set behavior keys in config.yaml: auto_thread=${DISCORD_AUTO_THREAD:-false}, require_mention=${DISCORD_REQUIRE_MENTION:-false}
  5. chmod 600 ~/.hermes/.env
  6. Verify secrets landed (grep -c)
  7. ONLY NOW: DISCORD_ENABLED=true (gated on Step 3 validation)
  8. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  9. Verify Discord WS connection in logs
 10. Smoke test: allowlisted user DMs / @-mentions the bot; expect reply

Token is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets first (NOT enable yet)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set DISCORD_BOT_TOKEN '$DISCORD_BOT_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set DISCORD_ALLOWED_USERS '$DISCORD_ALLOWED_USERS'"
if [ -n "${DISCORD_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set DISCORD_HOME_CHANNEL '$DISCORD_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

# Behavior keys land in config.yaml (not .env) — they're not secrets.
if [ -n "${DISCORD_AUTO_THREAD:-}" ] || [ -n "${DISCORD_REQUIRE_MENTION:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    grep -q '^discord:' ~/.hermes/config.yaml || printf '\ndiscord:\n' >> ~/.hermes/config.yaml
    # Append/update auto_thread + require_mention under discord:
    python3 -c \"
import yaml, sys
p='$HOME/.hermes/config.yaml'.replace('\\\$HOME','$HOME')
d=yaml.safe_load(open(p)) or {}
d.setdefault('discord', {})
d['discord']['auto_thread']='${DISCORD_AUTO_THREAD:-false}' in ('true','True','1')
d['discord']['require_mention']='${DISCORD_REQUIRE_MENTION:-false}' in ('true','True','1')
yaml.safe_dump(d, open(p,'w'), sort_keys=False)
\"  || echo 'WARN: could not auto-update config.yaml — edit manually if behavior keys needed.'
  "
fi
```

Verify secrets landed (returns the count, NEVER the values):

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(DISCORD_BOT_TOKEN=.|DISCORD_ALLOWED_USERS=.|DISCORD_HOME_CHANNEL=.)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 2 ] || { echo "FAIL: secrets did not land (got $COUNT, need ≥2). Rolling back."; rollback; exit 1; }
echo "Discord secrets confirmed in ~/.hermes/.env."
```

Never `echo >>`. Never put the bot token in `config.yaml`.

---

## Step 6 — enable Discord (only after Step 5 verification passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set DISCORD_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
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

## Step 8 — verify Discord WS connection (poll up to 30s)

```bash
CONNECTED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE 'discord.*(ready|connected|logged in as)|"user":{"id":"[0-9]+"'; then
    CONNECTED=1
    echo "OK: Discord WS connected."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Discord did not connect within 30s. Common causes: wrong token, bot deleted, IP banned. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (DM or @-mention from an allowlisted user)

```bash
FIRST_USER=$(printf '%s' "$DISCORD_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Discord user ($FIRST_USER):
  1. Open Discord; find the bot in a shared server (or your DMs after inviting it).
  2. Send "ping" — either as a DM or @-mention in a channel where the bot is present.
  3. The bot should reply within 5s.

If no reply:
  - Check 'hermes logs gateway -n 50 | grep -i discord' for handler errors
  - If the bot replies in a thread you didn't want: set DISCORD_AUTO_THREAD=false and re-run
  - If the bot only responds when @-mentioned: that's DISCORD_REQUIRE_MENTION=true — set to false for DM-style
  - Confirm Message Content Intent is ON in Developer Portal (Step 3 WARN if it was off)
EOF

ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -i discord" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set DISCORD_ENABLED false 2>/dev/null || \
    sed -i 's|^DISCORD_ENABLED=true|DISCORD_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Discord disabled. Token + allowlist preserved."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^DISCORD_BOT_TOKEN=/d;
            /^DISCORD_ALLOWED_USERS=/d;
            /^DISCORD_HOME_CHANNEL=/d;
            /^DISCORD_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. All Discord config wiped."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Message Content Intent OFF in Portal | Bot connects, shows green, but `message.content` is always empty — looks like Hermes is mute | Step 3 reads `flags` from `/applications/@me` and WARNs if the limited-flag bit is set |
| 2 | Server Members Intent OFF in Portal | Username resolution / DM allowlist matching fails | Step 3 WARNs separately for this intent |
| 3 | `DISCORD_ENABLED=true` before allowlist | Bot fails OPEN — anyone in any invited server can talk to it | Step 3 hard-gate; Step 6 only after Step 5 |
| 4 | Pasting a USER token instead of BOT token | API rejects with 401; bot never connects | Step 3 calls `/applications/@me` — token must work or hard-abort |
| 5 | `auto_thread: true` when user wants in-channel replies | Replies land in a new thread; user thinks the bot ignored them | Default `false` in dry-run; Step 9 troubleshooting calls it out |
| 6 | `require_mention: true` for DM use | Bot ignores DMs unless @-mentioned (which doesn't work in DMs) | Set to `false` for personal-assistant use; `true` only in shared servers |
| 7 | `DISCORD_ALLOW_BOTS` set without bot's own ID in allowlist | Setting is a no-op without the bot ID also allowed | Add the bot's User ID to `DISCORD_ALLOWED_USERS` if needed |
| 8 | Allowlist using `@username` instead of snowflake ID | Allowlist matcher is exact-string on the 17-19 digit ID | Step 3 validator requires snowflake format |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the documented sed pattern |
| 11 | Token in `config.yaml` | Often checked into git; tokens exposed | Only `~/.hermes/.env`, `chmod 600`; only behavior keys go in yaml |
| 12 | Token rotated in Portal without redeploy | Old token in `.env` keeps failing 401 | Rotate token → re-run with `FORCE=1` |
| 13 | Bot not invited to any server | WS connects but there's no place to talk; smoke test mute | Operator must run the OAuth2 URL with `bot` scope to invite |
| 14 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + token + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every ID is 17-19 digits; token ≥50 chars + accepted by Discord API
- [ ] Intent self-check ran via `/applications/@me`; warnings printed if either privileged intent is OFF
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Secrets written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Behavior keys (`auto_thread`, `require_mention`) written to `config.yaml` if supplied
- [ ] `DISCORD_ENABLED=true` set ONLY after Step 5 verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Discord WS connection confirmed in logs within 30s
- [ ] Live smoke: allowlisted user DM'd / @-mentioned the bot and got a reply
- [ ] Bot is invited to at least one server (operator-confirmed)
- [ ] Rollback function defined (`rollback`: disable + keep secrets; `hard_rollback`: wipe everything)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
intent, and Discord API failure modes.
