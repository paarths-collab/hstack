---
name: hermes-cron
description: "Create, verify and manage scheduled jobs on a self-hosted Hermes v0.22.5 over SSH: agent prompts, no-agent scripts, and opt-in native backup and session-prune jobs. Use when the user wants something to run on a schedule."
---

# /hermes-cron — scheduled jobs (SSH-first, Hermes v0.22.5)

You are the engineer wiring a scheduled job on a self-hosted Hermes agent. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a
remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0,
which puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Run all blocks in ONE
shell session: later steps call the Step 0 functions.

A cron job is a **standing rule that runs unattended**. This skill therefore shows exactly
what will run, when, and where the output goes, and creates it only after an explicit yes.
It writes no secrets and does not touch `.env` or `config.yaml`, so it has no
snapshot/rollback of those files; its undo is `cron remove` of the job this run created
(and of the preset script this run wrote).

## What cron is at v0.22.5 (source-verified, not live-verified)

- **Two job kinds.** An *agent* job gives a prompt to the LLM each firing (it spends tokens
  and the final response is the output). A *no-agent* job (`--script FILE --no-agent`) runs a
  script from `~/.hermes/scripts/` and delivers its stdout verbatim: empty stdout is
  silent, a non-zero exit or timeout produces an error alert (`cron/scheduler.py:1522-1580`).
  Scripts must be given as a relative path of an existing file under `~/.hermes/scripts/`
  (`tools/cronjob_job_args.py:416-437`); `.sh`/`.bash` run with bash, everything else with Python
  (`hermes_cli/subcommands/cron.py:41-50`).
- **Schedules** (`cron/jobs.py:783-856`): `every 2h` and a bare `30m`/`2h`/`1d` are RECURRING
  intervals; `in 30m` is a one-shot; `0 9 * * 1-5` is a cron expression (needs the `croniter`
  package, `cron/jobs.py:766-776`); an ISO timestamp is a one-shot. A naive timestamp or cron time is read
  in the Hermes timezone: `HERMES_TIMEZONE`, else `timezone` in `config.yaml`, else the server's
  local time (`hermes_time.py:1-6`, `cron/jobs.py:816-825`). There is no per-job timezone flag.
- **Delivery.** A job created from the CLI has no origin, so the default is `local`: the output is
  only saved under `~/.hermes/cron/output/` and nothing is sent to a chat (`cron/jobs.py:114,1838-1839,3384-3392`,
  `cron/scheduler_delivery.py:603-604,871-877`). `--deliver telegram` (a bare platform name) means that
  platform's HOME CHANNEL, and resolves to nothing — silently — when no home channel is set
  (`cron/scheduler_delivery.py:657-673`); run `/hermes-home` first. `--deliver telegram:<chat_id>` addresses a chat directly.
- **No dedupe.** `cron create` accepts any number of jobs with the same name or prompt
  (`cron/jobs.py:1788-1866`), so this skill looks a name up first. Ids are 12 hex characters
  (`cron/jobs.py:1840`). `cron remove|pause|resume|run` accept an id or a unique name
  (`cron/jobs.py:1939-1954`).
- **The scheduler lives in the gateway** (`hermes_cli/cron.py:43-87`, `tools/cronjob_tools.py:709-711`): a job created while no
  gateway is running is stored but never fires, so the skill requires a ready gateway first. Creating a job needs no
  restart; the ticker reads the job store on every tick (`cron/jobs.py:2858-2868`).
- **The lifecycle guard rejects restart/stop jobs.** `cron create` refuses any prompt or script that
  contains a gateway restart/stop/uninstall command (also `systemctl`/`launchctl`/`pkill` shapes naming the
  gateway), because a job that restarts the gateway from inside the gateway causes a SIGTERM-respawn loop
  (`cron/lifecycle_guard.py:1-8,30-67,1231-1293`, called from `cron/jobs.py:1853-1855`). The old "nightly
  gateway restart" default is therefore gone; nothing in this skill schedules one. If you really want periodic
  restarts, use an operating-system timer outside Hermes (not part of this skill).

### What replaced the old "reliability defaults"

| Old default | Why it went | Now |
|-------------|-------------|-----|
| Nightly "gateway stop, then run" LLM job | The guard rejects it, and the command it named does not exist | Dropped. Restart manually with `/hermes-restart` |
| Nightly LLM job "push `~/.hermes` to a GitHub repo" | An agent improvising a push of a directory that holds `.env` | `CRON_KIND=backup`: a no-agent script running the native `hermes backup` into a private local directory. Pushing `~/.hermes` anywhere is not done by this skill |
| Weekly LLM job "prune session files" | Sessions are rows in `state.db`, not files; an LLM has no business deleting them | `CRON_KIND=sessions`: a no-agent script running `hermes sessions prune --older-than N --yes`. Hermes can also prune by itself: `sessions.auto_prune: true` with `sessions.retention_days` (`hermes_cli/config_defaults.py:2278-2307`, off by default) |

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$CRON_KIND` | `agent` (default), `script`, `backup` or `sessions` | Ask the user what should run |
| `$CRON_NAME` | Unique job name (`A-Za-z0-9._-`, max 50). Defaults: `hstack-backup`, `hstack-sessions-prune`. It is the idempotency key | Ask the user |
| `$CRON_SCHEDULE` | `every 6h`, `0 9 * * 1-5`, `in 30m`, an ISO timestamp. Defaults: `every 1d` (backup), `every 7d` (sessions) | Ask the user; confirm the timezone it will be read in |
| `$CRON_PROMPT` | `agent` only: a self-contained instruction (a firing has no chat context) | Ask the user. No credentials in it |
| `$CRON_SCRIPT` | `script` only: filename that ALREADY exists in `~/.hermes/scripts/` on the VPS (`*.sh`, `*.bash`, `*.py`) | The user's script |
| `$CRON_DELIVER` | `local` (default), a platform name for its home channel, or `platform:chat_id` | Ask where output should go |
| `$CRON_FAILURE_DELIVER` | Optional: where failure notices go (`local` silences them) | Optional |
| `$BACKUP_KEEP` | `backup` only: how many `hermes-backup-*.zip` to keep (default 7) | Ask the user |
| `$PRUNE_DAYS` | `sessions` only: delete ended, unpinned sessions older than this many days. **No default**: the deletion is irreversible, so the user must name the number | Ask the user |

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
SKILL_NAME=hermes-cron
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
# gw_reload is part of the shared helper set and is not called by this skill: creating a job needs no restart.

# strip_ansi: `hermes` colours its output only on a terminal (hermes_cli/colors.py:7-11); remove any escape codes anyway.
strip_ansi() { LC_ALL=C sed $'s/\033\\[[0-9;]*m//g'; }
# shq STRING: one single-quoted word for the remote shell (values may contain spaces and quotes; none is a secret).
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# cron_list_all: `cron list --all` of the default profile (disabled and completed jobs included).
cron_list_all() {
  local out
  out=$(remote 'hermes -p default cron list --all' 2>&1) || { printf '%s\n' "$out" | strip_ansi >&2; return 1; }
  printf '%s\n' "$out" | strip_ansi
}
# cron_ids_by_name NAME < list-text : ids of the jobs whose "Name:" row equals NAME. `cron list` prints "  <id> [active]" and then
# "    Name:      <name>" rows and never the prompt (hermes_cli/cron.py:196-262), so the id is the first word of the line before.
cron_ids_by_name() {
  awk -v want="$1" '
    length($1) == 12 && $1 ~ /^[0-9a-f]+$/ && $2 ~ /^\[/ { id = $1; next }
    $1 == "Name:" { n = $0; sub(/^[ \t]*Name:[ \t]*/, "", n); sub(/[ \t]+$/, "", n); if (n == want && id != "") print id }'
}
# undo_job: remove ONLY what this run created: the job (by the id parsed from "Created job:") and the preset script it wrote.
undo_job() {
  local rc=0 after
  if [ -n "${CREATED_ID:-}" ]; then
    remote "hermes -p default cron remove $CREATED_ID" >/dev/null 2>&1 || rc=1
    if after=$(cron_list_all); then
      if printf '%s\n' "$after" | cron_ids_by_name "$CRON_NAME" | grep -qx "$CREATED_ID"; then rc=1; fi
    else
      rc=1
    fi
  fi
  if [ "${SCRIPT_CREATED:-0}" = 1 ]; then remote "rm -f \"\$HOME/.hermes/scripts/$SCRIPT_NAME\"" >/dev/null 2>&1 || rc=1; fi
  if [ "$rc" = 0 ]; then echo "undo: removed what this run created (job ${CREATED_ID:-none}, script ${SCRIPT_CREATED:-0})."
  else echo "undo: could NOT remove everything this run created - inspect with: hermes -p default cron list --all" >&2; fi
  return "$rc"
}
```

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (`HERMES_VERSION` in `VERSIONS.txt`). If `hostname` shows a hex name you are
inside a container: leave it, jobs belong to the host's Hermes home.

---

## Step 2 — validate every input locally (nothing is sent yet)

```bash
abort() { echo "ABORT: $* Nothing was written."; exit 1; }
# chars_ok SET VALUE: VALUE is non-empty and every character is in SET (LC_ALL=C so non-ASCII letters never count as alphanumerics).
chars_ok() { local LC_ALL=C; case "$2" in ""|*[!$1]*) return 1 ;; esac; return 0; }
CRON_KIND=${CRON_KIND:-agent}
case "$CRON_KIND" in
  agent|script) ;;
  backup)   CRON_NAME=${CRON_NAME:-hstack-backup};         CRON_SCHEDULE=${CRON_SCHEDULE:-every 1d} ;;
  sessions) CRON_NAME=${CRON_NAME:-hstack-sessions-prune}; CRON_SCHEDULE=${CRON_SCHEDULE:-every 7d} ;;
  *) abort "CRON_KIND must be agent, script, backup or sessions (got: $CRON_KIND)." ;;
esac
chars_ok 'A-Za-z0-9._-' "${CRON_NAME:-}" || abort "CRON_NAME must be 1-50 characters of A-Za-z0-9._- (got: ${CRON_NAME:-empty})."
[ "${#CRON_NAME}" -le 50 ] || abort "CRON_NAME is longer than 50 characters."
chars_ok 'A-Za-z0-9 */,:+._-' "${CRON_SCHEDULE:-}" || abort "CRON_SCHEDULE is empty or has unexpected characters (examples: 'every 6h', '0 9 * * 1-5', 'in 30m')."
CRON_DELIVER=${CRON_DELIVER:-local}
chars_ok 'A-Za-z0-9_:.#@+,-' "$CRON_DELIVER" || abort "CRON_DELIVER has unexpected characters (examples: local, telegram, telegram:-100123)."
[ -z "${CRON_FAILURE_DELIVER:-}" ] || chars_ok 'A-Za-z0-9_:.#@+,-' "$CRON_FAILURE_DELIVER" || abort "CRON_FAILURE_DELIVER has unexpected characters."

# A bare platform name in CRON_DELIVER means its home channel; with none set the job would create fine and deliver nothing.
home_var_for() {
  case "$1" in
    matrix) echo MATRIX_HOME_ROOM ;;
    google_chat|google-chat) echo GOOGLE_CHAT_HOME_CHANNEL ;;
    telegram|discord|slack|mattermost|signal|whatsapp|teams) printf '%s_HOME_CHANNEL\n' "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" ;;
    *) return 1 ;;
  esac
}
for tgt in $(printf '%s,%s' "$CRON_DELIVER" "${CRON_FAILURE_DELIVER:-}" | tr ',' ' '); do
  case "$tgt" in *:*) continue ;; esac
  v=$(home_var_for "$tgt") || continue
  remote "hermes -p default config get $v" >/dev/null 2>&1 \
    || abort "deliver target '$tgt' means its home channel, but $v is not set. Run /hermes-home first (or use '$tgt:<chat_id>')."
done

PROMPT_ARG=""; SCRIPT_ARGS=""; SCRIPT_NAME=""; SCRIPT_BODY=""
case "$CRON_KIND" in
  agent)
    [ -n "${CRON_PROMPT:-}" ] || abort "CRON_KIND=agent needs CRON_PROMPT."
    # The prompt is stored in plaintext in the job store. Refuse credential shapes (heuristic) and what the lifecycle guard would refuse anyway.
    if printf '%s\n' "$CRON_PROMPT" | grep -Eq '(^|[^[:alnum:]])(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|[0-9]{8,10}:[A-Za-z0-9_-]{30,})' \
       || printf '%s\n' "$CRON_PROMPT" | grep -Eiq '(api[_-]?key|token|secret|password)[[:space:]]*[=:]'; then
      abort "CRON_PROMPT looks like it contains a credential (heuristic; rephrase if this is a false positive). Keep secrets in ~/.hermes/.env, never in a prompt."
    fi
    if printf '%s\n' "$CRON_PROMPT" | grep -Eiq 'gateway[[:space:]]+(restart|stop|uninstall)'; then
      abort "CRON_PROMPT contains a gateway restart/stop command; Hermes rejects those in cron jobs (SIGTERM-respawn loop)."
    fi
    PROMPT_ARG=$(shq "$CRON_PROMPT") ;;
  script)
    chars_ok 'A-Za-z0-9._-' "${CRON_SCRIPT:-}" && case "$CRON_SCRIPT" in .*) false ;; *) true ;; esac \
      || abort "CRON_SCRIPT must be a plain filename that exists in ~/.hermes/scripts/ on the VPS."
    case "$CRON_SCRIPT" in *.sh|*.bash|*.py) ;; *) abort "CRON_SCRIPT must end in .sh, .bash or .py." ;; esac
    SCRIPT_NAME=$CRON_SCRIPT
    remote "test -f \"\$HOME/.hermes/scripts/$SCRIPT_NAME\"" || abort "$SCRIPT_NAME does not exist in ~/.hermes/scripts/ on the VPS."
    SCRIPT_ARGS=" --script $(shq "$SCRIPT_NAME") --no-agent" ;;
  backup)
    BACKUP_KEEP=${BACKUP_KEEP:-7}
    chars_ok '0-9' "$BACKUP_KEEP" || abort "BACKUP_KEEP must be a whole number."
    [ "$BACKUP_KEEP" -ge 1 ] && [ "$BACKUP_KEEP" -le 365 ] || abort "BACKUP_KEEP must be between 1 and 365."
    SCRIPT_NAME=hstack-backup.sh
    SCRIPT_BODY=$(cat <<'EOS'
#!/bin/bash
# Managed by /hermes-cron (preset "backup"). Native Hermes backup: a SQLite-safe zip of the Hermes home.
# The zip contains ~/.hermes/.env and auth.json. Keep this directory private; never copy it into git or a chat.
set -eu
umask 077
OUT="${HERMES_HOME:-$HOME/.hermes}/backups"
mkdir -p "$OUT"
chmod 700 "$OUT"
HB=$(command -v hermes 2>/dev/null || true)
[ -n "$HB" ] || HB="$HOME/.local/bin/hermes"
"$HB" -p default backup -o "$OUT" -k __KEEP__ >/dev/null
EOS
)
    SCRIPT_BODY=${SCRIPT_BODY//__KEEP__/$BACKUP_KEEP}
    SCRIPT_ARGS=" --script $(shq "$SCRIPT_NAME") --no-agent" ;;
  sessions)
    chars_ok '0-9' "${PRUNE_DAYS:-}" || abort "CRON_KIND=sessions needs PRUNE_DAYS (a whole number of days). There is no default: the deletion is irreversible."
    [ "$PRUNE_DAYS" -ge 1 ] && [ "$PRUNE_DAYS" -le 3650 ] || abort "PRUNE_DAYS must be between 1 and 3650."
    SCRIPT_NAME=hstack-sessions-prune.sh
    SCRIPT_BODY=$(cat <<'EOS'
#!/bin/bash
# Managed by /hermes-cron (preset "sessions"). Native prune of ENDED, unpinned sessions older than __DAYS__ days. Irreversible.
set -eu
HB=$(command -v hermes 2>/dev/null || true)
[ -n "$HB" ] || HB="$HOME/.local/bin/hermes"
"$HB" -p default sessions prune --older-than __DAYS__ --yes >/dev/null
EOS
)
    SCRIPT_BODY=${SCRIPT_BODY//__DAYS__/$PRUNE_DAYS}
    SCRIPT_ARGS=" --script $(shq "$SCRIPT_NAME") --no-agent" ;;
esac
FAILURE_ARG=""
[ -z "${CRON_FAILURE_DELIVER:-}" ] || FAILURE_ARG=" --failure-deliver $(shq "$CRON_FAILURE_DELIVER")"
echo "inputs OK: kind=$CRON_KIND name=$CRON_NAME schedule='$CRON_SCHEDULE' deliver=$CRON_DELIVER"
```

---

## Step 3 — idempotency (skip if a job with this name exists)

`cron create` never dedupes, so look the name up first. A preset script that already exists
with different content is somebody else's file: the skill stops instead of overwriting it.

```bash
LIST=$(cron_list_all) || { echo "ABORT: could not read 'cron list'. Nothing was written."; exit 1; }
EXISTING=$(printf '%s\n' "$LIST" | cron_ids_by_name "$CRON_NAME")
if [ -n "$EXISTING" ]; then
  echo "A job named '$CRON_NAME' already exists (id: $(printf '%s' "$EXISTING" | tr '\n' ' ')). Nothing was written."
  echo "Change it with: hermes -p default cron edit <id> --schedule ... (see 'Managing existing jobs'), or pick another CRON_NAME."
  exit 0
fi
SCRIPT_CREATED=0
if [ -n "$SCRIPT_BODY" ]; then
  if remote "test -e \"\$HOME/.hermes/scripts/$SCRIPT_NAME\""; then
    ON_DISK=$(remote "cat \"\$HOME/.hermes/scripts/$SCRIPT_NAME\"")
    [ "$ON_DISK" = "$SCRIPT_BODY" ] || abort "~/.hermes/scripts/$SCRIPT_NAME already exists with different content; move it aside or choose another setup."
  else
    SCRIPT_CREATED=1
  fi
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
TZ_NOTE=$(remote 'hermes -p default config get HERMES_TIMEZONE 2>/dev/null || hermes -p default config get timezone 2>/dev/null || true')
SERVER_NOW=$(remote 'date "+%Y-%m-%d %H:%M %Z"')
UNDO_NOTE=""; [ "$SCRIPT_CREATED" = 1 ] && UNDO_NOTE=" (and the script file written in step 2)"
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Standing rule: job '$CRON_NAME' will run UNATTENDED on schedule '$CRON_SCHEDULE' until someone removes it.
  1. Make sure the gateway (it hosts the cron scheduler) is ready: hermes -p default gateway ensure --json (starts an installed, stopped service)
EOF
case "$CRON_KIND" in
  agent)    printf '  2. hermes -p default cron create %s <prompt> --name %s --deliver %s\n     Each firing calls the LLM (token cost) with this prompt:\n     | %s\n' "$(shq "$CRON_SCHEDULE")" "$CRON_NAME" "$CRON_DELIVER" "$CRON_PROMPT" ;;
  script)   printf '  2. hermes -p default cron create %s --script %s --no-agent --name %s --deliver %s\n     No LLM. It runs ~/.hermes/scripts/%s with the privileges of the gateway process; its stdout is delivered. First lines of that file:\n' "$(shq "$CRON_SCHEDULE")" "$SCRIPT_NAME" "$CRON_NAME" "$CRON_DELIVER" "$SCRIPT_NAME"
            remote "sed -n 1,25p \"\$HOME/.hermes/scripts/$SCRIPT_NAME\"" | sed 's/^/     | /' ;;
  backup|sessions)
            printf '  2. %s ~/.hermes/scripts/%s (mode 700), then hermes -p default cron create %s --script %s --no-agent --name %s --deliver %s\n     No LLM. The script is:\n' "$([ "$SCRIPT_CREATED" = 1 ] && echo "Write" || echo "Reuse (identical content)")" "$SCRIPT_NAME" "$(shq "$CRON_SCHEDULE")" "$SCRIPT_NAME" "$CRON_NAME" "$CRON_DELIVER"
            printf '%s\n' "$SCRIPT_BODY" | sed 's/^/     | /' ;;
esac
cat <<EOF
  3. Read the id from the "Created job: <id>" line, then confirm it with 'cron list --all' and 'cron doctor'.
  Timezone Hermes reads the schedule in: ${TZ_NOTE:-server-local time (HERMES_TIMEZONE and 'timezone' are unset)}; the server clock is $SERVER_NOW.
  Output goes to: $CRON_DELIVER (local = saved on the VPS only, nothing is sent to a chat).
  Undo: hermes -p default cron remove <id>$UNDO_NOTE.
EOF
if [ "$CRON_KIND" = backup ]; then
  echo "  Note: each archive contains ~/.hermes/.env and auth.json, so it stays in ~/.hermes/backups (mode 700) on this VPS. An off-box copy is your call; do not push it to git."
fi
if [ "$CRON_KIND" = sessions ]; then
  echo "  Warning: each run permanently DELETES ended, unpinned sessions older than $PRUNE_DAYS days (hermes sessions prune --yes)."
fi
echo "No secrets are written by this skill."
```

Show it to the user. This job runs without anyone watching, so continue only on an explicit yes. Do not set
`AUTO_APPROVE=1` yourself; honour it only if the user set it. If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — create the job and read its id from the real output

```bash
gw_ready >/dev/null || { echo "ABORT: the gateway (cron scheduler host) is not ready; run /hermes-restart or /hermes-fix first. Nothing was written."; exit 1; }
CREATED_ID=""
if [ -n "$SCRIPT_BODY" ] && [ "$SCRIPT_CREATED" = 1 ]; then
  printf '%s\n' "$SCRIPT_BODY" \
    | remote "umask 077; mkdir -p \"\$HOME/.hermes/scripts\" && cat > \"\$HOME/.hermes/scripts/$SCRIPT_NAME\" && chmod 700 \"\$HOME/.hermes/scripts/$SCRIPT_NAME\"" \
    || { echo "FAIL: could not write ~/.hermes/scripts/$SCRIPT_NAME."; undo_job; exit 1; }
fi
CREATE_OUT=$(remote "hermes -p default cron create $(shq "$CRON_SCHEDULE") ${PROMPT_ARG}${SCRIPT_ARGS} --name $(shq "$CRON_NAME") --deliver $(shq "$CRON_DELIVER")${FAILURE_ARG}" 2>&1) \
  || { echo "FAIL: cron create was refused: $(printf '%s\n' "$CREATE_OUT" | strip_ansi | head -n 3)"; undo_job; exit 1; }
CREATE_OUT=$(printf '%s\n' "$CREATE_OUT" | strip_ansi)
CREATED_ID=$(printf '%s\n' "$CREATE_OUT" | sed -n 's/^Created job: \([0-9a-f]\{12\}\)[[:space:]]*$/\1/p' | head -n 1)
if [ -z "$CREATED_ID" ]; then
  # The line was not in the expected shape: fall back to the name, but only when it identifies exactly one job.
  CANDIDATES=$(cron_list_all | cron_ids_by_name "$CRON_NAME")
  if [ "$(printf '%s\n' "$CANDIDATES" | grep -c .)" = 1 ]; then CREATED_ID=$CANDIDATES
  else echo "FAIL: could not read the job id from: $CREATE_OUT. Inspect 'hermes -p default cron list --all' before retrying."; undo_job; exit 1; fi
fi
echo "OK: created job $CREATED_ID ($CRON_NAME)"
```

`cron create` prints `Created job: <id>`, then `Name:`/`Schedule:`/`Next run:` rows
(`hermes_cli/cron.py:790-812`); a refusal prints `Failed to create job: <reason>` and exits 1 (a rejected
schedule, a missing script, or the lifecycle guard). Nothing is guessed from `cron list` unless that line is missing.

---

## Step 6 — verify the job is registered and healthy

```bash
LIST=$(cron_list_all)
printf '%s\n' "$LIST" | cron_ids_by_name "$CRON_NAME" | grep -qx "$CREATED_ID" \
  || { echo "FAIL: job $CREATED_ID is not in 'cron list --all'."; undo_job; exit 1; }
[ "$(printf '%s\n' "$LIST" | cron_ids_by_name "$CRON_NAME" | grep -c .)" = 1 ] \
  || { echo "FAIL: more than one job is now named '$CRON_NAME'."; undo_job; exit 1; }
DOCTOR=$(remote 'hermes -p default cron doctor' 2>&1) && DOCTOR_RC=0 || DOCTOR_RC=$?
DOCTOR=$(printf '%s\n' "$DOCTOR" | strip_ansi)
if [ "$DOCTOR_RC" != 0 ]; then
  if printf '%s\n' "$DOCTOR" | grep -q "$CREATED_ID"; then
    echo "FAIL: cron doctor reports a problem with the new job:"; printf '%s\n' "$DOCTOR" | head -n 12; undo_job; exit 1
  fi
  echo "WARN: cron doctor reports problems with OTHER jobs (the new job is clean); look at them separately: hermes -p default cron doctor"
fi
echo "OK: job $CREATED_ID is listed and cron doctor has no finding for it."
```

`cron doctor` is read-only and exits 0 only when no job has a finding (script missing or outside the scripts
directory, overdue `next_run_at`, last failure, ...; `hermes_cli/cron.py:701-757`). `cron list` shows the
schedule, next run, delivery and (for script jobs) the script and `Mode: no-agent` rows, never the prompt.

---

## Step 7 — optional: run it once now (`SMOKE_RUN=1`)

A manual run has exactly the side effects of a scheduled firing (LLM tokens, a message, a backup zip, deleted
sessions), so it is opt-in. Never run the `sessions` preset this way unless the user wants the deletion now.

```bash
if [ "${SMOKE_RUN:-0}" = 1 ]; then
  RUN_OUT=$(remote "hermes -p default cron run $CREATED_ID" 2>&1) && RUN_RC=0 || RUN_RC=$?
  RUN_OUT=$(printf '%s\n' "$RUN_OUT" | strip_ansi)
  printf '%s\n' "$RUN_OUT"
  case "$RUN_OUT" in
    *"Ran now: succeeded"*) echo "OK: the job ran and succeeded." ;;
    *"next scheduler tick"*) echo "OK: queued for the next scheduler tick (an agent job); check 'cron list' later." ;;
    *) echo "WARN: run result was '$RUN_RC' - read the output above and 'hermes -p default logs gateway -n 100'." ;;
  esac
fi
echo "DONE: job $CREATED_ID ($CRON_NAME) is scheduled."
```

`cron run` prints `Triggered job: <name> (<id>)` and then `Ran now: succeeded.`/`failed.` when it ran in the CLI, or
`It will run on the next scheduler tick.` (`hermes_cli/cron.py:858-904`). A chat message arriving is the only proof of delivery.

---

## Managing existing jobs

All of these are the native commands; ids come from `cron list`.

```bash
remote 'hermes -p default cron list --all'
remote 'hermes -p default cron pause <id>'
remote 'hermes -p default cron resume <id>'
remote 'hermes -p default cron edit <id> --schedule "every 12h"'
remote 'hermes -p default cron remove <id>'
remote 'hermes -p default cron status'
```

`pause` keeps the job and stops it firing; `remove` deletes it. In chat the user can also just say "every morning
at 8, summarise X" and Hermes creates the job itself.

---

## Rollback

There is no `.env`/`config.yaml` change to restore. A failure after Step 5 calls `undo_job`, which runs
`cron remove <id>` for the job this run created and deletes the preset script only if this run wrote it, then checks
the job is gone. To undo a finished run later, with the Step 0 functions loaded:

```bash
CREATED_ID=$(cron_list_all | cron_ids_by_name "$CRON_NAME" | head -n 1) && undo_job
```

Jobs you did not create are never removed. The output a job already produced stays under `~/.hermes/cron/output/`.

---

## Verified against Hermes v0.22.5

Read in the source of tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repository root:

- `cron` subcommands and flags: `hermes_cli/subcommands/cron.py:14-205` (`create|add SCHEDULE [PROMPT] --name --deliver --failure-deliver --script --no-agent --paused ...`,
  `list [--all]`, `pause`, `resume`, `run JOB_ID`, `remove|rm|delete`, `edit`, `status`, `doctor`).
- Output formats: `Created job: <id>` `hermes_cli/cron.py:790-812`; `list` rows `hermes_cli/cron.py:177-262`; `run` verdicts `:858-904`; `doctor` exit codes `:738-757`.
- Job creation rules: `cron/jobs.py:1788-1866` (default delivery `local`, 12-hex id, name = first 50 characters of the prompt), schedule parser `cron/jobs.py:783-856`,
  references by id or name `cron/jobs.py:1939-1954`, script path and no-agent rules `tools/cronjob_job_args.py:416-437`, `tools/cronjob_tools.py:642-702`,
  prompt threat scan `tools/cronjob_prompt_scan.py:27-40,121-130`.
- Lifecycle guard: `cron/lifecycle_guard.py:30-67,1231-1293`, enforced in `cron/jobs.py:1853-1855`.
- Delivery and home channels: `cron/scheduler_delivery.py:417-472,593-673,871-877`; no-agent runs `cron/scheduler.py:1522-1580`; script environment and timeout
  `cron/scheduler_script.py:432-515`, `cron/scheduler.py:1391`.
- Native backup and prune used by the presets: `hermes_cli/subcommands/backup.py:16-35` (`-o`, `-k` apply to FULL backups; `-q/--quick` snapshots ignore `-k`),
  `hermes_cli/backup.py:72-95,550-566,590-682` (the `backups` directory is excluded from archives; `-k` prunes only `hermes-backup-*.zip` beside the output),
  `hermes_cli/subcommands/sessions.py:122-139`, `hermes_cli/sessions_cmd.py:738-815` (prune deletes ended, unpinned sessions; `--yes` skips the prompt).
- Home channel and send: see `/hermes-home`.

Not verified: nothing here was run against a real Hermes. Whether `croniter` is installed on a given host, how the
sanitised script environment resolves `hermes` and `HERMES_HOME` for the preset scripts (they fall back to `~/.local/bin/hermes`
and `~/.hermes`), and chat delivery itself were not observed. The test double that exercises these blocks encodes the output
strings quoted above; it is not evidence about the real CLI.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Reading the id from `cron list` by grepping the prompt | `list` never prints the prompt; the first word of a matching `Name:` row is `Name:` | Parse `Created job: <id>` from `create`; confirm with the name lookup (Steps 5-6) |
| 2 | Assuming output reaches a chat | CLI-created jobs default to `local`: the output is only saved on the VPS | Choose `--deliver` explicitly; a bare platform name needs a home channel (`/hermes-home`) |
| 3 | `30m` read as a one-shot | A bare duration is a RECURRING interval; `in 30m` is the one-shot | Use `in 30m` for one-shots |
| 4 | Hour in the wrong zone | Schedules are read in `HERMES_TIMEZONE`/`timezone`, else server-local time; there is no per-job zone | Step 4 prints the zone and the server clock; set the zone in Hermes config first |
| 5 | A cron expression rejected | Cron expressions need the `croniter` package (`cron/jobs.py:766-776`) | Use `every Nh`, or install the package |
| 6 | Scheduling a gateway restart | The lifecycle guard rejects it (respawn loop) | Restart by hand with `/hermes-restart` |
| 7 | A job created while the gateway is down | The scheduler lives in the gateway; the job is stored and never fires | Step 5 requires `gateway ensure` to report ready first |
| 8 | Duplicate jobs on a re-run | `cron create` does not dedupe | Name lookup in Step 3; `cron edit` to change one |
| 9 | An LLM job over `~/.hermes` | The directory holds `.env` and `auth.json` | Backups and prunes are no-agent scripts calling the native commands |
| 10 | `--script` with an absolute path or a missing file | Only a relative path of an existing file under `~/.hermes/scripts/` is accepted | Step 2 checks it exists; presets write it first |
| 11 | Secrets in a prompt | Stored in plaintext in the job store and visible to the agent | Keep them in `~/.hermes/.env`; Step 2 refuses credential shapes |
| 12 | Fresh shell per command | Step 0 functions are undefined later | Re-run Step 0 first |
| 13 | Expecting `-k` to prune quick snapshots | `-k` only prunes full `hermes-backup-*.zip` archives | The backup preset uses a full backup; `-q` snapshots are pruned by Hermes itself (default 20) |
| 14 | `AUTO_APPROVE=1` set by the agent for an unattended job | The user never saw what will run unattended | Honour it only when the user set it |
| 15 | Bare `hermes` over ssh: `command not found` | Non-login ssh shells lack `~/.local/bin` | `remote()` exports PATH; presets fall back to `~/.local/bin/hermes` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed and the banner names Hermes `0.22.5`
- [ ] Inputs validated locally; a bare-platform `--deliver` target has its home channel set
- [ ] No existing job with the same name (or the run exited 0 reporting it)
- [ ] Dry run shown (schedule, timezone, delivery, prompt or script, side effects) and the user said yes
- [ ] Gateway reported ready by `gateway ensure --json` before the job was created
- [ ] Job created; its id read from the `Created job: <id>` line
- [ ] `cron list --all` shows exactly one job with that name and id; `cron doctor` has no finding for it
- [ ] No gateway-restart job, no LLM job over `~/.hermes`, no secret in a prompt or script
- [ ] A failure after creation removed only what this run created (`undo_job`)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and cron failure modes.
