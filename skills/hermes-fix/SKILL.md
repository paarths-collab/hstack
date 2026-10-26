---
name: hermes-fix
description: "Diagnose and repair a broken self-hosted Hermes v0.22.5 over SSH, starting from hermes doctor: gateway down or wedged, bot silent, model or tool errors, PATH, Docker UID, memory growth. Repairs are consent-gated, snapshot-backed and reload only through the native gateway lifecycle. Use when Hermes is broken. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI)."
---

# /hermes-fix — diagnose first, repair with consent (SSH-first)

You are the engineer fixing a broken self-hosted Hermes agent on the user's VPS. The agent (Hermes, Claude Code, Codex, Cursor,
Gemini CLI — whichever ran you) works over SSH as root against the VPS.

Do everything autonomously that is safe; stop for the things a machine must not decide alone: a missing API key, running
`hermes doctor --fix`, interrupting live chats, editing the user's shell profile, or anything that installs a persistent service.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches the VPS through
the `remote` helper from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Secrets travel to the
VPS only over ssh STDIN. Run all blocks in ONE shell session: later steps call the Step 0 functions.

**Honest picture (Hermes v0.22.5).** `hermes doctor` is the first tool, and its exit status is meaningful: it is **1 when issues remain**
and 0 when it found none (`hermes_cli/doctor.py:172-194`, forwarded by `hermes_cli/main.py:1837,3550-3554`). It checks configuration,
credentials, providers (it opens outbound connections to each configured one), tool availability, state files and the gateway *service*
setup (linger). It does **not** check that a gateway is running or that the bot answers. `gateway status` text is shown as information
only: `✗ Gateway is not running` contains the word `running`. Everything below is checked against the v0.22.5 source (see "Verified
against Hermes v0.22.5"); nothing was run against a real host.

`hermes doctor --fix` is **not** a harmless tidy-up. It can create `.env`, migrate `config.yaml`, remove a stale `HERMES_MAX_ITERATIONS`
from `.env`, repair a malformed `state.db` (with a backup beside it), checkpoint a large WAL and recreate the `~/.local/bin/hermes`
link. The snapshot below restores only `.env` and `config.yaml`, so `--fix` needs the user's explicit yes (`ALLOW_DOCTOR_FIX=1`).

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$FORCE` (optional) | `1` = run the fixes even when `doctor` found nothing and no symptom was given | Ask |
| `$SYMPTOM` (optional) | one of `gateway-down`, `wedged`, `bot-silent`, `model-error`, `tools`, `oom`, `command-not-found`, `docker-chown`, `not-configured` | The user; leave empty to follow `doctor` only |
| `$ALLOW_DOCTOR_FIX` (optional) | `1` = run `hermes doctor --fix` (Step 4). Only after the user agreed to what Step 3 lists | Ask |
| `$GW_INTERRUPT` (optional) | `1` = interrupt live sessions when a reload needs it. Leave unset unless the user said so | Ask |
| `$NEW_KEY_NAME` / `$NEW_KEY_VALUE` (optional, `SYMPTOM=tools` only) | a tool-backend variable that `doctor` lists as missing, and its value | The vendor's dashboard; never paste it in chat |
| `$FIX_PATH` (optional, `SYMPTOM=command-not-found` only) | `1` = append the PATH line to `~/.bashrc` | Ask |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was written."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=hermes-fix
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
```

Rules for calling them (every skill follows these):

- A failure BEFORE `snapshot` (SSH check, Hermes check, diagnosis, key format check, declined dry run) is `exit 1` with
  `ABORT: ... Nothing was written.` — it does NOT call `rollback`.
- `snapshot` runs immediately before the first write (Step 4 or the key write in Step 5) and REFUSES when a snapshot dir already
  exists (a crashed run): run `rollback` first, then re-run.
- Every failure AFTER `snapshot` is `rollback; exit 1`.
- The last step calls `finish` after verification. `rollback` RESTORES the exact pre-skill `.env` and `config.yaml`; it never just deletes keys.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "DIAGNOSED: hermes is not reachable even with ~/.local/bin on PATH. Reinstall with /hermes-install. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5`. A host where `hermes` runs only after `~/.local/bin` is added to PATH (plain `ssh host hermes` fails,
`remote` works) is the `command-not-found` case: see Fix A in Step 5.

---

## Step 2 — diagnose (read-only), then decide whether there is anything to do

`doctor` is run as-is (no `--fix`), its output and exit status are kept, and `gateway status` and the gateway log are shown as information.

```bash
echo "--- diagnose: hermes doctor (exit status 1 = issues remain; outbound provider probes are normal) ---"
DOCTOR_RC=0
DOCTOR_OUT=$(remote 'hermes -p default doctor 2>&1') || DOCTOR_RC=$?
printf '%s\n' "$DOCTOR_OUT"
echo "(hermes doctor exit code: $DOCTOR_RC)"
echo "--- diagnose: gateway status (informational text, not a health verdict) ---"
remote 'hermes -p default gateway status' || echo "(gateway status exited $?)"
echo "--- diagnose: recent gateway log ---"
remote 'hermes -p default logs gateway -n 40' || echo "(logs gateway exited $?)"
ENV_OPEN=0
remote 'f="$HOME/.hermes/.env"; [ ! -e "$f" ] || [ "$(ls -ln "$f" | cut -c5-10)" = "------" ]' || ENV_OPEN=1
[ "$ENV_OPEN" = "0" ] || echo "FOUND: the .env file is readable by group or others, and it holds API keys. Step 4 sets it to mode 600."
```

Gate everything that would write, before any snapshot:

```bash
case "${SYMPTOM:-}" in
  ""|gateway-down|wedged|bot-silent|model-error|tools|oom|command-not-found|docker-chown|not-configured) ;;
  *) echo "ABORT: unknown SYMPTOM '${SYMPTOM}'. Nothing was written."; exit 1 ;;
esac
if [ -n "${NEW_KEY_NAME:-}" ] || [ -n "${NEW_KEY_VALUE:-}" ]; then
  secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
    local LC_ALL=C
    case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
    return 0
  }
  [ "${SYMPTOM:-}" = "tools" ] || { echo "ABORT: NEW_KEY_NAME and NEW_KEY_VALUE are only used with SYMPTOM=tools. Nothing was written."; exit 1; }
  name_ok() {  # UPPER_SNAKE_CASE only, in the C locale so ranges mean ASCII
    local LC_ALL=C
    case "$1" in ""|[!A-Z]*|*[!A-Z0-9_]*) return 1 ;; esac
    return 0
  }
  name_ok "${NEW_KEY_NAME:-}" || { echo "ABORT: NEW_KEY_NAME must be an UPPER_SNAKE_CASE variable name. Nothing was written."; exit 1; }
  secret_chars_ok "${NEW_KEY_VALUE:-}" \
    || { echo "ABORT: NEW_KEY_VALUE is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
  printf '%s\n' "$DOCTOR_OUT" | grep -qF -- "$NEW_KEY_NAME" \
    || { echo "ABORT: hermes doctor did not list $NEW_KEY_NAME as missing. This skill only sets a variable doctor names; use the vendor's integration skill otherwise. Nothing was written."; exit 1; }
fi
if [ "$DOCTOR_RC" = "0" ] && [ "$ENV_OPEN" = "0" ] && [ -z "${SYMPTOM:-}" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Nothing to fix: hermes doctor found no issues and the .env file is private."
  echo "That does not cover whether the gateway is running or the bot answers: doctor does not check either, and the status text above is only information."
  echo "If something is still wrong, rerun with SYMPTOM=gateway-down, wedged, bot-silent, model-error, tools, oom, command-not-found or docker-chown (or FORCE=1)."
  exit 0
fi
```

`doctor` lists numbered issues; read them before choosing a symptom. Rows saying `(not configured)` for a provider you do not use are warnings and
are not counted as issues (`hermes_cli/doctor_connectivity.py:123-141`); see Fix H.

---

## Step 3 — DRY RUN preview (always show before changing anything)

```bash
cat <<EOF
DRY RUN — planned on $VPS_USER@$VPS_IP (symptom: ${SYMPTOM:-none, follow doctor}; doctor exit code: $DOCTOR_RC; .env too open: $ENV_OPEN):
  1. Native safety net: hermes backup --quick --label hermes-fix  (state.db, config.yaml, .env, auth.json, cron jobs, pairing)
  2. hstack snapshot of ~/.hermes/.env and config.yaml (rollback restores them byte for byte; it does NOT cover state.db)
  3. chmod 600 ~/.hermes/.env when group or others can read it
  4. hermes doctor --fix  ONLY with ALLOW_DOCTOR_FIX=1 (now: ${ALLOW_DOCTOR_FIX:-0}). It may create .env, migrate config.yaml, drop a stale
     HERMES_MAX_ITERATIONS from .env, repair state.db or checkpoint its WAL (with backups beside it) and recreate the ~/.local/bin/hermes link
  5. The symptom fix of Step 5 (${SYMPTOM:-none})
  6. A gateway reload through gw_reload, only if .env or config.yaml changed content; then hermes doctor again to show what remains
No cron job or crontab entry is created, no pid/lock file is deleted, no process is killed, no secret is printed.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), continue. `AUTO_APPROVE=1` does **not** stand in for `ALLOW_DOCTOR_FIX=1`.

---

## Step 4 — snapshot and the native repairs (consent-gated)

```bash
SNAP=0
ensure_snapshot() {
  [ "$SNAP" = "1" ] && return 0
  snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
  SNAP=1
}
fail_out() {  # fail_out MESSAGE: report, restore the pre-skill files when a snapshot exists, stop
  echo "$1"
  if [ "$SNAP" = "1" ]; then rollback; fi
  exit 1
}
NEED_WRITE=0
[ "$ENV_OPEN" = "1" ] && NEED_WRITE=1
[ "${ALLOW_DOCTOR_FIX:-0}" = "1" ] && [ "$DOCTOR_RC" != "0" ] && NEED_WRITE=1
if [ "$NEED_WRITE" = "1" ]; then
  remote 'hermes -p default backup --quick --label hermes-fix' \
    || { echo "ABORT: the native quick snapshot failed, so no repair was started. Nothing was written."; exit 1; }
  ensure_snapshot
fi
if [ "$ENV_OPEN" = "1" ]; then
  remote 'chmod 600 ~/.hermes/.env' || fail_out "FAIL: chmod 600 on the .env file failed."
fi
if [ "${ALLOW_DOCTOR_FIX:-0}" = "1" ] && [ "$DOCTOR_RC" != "0" ]; then
  echo "--- repair: hermes doctor --fix ---"
  FIX_OUT=$(remote 'hermes -p default doctor --fix 2>&1') || true
  printf '%s\n' "$FIX_OUT"
  case "$FIX_OUT" in *"Traceback (most recent call last)"*) fail_out "FAIL: doctor --fix crashed." ;; esac
  remote 'if [ -f ~/.hermes/.env ]; then chmod 600 ~/.hermes/.env; fi' || fail_out "FAIL: chmod 600 on the .env file failed."
elif [ "$DOCTOR_RC" != "0" ]; then
  echo "doctor --fix was NOT run: it needs ALLOW_DOCTOR_FIX=1, set only after the user agreed to the repairs listed in Step 3."
fi
```

`doctor --fix` creates a missing `.env` with mode 600 but does not tighten an existing one; the `chmod 600` lines do
(`hermes_cli/doctor_config.py:171-200`). Its own exit status is informational: it stays 1 while manual issues remain, so the skill reads
the report and the second `doctor` run in Step 6 instead of treating a non-zero status as failure. The native quick snapshot is an extra
safety net (restoring it is a `/snapshot restore <id>` inside a Hermes session, `hermes_cli/backup.py:2081-2094`); hstack's snapshot is the
headless restore for `.env` and `config.yaml`.

---

## Step 5 — the symptom fix

Pick by `SYMPTOM`. Each block does nothing for other symptoms. Fixes that only read, or only explain, say so.

### Fix A — `command-not-found`: hermes is missing from PATH in plain ssh shells

```bash
if [ "${SYMPTOM:-}" = "command-not-found" ]; then
  echo "--- fix A: where hermes is, and what a plain ssh shell sees ---"
  remote 'ls -l "$HOME/.local/bin/hermes"' || echo "(no ~/.local/bin/hermes: reinstall with /hermes-install; doctor cannot recreate a launcher that points nowhere)"  # hermes-parse: skip (a file path, not a hermes command)
  ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" 'command -v hermes' || echo "(a plain ssh shell does not find hermes: ~/.local/bin is not on its PATH)"
  if [ "${FIX_PATH:-0}" = "1" ]; then
    ensure_snapshot
    remote 'bash -s' <<'REMOTE' || fail_out "FAIL: could not append the PATH line."
grep -qF '.local/bin' "$HOME/.bashrc" 2>/dev/null || printf '\n%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
REMOTE
    echo "Added the PATH line to ~/.bashrc (new shells only; the snapshot does not cover this file)."
  else
    echo "Not editing ~/.bashrc: set FIX_PATH=1 after the user agreed. 'hermes doctor --fix' recreates a missing ~/.local/bin/hermes link and prints this PATH hint itself."
  fi
fi
```

Doctor's own check is `hermes_cli/doctor_platform.py:588-658`: it verifies the launcher entry point and the `~/.local/bin/hermes` link, repairs the link
with `--fix` and tells you to add `~/.local/bin` to PATH. Never `sudo` to repair the install; reinstall as the target user with `/hermes-install`.
Interactive shells need the PATH line; the skills here do not (`remote()` exports it for every call).

### Fix B — `gateway-down` and `wedged`: native start or native restart

`gateway ensure` starts an installed service or spawns an unmanaged gateway, and exits 0 only when the gateway is ready. A gateway that is
up but unresponsive needs the drain-aware restart. Both are the shared helpers; stale pid and lock files are handled by the native commands, so nothing
is deleted by hand.

```bash
case "${SYMPTOM:-}" in
  gateway-down)
    echo "--- fix B: gateway ensure (starts one when none is running; never installs a service) ---"
    if ! gw_ready 60; then
      remote 'hermes -p default logs gateway -n 60' || true
      fail_out "FAIL: gateway ensure did not report a ready gateway (state and reason_code above; the exit-code table is in /hermes-restart Step 6). Nothing was deleted or killed."
    fi ;;
  wedged)
    echo "--- fix B: native restart of an unresponsive gateway ---"
    if ! gw_reload; then
      remote 'hermes -p default logs gateway -n 60' || true
      fail_out "FAIL: the reload failed or was refused (live sessions: rerun with GW_INTERRUPT=1 only if interrupting them is acceptable)."
    fi ;;
esac
```

If a refusal says live sessions, or the output names a service manager, read it: `/hermes-restart` explains each refusal and why `--force`, `--all`,
`gateway stop` and deleting pid files are not the answer. A gateway that restarts but is down again in minutes: read `logs gateway` and
`~/.hermes/logs/gateway-stdio.log` (the launch's own output, `hermes_cli/gateway_runtime_start.py:70-101`) for the startup error.

### Fix C — `bot-silent`: read the log and the pairing list (read-only)

```bash
if [ "${SYMPTOM:-}" = "bot-silent" ]; then
  echo "--- fix C: unauthorized-user lines in the gateway log ---"
  remote "hermes -p default logs gateway -n 200 | grep -i 'unauthorized user' | tail -n 10" || echo "(no 'Unauthorized user' lines in the last 200 log lines)"
  echo "--- fix C: platform rows ---"
  remote 'hermes -p default status --full' || echo "(hermes status exited $?)"
  echo "--- fix C: pairing (pending requests and approved users) ---"
  remote 'hermes -p default pairing list' || echo "(pairing list exited $?)"
  echo "NOTE: hermes pairing approve <platform> <request-id> grants a person access to the bot. It is the user's decision; this skill never runs it."
fi
```

A message from someone who is not authorized gets, by default, a pairing code in a DM (`unauthorized_dm_behavior` is `pair`:
`gateway/config.py:645`, `gateway/run_inbound.py:215-240`); with `ignore` the sender gets nothing and the log says `Unauthorized user (ignored)`. So a silent bot
usually means the sender is not on the allowlist (`TELEGRAM_ALLOWED_USERS` holds numeric user ids) or the platform is not configured. Do not
approve anyone yourself: `hermes pairing approve <platform> <request-id>` grants a person access to the bot, so show the pending list and let the user decide.
Allowlists and the Telegram token are `/platform-telegram`'s job.

### Fix D — `model-error`: a 400/401 from the model provider

```bash
if [ "${SYMPTOM:-}" = "model-error" ]; then
  echo "--- fix D: configured model (credentials are masked) ---"
  remote 'hermes -p default config get model.provider' || echo "(config get exited $?)"
  remote 'hermes -p default config get model.default' || echo "(config get exited $?)"
  echo "--- fix D: the doctor rows about the model and the providers ---"
  printf '%s\n' "$DOCTOR_OUT" | grep -iE 'model|provider|api' || echo "(doctor printed no model or provider row)"
fi
```

Doctor validates `model.provider`/`model.default` against the provider registry and probes each configured provider
(`hermes_cli/doctor_config.py:_validate_model_config`, `hermes_cli/doctor_connectivity.py:123-165`): a model name from another provider, a missing key, an
invalid key (401), no credits (402) or a rate limit (429) show up there. The repair is `/hermes-model`, which checks the key with a live call before it writes.
This skill never writes a provider key.

### Fix E — `tools`: a tool backend reports a missing variable, or an auxiliary task silently uses the main model

At v0.22.5 an auxiliary task set to `auto` uses the main chat model, and web extraction is not an auxiliary task at all
(`website/docs/user-guide/configuration.md`, "Auxiliary Models"), so "add the auxiliary provider key" is no longer the usual cure. Read the
doctor rows first: **Tool Availability** lists `(missing VARIABLE)` per toolset, and the config check reports an explicitly routed
`auxiliary.<task>.provider` that does not resolve ("the task silently runs on the main model",
`hermes_cli/doctor_config.py:308-332`, `hermes_cli/doctor_tools.py:504-530`).

```bash
if [ "${SYMPTOM:-}" = "tools" ]; then
  echo "--- fix E: tool and auxiliary rows from the doctor report ---"
  printf '%s\n' "$DOCTOR_OUT" | grep -iE 'missing|not configured|auxiliary|provider' || echo "(doctor printed no tool or auxiliary row)"
  if [ -n "${NEW_KEY_NAME:-}" ]; then
    ensure_snapshot
    printf '%s\n' "$NEW_KEY_VALUE" \
      | remote "IFS= read -r v && hermes -p default config set $NEW_KEY_NAME \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env" \
      || fail_out "FAIL: could not write $NEW_KEY_NAME."
    WROTE=$(remote "grep -c '^$NEW_KEY_NAME=' ~/.hermes/.env || true")
    [ "$WROTE" = "1" ] || fail_out "FAIL: $NEW_KEY_NAME was not written exactly once (found ${WROTE:-0})."
  else
    echo "No variable was written (NEW_KEY_NAME is empty). An auxiliary routing problem is fixed under auxiliary.<task> in config.yaml (hermes model, 'Configure auxiliary models')."
  fi
fi
```

There is no side-effect-free vendor endpoint this skill can call for an arbitrary tool key, so there is **no live preflight before the write**: the
previous value is protected by the snapshot, and `doctor --live` in Step 6 is the check afterwards (one bounded, read-only call per configured
tool backend; it makes real network calls). `config set` routes an UPPER_SNAKE name to `.env` and does not echo the value
(`hermes_cli/config.py:3417-3440`). The value is not on any command line locally; on the VPS it is briefly in the `hermes` process argv (the accepted trade-off).

### Fix F — `oom`: the gateway grows until the kernel kills it (diagnosis; no nightly restart)

```bash
if [ "${SYMPTOM:-}" = "oom" ]; then
  echo "--- fix F: hermes processes (pid, elapsed, rss in KB) ---"
  remote "ps -eo pid,etime,rss,comm | grep '[h]ermes'" || echo "(no process named hermes found)"
  echo "--- fix F: gateway status (shows the service manager when a service is installed; informational) ---"
  remote 'hermes -p default gateway status' || echo "(gateway status exited $?)"
  echo "--- fix F: the per-session agent cache settings that bound gateway memory ---"
  remote 'hermes -p default config get agent.agent_cache' || echo "(config get exited $?)"
  echo "--- fix F: errors log ---"
  remote 'hermes -p default logs errors -n 40' || echo "(logs errors exited $?)"
  echo "NOTE: no nightly restart is installed or offered: native cron refuses jobs that restart or stop the gateway, and the installed service unit has Restart=always (see Fix F)."
fi
```

The old copy of this skill installed a root crontab entry that ran `gateway stop` at 04:00 and then started the gateway with a `--daemon` flag. That is removed, not
replaced: the `--daemon` flag does not exist (argparse rejects it, exit 2), so the job would stop the gateway every night and fail to start it, and v0.22.5's own cron
refuses jobs that restart or stop the gateway (`cron/lifecycle_guard.py:30-67`, enforced by `cron.jobs.create_job`) because that loops. No
scheduled restart is offered at all. What v0.22.5 gives instead:

- The installed service (`hermes gateway install`, or `INSTALL_SERVICE=1` in `/hermes-restart`) runs the gateway under a unit with `Restart=always` and `RestartSec=5`
  (`hermes_cli/gateway.py:3262-3290`), so a gateway killed by the OOM killer returns in about five seconds. Without a service nothing brings it back: `gateway ensure` or
  `/hermes-restart` starts it again.
- The gateway keeps a per-session agent cache bounded by `agent.agent_cache.max_size` (128), `idle_ttl_secs` (3600) and a resident-memory budget
  `memory_high_mb` (`"auto"`, derived from the cgroup limit or total RAM) above which least-recently-used transcripts are shed
  (`hermes_cli/config_defaults.py:75-106`). On a small VPS a lower `max_size` is the native lever; changing it is the user's decision
  (`hermes -p default config set agent.agent_cache.max_size 64`, then `/hermes-restart`).
- `gateway status` appends "Recent gateway health" warnings (stale heartbeat, wedged loop, startup failure) when the gateway's state file says so
  (`hermes_cli/gateway.py:4698-4750`).

This skill found no source evidence at v0.22.5 for or against a particular memory-growth bug, so it states none. If RSS keeps growing, record the
numbers above over time and tell the user; a planned `/hermes-restart` is the stop-gap.

### Fix G — `docker-chown`: `chown ... not permitted` in a container

```bash
if [ "${SYMPTOM:-}" = "docker-chown" ]; then
  echo "--- fix G: the host user and the owner of ~/.hermes (numeric) ---"
  remote 'id -u; id -g; ls -ldn "$HOME/.hermes"' || echo "(could not read the ids)"
fi
```

`HERMES_UID` and `HERMES_GID` are **container environment variables**, read by the image's entrypoint (`docker/stage2-hook.sh:98-110`, aliases `PUID`/`PGID`),
so they do not belong in `~/.hermes/.env`. Start the container as root (the default), not with `--user`, and pass the host ids when it is created:
`docker run -e HERMES_UID=$(id -u) -e HERMES_GID=$(id -g) ...` (the entrypoint prints exactly this in its `--user` error, `docker/main-wrapper.sh:40-62`). Recreating a
container is the deploy skill's job; this skill does not touch containers.

### Fix H — `not-configured`: a `(not configured)` row in doctor

No command. Read the row: `(not configured)` next to a provider or tool you do not use is a warning and adds nothing to the issue list
(`hermes_cli/doctor_connectivity.py:123-141`; a toolset with a missing variable does add one, see Fix E). For an MCP server, the arbiter is
`hermes -p default mcp test <name>` (exit 0 connected), not the doctor row. Do not "fix" it by rewriting MCP configuration.

---

## Step 6 — reload if the files changed, verify, finish

The gateway re-reads `.env` at start and per turn, but `config.yaml` and MCP changes need a restart, so the skill reloads once, only when the content of
`.env` or `config.yaml` differs from the snapshot (a mode change alone needs no reload).

```bash
CHANGED=0
if [ "$SNAP" = "1" ]; then
  CHANGED=$(remote 'd=$HOME/.hermes/.hstack-backup/hermes-fix; c=0; for f in .env config.yaml; do if [ -f "$d/$f" ]; then cmp -s "$d/$f" "$HOME/.hermes/$f" || c=1; elif [ -e "$HOME/.hermes/$f" ]; then c=1; fi; done; echo $c') \
    || fail_out "FAIL: could not compare the files with the snapshot."
fi
if [ "$CHANGED" = "1" ]; then
  echo "--- reload: .env or config.yaml changed content ---"
  gw_reload || fail_out "FAIL: the gateway did not restart ready after the repair. Restoring the previous files."
fi
```

```bash
if [ "$SNAP" = "1" ]; then
  echo "--- verify: hermes doctor again ---"
  FINAL_RC=0
  remote 'hermes -p default doctor 2>&1' || FINAL_RC=$?
  echo "(hermes doctor exit code after the repair: $FINAL_RC. 1 means issues remain; they are listed above for the user.)"
  if [ "${SYMPTOM:-}" = "tools" ]; then
    echo "--- verify: hermes doctor --live (one read-only call per tool backend; real network calls) ---"
    remote 'hermes -p default doctor --live 2>&1' || echo "(doctor --live exited $?: read the backend rows; if the new key is rejected, run rollback)"
  fi
  finish || exit 1
else
  echo "No file was changed, so there is nothing to reload or verify with doctor."
fi
echo "DONE: report the doctor output above. A repaired config is not proof that the bot answers: ask the user to send one test message."
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/hermes-fix.prev` for a manual undo (see Rollback).

---

## Rollback

Defined once, in Step 0. It runs automatically (`fail_out` calls it) on every failure after `snapshot`. It does not delete keys; it RESTORES the exact
pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/hermes-fix/` (a file that did not exist before is
  removed), `.env` is set to `chmod 600`, and the gateway is reloaded with `gw_reload`; only then does the snapshot move to `hermes-fix.prev`.
  If the gateway does not come back ready, `rollback` prints `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero:
  read `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused because of live sessions is the same case
  (`GW_INTERRUPT=1` only if interrupting them is acceptable).
- It does **not** undo `doctor --fix` work outside those two files: a repaired `state.db` keeps the backup `doctor` left beside it, and the native quick snapshot
  (`~/.hermes/state-snapshots/`) restores with `/snapshot restore <id>` inside a Hermes session. It does not undo a `~/.bashrc` edit.

Failures before `snapshot` wrote nothing. If a run is interrupted after `snapshot`, the next `snapshot` refuses to run; call `rollback` first.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

Never wipe `~/.hermes` to "reset": that destroys memory, allowlists and sessions. The `.prev` folder holds the previous `.env` (old secrets) at mode 600; delete it once you no
longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating `gateway status` text as health (grep `running`) | `✗ Gateway is not running` contains `running`; doctor does not check the gateway either | `gw_ready` (`gateway ensure --json` exit 0 and `"state":"ready"`); status text is information |
| 2 | A nightly cron that stops the gateway and starts it with `--daemon` | `--daemon` does not exist, so the job stops the gateway every night and cannot start it; native cron refuses restart/stop jobs | none is installed; the service unit has `Restart=always` |
| 3 | `doctor --fix` as a reflex | it edits `.env`/`config.yaml`, can repair `state.db` and the launcher link; only two of those are in the snapshot | `ALLOW_DOCTOR_FIX=1` after the user agreed; quick backup first |
| 4 | Gating on `doctor`'s exit status alone | non-zero means issues remain (including warnings you may accept), zero says nothing about the running gateway | read the report; check the gateway through `gw_ready` when it matters |
| 5 | Deleting pid/lock files or `pkill`ing | `restart`/`ensure` replace stale owners; hand deletion is profile-blind | read the refusal, see `/hermes-restart` |
| 6 | `echo >> ~/.hermes/.env` to add a key | can merge onto a line without a trailing newline | `config set` over stdin (Fix E) |
| 7 | A secret in `config.yaml` or on a command line | world-readable or visible in `ps` | `.env` only, mode 600; the value travels over ssh stdin |
| 8 | Putting `HERMES_UID`/`HERMES_GID` in `~/.hermes/.env` | they are read from the container environment by the entrypoint | `docker run -e HERMES_UID=... -e HERMES_GID=...` at container creation |
| 9 | Treating `(not configured)` as a failure | warnings for providers you do not use add no issue | read which row, see Fix H |
| 10 | Approving a pairing request to make the bot "work" | it grants a person access | show the pending list; the user decides |
| 11 | Wiping `~/.hermes` | destroys memory, allowlists, sessions | never; `rollback` restores the two files |
| 12 | Container vs host confusion | `hermes` inside a container is invisible to the host | `whoami; hostname` first: a hex hostname means a container |
| 13 | Fresh shell per command | Step 0 functions are undefined later | re-run the Step 0 block first |
| 14 | Reloading after a mode-only change | needless restart interrupts chats | Step 6 compares content with the snapshot |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (`0.22.5`)
- [ ] `hermes doctor` was the first diagnostic; its output and exit status were shown; gateway status text was shown as information only
- [ ] A clean doctor report with no symptom ended the run early without claiming the gateway healthy
- [ ] Dry run shown; user approved (or `AUTO_APPROVE=1`); `doctor --fix` ran only with `ALLOW_DOCTOR_FIX=1`
- [ ] Native quick backup and hstack snapshot taken before the first write; no write happened before them
- [ ] `.env` is mode 600; any new secret was written over stdin with `config set` and is NOT in `config.yaml` and NOT echoed in chat
- [ ] Gateway reloaded with `gw_reload` (ready, new instance) only when `.env`/`config.yaml` content changed
- [ ] No crontab or cron job was created, no pid/lock file deleted, no process killed
- [ ] `doctor` was rerun after the repair and what remains was reported; `finish` ran, or `rollback` restored the pre-fix files

---

## Verified against Hermes v0.22.5

Read in the tagged source (`NousResearch/hermes-agent` at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`), paths relative to the repo root:

- `hermes_cli/subcommands/doctor.py:10-25` (`--fix`, `--live`, `--ack`), `hermes_cli/doctor.py:148-166,172-194` (summary and exit status),
  `hermes_cli/main.py:1837,3550-3554` (the status is forwarded as the process exit code).
- `hermes_cli/doctor_config.py:171-200` (missing `.env` is created with mode 600, an existing one is not changed), `:308-332` (auxiliary routing),
  `:357-430` (config migration, stale root keys, `HERMES_MAX_ITERATIONS`), `hermes_cli/doctor_state.py:293-318,342-363,422-470` (`state.db` write probe, repair, WAL
  checkpoint), `hermes_cli/doctor_platform.py:254-280,588-658` (linger check, launcher link), `hermes_cli/doctor_tools.py:504-530`, `hermes_cli/doctor_connectivity.py:123-165`.
- `hermes_cli/subcommands/gateway.py:70-215`, `hermes_cli/gateway.py:3262-3290` (unit text: `Restart=always`, `RestartSec=5`), `:4698-4750`, `:5454-5536`, `:5579-5650`;
  `hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`, `hermes_cli/gateway_lifecycle_guards.py:81-129` (see `/hermes-restart`).
- `cron/lifecycle_guard.py:30-67` (cron jobs that restart, stop or kill the gateway are rejected), `hermes_cli/config_defaults.py:75-123`.
- `gateway/config.py:645`, `gateway/run_inbound.py:215-240`, `hermes_cli/pairing.py:22-53` (unauthorized users and `pairing list`).
- `hermes_cli/backup.py:2081-2094` (`backup --quick --label`), `hermes_cli/config.py:3417-3440` (`config set` routing, value not echoed),
  `docker/stage2-hook.sh:36-110`, `docker/main-wrapper.sh:30-62` (`HERMES_UID`/`HERMES_GID` are `docker run -e` variables).
- `gateway/run.py:1583-1600`: `.env` is loaded when the gateway starts and reloaded per turn outside multiplex mode.

Not verified: nothing was run against a real Hermes host, a real Docker container or a real provider. Upstream issue numbers quoted by the old copy of this skill
(a "not configured" cosmetic row, an RSS leak, a Docker image tag) could not be confirmed or refuted from the tagged source and are not repeated. The stub the tests use reproduces the command
syntax of v0.22.5 but invents behaviour.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for the full symptom -> cause -> fix catalogue.
