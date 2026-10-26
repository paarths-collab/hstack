---
name: hermes-home
description: "Set or verify the home channel (where cron output and proactive notices are delivered) of a self-hosted Hermes v0.22.5 over SSH, proving it with a native hermes send probe. Use after a messaging platform is wired."
---

# /hermes-home — set and verify the home channel (SSH-first, Hermes v0.22.5)

You are the engineer wiring the **home channel** of a self-hosted Hermes agent. The agent
(Hermes, Claude Code, Codex, Cursor, Gemini — whichever ran you) works over SSH as root against the VPS.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0,
which puts `~/.local/bin` (where `hermes` lives) on the remote PATH. The chat id travels to the VPS over ssh
STDIN. Run all blocks in ONE shell session: later steps call the Step 0 functions.

The home channel is the chat a bare platform name points at: `hermes send --to telegram "..."`, cron's
`--deliver telegram`, and the gateway's own proactive messages. Without one, a job that delivers to a bare
platform name creates fine and sends nothing.

Do everything autonomously; stop only for things a machine cannot do (find a chat id, type `/sethome` in a
chat, invite the bot to a channel).

## What the home channel is at v0.22.5 (source-verified, not live-verified)

- **It is an environment setting.** Each platform has one variable (`PlatformEntry.cron_deliver_env_var`):
  `TELEGRAM_HOME_CHANNEL`, `DISCORD_HOME_CHANNEL`, `SLACK_HOME_CHANNEL`, `MATTERMOST_HOME_CHANNEL`, `SIGNAL_HOME_CHANNEL`,
  `WHATSAPP_HOME_CHANNEL`, `TEAMS_HOME_CHANNEL`, `GOOGLE_CHAT_HOME_CHANNEL` and, for Matrix, **`MATRIX_HOME_ROOM`**
  (`plugins/platforms/<name>/adapter.py`, `signal/register.py:68`; citations below). A bare `UPPER_SNAKE` key given to
  `hermes config set` is written to `~/.hermes/.env` and the command never echoes the value
  (`hermes_cli/config.py:3398-3433`, `hermes_cli/config_env_routing.py:1-87`).
- **`/sethome` persists.** Typed in a chat it saves the home channel to `config.yaml` (`platforms.<platform>.home_channel`) AND writes
  the env variable (`gateway/slash_commands.py:659-701`); it is not a process-memory setting. On Slack the command is `/hermes sethome`
  (`gateway/run_turn_prepare.py:581-582`). Both paths end in the same variable this skill sets, so either is fine;
  `hermes config set` needs a chat id, `/sethome` needs someone in the chat.
- **The env variable wins.** The gateway config is "env > config.yaml" (`gateway/config.py:826,849`) and cron looks up the env variable
  first (`cron/scheduler_delivery.py:417-472`). A stale `config.yaml` home channel is therefore harmless while the variable is set.
- **Who reads it, and when.** `hermes send` loads `~/.hermes/.env` itself on every call (`hermes_cli/send_cmd.py:147-196`); cron reloads
  `.env` before each job run (`cron/scheduler.py:1527-1535,2429-2433`). Neither needs a gateway restart. The running gateway keeps its
  platform config in memory (`/sethome` patches it live, `gateway/slash_commands.py:696-698`), so its own proactive messages
  use the new value after the next gateway start: set `RELOAD_GATEWAY=1` to do that now. A reload interrupts nothing by default: a
  refusal because of live chats is reported and never overridden.
- **Applied only to a configured platform.** The variable is turned into a home channel only when the platform is present in the gateway
  config (`gateway/platform_env.py:104-113`); a variable for a platform that is not wired does nothing.
- **Not covered:** thread/topic homes (`<VAR>_THREAD_ID`, Telegram's `TELEGRAM_CRON_THREAD_ID`) and multi-profile hosts.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PLATFORM` | `telegram`, `discord`, `slack`, `mattermost`, `matrix`, `signal`, `whatsapp`, `teams` or `google_chat` | Which platform is already wired |
| `$HOME_CHAT_ID` | The chat/channel/room id to use. **Leave it unset to only VERIFY** a home channel that someone already set with `/sethome` | See the quirks below |

Per-platform ids:

- **Telegram** — DMs use a positive id; groups and supergroups use negative ids (often `-100...`). Keep the leading `-`.
- **Discord** — the numeric channel id (Developer Mode on, right-click the channel, Copy Channel ID).
- **Slack** — a `C...` channel id (a `G...` private channel or `D...` DM also works), NOT `#channel-name`; invite the bot first (`/invite @hermes`).
- **Mattermost** — the 26-character channel id, not the channel name.
- **Matrix** — the room id `!abcdef:server.tld`; the variable is `MATRIX_HOME_ROOM`.
- **Signal / WhatsApp / Teams / Google Chat** — the id the platform skill documents for that chat.

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=hermes-home
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
# shq STRING: one single-quoted word for the remote shell (the probe text contains spaces).
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
```

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  echo "whoami=$(whoami) hostname=$(hostname)" >&2
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5`, with `whoami=root` on a readable hostname (a hex hostname means you are inside a container: leave it).

---

## Step 2 — validate inputs and prove the platform is wired (nothing is written)

```bash
abort() { echo "ABORT: $* Nothing was written."; exit 1; }
# chars_ok SET VALUE: VALUE is non-empty and every character is in SET (LC_ALL=C so non-ASCII letters never count as alphanumerics).
chars_ok() { local LC_ALL=C; case "$2" in ""|*[!$1]*) return 1 ;; esac; return 0; }
PLATFORM=$(printf '%s' "${PLATFORM:-}" | tr '[:upper:]-' '[:lower:]_')
case "$PLATFORM" in
  telegram|discord|slack|mattermost|signal|whatsapp|teams|google_chat) HOME_VAR=$(printf '%s_HOME_CHANNEL' "$PLATFORM" | tr '[:lower:]' '[:upper:]') ;;
  matrix) HOME_VAR=MATRIX_HOME_ROOM ;;
  *) abort "PLATFORM must be telegram, discord, slack, mattermost, matrix, signal, whatsapp, teams or google_chat (got: ${PLATFORM:-empty})." ;;
esac
MODE=verify
if [ -n "${HOME_CHAT_ID:-}" ]; then
  MODE=set
  # hstack sanity filters, not Hermes rules: refuse what cannot be an id (spaces, quotes, newlines) and the usual wrong paste.
  chars_ok 'A-Za-z0-9@._:!#/+=-' "$HOME_CHAT_ID" || abort "HOME_CHAT_ID has characters an id never contains (spaces, quotes, newline)."
  case "$PLATFORM" in
    telegram)   chars_ok '0-9' "${HOME_CHAT_ID#-}" || abort "a Telegram id is a number, negative for groups (keep the leading '-')." ;;
    discord)    chars_ok '0-9' "$HOME_CHAT_ID" || abort "a Discord channel id is the numeric snowflake, not the channel name." ;;
    slack)      case "$HOME_CHAT_ID" in [CGD][A-Z0-9]*) ;; *) abort "a Slack home must be a channel id like C0123ABCD, not '#name'." ;; esac ;;
    mattermost) [ "${#HOME_CHAT_ID}" = 26 ] && chars_ok 'a-z0-9' "$HOME_CHAT_ID" || abort "a Mattermost channel id is 26 lowercase letters/digits, not the channel name." ;;
    matrix)     case "$HOME_CHAT_ID" in '!'*:*) ;; *) abort "a Matrix room id looks like !abcdef:server.tld." ;; esac ;;
  esac
fi
# Native 'is this platform wired' check: `hermes send --list PLATFORM` exits 0 only when the platform has a channel directory
# entry or is connected in the gateway config (hermes_cli/send_cmd.py:84-115); otherwise it exits 1 naming the configured ones.
remote "hermes -p default send --list $PLATFORM" >/dev/null 2>&1 \
  || abort "$PLATFORM is not wired (not in 'hermes send --list'). Run /platform-$PLATFORM first."
echo "inputs OK: platform=$PLATFORM variable=$HOME_VAR mode=$MODE"
```

---

## Step 3 — read the current value (idempotency)

`hermes config get` prints the stored value of an env setting and exits 1 with `Config key not set: <key>` when there is none
(`hermes_cli/config.py:3536-3560`). A home channel is an identifier, not a credential, so it is printed unmasked; this block keeps it
in a variable and prints only its length and first characters.

```bash
CURRENT=$(remote "hermes -p default config get $HOME_VAR" 2>/dev/null) && HAD_CURRENT=1 || { CURRENT=""; HAD_CURRENT=0; }
if [ "$MODE" = verify ]; then
  [ "$HAD_CURRENT" = 1 ] || abort "no home channel is set for $PLATFORM ($HOME_VAR). Type /sethome in the target chat (Slack: /hermes sethome) or re-run with HOME_CHAT_ID."
  echo "verify only: $HOME_VAR is set (length ${#CURRENT}, starts '${CURRENT:0:3}')."
elif [ "$HAD_CURRENT" = 1 ] && [ "$CURRENT" = "$HOME_CHAT_ID" ] && [ "${FORCE:-0}" != 1 ]; then
  echo "$HOME_VAR is already set to this id. Nothing was written. FORCE=1 re-writes it and re-runs the probe."
  exit 0
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
EOF
if [ "$MODE" = set ]; then
  cat <<EOF
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write $HOME_VAR (length ${#HOME_CHAT_ID}, starts '${HOME_CHAT_ID:0:3}') with 'hermes -p default config set', value over ssh stdin, chmod 600 ~/.hermes/.env
     Previous value: $([ "$HAD_CURRENT" = 1 ] && echo "set (length ${#CURRENT}, starts '${CURRENT:0:3}')" || echo "<unset>")
  3. Read it back with 'hermes -p default config get $HOME_VAR' (compared locally, not printed)
EOF
else
  echo "  1. (verify only) no write, no snapshot"
fi
if [ -n "${RELOAD_GATEWAY:-}" ]; then
  echo "  4. Reload the gateway (restart --detach, then ensure --json until ready) so its in-memory platform config matches"
else
  echo "  4. No gateway reload: hermes send and cron read .env themselves (set RELOAD_GATEWAY=1 to reload anyway)"
fi
if [ -n "${SKIP_PROBE:-}" ]; then
  echo "  5. (skipped, SKIP_PROBE is set) no probe: delivery will NOT be proven"
else
  echo "  5. Send ONE real probe message to the $PLATFORM home channel: hermes -p default send --to $PLATFORM \"<probe text>\" (everyone in that chat will see it)"
fi
echo "  Any failure after the snapshot restores the previous .env and config.yaml."
echo "The chat id is never printed beyond the prefix above."
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the home channel (value over stdin, chmod 600)

```bash
if [ "$MODE" = set ]; then
  snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
  printf '%s\n' "$HOME_CHAT_ID" \
    | remote "IFS= read -r v && hermes -p default config set $HOME_VAR -- \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env" \
    || { echo "FAIL: could not write $HOME_VAR."; rollback; exit 1; }
  GOT=$(remote "hermes -p default config get $HOME_VAR" 2>/dev/null) || GOT=""
  [ "$GOT" = "$HOME_CHAT_ID" ] || { echo "FAIL: $HOME_VAR does not read back as the value that was written."; rollback; exit 1; }
  [ "$(remote "grep -c '^$HOME_VAR=' ~/.hermes/.env || true")" = 1 ] \
    || { echo "FAIL: $HOME_VAR is not present exactly once in ~/.hermes/.env."; rollback; exit 1; }
  echo "OK: $HOME_VAR written to ~/.hermes/.env and read back."
fi
```

`--` keeps a negative id (`-100...`) from being read as an option. `config set` removes a stale top-level `config.yaml`
copy of the same name (`hermes_cli/config_env_routing.py:44-64`). Writing the variable does not touch the
`platforms.<platform>.home_channel` entry a past `/sethome` left in `config.yaml`; the variable wins over it.

---

## Step 6 — optional: reload the gateway (`RELOAD_GATEWAY=1`)

Only the running gateway process holds the old value in memory (see "Who reads it" above). `gw_reload` (Step 0) restarts the
default-profile gateway natively and returns only when `gateway ensure` reports a ready gateway with a new `instance_id`. A refusal because
of live sessions is reported, not overridden (`GW_INTERRUPT=1` would interrupt them; use it only when that is acceptable).

```bash
if [ -n "${RELOAD_GATEWAY:-}" ]; then
  gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready."; [ "$MODE" = set ] && rollback; exit 1; }
  echo "OK: gateway reloaded; its platform config now holds the new home channel."
fi
```

---

## Step 7 — prove it with a native probe (`hermes send --to PLATFORM`)

A bare platform name addresses the home channel; the success line is `Sent to <platform> home channel (chat_id: <id>)`, an
unset home channel exits 1 with `No home channel set for <platform> ...` (`hermes_cli/send_cmd.py:245-249`,
`tools/send_message_tool.py:242-245,284-285,401-413`). `hermes send` uses the bot credentials directly: no LLM, and for the bot-token
platforms no running gateway. Exit codes: 0 sent, 1 delivery error, 2 usage.

```bash
if [ -n "${SKIP_PROBE:-}" ]; then
  echo "WARN: probe skipped: delivery to the $PLATFORM home channel is NOT proven."
else
  PROBE="hermes-home probe $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  EXPECT_ID=${HOME_CHAT_ID:-$CURRENT}
  PROBE_OUT=$(remote "hermes -p default send --to $PLATFORM $(shq "$PROBE")" 2>&1) && PROBE_RC=0 || PROBE_RC=$?
  if [ "$PROBE_RC" != 0 ]; then
    echo "FAIL: the probe was not delivered (hermes send exit $PROBE_RC):"
    printf '%s\n' "$PROBE_OUT" | sed 's/(chat_id: [^)]*)/(chat_id: ...)/' | head -n 5
    echo "  Typical causes: the bot is not in that chat (invite it), the token is wrong or revoked, the id is not a chat the bot can post to."
    [ "$MODE" = set ] && rollback
    exit 1
  fi
  case "$PROBE_OUT" in
    *"home channel"*) echo "OK: probe delivered through the $PLATFORM home channel."
      case "$PROBE_OUT" in
        *"(chat_id: $EXPECT_ID)"*) ;;
        *) [ "$PLATFORM" = slack ] || echo "WARN: the probe resolved to a different id than $HOME_VAR holds - another source is winning (a stale variable in the gateway environment, a profile)." ;;
      esac ;;
    *) echo "WARN: hermes send exited 0 but did not report using the home channel: check the chat by hand." ;;
  esac
fi
if [ "$MODE" = set ]; then finish || exit 1; fi
```

A message appearing in the chat is the only proof a human can see it; the exit code and the `home channel` note are the proof the
route resolved and the platform accepted the message. `finish` keeps the pre-run files as `~/.hermes/.hstack-backup/hermes-home.prev` for
a manual undo.

---

## Rollback

Defined once in Step 0 and run automatically (`rollback; exit 1`) on every failure after `snapshot`. It does not just unset the key:
it RESTORES the exact previous `~/.hermes/.env` and `config.yaml` from the snapshot (a variable that did not exist is gone again, an old
value is back), sets `.env` to `chmod 600`, reloads the gateway with `gw_reload`, and only then retires the snapshot. If the gateway does not come
back ready it says so and keeps the snapshot: fix the gateway, then run `rollback` again. A restart refused because of live
sessions is the same case.

To undo a finished run, with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (with its secrets) at mode 600; delete it once you no longer need the undo.

---

## Verified against Hermes v0.22.5

Read in the source of tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repository root:

- Home variables: `plugins/platforms/telegram/adapter.py:7372`, `discord/adapter.py:7402`, `slack/adapter.py:6941`, `mattermost/adapter.py:740`, `matrix/adapter.py:3273`
  (`MATRIX_HOME_ROOM`), `signal/register.py:68`, `whatsapp/adapter.py:1266`, `teams/adapter.py:850`, `google_chat/adapter.py:1790`; env-to-config step `gateway/platform_env.py:104-113`.
- `hermes config get|set|unset`: `hermes_cli/subcommands/config.py:9-44`, `hermes_cli/config.py:3398-3433` (set routes an UPPER_SNAKE key to `.env`, prints `Set <KEY> in <path>`, no value),
  `:3536-3580` (get; a missing key exits 1 with `Config key not set: <key>`), `:3589-3626` (unset), `hermes_cli/config_env_routing.py:1-87`.
- `/sethome`: `gateway/slash_commands.py:659-701` (config.yaml AND env variable), Slack spelling `gateway/run_turn_prepare.py:581-582`.
- Precedence and timing: `gateway/config.py:825-849`, `cron/scheduler_delivery.py:417-472`, `cron/scheduler.py:1527-1535,2429-2433`, `hermes_cli/send_cmd.py:147-196`.
- `hermes send`: `hermes_cli/send_cmd.py:194-262` (bare platform = home channel; `--list PLATFORM`, `--json`, `--quiet`; exit 0/1/2), `:84-115` (`--list` source),
  `tools/send_message_tool.py:242-285,401-413` (success note and the no-home-channel error).

Not verified: nothing here was run against a real Hermes or a real chat. The per-platform id shape checks are hstack's own sanity filters.
Whether a given platform's `hermes send` works without the gateway running, and how Slack DM ids are normalised, were not observed.
The test double that exercises these blocks encodes the strings quoted above; it is not evidence about the real CLI.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Believing `/sethome` is lost on restart | It is not: it writes `config.yaml` and the env variable (`gateway/slash_commands.py:659-701`) | Either path works; this skill verifies whichever was used |
| 2 | Matrix: writing `MATRIX_HOME_CHANNEL` | The variable is `MATRIX_HOME_ROOM` | Step 2 maps it; a wrong name is silently ignored |
| 3 | Reading the value with `config show` | `config show` does not print `VAR=value` lines | `hermes config get <VAR>` (Step 3) |
| 4 | `hermes send --home` | There is no such flag; a bare platform name is the home channel | `hermes send --to <platform> "text"` |
| 5 | Telegram: dropping the leading `-` of a group id | `-100...` becomes a different, nonexistent chat | Keep it; Step 5 writes with `--` so it is not parsed as an option |
| 6 | Slack: `#channel-name`, or bare `/sethome` | Slack wants the `C...` id; the slash command is `/hermes sethome` | Step 2 rejects names |
| 7 | Slack/Discord/Teams: bot not in the chat | The platform rejects the post: the probe fails | Invite the bot, then re-run |
| 8 | Discord/Mattermost: a channel NAME | Names are not ids | Copy the id |
| 9 | A stale shell export of the same variable | Some processes may still resolve the old value | Step 7 compares the id the probe resolved with the one written |
| 10 | Expecting a restart to be needed | `hermes send` and cron read `.env` themselves; only the gateway's in-memory config is stale | `RELOAD_GATEWAY=1` only when the gateway's own notices must switch now |
| 11 | Topic/thread homes | `<VAR>_THREAD_ID` and `TELEGRAM_CRON_THREAD_ID` are separate settings | Out of scope here; set them with `hermes config set` deliberately |
| 12 | Platform not wired | The variable applies only to a configured platform | Step 2 requires `hermes send --list <platform>` to succeed |
| 13 | `echo >> .env` | Can merge onto a line without a trailing newline | `hermes config set` only |
| 14 | Probe text in a busy group | Everyone sees it | Step 4 says so; use `SKIP_PROBE=1` only knowingly |
| 15 | Fresh shell per command | Step 0 functions are undefined later | Re-run Step 0 first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed and the banner names Hermes `0.22.5`
- [ ] `hermes send --list $PLATFORM` succeeded (the platform is wired)
- [ ] Idempotency checked with `hermes config get`: an identical value exits 0 without writing
- [ ] Dry run shown and approved (or `AUTO_APPROVE=1`); verify-only mode writes nothing
- [ ] Snapshot taken before the write; the id travelled over ssh stdin; `.env` is `chmod 600`; the value read back equals what was written
- [ ] Gateway reloaded only if `RELOAD_GATEWAY=1` (ready, new instance) and never interrupted without `GW_INTERRUPT=1`
- [ ] Probe sent with `hermes send --to $PLATFORM` and reported the home channel (or `SKIP_PROBE=1` was a conscious choice)
- [ ] The id was never printed beyond a short prefix; `finish` ran (or the run was verify-only)
- [ ] A failed run restored the previous `.env` and `config.yaml` (`rollback`)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and platform delivery failure modes.
