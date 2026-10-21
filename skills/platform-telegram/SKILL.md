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

**Where the commands run.** Every bash block below runs on YOUR machine (possibly macOS
with bash 3.2) and reaches the VPS through `remote()` (defined in Step 0). Run all blocks in
ONE shell session: later steps call `remote`, `snapshot`, `rollback`, `finish` and
`tg_username`. The bot token only ever travels over ssh **stdin**, never in an ssh argument,
a URL on a command line, or a quoted remote string.

**Honest picture (verified 2026-06):** Telegram is the most reliable headless platform for
Hermes. No QR pairing, no Meta dev account, no OAuth dance, no rate-limit chaos. Just two
env vars + one gateway restart. The only common failure modes are operator mistakes
(allowlist using @handle instead of numeric ID, token truncated at the colon, group IDs
without the leading negative sign).

**Why the hard allowlist matters:** Hermes Telegram refuses messages from non-allowlisted
users by default — that's the safe behavior. Upstream Hermes turns Telegram on as soon as
`TELEGRAM_BOT_TOKEN` is present (there is no `TELEGRAM_ENABLED` variable), so a token with
no `TELEGRAM_ALLOWED_USERS` means **nobody can talk to the bot, including the operator** —
looks like a silent crash. This skill refuses to write anything until at least one numeric
user ID is supplied, and writes the allowlist BEFORE the token.

**The post-setup nudge:** First-time Telegram setup typically requires one extra
`gateway stop && gateway run` cycle after enabling. Hermes registers the bot, then needs to
fully reload its event loop before the first message routes correctly. This skill bakes
that in.

**Env names: what is and is not verified (2026-10).** Checked against upstream Hermes'
env-var reference page: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`,
`TELEGRAM_HOME_CHANNEL`. The pin is Hermes `0.15.2`; those names were read from upstream
docs/`main`, not from a 0.15.2 build. Everything else this skill relies on is
**unverified** and is guarded by a check or a rollback:

- the claim that `TELEGRAM_BOT_TOKEN` alone enables the platform (read from upstream source);
- the `platforms.telegram.enabled` config key (Step 6);
- `hermes config set KEY -- value` (upstream documents `<key> <value> [--force]`; the `--`
  that protects negative chat IDs is unverified);
- `hermes logs gateway -n N` (Steps 8 and 9);
- the allow-all switch names `TELEGRAM_ALLOW_ALL_USERS` and `GATEWAY_ALLOW_ALL_USERS`, which
  the Step 3 gate refuses to run alongside (if the real names differ, that check cannot see them).

This skill never sets a group-wide allowlist: upstream's `TELEGRAM_GROUP_ALLOWED_CHATS`
authorizes every member of the listed groups, a wider grant than a per-user allowlist.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TELEGRAM_BOT_TOKEN` | Full token in form `<digits>:<letters>` | Telegram → @BotFather → `/newbot` → name + username (must end in `bot`) → copy token |
| `$TELEGRAM_ALLOWED_USERS` | Comma-separated numeric Telegram user IDs (NOT @handles) | Telegram → @userinfobot → it replies with the numeric ID |
| `$TELEGRAM_HOME_CHANNEL` *(optional)* | Numeric chat ID for cron pings (groups are negative: `-100...`) | For DMs: same as user ID. For groups: add @userinfobot to the group, then it sends the group's ID |

If `$TELEGRAM_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

Confirm SSH access (first connect: trust the host key once):

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was written."; exit 1; }
```

---

## Step 0 — helpers (define before anything can fail)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=platform-telegram
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
# A leftover snapshot means an earlier run wrote something and never finished or rolled
# back. Snapshotting now would capture that half-written state as "known good".
if [ -d "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$d" && chmod 700 "$HOME/.hermes/.hstack-backup" "$d"
for f in .env config.yaml; do
  rm -f "$d/$f" "$d/$f.absent"
  if [ -f "$HOME/.hermes/$f" ]; then cp -p "$HOME/.hermes/$f" "$d/$f"; else : > "$d/$f.absent"; fi
done
chmod 600 "$d"/* 2>/dev/null || true
REMOTE
}

# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), then reload the gateway.
rollback() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 0; }
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then cp -p "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then rm -f "$HOME/.hermes/$f"; fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
rm -rf "$d.prev"; mv "$d" "$d.prev"
hermes gateway stop || true; sleep 2; hermes gateway run --daemon || true
sleep 3
st=$(hermes gateway status 2>&1 || true)
if printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
  echo "rollback: files restored, but the gateway did NOT come back — start it manually (hermes gateway start) and check hermes logs"
  exit 1
fi
echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
REMOTE
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; rm -rf \"\$d.prev\"; [ -d \"\$d\" ] && mv \"\$d\" \"\$d.prev\"; true"
}

# tg_username: read a Telegram getMe JSON body on stdin; print the bot username,
# or print nothing unless the body says "ok": true. Never prints the token.
tg_username() {
  local body u
  body=$(cat)
  if command -v python3 >/dev/null 2>&1; then
    u=$(printf '%s' "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    print(d["result"]["username"] if d.get("ok") is True else "")
except Exception:
    print("")' 2>/dev/null)
  else
    u=""
    if printf '%s' "$body" | grep -Eq '"ok" *: *true'; then
      u=$(printf '%s' "$body" | tr -d '\n' | sed -n 's/.*"username" *: *"\([A-Za-z0-9_]*\)".*/\1/p')
    fi
  fi
  case "$u" in ''|*[!A-Za-z0-9_]*) u="" ;; esac
  printf '%s\n' "$u"
}
```

Rules used below: failures BEFORE `snapshot` (Steps 1–4) just `exit 1` with
"Nothing was written" and never call `rollback`. Every failure AFTER `snapshot`
(Steps 5–8) does `rollback; exit 1`.

**Unverified CLI surface.** Upstream's CLI docs list `hermes gateway run|start|stop|restart|status|install`. `hermes gateway run --daemon` is NOT in those docs: they are this repo's declared adapter surface, unverified against upstream. If a call fails with "unknown option/command", check `hermes gateway --help` on the VPS and adapt; the hard-gate and rollback logic does not depend on the exact flags.

---

## Step 1 — verify Hermes is reachable on the VPS

This skill writes the HOST's `~/.hermes/.env`, so `hermes` must be installed on the host
(not only inside a container).

```bash
remote 'command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  echo "Using: $(command -v hermes)"
  hermes --version' \
  || { echo "ABORT: Hermes is not installed on the host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

Upstream enables Telegram from the token alone, so "wired" means a token plus a non-empty
allowlist are already in `~/.hermes/.env`. The check prints counts only, never values.

```bash
STATE=$(remote 'f=$HOME/.hermes/.env
  t=$(grep -cE "^TELEGRAM_BOT_TOKEN=.?[0-9]+:" "$f" 2>/dev/null)
  a=$(grep -cE "^TELEGRAM_ALLOWED_USERS=.?[0-9]" "$f" 2>/dev/null)
  echo "${t:-0} ${a:-0}"; true') || STATE="0 0"
read -r HAS_TOKEN HAS_ALLOW <<<"$STATE"
if [ "${HAS_TOKEN:-0}" -ge 1 ] && [ "${HAS_ALLOW:-0}" -ge 1 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Telegram already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + token format + Telegram API validation)

Nothing has been written yet, so every failure here is a plain `exit 1`. The live check runs
FROM THE VPS (this also proves its egress to Telegram works) and uses the token you were
given, sent over ssh stdin as a curl config. It cannot use `~/.hermes/.env`: that file does
not hold the token until Step 5.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
TELEGRAM_ALLOWED_USERS=$(printf '%s' "${TELEGRAM_ALLOWED_USERS:-}" | csv_clean)
TELEGRAM_HOME_CHANNEL=$(printf '%s' "${TELEGRAM_HOME_CHANNEL:-}" | csv_clean)

if [ -z "$TELEGRAM_ALLOWED_USERS" ]; then
  echo "ABORT: TELEGRAM_ALLOWED_USERS is empty. Hermes Telegram default-denies all users."
  echo "Even the operator could not talk to the bot. Supply your numeric Telegram user ID."
  echo "Get yours by messaging @userinfobot in Telegram. Nothing was written."
  exit 1
fi

# A wildcard anywhere in the allowlist ("*", "555,*") would open the bot to everyone.
case "$TELEGRAM_ALLOWED_USERS" in
  *'*'*) echo "ABORT: TELEGRAM_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac

# check_ids NAME VALUE REGEX — every comma-separated entry must match REGEX.
check_ids() {
  local bad
  bad=$(printf '%s' "$2" | tr ',' '\n' | grep -vE "$3" | cut -c1-20 || true)
  if [ -n "$bad" ]; then
    echo "ABORT: invalid entries in $1:"
    echo "$bad"
    echo "Expected numeric IDs only (no @handles). Nothing was written."
    return 1
  fi
}
# User IDs are positive integers; chat IDs may be negative (groups, supergroups: -100...).
check_ids TELEGRAM_ALLOWED_USERS "$TELEGRAM_ALLOWED_USERS" '^[0-9]+$' || exit 1
if [ -n "$TELEGRAM_HOME_CHANNEL" ]; then check_ids TELEGRAM_HOME_CHANNEL "$TELEGRAM_HOME_CHANNEL" '^-?[0-9]+$' || exit 1; fi
if [ -n "$TELEGRAM_HOME_CHANNEL" ] && [ "$TELEGRAM_HOME_CHANNEL" != "${TELEGRAM_HOME_CHANNEL%%,*}" ]; then
  echo "ABORT: TELEGRAM_HOME_CHANNEL takes ONE chat ID. Nothing was written."; exit 1
fi

# Open-access switches already present on the VPS would make the allowlist meaningless.
# open_access_names prints NAMES only (never values). Fail-closed: any value other than an
# explicit false/0/no/off counts as on, and an unreadable .env aborts.
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
[ -f "$f" ] || exit 0
for n in TELEGRAM_ALLOW_ALL_USERS GATEWAY_ALLOW_ALL_USERS; do
  v=$(sed -n "s/^[[:space:]]*$n=//p" "$f" | tail -n1 | tr -d "\"' \r" | tr 'A-Z' 'a-z')
  case "$v" in ""|false|0|no|off) ;; *) echo "$n" ;; esac
done
REMOTE
}
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env on the VPS to check for allow-all switches. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)), so ANYONE could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

# Token charset first (also guarantees no quote, backslash or newline can reach the curl config).
case "${TELEGRAM_BOT_TOKEN:-}" in
  ''|*[!A-Za-z0-9_:-]*)
    echo "ABORT: TELEGRAM_BOT_TOKEN is empty or has characters a BotFather token never has. Nothing was written."
    exit 1 ;;
esac
# Token format: BotFather tokens are <digits>:<alphanumeric+_-> — at least 35 chars total.
printf '%s' "$TELEGRAM_BOT_TOKEN" | grep -qE '^[0-9]+:[A-Za-z0-9_-]{30,}$' \
  || { echo "ABORT: TELEGRAM_BOT_TOKEN format wrong. Expected <digits>:<letters>. Did you copy only the part before the colon? Nothing was written."; exit 1; }

# Live API check via getMe, from the VPS. The token rides ssh stdin as a curl config.
ME=$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_BOT_TOKEN" \
  | remote "curl -fsS --max-time 15 --config -" 2>/dev/null) || ME=""
USERNAME=$(printf '%s' "$ME" | tg_username)
[ -n "$USERNAME" ] || { echo "ABORT: Telegram getMe (run from the VPS) did not accept the token, or the VPS cannot reach api.telegram.org. Re-check the token from @BotFather. Nothing was written."; exit 1; }
echo "Token OK: bot is @$USERNAME"
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$TELEGRAM_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. Snapshot ~/.hermes/.env and config.yaml (restored automatically if anything below fails)
  1. Write TELEGRAM_ALLOWED_USERS ($USERS_N user(s)) via 'hermes config set' (value sent over ssh stdin)
  2. Write TELEGRAM_HOME_CHANNEL (${TELEGRAM_HOME_CHANNEL:-none}) if supplied
  3. Write TELEGRAM_BOT_TOKEN (length ${#TELEGRAM_BOT_TOKEN}, bot @$USERNAME) LAST, over ssh stdin
  4. chmod 600 ~/.hermes/.env; verify the keys landed (counts only)
  5. Set platforms.telegram.enabled true in config.yaml (the token alone enables Telegram upstream)
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. POST-SETUP NUDGE: a second stop+run cycle 10s later (Telegram quirk on first wire-up)
  8. Smoke test: read the token back from ~/.hermes/.env on the VPS, call getMe, scan logs
 9. Live test: allowlisted user DMs the bot; expect reply within 5s

Token is NEVER printed in plaintext beyond a length + bot @handle.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`). If the user declines: `echo "ABORT: declined. Nothing was written."; exit 1`.

---

## Step 5 — write secrets first (token LAST), then verify

The allowlist goes in before the token, because the token is what makes Hermes turn Telegram
on. Each value travels as ONE line on ssh stdin and is read by `read -r` on the VPS. The `--`
keeps values that start with `-` (negative chat IDs) from being parsed as options (that
`--` syntax is unverified against upstream, see the list at the top). The output of
`hermes config set` is discarded so Hermes can never echo a value into chat.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE — KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes config set $1 -- \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put TELEGRAM_ALLOWED_USERS "$TELEGRAM_ALLOWED_USERS" \
  || { echo "FAIL: could not write TELEGRAM_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$TELEGRAM_HOME_CHANNEL" ]; then
  put TELEGRAM_HOME_CHANNEL "$TELEGRAM_HOME_CHANNEL" \
    || { echo "FAIL: could not write TELEGRAM_HOME_CHANNEL."; rollback; exit 1; }
fi
put TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN" \
  || { echo "FAIL: could not write TELEGRAM_BOT_TOKEN."; rollback; exit 1; }
```

Verify the secrets landed (counts the keys, compares the non-secret allowlist, re-checks that no
wildcard or allow-all switch is present; NEVER prints the token):

```bash
COUNT=$(remote 'grep -cE "^(TELEGRAM_BOT_TOKEN|TELEGRAM_ALLOWED_USERS)=." ~/.hermes/.env 2>/dev/null; true')
GOT_USERS=$(remote 'sed -n "s/^TELEGRAM_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
if [ "$COUNT" != "2" ] || [ "$GOT_USERS" != "$TELEGRAM_ALLOWED_USERS" ]; then
  echo "FAIL: secrets did not land (key count $COUNT, need 2; allowlist match: no if different). Rolling back."
  rollback; exit 1
fi
case "$GOT_USERS" in
  *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;;
esac
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Telegram secrets confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use this stdin-based upsert for each key instead
> (the value still never touches an argument list; no `echo >>`):
> ```bash
> upsert() {  # upsert KEY VALUE
>   printf '%s\n' "$2" | remote "IFS= read -r v; f=\$HOME/.hermes/.env; touch \"\$f\"; chmod 600 \"\$f\"; \
>     V=\"\$v\" awk -v k='$1' 'BEGIN{v=ENVIRON[\"V\"]} index(\$0,k\"=\")==1{print k\"=\"v; d=1; next} {print} END{if(!d) print k\"=\"v}' \"\$f\" > \"\$f.tmp\" \
>     && cat \"\$f.tmp\" > \"\$f\" && rm -f \"\$f.tmp\""
> }
> ```

Never put the bot token in `config.yaml`.

---

## Step 6 — enable Telegram (only after Step 5 verification passed)

Upstream turns Telegram on from the token alone, **unless** `config.yaml` explicitly says
`platforms.telegram.enabled: false` (an explicit disable beats env credentials). Setting the flag
to `true` removes that trap. It is the only `config.yaml` edit, and it is covered by the snapshot.

```bash
remote "hermes config set platforms.telegram.enabled true && chmod 600 ~/.hermes/.env" \
  || echo "WARN: could not set platforms.telegram.enabled (the key itself is unverified). This is a WARN on purpose: upstream enables Telegram from the token alone unless config.yaml disables it, and Step 8 will tell if Telegram is not connected."
```

---

## Step 7 — reload + post-setup nudge (Telegram first-wire-up quirk)

```bash
# Initial reload
remote "hermes gateway stop || true"
sleep 2
remote "hermes gateway run --daemon" \
  || { echo "FAIL: gateway did not start. Rolling back."; rollback; exit 1; }
sleep 10

# Post-setup nudge — many first-time setups need a second cycle for the bot
# event loop to fully register. Cheap insurance.
echo "Post-setup nudge: cycling gateway once more (Telegram first-wire-up quirk)."
remote "hermes gateway stop || true"
sleep 2
remote "hermes gateway run --daemon" \
  || { echo "FAIL: gateway did not restart. Rolling back."; rollback; exit 1; }
sleep 5
```

---

## Step 8 — verify Telegram is connected (smoke test, poll up to 30s)

Two checks: (1) the token PERSISTED — it is read back from `~/.hermes/.env` on the VPS (the
non-interactive ssh shell never loads that file, so it is read explicitly) and `getMe` must
return the same bot as in Step 3; (2) Hermes logs show the bot is connected.

```bash
BODY=$(remote 'v=$(sed -n "s/^TELEGRAM_BOT_TOKEN=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  printf "url = \"https://api.telegram.org/bot%s/getMe\"\n" "$v" | curl -fsS --max-time 15 --config -' 2>/dev/null) || BODY=""
POST_USER=$(printf '%s' "$BODY" | tg_username)
if [ -z "$POST_USER" ] || [ "$POST_USER" != "$USERNAME" ]; then
  echo "FAIL: getMe with the token stored on the VPS did not return @$USERNAME. Rolling back."
  rollback; exit 1
fi

# Hermes log scan
CONNECTED=0
for i in $(seq 1 6); do
  if remote "hermes logs gateway -n 200 2>&1" \
       | grep -qiE 'telegram.*(connected|ready|long.?poll|webhook)'; then
    CONNECTED=1
    echo "OK: Telegram connected (bot @$USERNAME)."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Telegram did not appear in gateway logs within 30s. Rolling back."; rollback; exit 1; }

finish
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

# Redact first: a log line can contain the Bot API URL, which embeds the token.
remote "hermes logs gateway -n 50 2>&1" | sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot<redacted>#g' | grep -i telegram | tail -20 || true
```

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in **Step 0**. It restores the exact pre-run `~/.hermes/.env`
and `config.yaml` from `~/.hermes/.hstack-backup/platform-telegram/` (byte-for-byte), then
reloads the gateway (and checks `hermes gateway status`: if the gateway is not reported running it
prints `files restored, but the gateway did NOT come back` and exits non-zero, so start it by hand with
`hermes gateway start`). So a failed `FORCE=1` re-run puts the previous working token and
allowlist back; a failed first run removes the files this skill created. Failures in Steps
1–4 happen before the snapshot and change nothing.

After a successful run (`finish`) the snapshot is kept as `platform-telegram.prev` for a
manual undo. Both directories are `chmod 700` and hold secrets, so delete them when you no
longer need the undo:

```bash
# Manual undo of the last successful run, then reload:
remote "d=\$HOME/.hermes/.hstack-backup/platform-telegram.prev; cp -p \"\$d/.env\" ~/.hermes/.env && chmod 600 ~/.hermes/.env && hermes gateway stop; sleep 2; hermes gateway run --daemon"
# Forget the backup (it contains the previous secrets):
remote 'rm -rf ~/.hermes/.hstack-backup/platform-telegram.prev'
```

To remove Telegram entirely instead (destructive, only if the user asks):

```bash
remote 'sed -i "/^TELEGRAM_BOT_TOKEN=/d;/^TELEGRAM_ALLOWED_USERS=/d;/^TELEGRAM_HOME_CHANNEL=/d" ~/.hermes/.env && chmod 600 ~/.hermes/.env'
remote "hermes config set platforms.telegram.enabled false; hermes gateway stop; sleep 2; hermes gateway run --daemon"
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `TELEGRAM_ALLOWED_USERS` | Gateway default-denies; nobody (including operator) can talk to the bot | Step 3 hard-abort; allowlist written before the token in Step 5 |
| 2 | Allowlist using @handle instead of numeric ID | Allowlist matcher is integer-equality on the user's `id` | Step 3 validator requires `^[0-9]+$` per user ID |
| 3 | Token truncated at the colon | Token is `<digits>:<letters>` — colon is part of the secret | Step 3 regex requires `[0-9]+:[A-Za-z0-9_-]{30,}` |
| 4 | First message dropped after enable | Long-poll initializer not warm yet | Step 7 nudge (second stop+run cycle); Step 9 says "send a second message" |
| 5 | Group ID without leading `-` (or missing `-100` prefix for supergroups) | Telegram sends from groups as negative IDs; matcher fails | Add @userinfobot to the group → it sends the correct negative ID; `TELEGRAM_HOME_CHANNEL` accepts `^-?[0-9]+$` |
| 6 | `gateway restart` instead of `stop`+`run` | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 7) |
| 7 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the stdin upsert shown there |
| 8 | Token in `config.yaml` | Often checked into git; tokens exposed | Only `~/.hermes/.env`, `chmod 600` |
| 9 | Token revoked in @BotFather without redeploy | Old token in `.env` keeps failing on `getMe` | Rotate token → re-run with `FORCE=1`; if the new run fails, `rollback` restores the OLD working values |
| 10 | Bot username doesn't end in `bot` | @BotFather rejects username; user gets stuck before this skill runs | Tell user up front; @BotFather error is self-explanatory |
| 11 | Token in an ssh argument, URL on a command line, or a single-quoted remote string | Leaks into `ps`; breaks on odd characters; an escaped `\$VAR` inside a single-quoted remote URL is sent literally and always fails the check | The token goes over ssh stdin as a curl config (Step 3) or `read -r` (Step 5); the post-write check reads it back from `~/.hermes/.env` (Step 8) |
| 12 | Webhook mode left over from a prior install | Telegram refuses long-poll if a webhook is registered | If the Step 8 log shows webhook errors, call `deleteWebhook` from the VPS with the same stdin technique: `printf 'url = "https://api.telegram.org/bot%s/deleteWebhook"\n' "$TELEGRAM_BOT_TOKEN" \| remote "curl -fsS --max-time 15 --config -"` |
| 13 | Container vs host confusion | A container install reads its own `/opt/data/.env`, not the host's `~/.hermes/.env` | Step 1 requires `hermes` on the host and aborts otherwise |
| 14 | Looking for a `TELEGRAM_ENABLED` switch | It is not an upstream variable; the token enables the platform, and only `platforms.telegram.enabled: false` in `config.yaml` overrides that | Step 6 sets the `config.yaml` flag; do not write `TELEGRAM_ENABLED` |
| 15 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-telegram/` behind | `snapshot` refuses to run so a half-written state is never captured as known-good | Run `rollback` (restores the pre-crash files), then re-run the skill |
| 16 | `TELEGRAM_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS` on in `.env`, or a `*` in the allowlist (`555,*`) | Anyone can use the bot regardless of the allowlist | Step 3 aborts before any write and Step 5 re-checks after it (names only, values never printed); never set them with this skill; remove them if present |
| 17 | `hermes config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees it (the local ssh argv stays clean because values travel over stdin) | Accepted for the primary path; the stdin `upsert` fallback in Step 5 avoids it. Output of the write is discarded so Hermes can never echo a value into chat |
| 18 | Pasting gateway logs into chat | A log line can contain the Bot API URL, which embeds the bot token | Step 9 pipes logs through `sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot<redacted>#g'`; do the same for any log you show |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS host (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if token + allowlist already present, unless `FORCE=1`)
- [ ] HARD GATE passed with nothing written: allowlist non-empty, no `*` anywhere in it, every user ID matches `^[0-9]+$`; no allow-all switch (`TELEGRAM_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS`) in the VPS `.env`; token matches `^[0-9]+:[A-Za-z0-9_-]{30,}$`
- [ ] Live Telegram `getMe` (run from the VPS, token sent over ssh stdin) returned the bot's `@username`
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `TELEGRAM_ALLOWED_USERS` written before `TELEGRAM_BOT_TOKEN`; both in `~/.hermes/.env`, `chmod 600`, verified by count (no values printed), with the allowlist re-read and the open-access check repeated after the write
- [ ] `platforms.telegram.enabled` set only after Step 5 verification passed (no `TELEGRAM_ENABLED` variable)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart) — TWICE (initial + nudge)
- [ ] Post-reload `getMe` using the token READ BACK from `~/.hermes/.env` on the VPS returned the same bot
- [ ] Telegram connect confirmed in gateway log within 30s, then `finish` ran
- [ ] Live smoke: allowlisted user DM'd @$USERNAME and got a reply (possibly on 2nd message)
- [ ] Any failure after the snapshot ran `rollback` (Step 0) and restored the prior `.env` + `config.yaml`

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
allowlist, and Telegram long-poll failure modes.
