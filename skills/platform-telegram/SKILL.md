---
name: platform-telegram
description: Wire a remote Hermes Agent to Telegram (BotFather token + numeric user-ID allowlist) over SSH. The most reliable headless platform — pure env-vars, no QR, no OAuth. Enforces a hard allowlist gate and a Telegram API token verification before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-telegram — wire Telegram to a remote Hermes (SSH-first, the reliable wedge)

You are the engineer connecting Telegram to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Talk to **@BotFather** in Telegram to create a bot and copy its token (`digits:letters`).
2. Talk to **@userinfobot** to find their own numeric user ID for the allowlist.

Everything else — token storage, allowlist gate, Telegram API verification, gateway reload,
post-setup nudge, smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest picture (verified 2026-06):** Telegram is the most reliable headless platform for
Hermes. No QR pairing, no Meta dev account, no OAuth dance, no rate-limit chaos. Just two
env vars + one gateway restart. The only common failure modes are operator mistakes
(allowlist using @handle instead of numeric ID, token truncated at the colon, group IDs
without the leading negative sign).

**Why the hard allowlist matters:** Hermes Telegram refuses messages from non-allowlisted
users by default — that's the safe behavior. But if an operator runs `TELEGRAM_ENABLED=true`
WITHOUT setting the allowlist, the same default means **nobody can talk to the bot, including
the operator** — looks like a silent crash. This skill refuses to enable until at least one
numeric user ID is set.

**The post-setup nudge:** First-time Telegram setup typically requires one extra
`gateway stop && gateway run` cycle after enabling. Hermes registers the bot, then needs to
fully reload its event loop before the first message routes correctly. This skill bakes
that in.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TELEGRAM_BOT_TOKEN` | Full token in form `<digits>:<letters>` | Telegram → @BotFather → `/newbot` → name + username (must end in `bot`) → copy token |
| `$TELEGRAM_ALLOWED_USERS` | Comma-separated numeric Telegram user IDs (NOT @handles) | Telegram → @userinfobot → it replies with the numeric ID |
| `$TELEGRAM_HOME_CHANNEL` *(optional)* | Numeric chat ID for cron pings (groups are negative: `-100...`) | For DMs: same as user ID. For groups: add @userinfobot to the group, then it sends the group's ID |
| `$TELEGRAM_ALLOWED_CHATS` *(optional)* | Comma-separated chat IDs the bot may post to | Useful when the bot is in a group; otherwise the allowlist user IDs are enough |

If `$TELEGRAM_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TELEGRAM_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^TELEGRAM_BOT_TOKEN=[0-9]+:.+' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^TELEGRAM_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'TELEGRAM_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Telegram already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + token format + Telegram API validation)

```bash
if [ -z "${TELEGRAM_ALLOWED_USERS:-}" ]; then
  echo "ABORT: TELEGRAM_ALLOWED_USERS is empty. Hermes Telegram default-denies all users."
  echo "Even the operator could not talk to the bot. Supply your numeric Telegram user ID."
  echo "Get yours by messaging @userinfobot in Telegram."
  exit 1
fi

# Telegram user IDs are integers (positive); group/channel IDs are negative.
INVALID=$(printf '%s' "$TELEGRAM_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^-?[0-9]+$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid Telegram user IDs (must be integers, optionally negative for groups):"
  echo "$INVALID"
  echo "Common mistake: pasted @username instead of numeric ID from @userinfobot."
  exit 1
fi

# Token format: BotFather tokens are <digits>:<alphanumeric+_-> — at least 35 chars total.
printf '%s' "$TELEGRAM_BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]{30,}$' \
  || { echo "ABORT: TELEGRAM_BOT_TOKEN format wrong. Expected <digits>:<letters>. Did you copy only the part before the colon?"; exit 1; }

# Live API check via getMe — proves the token is real and the bot exists.
ME=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS --max-time 10 'https://api.telegram.org/bot\$TELEGRAM_BOT_TOKEN/getMe'
" 2>/dev/null) || true
USERNAME=$(printf '%s' "$ME" | grep -oE '"username":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$USERNAME" ] || { echo "ABORT: Telegram API rejected the token (or no network). Re-check the token from @BotFather."; exit 1; }
echo "Token OK: bot is @$USERNAME"
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$TELEGRAM_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write TELEGRAM_BOT_TOKEN (length ${#TELEGRAM_BOT_TOKEN}, bot @$USERNAME) via 'hermes config set'
  2. Write TELEGRAM_ALLOWED_USERS ($USERS_N user(s))
  3. Write TELEGRAM_HOME_CHANNEL (${TELEGRAM_HOME_CHANNEL:-none}) if supplied
  4. Write TELEGRAM_ALLOWED_CHATS (${TELEGRAM_ALLOWED_CHATS:-none}) if supplied
  5. chmod 600 ~/.hermes/.env
  6. Verify secrets landed (grep -c)
  7. ONLY NOW: TELEGRAM_ENABLED=true (gated on Step 3 validation)
  8. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  9. POST-SETUP NUDGE: a second stop+run cycle 10s later (Telegram quirk on first wire-up)
 10. Verify connection via getMe + log scan
 11. Smoke test: allowlisted user DMs the bot; expect reply within 5s

Token is NEVER printed in plaintext beyond a length + bot @handle.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets first (NOT enable yet)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_BOT_TOKEN '$TELEGRAM_BOT_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_ALLOWED_USERS '$TELEGRAM_ALLOWED_USERS'"
if [ -n "${TELEGRAM_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_HOME_CHANNEL '$TELEGRAM_HOME_CHANNEL'"
fi
if [ -n "${TELEGRAM_ALLOWED_CHATS:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_ALLOWED_CHATS '$TELEGRAM_ALLOWED_CHATS'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify secrets landed (returns the count, NEVER the values):

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(TELEGRAM_BOT_TOKEN=[0-9]|TELEGRAM_ALLOWED_USERS=.|TELEGRAM_HOME_CHANNEL=.|TELEGRAM_ALLOWED_CHATS=.)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 2 ] || { echo "FAIL: secrets did not land (got $COUNT, need ≥2). Rolling back."; rollback; exit 1; }
echo "Telegram secrets confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use the safe sed pattern (pipe delimiter — the
> token contains `:` which is fine with `\|`, and the universal rule prevents future bugs):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN' 'TELEGRAM_ALLOWED_USERS=$TELEGRAM_ALLOWED_USERS'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the bot token in `config.yaml`.

---

## Step 6 — enable Telegram (only after Step 5 verification passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 7 — reload + post-setup nudge (Telegram first-wire-up quirk)

```bash
# Initial reload
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 10

# Post-setup nudge — many first-time setups need a second cycle for the bot
# event loop to fully register. Cheap insurance.
echo "Post-setup nudge: cycling gateway once more (Telegram first-wire-up quirk)..."
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify Telegram is connected (poll up to 30s)

Two checks: (1) Telegram API confirms the bot identity matches; (2) Hermes logs show the
bot is connected.

```bash
# Re-confirm getMe still works
ME=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS --max-time 10 'https://api.telegram.org/bot\$TELEGRAM_BOT_TOKEN/getMe'
" 2>/dev/null) || true
printf '%s' "$ME" | grep -q '"ok":true' \
  || { echo "FAIL: Telegram API getMe no longer succeeds. Rolling back."; rollback; exit 1; }

# Hermes log scan
CONNECTED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE 'telegram.*(connected|ready|long.?poll|webhook)'; then
    CONNECTED=1
    echo "OK: Telegram connected (bot @$USERNAME)."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Telegram did not appear in gateway logs within 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (DM from an allowlisted user)

```bash
FIRST_USER=$(printf '%s' "$TELEGRAM_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Telegram user ($FIRST_USER):
  1. Open Telegram; find @$USERNAME (the bot).
  2. Send "hello".
  3. The bot should reply within 5s.

If silent on first message:
  - Sometimes the first message is dropped during long-poll initialization
  - Send a second message — it should land
  - If still silent: 'hermes gateway status' on the VPS; confirm the user ID is numeric
EOF

ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -i telegram" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set TELEGRAM_ENABLED false 2>/dev/null || \
    sed -i 's|^TELEGRAM_ENABLED=true|TELEGRAM_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Telegram disabled. Token + allowlist preserved."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^TELEGRAM_BOT_TOKEN=/d;
            /^TELEGRAM_ALLOWED_USERS=/d;
            /^TELEGRAM_HOME_CHANNEL=/d;
            /^TELEGRAM_ALLOWED_CHATS=/d;
            /^TELEGRAM_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. All Telegram config wiped. Next /platform-telegram starts fresh."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `TELEGRAM_ALLOWED_USERS` | Gateway default-denies; nobody (including operator) can talk to the bot | Step 3 hard-abort; Step 6 only after Step 5 verification |
| 2 | Allowlist using @handle instead of numeric ID | Allowlist matcher is integer-equality on the user's `id` | Step 3 validator requires `^-?[0-9]+$` |
| 3 | Token truncated at the colon | Token is `<digits>:<letters>` — colon is part of the secret | Step 3 regex requires `[0-9]+:[A-Za-z0-9_-]{30,}` |
| 4 | First message dropped after enable | Long-poll initializer not warm yet | Step 7 nudge (second stop+run cycle); Step 9 says "send a second message" |
| 5 | Group ID without leading `-` (or missing `-100` prefix for supergroups) | Telegram sends from groups as negative IDs; matcher fails | Add @userinfobot to the group → it sends the correct negative ID |
| 6 | `gateway restart` instead of `stop`+`run` | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 7) |
| 7 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the documented sed pattern |
| 8 | Token in `config.yaml` | Often checked into git; tokens exposed | Only `~/.hermes/.env`, `chmod 600` |
| 9 | Token revoked in @BotFather without redeploy | Old token in `.env` keeps failing on `getMe` | Rotate token → re-run with `FORCE=1` |
| 10 | Bot username doesn't end in `bot` | @BotFather rejects username; user gets stuck before this skill runs | Tell user up front; @BotFather error is self-explanatory |
| 11 | sed with `/` delimiter on token | Token contains `:` which doesn't break sed, but the universal rule prevents future bugs | Always `\|` delimiter |
| 12 | Webhook mode left over from a prior install | Telegram refuses long-poll if a webhook is registered | `curl https://api.telegram.org/bot<TOKEN>/deleteWebhook` if Step 8 log shows webhook errors |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + token + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every ID matches `^-?[0-9]+$`; token matches `^[0-9]+:[A-Za-z0-9_-]{30,}$`
- [ ] Live Telegram `getMe` API call returned the bot's `@username`
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Secrets written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `TELEGRAM_ENABLED=true` set ONLY after Step 5 verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart) — TWICE (initial + nudge)
- [ ] Second `getMe` post-reload still returns OK
- [ ] Telegram connect confirmed in gateway log within 30s
- [ ] Live smoke: allowlisted user DM'd @$USERNAME and got a reply (possibly on 2nd message)
- [ ] Rollback function defined (`rollback`: disable + keep token; `hard_rollback`: wipe everything)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
allowlist, and Telegram long-poll failure modes.
