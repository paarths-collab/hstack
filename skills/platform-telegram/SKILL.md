---
name: platform-telegram
description: Wire a remote Hermes Agent v0.22.5 to Telegram (BotFather token + numeric user-ID allowlist) over SSH. Long polling, pure env vars, no QR or OAuth. Enforces a hard allowlist gate and a live Telegram getMe check before anything is written, reloads the gateway once natively, and rolls back to the previous values on any failure. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-telegram — wire Telegram to a remote Hermes (SSH-first, the reliable wedge)

You are the engineer connecting Telegram to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Talk to **@BotFather** in Telegram to create a bot and copy its token (`digits:letters`).
2. Talk to **@userinfobot** to find their own numeric user ID for the allowlist.

Everything else — token storage, allowlist gate, Telegram API verification, one native gateway reload,
connect verification from the gateway log, native smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Where the commands run.** Every bash block below runs on YOUR machine (possibly macOS
with bash 3.2) and reaches the VPS through `remote()` (defined in Step 0). Run all blocks in
ONE shell session: later steps call `remote`, `snapshot`, `rollback`, `finish` and
`tg_username`. The bot token only ever travels over ssh **stdin**, never in an ssh argument,
a URL on a command line, or a quoted remote string.

**Honest picture (source-verified against Hermes v0.22.5, not run live).** Telegram is the most reliable headless platform for
Hermes: no QR pairing, no Meta dev account, no OAuth dance. It is long polling driven by two env vars plus one gateway reload. The
common failure modes are operator mistakes (allowlist using @handle instead of numeric ID, token truncated at the colon, group IDs
without the leading negative sign) and a second process polling the same bot token. See "Verified against Hermes v0.22.5" at the
end for what was read in source and what is still unverified.

**Why the hard allowlist matters.** Upstream turns Telegram on as soon as `TELEGRAM_BOT_TOKEN` is present (there is no
`TELEGRAM_ENABLED` variable; `plugins/platforms/telegram/gateway_env.py:12-15`). Without an allowlist Hermes still denies by default,
but an unknown sender's DM is answered with a pairing code that the operator can approve
(`gateway/authz_mixin.py:716-758`); once `TELEGRAM_ALLOWED_USERS` is set, unknown senders are silently ignored. This skill refuses to
write anything until at least one numeric user ID is supplied, and writes the allowlist BEFORE the token so the bot is never live
without it. The same allowlist logic honours a `*` entry in `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_GROUP_ALLOWED_USERS` and
`GATEWAY_ALLOWED_USERS` as "everyone" (`gateway/authz_mixin.py:700-714`), and `TELEGRAM_ALLOW_ALL_USERS` as a bypass
(`:670-671`), so the gate refuses all of those and never sets any of them.

**One reload, no nudge.** Earlier revisions of this skill ran a second reload cycle ("post-setup nudge") because first-time setup
was believed to need one. That is dropped: the v0.22.5 adapter only reports `Connected to Telegram (polling mode)` after its cold-start
readiness gate has seen a successful `getUpdates` round-trip (`plugins/platforms/telegram/adapter.py:1941-2027`, `:3231`), so a second
cycle proves nothing the log line does not, and it cannot recover a message sent before startup: on a cold boot the adapter discards
updates Telegram queued while the gateway was offline by default (`platforms.telegram.extra.drop_pending_on_cold_boot`, default
`true`; `adapter.py:704`, `:3099-3111`). Step 8 therefore requires log evidence of the connect, and Step 9 tells the user to send the
first message AFTER that line.

This skill never sets a group-wide allowlist: `TELEGRAM_GROUP_ALLOWED_CHATS` authorizes every member of the listed groups, a wider
grant than a per-user allowlist. An existing non-empty one is refused too; remove it before proceeding with a private per-user setup.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TELEGRAM_BOT_TOKEN` | Full token in form `<digits>:<letters>` | Telegram → @BotFather → `/newbot` → name + username (must end in `bot`) → copy token |
| `$TELEGRAM_ALLOWED_USERS` | Comma-separated numeric Telegram user IDs (NOT @handles) | Telegram → @userinfobot → it replies with the numeric ID |
| `$TELEGRAM_HOME_CHANNEL` *(optional)* | Numeric chat ID for cron pings (groups are negative: `-100...`) | For DMs: same as user ID. For groups: add @userinfobot to the group, then it sends the group's ID |

If `$TELEGRAM_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed. Optional switches: `FORCE=1` (rewire an existing setup),
`AUTO_APPROVE=1` (skip the dry-run confirmation), `GW_INTERRUPT=1` (let the gateway restart interrupt live chat sessions; never set it
unless that is acceptable).

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
# gw_ready [SECONDS]: native readiness. Succeeds only when `gateway ensure --json` exits 0 and reports "state":"ready"
# (the transient pending/draining codes 5 and 6 are retried twice). It never greps `gateway status` text, because the stopped
# gateway prints "✗ Gateway is not running", which contains "running".
gw_ready() {
  remote "T=${1:-60} bash -s" <<'REMOTE'
n=0
while :; do
  out=$(hermes -p default gateway ensure --json --timeout "$T") && rc=0 || rc=$?
  [ "$rc" = 0 ] && break
  n=$((n + 1))
  { [ "$rc" = 5 ] || [ "$rc" = 6 ]; } && [ "$n" -lt 3 ] || { printf '%s\n' "$out" >&2; exit 1; }
  sleep 3
done
case $out in *'"state":"ready"'*) printf '%s\n' "$out" ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
REMOTE
}
# gw_reload: restart the default-profile gateway natively and require a ready gateway with a NEW instance_id.
# `--detach` keeps `restart` from running the gateway inside the ssh shell when no service is installed. With live
# sessions and no terminal, restart refuses; GW_INTERRUPT=1 adds -y and interrupts them deliberately (never set by default).
# Side effect: the pre-restart `ensure` read that captures the old instance_id STARTS a gateway when none is running (ensure never
# installs a service, but it does start one). A reload implies the gateway should run, so that is accepted; read-only skills never call gw_reload.
gw_reload() {
  local old new out interrupt
  interrupt=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then interrupt=1; fi
  # Keep an endpoint identity even when ensure exits 6 (draining/restart_wait).
  out=$(remote 'hermes -p default gateway ensure --json --timeout 10 2>/dev/null') || :
  old=$(printf '%s\n' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  remote "hermes -p default gateway restart --detach${interrupt:+ -y}" \
    || { echo "gw_reload: gateway restart failed or was refused (live sessions? re-run with GW_INTERRUPT=1 only if interrupting them is acceptable)." >&2; return 1; }
  out=$(gw_ready) || return 1
  new=$(printf '%s' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  if [ -n "$old" ] && [ "$new" = "$old" ]; then echo "gw_reload: the gateway instance did not change, so it was not restarted." >&2; return 1; fi
  printf '%s\n' "$out"
}

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/$SKILL_NAME"
# The active recovery point is published only after every artifact has been verified.
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
lock="$d.creating"
mkdir "$lock" 2>/dev/null || { echo "snapshot: another $SKILL_NAME snapshot is being created; retry after it finishes." >&2; exit 1; }
t=""
trap '[ -z "$t" ] || rm -rf "$t"; rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo "snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
t=$(mktemp -d "$p/.snapshot-$SKILL_NAME.XXXXXX")
for f in .env config.yaml; do
  if [ -f "$HOME/.hermes/$f" ]; then
    cp -p "$HOME/.hermes/$f" "$t/$f"
    cmp -s "$HOME/.hermes/$f" "$t/$f"
    chmod 600 "$t/$f"
  elif [ -e "$HOME/.hermes/$f" ] || [ -L "$HOME/.hermes/$f" ]; then
    echo "snapshot: $f is not a readable regular file; nothing was written." >&2; exit 1
  else
    : > "$t/$f.absent"
    chmod 600 "$t/$f.absent"
  fi
done

for f in .env config.yaml; do
  for entry in "$f" "$f.absent"; do
    if [ -f "$t/$entry" ]; then cksum < "$t/$entry" > "$t/$entry.cksum"; chmod 600 "$t/$entry.cksum"; fi
  done
done
printf 'hstack-snapshot-v1\n' > "$t/.complete"
chmod 600 "$t/.complete"
mv "$t" "$d"
[ -f "$d/.complete" ] && [ ! -d "$t" ] || { echo "snapshot: recovery-point publication failed; nothing was written." >&2; exit 1; }
t=""
REMOTE
}
# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), reload the gateway with gw_reload, then retire the snapshot.
rollback() {
  local rc=0
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE' || rc=$?
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 10; }
# Incomplete legacy snapshots cannot prove that their final copy succeeded. Keep them for manual recovery.
[ -f "$d/.complete" ] && [ "$(cat "$d/.complete")" = hstack-snapshot-v1 ] \
  || { echo "rollback: snapshot is incomplete or legacy; active snapshot retained for manual recovery." >&2; exit 1; }
for f in .env config.yaml; do
  count=0
  for entry in "$f" "$f.absent"; do
    if [ -f "$d/$entry" ]; then
      count=$((count + 1))
      [ -f "$d/$entry.cksum" ] || { echo "rollback: missing checksum for $f; active snapshot retained for recovery." >&2; exit 1; }
      checksum=$(cksum < "$d/$entry")
      expected_checksum=$(cat "$d/$entry.cksum")
      [ "$checksum" = "$expected_checksum" ] \
        || { echo "rollback: corrupt backup for $f; active snapshot retained for recovery." >&2; exit 1; }
    fi
  done
  [ "$count" = 1 ] || { echo "rollback: missing or ambiguous backup for $f; active snapshot retained for recovery." >&2; exit 1; }
done
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then
    cp -p "$d/$f" "$HOME/.hermes/$f"
    cmp -s "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then
    rm -f "$HOME/.hermes/$f"
    [ ! -e "$HOME/.hermes/$f" ] && [ ! -L "$HOME/.hermes/$f" ] || { echo "rollback: file removal failed; active snapshot retained." >&2; exit 1; }
  else
    echo "rollback: missing backup for $f; active snapshot retained for recovery." >&2
    exit 1
  fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
exit 0
REMOTE
  [ "$rc" = 10 ] && return 0
  [ "$rc" = 0 ] || return "$rc"
  gw_reload >/dev/null \
    || { echo "rollback: files restored, but the gateway did NOT come back ready — active snapshot retained; inspect the gateway and retry rollback after resolving the fault" >&2; return 1; }
  finish || return 1
  echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
trap 'echo "finish: could not retire the active snapshot; inspect the recovery point before continuing." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || exit 0
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
REMOTE
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
(Steps 5–8) does `rollback; exit 1`. `rollback` RESTORES the pre-skill `.env` and `config.yaml`; it never just deletes keys.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.

**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`,
which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id` than before. Why this shape
(source-verified, not live-verified):

- `gateway restart` restarts the installed systemd/launchd service, or, with no service, stops the profile's gateway and runs the
  replacement **in the calling shell**; `--detach` starts it in the background the way `ensure` does, so an ssh call cannot hang
  (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`, `hermes_cli/gateway_runtime_start.py:86-97`).
- With live sessions it asks y/N on a TTY and **refuses with exit 1 without one**; `-y`/`--yes` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:97-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y`
  on its own: set `GW_INTERRUPT=1` only when interrupting live chats is acceptable. Do not use `--force` or `--all` to evade a refusal.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the
  gateway is ready (5 deadline/starting, 6 draining, 3 incompatible, 4 authorization, 7 conflict)
  (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`). `instance_id` is a fresh uuid per gateway process
  (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is never used as a health check.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml and MCP changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  `gateway run` is the foreground command.
  There is no `--daemon` flag.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

This skill writes the HOST's `~/.hermes/.env`, so `hermes` must be installed on the host
(not only inside a container).

```bash
HERMES_BANNER=$(remote 'command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  hermes -p default --version') \
  || { echo "ABORT: Hermes is not installed on the host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
echo "Using: $HERMES_BANNER"
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked against the
v0.22.5 source; it has not been run against a live host.

---

## Step 2 — idempotency check (skip if already wired)

Upstream enables Telegram from the token alone. Skip setup only when the stored token and
numeric user allowlist are each defined once, the file is private, and no allow-all switch,
group-wide allowlist or `*` wildcard in the global / group-sender allowlists is on. An unsafe existing setup aborts before the idempotency return; it must never be
reported as already wired. The check prints a status only, never stored values.

```bash
if [ "${FORCE:-0}" != "1" ]; then
  STATE=$(remote 'bash -s' <<'REMOTE'
f=$HOME/.hermes/.env
if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo needs_setup; exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || { echo unsafe; exit 0; }
mode=$(stat -c %a "$f" 2>/dev/null) || mode=$(stat -f %Lp "$f" 2>/dev/null) || exit 1
[ "$mode" = 600 ] || { echo unsafe; exit 0; }
awk '
  function value(s) {
    sub(/^[^=]*=/, "", s)
    sub(/\r$/, "", s)
    if (length(s) >= 2) {
      q = substr(s, 1, 1)
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s)-2)
    }
    return s
  }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^TELEGRAM_BOT_TOKEN=/) { tokens++; token = value(line) }
    if (line ~ /^TELEGRAM_ALLOWED_USERS=/) { lists++; users = value(line) }
    if (line ~ /^TELEGRAM_GROUP_ALLOWED_CHATS=/) {
      v = value(line); gsub(/[[:space:]]/, "", v)
      if (v != "") open_access = 1
    }
    if (line ~ /^(GATEWAY_ALLOWED_USERS|TELEGRAM_GROUP_ALLOWED_USERS)=/) {
      if (index(value(line), "*") > 0) open_access = 1
    }
    if (line ~ /^(TELEGRAM_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) {
      v = tolower(value(line)); gsub(/[[:space:]]/, "", v)
      if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") open_access = 1
    }
  }
  END {
    if (tokens == 0 || lists == 0) print "needs_setup"
    else if (open_access || tokens > 1 || lists > 1) print "unsafe"
    else if (token !~ /^[0-9]+:[A-Za-z0-9_-]+$/ || length(substr(token, index(token, ":") + 1)) < 30) print "needs_setup"
    else if (users !~ /^[0-9]+(,[0-9]+)*$/) print "unsafe"
    else print "safe"
  }' "$f"
REMOTE
) || { echo "ABORT: could not check the stored Telegram setup. Nothing was written."; exit 1; }
  case "$STATE" in
    safe) echo "Telegram already wired. Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Telegram setup is unsafe (check file mode, duplicate keys, numeric allowlist and access overrides). Nothing was written."; exit 1 ;;
  esac
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

# Open-access switches, group-wide grants and `*` wildcards on the VPS defeat a private per-user allowlist.
# open_access_names prints NAMES only (never values). Fail-closed: any value other than an
# explicit false/0/no/off counts as on for the allow-all switches (Hermes itself honours only true/1/yes,
# gateway/authz_mixin.py:27), any `*` in GATEWAY_ALLOWED_USERS / TELEGRAM_GROUP_ALLOWED_USERS counts as on,
# and an unreadable .env aborts.
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || exit 1
awk '
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^(TELEGRAM_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|TELEGRAM_GROUP_ALLOWED_CHATS|GATEWAY_ALLOWED_USERS|TELEGRAM_GROUP_ALLOWED_USERS)=/) next
    n = line; sub(/=.*/, "", n)
    v = line; sub(/^[^=]*=/, "", v)
    gsub(/[\"\047[:space:]]/, "", v); v = tolower(v)
    if (n == "TELEGRAM_GROUP_ALLOWED_CHATS") { if (v != "") on[n] = 1 }
    else if (n == "GATEWAY_ALLOWED_USERS" || n == "TELEGRAM_GROUP_ALLOWED_USERS") { if (index(v, "*") > 0) on[n] = 1 }
    else if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") on[n] = 1
  }
  END { for (n in on) print n }' "$f"
REMOTE
}
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env on the VPS to check for allow-all switches. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)), so users outside the per-user allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
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
  0. (already passed) allowlist + token format checks and a live Telegram getMe from the VPS; nothing is written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write TELEGRAM_ALLOWED_USERS ($USERS_N user(s)) via 'hermes -p default config set' (value sent over ssh stdin)
  3. Write TELEGRAM_HOME_CHANNEL (${TELEGRAM_HOME_CHANNEL:-none}) if supplied
  4. Write TELEGRAM_BOT_TOKEN (length ${#TELEGRAM_BOT_TOKEN}, bot @$USERNAME) LAST, over ssh stdin; chmod 600; verify the keys landed (counts only)
  5. Set platforms.telegram.enabled true in config.yaml (the token alone enables Telegram upstream)
  6. Reload the gateway ONCE: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
  7. Verify: read the token back from ~/.hermes/.env on the VPS, call getMe, require 'Connected to Telegram' in the gateway log since the reload
  8. Native smoke: ${TELEGRAM_HOME_CHANNEL:+hermes -p default send --to telegram (ONE message to the home channel); }${TELEGRAM_HOME_CHANNEL:-no message is sent: no home channel is set (TELEGRAM_HOME_CHANNEL not set); }then hermes -p default pairing list (read-only)
  9. Live test: an allowlisted user DMs the bot after step 7 and gets a reply
  Any failure after step 1 restores the snapshot and reloads the gateway.

Token is NEVER printed in plaintext beyond a length + bot @handle.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`). If the user declines: `echo "ABORT: declined. Nothing was written."; exit 1`.

---

## Step 5 — write secrets first (token LAST), then verify

The allowlist goes in before the token, because the token is what makes Hermes turn Telegram
on. Each value travels as ONE line on ssh stdin and is read by `read -r` on the VPS. The `--`
keeps values that start with `-` (negative chat IDs) from being parsed as options; the vendored v0.22.5 argparse
accepts `config set KEY -- -1001234` and `config set KEY -1001234` alike and yields the same value, so `--` is cheap insurance, not a
requirement. `config set` routes UPPER_SNAKE names to `~/.hermes/.env` (`TELEGRAM_BOT_TOKEN` through the credential lifecycle because
of its `_TOKEN` suffix, the allowlist and home channel as plain env settings) and never to `config.yaml`
(`hermes_cli/config.py:871-881`, `:3416-3438`). Its output is discarded so Hermes can never echo a value into chat.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE — KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 -- \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
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

Never put the bot token in `config.yaml`.

---

## Step 6 — enable Telegram (only after Step 5 verification passed)

Upstream turns Telegram on from the token alone, **unless** `config.yaml` explicitly says
`platforms.telegram.enabled: false`: an explicit disable beats env credentials and only logs a one-time warning
(`gateway/config_env.py:56-73`, `:84-111`; any `enabled` key in a platform block sets the explicit marker,
`gateway/config_loader.py:145-162`). Setting the flag to `true` removes that trap. It is the only `config.yaml` edit, and it is
covered by the snapshot. `platforms` is an accepted container key and `true` is coerced to a boolean
(`hermes_cli/config.py:3050`, `:3090`, `:3207-3226`).

```bash
remote "hermes -p default config set platforms.telegram.enabled true && chmod 600 ~/.hermes/.env" \
  || echo "WARN: could not set platforms.telegram.enabled. This is a WARN on purpose: upstream enables Telegram from the token alone unless config.yaml disables it, and Step 8 will tell if Telegram is not connected."
```

---

## Step 7 — reload the gateway (once)

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. A refusal because of live sessions is reported with the `GW_INTERRUPT=1` hint, not overridden. There is deliberately
no second cycle (see "One reload, no nudge" at the top). `RELOAD_T0` marks the moment so Step 8 only reads log lines written after
the reload; a `Connected to Telegram` line from before it must not count as evidence.

```bash
RELOAD_T0=$(date +%s)
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify Telegram is connected (smoke test, poll up to 30s)

Two checks: (1) the token PERSISTED — it is read back from `~/.hermes/.env` on the VPS (the
non-interactive ssh shell never loads that file, so it is read explicitly) and `getMe` must
return the same bot as in Step 3; (2) the gateway log, restricted to the time since the reload (`hermes logs gateway --since Ns`,
`hermes_cli/subcommands/logs.py:47-48`, `hermes_cli/logs.py:81-87`), shows the bot is connected. The adapter logs
`Connected to Telegram (polling mode)` only after a successful first `getUpdates` (`adapter.py:3231`, `:1913-1938`), so that line is
the evidence that the bot is polling; "gateway ready" alone is not. A `Conflict` / `polling bootstrap conflict` line means another
process polls the same bot token (`adapter.py:2392-2455`; a second Hermes gateway on the same host that holds the bot-token lock keeps
this one from connecting at all, `adapter.py:3192`, `gateway/platforms/base.py:2190-2218`), and a `token rejected` line means the token was revoked
(`adapter.py:3260-3265`).

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
  LOG_STATUS=0
  SINCE_S=$(( $(date +%s) - RELOAD_T0 + 10 ))
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 200 --since ${SINCE_S}s 2>&1") || LOG_STATUS=$?
  # Use the latest status-bearing Telegram line: disconnected/failed is not connected,
  # and an older success must not mask a later connection failure.
  if [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | awk '
    {
      line = tolower($0)
      if (line !~ /(^|[^[:alnum:]_])telegram([^[:alnum:]_]|$)/) next
      if (line ~ /not[[:space:]_-]+(connected|ready)|(^|[^[:alnum:]_])(disconnected|failed|error|stopped)([^[:alnum:]_]|$)/) connected = 0
      else if (line ~ /(^|[^[:alnum:]_])(connected|ready|long.?poll|webhook)([^[:alnum:]_]|$)/) connected = 1
    }
    END { exit !connected }'; then
    CONNECTED=1
    echo "OK: Telegram connected (bot @$USERNAME)."
    break
  fi
  sleep 5
done
if [ "$CONNECTED" != "1" ]; then
  echo "FAIL: Telegram did not appear in gateway logs within 30s. Rolling back."
  echo "Look in 'hermes -p default logs gateway' for: Conflict (another process polls the same bot token), 'token rejected' (revoked), webhook errors (a leftover TELEGRAM_WEBHOOK_URL switches the adapter to webhook mode)."
  rollback; exit 1
fi

finish || exit 1
```

---

## Step 9 — live smoke test (native send, then a DM from an allowlisted user)

`hermes send --to telegram "text"` delivers one message to the home channel through the bot token alone: no LLM and no running gateway are
needed, exit 0 means the Bot API accepted it and exit 1 a delivery or backend error; it fails with a "no home channel" error when
`TELEGRAM_HOME_CHANNEL` is unset (`hermes_cli/send_cmd.py:14-16`, `:79-81`, `:194-240`, `tools/send_message_tool.py:242-246`, `:402-413`).
It proves outbound delivery only, and an API acknowledgement is not evidence that a person saw it. A failure here is a WARN, not a
rollback: the wiring itself was already proven by the getMe read-back and the connect line in Step 8, and the usual cause is on
Telegram's side (for a DM home channel the user normally has to message the bot first; that is a Telegram rule, not read from Hermes source).

`hermes pairing list` is read-only. The pairing store is a SECOND way in: a user approved there is authorized in union with
`TELEGRAM_ALLOWED_USERS` (`gateway/authz_mixin.py:676-684`). With an allowlist set Hermes does not issue pairing codes to strangers
(`:748-759`), so this list should be empty or contain only people you approved. This skill never runs `pairing approve`, `revoke` or
`clear-pending`.

```bash
FIRST_USER=$(printf '%s' "$TELEGRAM_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Telegram user ($FIRST_USER):
  1. Open Telegram; find @$USERNAME (the bot).
  2. Send "hello" NOW, after the connect line above. On a cold boot Hermes discards updates that Telegram queued while the gateway was
     offline (platforms.telegram.extra.drop_pending_on_cold_boot, default true), so a message sent before the reload is gone. Send it again.
  3. The bot should reply once the model answers.

If still silent after the connect line:
  - 'hermes -p default gateway status' and 'hermes -p default logs gateway' on the VPS
  - confirm the user ID is numeric and is the one in TELEGRAM_ALLOWED_USERS (an unlisted sender is silently ignored)
EOF

if [ -n "$TELEGRAM_HOME_CHANNEL" ]; then
  remote "hermes -p default send --to telegram 'hstack: Telegram is wired to this Hermes. Reply to the bot to test the allowlist.'" \
    || echo "WARN: hermes send to the home channel failed (exit 1 = delivery or backend error; read the error text above). Wiring was already proven in Step 8; the DM test below still applies."
else
  echo "No TELEGRAM_HOME_CHANNEL set: skipped the native send smoke. Set one and re-run with FORCE=1 to enable cron/send delivery."
fi
echo "Pairing store (a second way in, in union with the allowlist):"
remote "hermes -p default pairing list" || echo "WARN: could not read the pairing list."

# Redact first: a log line can contain the Bot API URL, which embeds the token.
remote "hermes -p default logs gateway -n 50 2>&1" | sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot<redacted>#g' | grep -i telegram | tail -20 || true
```

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in **Step 0**. It runs automatically (`rollback; exit 1`) on every failure after `snapshot`. It does not
delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/platform-telegram/`, verified by
  checksum first (a file that did not exist before is removed, so a first-time run leaves nothing behind; a `FORCE=1` re-run gets its
  previous token and allowlist back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `platform-telegram.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.
- A restore that fails reports `restoration failed; active snapshot retained for recovery` and never claims success.

Failures in Steps 1–4 happen before the snapshot and change nothing. If a run is interrupted after `snapshot` (crash, Ctrl-C), the
next `snapshot` refuses to run; call `rollback` first to restore the pre-crash state. Users approved in the pairing store are not part
of the snapshot (it lives outside `.env`/`config.yaml`) and survive a rollback.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including the old token) at mode 600; delete it once you no longer need the undo:

```bash
remote 'rm -rf ~/.hermes/.hstack-backup/platform-telegram.prev'
```

To remove Telegram entirely instead (destructive, only if the user asks), use the native writers and one reload:

```bash
for k in TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USERS TELEGRAM_HOME_CHANNEL; do
  remote "hermes -p default config unset $k >/dev/null 2>&1 || true"
done
remote "hermes -p default config set platforms.telegram.enabled false" && gw_reload
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `TELEGRAM_ALLOWED_USERS` | Gateway default-denies; strangers get a pairing code instead of an answer and the operator has no deterministic allowlist | Step 3 hard-abort; allowlist written before the token in Step 5 |
| 2 | Allowlist using @handle instead of numeric ID | Allowlist matcher is integer-equality on the user's `id` | Step 3 validator requires `^[0-9]+$` per user ID |
| 3 | Token truncated at the colon | Token is `<digits>:<letters>` — colon is part of the secret | Step 3 regex requires `[0-9]+:[A-Za-z0-9_-]{30,}` |
| 4 | First message sent before the bot connected is lost | On a cold boot Hermes drops updates queued while offline (`drop_pending_on_cold_boot`, default true); a second reload cycle does not bring them back | One reload only; Step 8 waits for `Connected to Telegram`; Step 9 says to send the first message after that line |
| 5 | Group ID without leading `-` (or missing `-100` prefix for supergroups) | Telegram sends from groups as negative IDs; matcher fails | Add @userinfobot to the group → it sends the correct negative ID; `TELEGRAM_HOME_CHANNEL` accepts `^-?[0-9]+$` |
| 6 | Reaching for a legacy reload (a `--daemon` flag, `gateway stop` then `ensure`) | The `--daemon` flag does not exist (argparse exit 2) and `gateway run` is the foreground command; stop-then-ensure is not the reload contract | `gw_reload` only (Step 7): `gateway restart --detach`, then `gateway ensure --json` must be ready with a new instance |
| 7 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes -p default config set` (Step 5), or the stdin upsert shown there |
| 8 | Token in `config.yaml` | Often checked into git; tokens exposed | Only `~/.hermes/.env`, `chmod 600` |
| 9 | Token revoked in @BotFather without redeploy | Old token in `.env` keeps failing on `getMe` | Rotate token → re-run with `FORCE=1`; if the new run fails, `rollback` restores the OLD working values |
| 10 | Bot username doesn't end in `bot` | @BotFather rejects username; user gets stuck before this skill runs | Tell user up front; @BotFather error is self-explanatory |
| 11 | Token in an ssh argument, URL on a command line, or a single-quoted remote string | Leaks into `ps`; breaks on odd characters; an escaped `\$VAR` inside a single-quoted remote URL is sent literally and always fails the check | The token goes over ssh stdin as a curl config (Step 3) or `read -r` (Step 5); the post-write check reads it back from `~/.hermes/.env` (Step 8) |
| 12 | Webhook mode left over from a prior install | The adapter clears a stale Telegram webhook itself on a cold start (`adapter.py:3143-3146`, `:1890-1915`), but a `TELEGRAM_WEBHOOK_URL` in `.env` switches it to webhook mode, which needs `TELEGRAM_WEBHOOK_SECRET` (`adapter.py:3114-3128`, `:3225-3227`) | This skill is long polling only: remove `TELEGRAM_WEBHOOK_URL` from `.env`. If the Step 8 log still shows webhook errors, call `deleteWebhook` from the VPS with the same stdin technique: `printf 'url = "https://api.telegram.org/bot%s/deleteWebhook"\n' "$TELEGRAM_BOT_TOKEN" \| remote "curl -fsS --max-time 15 --config -"` |
| 13 | Container vs host confusion | A container install reads its own `/opt/data/.env`, not the host's `~/.hermes/.env` | Step 1 requires `hermes` on the host and aborts otherwise |
| 14 | Looking for a `TELEGRAM_ENABLED` switch | It is not an upstream variable; the token enables the platform, and only `platforms.telegram.enabled: false` in `config.yaml` overrides that (`gateway_env.py:12-15`, `gateway/config_env.py:84-111`) | Step 6 sets the `config.yaml` flag; do not write `TELEGRAM_ENABLED` |
| 15 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-telegram/` behind | `snapshot` refuses to run so a half-written state is never captured as known-good | Run `rollback` (restores the pre-crash files), then re-run the skill |
| 16 | `TELEGRAM_ALLOW_ALL_USERS` on in `.env`, a `*` in `TELEGRAM_ALLOWED_USERS` (`555,*`), in `TELEGRAM_GROUP_ALLOWED_USERS` or in `GATEWAY_ALLOWED_USERS`, or a non-empty `TELEGRAM_GROUP_ALLOWED_CHATS` | Anyone (or every member of a group) can use the bot regardless of the per-user allowlist (`authz_mixin.py:670-714`). `GATEWAY_ALLOW_ALL_USERS` is also refused, although Hermes ignores it once a platform allowlist exists | Step 3 aborts before any write and Step 5 re-checks after it (names only, values never printed); never set them with this skill; remove them if present. Not checked: access granted from `config.yaml` (`allow_all_users`, per-platform `dm_policy`) |
| 17 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees it (the local ssh argv stays clean because values travel over stdin) | Accepted: `config set` is the only native writer, and it does not echo the value. Output of the write is discarded so Hermes can never echo a value into chat |
| 18 | Pasting gateway logs into chat | A log line can contain the Bot API URL, which embeds the bot token (Hermes redacts its own transport errors, `adapter.py:31-43`, but not every line) | Step 9 pipes logs through `sed -E 's#bot[0-9]+:[A-Za-z0-9_-]+#bot<redacted>#g'`; do the same for any log you show |
| 19 | Another process polls the same bot token (an old gateway, a dev laptop, a second host) | Telegram allows one `getUpdates` consumer per token: Hermes logs `Conflict` and retries (`adapter.py:2392-2455`) but never reaches `Connected to Telegram`; Step 8 rolls back | Stop the other consumer, or use a separate bot for it, then re-run |
| 20 | Reading a `Connected to Telegram` line from before the reload | `hermes logs gateway` keeps old lines; an older success would mask a new failure | Step 8 restricts the scan with `--since` to the time since the reload and uses the LATEST status-bearing line |
| 21 | Treating a successful `hermes send` as proof a person got the message | Exit 0 means the Bot API accepted it | Step 9 also requires the DM test; a `send` failure is a WARN |
| 22 | Approving pairing requests to add people | A pairing approval authorizes the user in union with the allowlist and also appends to `TELEGRAM_ALLOWED_USERS` (`gateway/pairing.py:63-77`, `:135-153`); this skill never does it for you | Add users by re-running with `FORCE=1` and the full numeric list; review `hermes -p default pairing list` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version banner names 0.22.5 on the VPS host (ABORT otherwise)
- [ ] Idempotency check ran (skipped if token + allowlist already present, unless `FORCE=1`)
- [ ] HARD GATE passed with nothing written: allowlist non-empty, no `*` anywhere in it, every user ID matches `^[0-9]+$`; no allow-all switch (`TELEGRAM_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS`), group-wide grant (`TELEGRAM_GROUP_ALLOWED_CHATS`) or `*` in `GATEWAY_ALLOWED_USERS` / `TELEGRAM_GROUP_ALLOWED_USERS` in the VPS `.env`; token matches `^[0-9]+:[A-Za-z0-9_-]{30,}$`
- [ ] Live Telegram `getMe` (run from the VPS, token sent over ssh stdin) returned the bot's `@username`
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `TELEGRAM_ALLOWED_USERS` written before `TELEGRAM_BOT_TOKEN`; both in `~/.hermes/.env`, `chmod 600`, verified by count (no values printed), with the allowlist re-read and the open-access check repeated after the write
- [ ] `platforms.telegram.enabled` set only after Step 5 verification passed (no `TELEGRAM_ENABLED` variable)
- [ ] Gateway reloaded exactly ONCE with `gw_reload` (`gateway restart --detach`, then `gateway ensure --json` ready with a new instance); never `stop`, `gateway run` or a second cycle
- [ ] Post-reload `getMe` using the token READ BACK from `~/.hermes/.env` on the VPS returned the same bot
- [ ] `Connected to Telegram` seen in the gateway log since the reload (within 30s), then `finish` ran
- [ ] Native smoke: `hermes -p default send --to telegram` exited 0 when a home channel was set (a failure is a WARN); `hermes -p default pairing list` reviewed
- [ ] Live smoke: allowlisted user DM'd @$USERNAME AFTER the connect line and got a reply (an API acknowledgement is not human observation)
- [ ] Any failure after the snapshot ran `rollback` (Step 0) and restored the prior `.env` + `config.yaml`

---

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repository root.

| Claim used by this skill | Source |
|---|---|
| `TELEGRAM_BOT_TOKEN` alone enables the platform; there is no `TELEGRAM_ENABLED`; the home channel env is `TELEGRAM_HOME_CHANNEL` and is applied only when the platform is configured | `plugins/platforms/telegram/gateway_env.py:12-19`, `gateway/platform_env.py:104-113`, `:160-178` |
| `platforms.telegram.enabled: false` in config.yaml beats env credentials (one-time warning); any `enabled` key marks the choice explicit | `gateway/config_env.py:56-73`, `:84-111`, `gateway/config_loader.py:145-162` |
| Authorization env names: `TELEGRAM_ALLOWED_USERS`, `TELEGRAM_ALLOW_ALL_USERS`, `TELEGRAM_GROUP_ALLOWED_CHATS`, `TELEGRAM_ALLOW_BOTS`; allow-all truthy values are `true`/`1`/`yes` | `plugins/platforms/telegram/gateway_env.py:23-29`, `gateway/authz_mixin.py:27`, `:44-45` |
| Order of checks: platform allow-all, pairing store (union), then the union of `TELEGRAM_ALLOWED_USERS` + `TELEGRAM_GROUP_ALLOWED_USERS` + `GATEWAY_ALLOWED_USERS`; a `*` in the union admits everyone; `GATEWAY_ALLOW_ALL_USERS` only applies when no allowlist is set | `gateway/authz_mixin.py:668-714` |
| With an allowlist set, unknown senders are ignored; without one they get a pairing code; startup warns when no allowlist exists | `gateway/authz_mixin.py:716-758`, `gateway/run_startup.py:1050-1058` |
| `pairing approve` mirrors the user into an already-configured allowlist; `pairing list` is read-only | `gateway/pairing.py:63-77`, `:135-153`, `hermes_cli/pairing.py:22-53`, `hermes_cli/subcommands/pairing.py:8-29` |
| `config set` routes UPPER_SNAKE names to `.env`, never echoes the value; `platforms.*` is an accepted container key; `true` is coerced to a boolean; negative numbers parse with or without `--` (checked with the vendored argparse) | `hermes_cli/config.py:871-881`, `:3050`, `:3090`, `:3207-3226`, `:3398`, `:3416-3438`, `hermes_cli/subcommands/config.py:27-34` |
| Cold-start connect: webhook cleared, polling started, readiness requires a successful first `getUpdates`, then `Connected to Telegram (polling mode)` is logged at WARNING | `plugins/platforms/telegram/adapter.py:1890-1915`, `:1941-2027`, `:3143-3170`, `:3172-3231` |
| Cold boot drops updates queued while offline unless `drop_pending_on_cold_boot: false` | `plugins/platforms/telegram/adapter.py:704`, `:3099-3111` |
| 409 conflicts are retried (max 5) and never reach "connected"; a rejected token is a non-retryable fatal error; a scoped lock keeps a second gateway from connecting with the same bot token | `plugins/platforms/telegram/adapter.py:2392-2455`, `:3260-3265`, `:3192`, `gateway/platforms/base.py:2190-2218` |
| `hermes send --to telegram TEXT`: home channel by platform name, no gateway or LLM needed, exit 0 / 1 / 2, errors on stderr | `hermes_cli/send_cmd.py:14-16`, `:62-81`, `:194-240`, `tools/send_message_tool.py:242-246`, `:284-285`, `:402-413` |
| `hermes logs gateway -n N --since Ns` | `hermes_cli/subcommands/logs.py:36-48`, `hermes_cli/logs.py:81-87` |
| Gateway restart / ensure / instance semantics | the "Gateway lifecycle" list in Step 0 |

Every `hermes ...` invocation in this file is also checked by `tests/skills/static.test.mjs` against the vendored v0.22.5 argparse
builders (syntax only).

**Unverified.** Nothing here was run against a real Hermes host, a real bot or a real Telegram account. Not checked by this skill:
access granted from `config.yaml` (`allow_all_users`, per-platform `dm_policy`, `TELEGRAM_ALLOW_BOTS`), multi-profile hosts, and
webhook mode. The exact wording of runtime log lines is read from the source's format strings, not from a captured log; the log scan
treats anything it cannot classify as "not connected" and rolls back. The behaviour of the offline stub is written down in
`tests/skills/stubs/hermes`; it is not evidence about the real CLI.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway,
allowlist, and Telegram long-poll failure modes.
