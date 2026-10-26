---
name: hermes-backup
description: Back up a self-hosted Hermes v0.22.5 agent over SSH with the native `hermes backup` (full zip or quick state snapshot), verify the archive, and restore it only behind an explicit gate. Use before risky changes; schedule recurring runs with /hermes-cron. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-backup — back up (and, behind a gate, restore) a remote Hermes (SSH-first)

You are the engineer taking a backup of the user's self-hosted Hermes Agent on their VPS.
The agent (Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to
a remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly
macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0, which wraps `ssh`
and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Run all blocks in ONE shell
session: later steps call the Step 0 functions.

Do everything autonomously; stop only for what a machine cannot do: choose where backups
live, and say yes to a restore.

**What Hermes backs up for you, and what it does not (v0.22.5, read from source).**

- `hermes update` takes a **pre-update quick snapshot by default** (`updates.pre_update_backup: quick`, keeps the
  newest one); `hermes update --backup` adds a full zip in `~/.hermes/backups/` (`updates.backup_keep`, default 5) and
  `--no-backup` skips both. That is the only automatic backup. Nothing is scheduled, so a nightly or weekly archive is
  something you set up with `/hermes-cron` (this skill never installs cron).
- `hermes backup` is the manual one. A **full** backup is a zip of the whole Hermes home: config, `.env`, `auth.json`,
  `state.db` (sessions and memory, copied with SQLite's own backup API, never as a torn file), cron jobs, pairing, skills.
  It leaves out the `hermes-agent` checkout, virtualenvs, caches, `backups/`, `state-snapshots/`, `checkpoints/`,
  browser profiles and SQLite `-wal/-shm` sidecars. A **quick** backup (`--quick --label NAME`) copies only the
  critical state files into `~/.hermes/state-snapshots/<id>/`.
- **Restore is the hard part.** A full zip is restored headlessly by `hermes import ZIP --force`, which overwrites the
  WHOLE home (sessions included) and refuses to run while a gateway owns it. A quick snapshot can only be restored
  inside an interactive Hermes session with the `/snapshot restore <id>` slash command; there is no `hermes snapshot`
  CLI. For undoing one hstack skill run, each skill's own Rollback restores only `.env` and `config.yaml`
  from `~/.hermes/.hstack-backup/<skill>.prev`; that is the narrow tool, this skill's restore is the wide one.
- **Secrets.** Every archive holds `.env`, `auth.json` and your sessions. The zip is NOT encrypted. This skill keeps
  it in a `0700` directory with mode `0600`, never prints it, and does **not** push it to GitHub or any git remote: git
  history cannot be unpublished, a zip is not encrypted, and the hstack contract is that secrets only ever travel to
  the VPS over ssh stdin. The only off-box option is an explicit `rsync` to a host the user owns (Step 7).

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$BACKUP_MODE` | `full` (zip, default) or `quick` (state snapshot) | User's choice |
| `$BACKUP_DIR` | Absolute directory on the VPS for full archives (default `$HOME/hermes-backups`; never inside `~/.hermes`) | User's choice; needs free disk |
| `$KEEP` | How many `hermes-backup-*.zip` the native retention keeps (default `7`; `0` keeps everything) | User's choice |
| `$LABEL` | Name for a quick snapshot (letters, digits, `.`, `_`, `-`) | Optional |
| `$OFFBOX_TARGET` | Optional `user@host:/path/` that `rsync` may copy the archive to | A host the user owns |
| `$RESTORE_FROM` | Restore only: absolute path of a `.zip` on the VPS | Output of a previous run |

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
SKILL_NAME=hermes-backup
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
```

This skill never writes `.env` or `config.yaml`, so it carries no `snapshot`/`rollback`: a backup is read-only for Hermes,
and a restore is undone from the safety backup it takes first (Restore 3). `gw_reload` is defined with the other shared
helpers and is not used here: the restore path only needs `gw_ready`.

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
  The foreground command is `gateway run`; no daemon flag exists on any gateway subcommand.

---

## Step 0b — archive helpers (local shell functions)

`check_archive` is the independent check of an archive: readable, non-empty, a valid zip and shaped like a Hermes home (the
same markers `hermes import` itself requires), with the mode forced to `0600`. `resolve_backup_dir` fixes `BACKUP_DIR`.

```bash
# resolve_backup_dir: default $HOME/hermes-backups on the VPS; absolute, plain characters, and never inside ~/.hermes
# (a directory in the Hermes home would be archived into the next backup; ~/.hermes/backups is the native exception).
resolve_backup_dir() {
  local rh
  rh=$(remote 'printf %s "$HOME"') || return 1
  BACKUP_DIR="${BACKUP_DIR:-$rh/hermes-backups}"
  case "$BACKUP_DIR" in
    /*) ;;
    *) echo "ABORT: BACKUP_DIR must be an absolute path on the VPS (got: $BACKUP_DIR). Nothing was written." >&2; return 1 ;;
  esac
  case "$BACKUP_DIR" in
    *[!A-Za-z0-9_./-]*|*..*) echo "ABORT: BACKUP_DIR has unexpected characters (letters, digits, / . _ - only, no ..). Nothing was written." >&2; return 1 ;;
  esac
  case "$BACKUP_DIR/" in
    "$rh/.hermes/backups/"*) ;;
    "$rh/.hermes/"*) echo "ABORT: BACKUP_DIR is inside ~/.hermes, so every backup would contain the previous ones. Nothing was written." >&2; return 1 ;;
  esac
}
# check_archive PATH: zip integrity (unzip, else python3), Hermes markers, mode 0600. Never prints archive contents.
check_archive() {
  remote "A='$1' bash -s" <<'REMOTE'
set -e
[ -f "$A" ] && [ -s "$A" ] || { echo "check_archive: $A is missing or empty." >&2; exit 1; }
m=$(stat -c %a "$A" 2>/dev/null || stat -f %Lp "$A")
[ "$m" = 600 ] || chmod 600 "$A"
if command -v unzip >/dev/null 2>&1; then
  unzip -tq "$A" >/dev/null 2>&1 || { echo "check_archive: zip integrity check failed for $A." >&2; exit 1; }
  names=$(unzip -Z1 "$A")
elif command -v python3 >/dev/null 2>&1; then
  names=$(python3 -I -c 'import sys,zipfile
z = zipfile.ZipFile(sys.argv[1])
sys.exit(3) if z.testzip() is not None else print("\n".join(z.namelist()))' "$A") \
    || { echo "check_archive: zip integrity check failed for $A." >&2; exit 1; }
else
  echo "check_archive: neither unzip nor python3 is installed, so the zip was not independently verified (the native writer only publishes after a clean close)." >&2
  exit 0
fi
printf '%s\n' "$names" | grep -Eq '(^|/)(config\.yaml|\.env|state\.db)$' \
  || { echo "check_archive: $A does not look like a Hermes backup (no config.yaml, .env or state.db inside)." >&2; exit 1; }
REMOTE
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

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked
against the v0.22.5 source; it has not been run against a live host. If you are inside a container, `whoami; hostname`
shows a hex hostname: run the commands on the Docker host instead (the Hermes home is a volume there).

---

## Step 2 — validate inputs locally, then survey the size (read-only)

Everything is checked before the first remote write. The values end up inside single-quoted remote commands, so only plain
characters are accepted.

```bash
BACKUP_MODE="${BACKUP_MODE:-full}"
KEEP="${KEEP:-7}"
case "$BACKUP_MODE" in full|quick) ;; *)
  echo "ABORT: BACKUP_MODE must be full or quick (got: $BACKUP_MODE). Nothing was written."; exit 1 ;;
esac
case "$KEEP" in ""|*[!0-9]*)
  echo "ABORT: KEEP must be a non-negative integer, 0 keeps everything (got: $KEEP). Nothing was written."; exit 1 ;;
esac
case "${LABEL:-}" in *[!A-Za-z0-9._-]*)
  echo "ABORT: LABEL may contain only letters, digits, dot, underscore and dash. Nothing was written."; exit 1 ;;
esac
if [ -n "${OFFBOX_TARGET:-}" ]; then
  case "$OFFBOX_TARGET" in
    git:*|http:*|https:*|s3:*|gs:*|ssh:*|-*|*[!A-Za-z0-9_.@:/~+-]*)
      echo "ABORT: OFFBOX_TARGET must be an rsync target like user@host:/path/ (no URL, no git host, no spaces or shell characters). Nothing was written."; exit 1 ;;
  esac
fi
resolve_backup_dir || exit 1
remote 'du -sh "$HOME/.hermes" 2>/dev/null; df -Ph "$HOME" | tail -n 1'
```

The `du` figure is the raw home; the zip is smaller (deflate, and the excluded trees above are not counted into it). A full
disk fails the native command cleanly: it writes to a hidden `.partial` file and renames it only after a clean close
(`hermes_cli/backup.py:221-239`), so no half-archive is ever published under the final name.

---

## Step 3 — idempotency check (full mode: skip if there is already a backup from today)

```bash
if [ "$BACKUP_MODE" = full ] && [ "${FORCE:-0}" != 1 ]; then
  TODAY=$(remote 'date +%F')
  HAVE=$(remote "ls -1 '$BACKUP_DIR' 2>/dev/null | grep -c '^hermes-backup-$TODAY-.*[.]zip\$' || true")
  if [ "${HAVE:-0}" -gt 0 ]; then
    echo "A backup from $TODAY already exists in $BACKUP_DIR ($HAVE archive(s)). Re-run with FORCE=1 to take another."
    exit 0
  fi
fi
```

The native name is `hermes-backup-YYYY-MM-DD-HHMMSS.zip`, so the date match needs no hand-made naming scheme.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) inputs validated, Hermes 0.22.5 confirmed, nothing written yet
  1. Mode: $BACKUP_MODE
  2. full : umask 077, mkdir -p $BACKUP_DIR (0700), then
            hermes -p default backup -o $BACKUP_DIR -k $KEEP
            (native zip of ~/.hermes, SQLite-safe; the native retention keeps the newest $KEEP hermes-backup-*.zip, 0 = all)
     quick: hermes -p default backup --quick${LABEL:+ --label $LABEL}   (critical state files into ~/.hermes/state-snapshots/)
  3. Verify the result (zip integrity, Hermes markers, mode 0600); nothing in ~/.hermes is modified
  4. Off-box copy: ${OFFBOX_TARGET:-none}  (rsync only; the zip is NOT encrypted and contains your secrets)

The archive will NEVER be printed and is not pushed to GitHub or any other git host.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — take the backup with the native command

`umask 077` makes the archive private from the first byte (the native writer does not chmod a full zip); the directory is
`0700`. The native exit codes are honoured: `0` complete, `1` an archive was kept but some file could not be added (or a hard
error), `2` another Hermes backup holds the lock (`hermes_cli/main.py:2185-2192`, `hermes_cli/backup.py:590-609`).

```bash
if [ "$BACKUP_MODE" = quick ]; then
  OUT=$(remote "hermes -p default backup --quick${LABEL:+ --label '$LABEL'}" 2>&1) \
    || { printf '%s\n' "$OUT"; echo "FAIL: hermes backup --quick failed."; exit 1; }
  printf '%s\n' "$OUT"
  SNAPSHOT_ID=$(printf '%s\n' "$OUT" | sed -n 's/^State snapshot created: //p' | head -n 1)
  case "$SNAPSHOT_ID" in ""|*[!A-Za-z0-9._-]*)
    echo "FAIL: hermes backup --quick reported no snapshot id (no state files to snapshot?)."; exit 1 ;;
  esac
else
  remote "umask 077; mkdir -p '$BACKUP_DIR' && chmod 700 '$BACKUP_DIR'" \
    || { echo "FAIL: could not create $BACKUP_DIR."; exit 1; }
  RC=0
  OUT=$(remote "umask 077; hermes -p default backup -o '$BACKUP_DIR' -k $KEEP" 2>&1) || RC=$?  # hermes-parse: skip (-k takes the integer validated in Step 2)
  printf '%s\n' "$OUT"
  ARCHIVE=$(printf '%s\n' "$OUT" | grep -E '^Backup (complete|incomplete): ' | head -n 1 | sed 's/^Backup [a-z]*: //')
  case "$RC" in
    0) ;;
    2) echo "FAIL: another Hermes backup is running (the native lock is held). Wait for it, then re-run."; exit 1 ;;
    *) echo "FAIL: hermes backup exited $RC${ARCHIVE:+; an INCOMPLETE archive was kept at $ARCHIVE (some file could not be added), do not rely on it}."; exit 1 ;;
  esac
  [ -n "$ARCHIVE" ] || { echo "FAIL: hermes backup did not report an archive path."; exit 1; }
  case "$ARCHIVE" in *[!A-Za-z0-9_./-]*)
    echo "FAIL: the reported archive path has unexpected characters, so it will not be used in a remote command: $ARCHIVE"; exit 1 ;;
  esac
fi
```

`-o` is treated as a directory only when it already exists (the `mkdir` above); a missing directory without a `.zip` suffix
would silently become a file named `<dir>.zip` (`hermes_cli/backup.py:550-568`). `-k` prunes only `hermes-backup-*.zip` in that
directory, only after a COMPLETE archive, and never with `0`; archives you name yourself are never touched. Nothing here
deletes files by age, and there is no `tar`.

---

## Step 6 — verify the result

```bash
if [ "$BACKUP_MODE" = quick ]; then
  remote "test -d \"\$HOME/.hermes/state-snapshots/$SNAPSHOT_ID\"" \
    || { echo "FAIL: snapshot $SNAPSHOT_ID is not in ~/.hermes/state-snapshots."; exit 1; }
  echo "OK: state snapshot $SNAPSHOT_ID created (private, ~/.hermes/state-snapshots/$SNAPSHOT_ID)."
  echo "    Restore it only inside an interactive Hermes session: /snapshot restore $SNAPSHOT_ID (CLI only; there is no headless restore for a snapshot)."
else
  check_archive "$ARCHIVE" \
    || { echo "FAIL: the archive failed the integrity check or does not hold Hermes state: $ARCHIVE"; exit 1; }
  remote "ls -l '$ARCHIVE'"
  echo "Archive: $ARCHIVE"
  echo "OK: backup complete and verified. This archive contains your secrets (.env, auth.json, sessions): keep it private."
fi
```

---

## Step 7 — optional off-box copy (rsync only, explicit)

The archive on the VPS survives an accidental `rm` but not a lost disk. If, and only if, the user gave `$OFFBOX_TARGET`, copy
the verified archive with `rsync` over key-based ssh (`BatchMode`: it never prompts for a password). The VPS must already have
a key that the target accepts. The copy is an unencrypted zip, so the target must be as private as the VPS itself. GitHub,
other git hosts, S3-style URIs and HTTP uploads are deliberately not offered (see the secrets note above).

```bash
if [ -z "${OFFBOX_TARGET:-}" ]; then
  echo "NOTE: no OFFBOX_TARGET set; the archive exists only on this VPS (a lost disk loses it)."
elif [ "$BACKUP_MODE" = quick ]; then
  echo "NOTE: quick snapshots stay in ~/.hermes/state-snapshots; there is no archive to copy."
else
  remote "rsync -a --partial -e 'ssh -o BatchMode=yes' '$ARCHIVE' '$OFFBOX_TARGET'" \
    && echo "OK: copied $ARCHIVE to $OFFBOX_TARGET (unencrypted zip)." \
    || { echo "FAIL: the copy to $OFFBOX_TARGET failed; the verified archive is still on the VPS."; exit 1; }
fi
```

Recurring backups: create the schedule with `/hermes-cron` (a no-agent script job that runs `hermes backup -o DIR -k N`).
Do not add a root cron entry here.

---

## Restore — destructive, gated, with a safety backup (Restore 1 to 6)

A restore overwrites the **whole** Hermes home with the archive: config, `.env`, `auth.json`, cron jobs, pairing, skills and
**sessions** (anything recorded after the archive was taken is replaced; the native import reports a session count that
shrank). It keeps this host's runtime files (`gateway_state.json`, `gateway.pid`, `cron.pid`, `gateway.lock`,
`processes.json`) and never restores SQLite sidecars (`hermes_cli/backup.py:147-148,827-838,1017-1035`). It refuses while a gateway
owns the home (`gateway/runtime_ownership.py:253-281`), so the gateway is stopped first and brought back at the end.

Run `Step 0`, `Step 0b` and `Step 1` first. Nothing below runs without the gate in Restore 2.

### Restore 1 — validate the archive and show what will happen

```bash
case "${RESTORE_FROM:-}" in
  /*.zip) ;;
  *) echo "ABORT: RESTORE_FROM must be an absolute path to a .zip archive on the VPS. Nothing was changed."; exit 1 ;;
esac
case "$RESTORE_FROM" in *[!A-Za-z0-9_./-]*|*..*)
  echo "ABORT: RESTORE_FROM has unexpected characters (letters, digits, / . _ - only, no ..). Nothing was changed."; exit 1 ;;
esac
remote "test -f '$RESTORE_FROM'" \
  || { echo "ABORT: RESTORE_FROM not found on the VPS: $RESTORE_FROM. Nothing was changed."; exit 1; }
check_archive "$RESTORE_FROM" \
  || { echo "ABORT: $RESTORE_FROM failed the archive check. Nothing was changed."; exit 1; }
resolve_backup_dir || exit 1
cat <<EOF
RESTORE PREVIEW — nothing has been changed yet.
  Archive : $RESTORE_FROM
  Target  : the WHOLE ~/.hermes on $VPS_USER@$VPS_IP, not just .env/config.yaml
  Replaced with the archive's copies: config.yaml, .env, auth.json, state.db (sessions, memory), cron jobs, pairing, skills.
  Kept from this host: gateway_state.json, gateway.pid, cron.pid, gateway.lock, processes.json.
  Anything recorded after the archive was taken is lost from the files it replaces (for example newer sessions).
  Before anything changes: a full safety backup to $BACKUP_DIR/pre-restore-<time>.zip, then the gateway is stopped.
  To undo just one hstack skill run instead, use that skill's Rollback (it restores only .env and config.yaml).
EOF
```

### Restore 2 — the consent gate

Show the preview to the user and ask in chat. Set `RESTORE_ACKNOWLEDGED=1` only after an explicit yes about THIS archive.
`AUTO_APPROVE=1` is not consent for a restore and must not be used for it.

```bash
[ "${RESTORE_ACKNOWLEDGED:-}" = 1 ] || {
  echo "ABORT: a restore needs RESTORE_ACKNOWLEDGED=1, set only after the user said yes to the preview in chat. AUTO_APPROVE does not satisfy this gate. Nothing was changed."
  exit 1
}
```

### Restore 3 — safety backup of the current state

```bash
STAMP=$(remote 'date +%Y%m%d-%H%M%S') || exit 1
SAFETY="$BACKUP_DIR/pre-restore-$STAMP.zip"
remote "umask 077; mkdir -p '$BACKUP_DIR' && chmod 700 '$BACKUP_DIR'" \
  || { echo "ABORT: could not create $BACKUP_DIR. Nothing was changed."; exit 1; }
if ! SOUT=$(remote "umask 077; hermes -p default backup -o '$SAFETY'" 2>&1); then
  printf '%s\n' "$SOUT"
  echo "ABORT: the safety backup failed, so nothing was restored. Nothing was changed."
  exit 1
fi
check_archive "$SAFETY" || { echo "ABORT: the safety backup failed its check, so nothing was restored. Nothing was changed."; exit 1; }
echo "Safety backup: $SAFETY"
```

The name does not start with `hermes-backup-`, so the native `-k` retention never deletes it.

### Restore 4 — stop the gateway (the import refuses while it runs)

With live chats and no terminal, `gateway stop` refuses (exit 1) unless you pass `-y`; `GW_INTERRUPT=1` adds it
deliberately (`hermes_cli/gateway_lifecycle_guards.py:97-129`). If no gateway is running on purpose and `stop` exits
non-zero, set `GATEWAY_ALREADY_STOPPED=1` to skip this step; the import still refuses by itself if a gateway owns the home.

```bash
if [ "${GATEWAY_ALREADY_STOPPED:-0}" != 1 ]; then
  GW_STOP_FLAG=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then GW_STOP_FLAG=1; fi
  remote "hermes -p default gateway stop${GW_STOP_FLAG:+ -y}" \
    || { echo "ABORT: the gateway was not stopped (live sessions? GW_INTERRUPT=1 interrupts them deliberately; GATEWAY_ALREADY_STOPPED=1 if none runs). Nothing was restored; the safety backup is $SAFETY."; exit 1; }
fi
```

### Restore 5 — import the archive

`--force` is required when there is no terminal: without it the native prompt reads EOF and aborts
(`hermes_cli/backup.py:772-790`). The import verifies every member before writing the first file.

```bash
IRC=0
IOUT=$(remote "hermes -p default import --force '$RESTORE_FROM'" 2>&1) || IRC=$?
printf '%s\n' "$IOUT" | tail -n 25
if [ "$IRC" != 0 ] || ! printf '%s\n' "$IOUT" | grep -q '^Done\. Your Hermes configuration has been restored\.'; then
  echo "FAIL: hermes import exited $IRC or did not finish (a partial restore is possible). Safety backup of the previous state: $SAFETY. Fix the cause and re-run the import, or restore the safety backup the same way."
  exit 1
fi
remote 'chmod 600 "$HOME/.hermes/.env" 2>/dev/null || true'
```

### Restore 6 — bring the gateway back and report

The import starts an installed gateway service on its own; `gw_ready` makes sure one is ready (`gateway ensure` starts a
service or an unmanaged daemon, and succeeds only when the gateway reports `ready`).

```bash
gw_ready >/dev/null \
  || { echo "FAIL: the restore finished but the gateway did not become ready. Inspect it with \`hermes -p default logs gateway -n 50\`; safety backup: $SAFETY."; exit 1; }
echo "OK: restore complete from $RESTORE_FROM. Safety backup of the previous state: $SAFETY (delete it when you no longer need the undo)."
```

Afterwards, re-run `/hermes-status` or `hermes -p default doctor`: a restored `.env`/`config.yaml` is exactly the archive's, so
anything an hstack skill wired after the archive was taken (a token, an MCP server) is gone and must be wired again.
Leftover snapshots from skill runs live in `~/.hermes/.hstack-backup/` and are part of every full archive.

---

## Rollback

A backup changes nothing in `~/.hermes` (apart from the `.backup.lock` file Hermes uses), so there is no Hermes state to roll
back. What can be left over:

- **No partial archive.** The native command writes to a hidden `.partial` file and publishes it only after a clean close, so a
  crash or a full disk leaves nothing under a `hermes-backup-*.zip` name.
- **An incomplete archive** (native exit 1) is kept by Hermes on purpose. Step 5 reports its path and fails; delete it by hand
  once you have a complete one, and never restore from it.
- **A failed restore** is undone with the safety backup that Restore 3 took first: run Restore 1 to 6 again with
  `RESTORE_FROM` set to the `pre-restore-*.zip` path that was printed (same gate, same steps).
- **A quick snapshot** is removed by deleting its directory under `~/.hermes/state-snapshots/`; Hermes also prunes it on its own
  (newest 20).

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Archive readable by other users | `.env`, `auth.json` and sessions are inside; the native writer does not chmod a full zip | `umask 077` on the command, `0700` directory, `check_archive` forces `0600` |
| 2 | `-o /some/dir` where the directory does not exist | The native command appends `.zip` and writes a FILE named `/some/dir.zip` | Step 5 creates the directory first |
| 3 | Expecting `-k` to prune other names | It only deletes `hermes-backup-*.zip` in the output directory, only after a complete archive, never with `0` | Keep native names; name hand-made archives anything else |
| 4 | Negative or text `-k` | The parser rejects it (exit 2); a negative would slice away the newest | Step 2 allows digits only |
| 5 | Trusting exit status alone | Exit 1 means an archive WAS written but is incomplete | Step 5 reports the path and fails |
| 6 | Backup dir inside `~/.hermes` | Every archive would contain the previous ones | `resolve_backup_dir` refuses it (only `~/.hermes/backups` is excluded natively) |
| 7 | Pushing the zip to GitHub | Unencrypted secrets, permanent history | Not offered; `rsync` to a host you own only |
| 8 | `hermes import` without `--force` over ssh | The `Continue? [y/N]` prompt reads EOF and aborts | Restore 5 passes `--force` only behind the gate |
| 9 | Importing while the gateway runs | Refused: `Exclusive maintenance refused ... stop the gateway` | Restore 4 stops it; Restore 6 brings it back |
| 10 | Restoring a quick snapshot headlessly | There is no CLI for it | `/snapshot restore <id>` inside an interactive `hermes` session |
| 11 | Restoring to undo one skill run | Rolls back sessions and cron jobs too | Use that skill's Rollback (restores only `.env` and `config.yaml`) |
| 12 | Believing `gateway stop` told the truth about "no gateway" | Its exit code with nothing running was not verified | `GATEWAY_ALREADY_STOPPED=1`; the import still refuses if a gateway owns the home |
| 13 | Deleting the pre-restore archive early | It is the only undo for the restore | Keep it until the restored agent has proven itself |
| 14 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run Step 0 and Step 0b first |

---

## Definition of done

Backup:

- [ ] SSH confirmed; Hermes banner names `0.22.5`
- [ ] Inputs validated locally (`BACKUP_MODE`, `KEEP`, `LABEL`, `BACKUP_DIR`, `OFFBOX_TARGET`) before any remote write
- [ ] Dry run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Full: `hermes -p default backup -o DIR -k N` exited 0 and reported `Backup complete`; archive `0600` in a `0700` directory
- [ ] Archive verified by `check_archive` (zip integrity, Hermes markers); nothing printed from inside it
- [ ] Quick: snapshot id reported, with the `/snapshot restore` hint
- [ ] Off-box copy done by `rsync` only if the user gave a target; otherwise the local-only note was shown
- [ ] No `tar`, no age-based `find -delete`, no git push; recurring runs go through `/hermes-cron`

Restore (only when asked):

- [ ] Archive validated and the preview shown; `RESTORE_ACKNOWLEDGED=1` set only after an explicit yes
- [ ] Safety backup `pre-restore-*.zip` taken and verified before anything changed
- [ ] Gateway stopped, `hermes -p default import --force` finished with `Done`, gateway ready again
- [ ] The user was told that anything wired after the archive was taken is gone

---

## Verified against Hermes v0.22.5

Read from the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the
repository root of that tag.

- `hermes backup` flags `-o/--output`, `-q/--quick`, `-l/--label` (quick only), `-k/--keep N` (default 3, `0` keeps all,
  digits only): `hermes_cli/subcommands/backup.py:16-35`. Dispatch and exit status (1 when the archive is incomplete):
  `hermes_cli/main.py:2185-2192`.
- Output name `hermes-backup-<YYYY-MM-DD-HHMMSS>.zip`, `-o` directory-versus-file rule, `.zip` suffix:
  `hermes_cli/backup.py:550-568`. Hidden `.partial` file renamed after a clean close: `:221-239`. Lock and exit 2:
  `:182-218,590-609`. Summary lines (`Backup complete: PATH`, `Restore with: hermes import`), prune after a complete archive only
  and only `hermes-backup-` names: `:612-681`, `_prune_prefixed_zips` `:1163-1171`.
- What is excluded (`hermes-agent`, `backups`, `state-snapshots`, `checkpoints`, caches, browser profiles, venvs, SQLite sidecars,
  pid/lock files): `:73-128`; SQLite is snapshotted with `sqlite3.backup` (`:124-127`, `_zip_sqlite_snapshot` `:490-503`). No `chmod`
  of a full zip exists in this module (the only `chmod` calls are `:955,1059,1310,1447-1453`), hence `umask 077`.
- Quick snapshot (`state-snapshots/<UTC stamp>[-label]`, directories `0700`, files `0600`, newest 20 kept by default):
  `:1122-1148,1232-1273,1447-1453,2081-2094`; there is no `hermes snapshot` CLI, only the `/snapshot` slash command:
  `:61-65`, `hermes_cli/commands.py` (`CommandDef("snapshot", ...)`).
- Automatic backups: `updates.pre_update_backup` default `"quick"`, `updates.backup_keep` 5:
  `hermes_cli/config_defaults.py:2362-2374`; mode resolution `hermes_cli/update_cmd_maint.py:621-642`; the quick snapshot keeps 1
  (`:30`); `hermes update --backup/--no-backup`: `hermes_cli/subcommands/update.py:33-40`. No scheduled backup exists.
- `hermes import ZIP [--force|-f]`: `hermes_cli/subcommands/import_cmd.py:9-17`; validation (config.yaml, .env or state.db inside),
  prompt and EOF abort, integrity pre-check, refusal while a gateway owns the home, skipped runtime files, secret-file modes,
  gateway revival: `hermes_cli/backup.py:732-912,914-934,1070-1100`, `hermes_cli/backup_restore.py:368-392`,
  `gateway/runtime_ownership.py:253-281`.
- `gateway stop` refusal with live sessions and `-y/--yes`: `hermes_cli/gateway_lifecycle_guards.py:97-129`,
  `hermes_cli/subcommands/gateway.py:146-155`; `gateway ensure` exit codes: `:121-127`.

**Not verified:** nothing here was run against a real Hermes or VPS. The behaviour of the stubs in `tests/skills/stub-commands/`
is written from the source above, not observed. Unknown: the exit status of `gateway stop` when no gateway runs; whether
`unzip`/`python3` exist on your VPS (the check degrades with a warning); restores of very large `state.db` files; and cross-version
restores (restore an archive onto the same Hermes version that made it).

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway failure modes.
