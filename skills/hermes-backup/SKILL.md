---
name: hermes-backup
description: Back up a self-hosted Hermes Agent (config, secrets, memory, sessions) over SSH. Use before risky changes and on a nightly schedule — Hermes has no automatic backups. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-backup — back up everything (SSH-first)

You are the engineer taking a backup of the user's self-hosted Hermes Agent on their VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not locally.

Do everything autonomously; stop only for things a machine cannot do (provide a private
remote target, confirm a destructive prune).

**Honest backup picture:** Hermes ships **no automatic backups**. `~/.hermes` contains
the entire agent state — config, `.env` secrets, memory, sessions — and can grow to
multiple GB (~3,000 session files is common). The archive contains secrets, so the
destination must be private (private GitHub repo, encrypted S3 bucket, or off-box rsync
target with restricted access). Restore is `hermes import <zipfile>`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$BACKUP_DIR` | Remote dir to write archives into (default `~/hermes-backups`) | User's choice; must be on a disk with free space |
| `$RETAIN_DAYS` | How many days of archives to keep (default `14`) | User's choice |
| `$OFFBOX_TARGET` | Optional: `rsync`/`scp` destination, or `git:<repo-url>` for private GitHub push | User-provided remote target |

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
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

Also confirm the data dir exists and check its size before backing up:

```bash
ssh "$VPS_USER@$VPS_IP" "
  [ -d ~/.hermes ] || { echo 'FAIL: ~/.hermes missing'; exit 1; }
  du -sh ~/.hermes
  find ~/.hermes/sessions -type f 2>/dev/null | wc -l | xargs -I{} echo 'sessions: {} files'
"
```

If session count is over ~3,000 or the dir is over ~3 GB, flag it — Step 3 will offer an
optional prune.

---

## Step 2 — idempotency check (skip if a fresh backup already exists today)

```bash
TODAY=$(date +%F)
BACKUP_DIR="${BACKUP_DIR:-~/hermes-backups}"
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "ls $BACKUP_DIR/hermes-${TODAY}*.zip $BACKUP_DIR/hermes-${TODAY}*.tgz 2>/dev/null | wc -l" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Backup for $TODAY already exists in $BACKUP_DIR. Set FORCE=1 to overwrite."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Create $BACKUP_DIR if missing; chmod 700
  2. Run: hermes backup -o $BACKUP_DIR/hermes-${TODAY}.zip
     (fallback if no built-in: tar czf $BACKUP_DIR/hermes-${TODAY}.tgz -C ~ .hermes)
  3. chmod 600 the new archive
  4. Verify archive exists and is non-empty
  5. (Optional) Push to off-box target: ${OFFBOX_TARGET:-<none>}
  6. Prune archives older than ${RETAIN_DAYS:-14} days in $BACKUP_DIR

The archive contains SECRETS — destination must be private.
No secret values will be printed.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — create the backup directory (chmod 700, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "mkdir -p $BACKUP_DIR && chmod 700 $BACKUP_DIR"
```

Verify (returns `1`):

```bash
EXISTS=$(ssh "$VPS_USER@$VPS_IP" "[ -d $BACKUP_DIR ] && echo 1 || echo 0")
[ "$EXISTS" = "1" ] || { echo "FAIL: $BACKUP_DIR not created. Rolling back."; rollback; exit 1; }
```

---

## Step 5 — take the backup (prefer built-in `hermes backup`)

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — built-in compressed archive

```bash
HERMES="\$HOME/.local/bin/hermes"
ARCHIVE="$BACKUP_DIR/hermes-${TODAY}.zip"
ssh "$VPS_USER@$VPS_IP" "
  $HERMES backup -o $ARCHIVE
  chmod 600 $ARCHIVE
"
```

### Path B (fallback) — plain tarball of the whole data dir

If the build has no `backup` subcommand, or for parity with non-Hermes tooling:

```bash
ARCHIVE="$BACKUP_DIR/hermes-${TODAY}.tgz"
ssh "$VPS_USER@$VPS_IP" "
  tar czf $ARCHIVE -C \$HOME .hermes
  chmod 600 $ARCHIVE
"
```

Do NOT inline secrets, do NOT print archive contents to the log, and do NOT use
`echo > <archive-path>` style pre-creation — `tar` and `hermes backup` handle creation.

---

## Step 6 — reload nothing (backup is read-only) but verify the archive

Backup is non-disruptive: there is no gateway to reload. Instead, verify the archive is
present, non-empty, and at least roughly the size of the source dir.

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  [ -s $ARCHIVE ] || { echo 'FAIL: archive missing or empty'; exit 1; }
  ls -lh $ARCHIVE
  if [ \"\${ARCHIVE##*.}\" = 'zip' ]; then
    unzip -tq $ARCHIVE >/dev/null && echo 'OK: zip integrity verified'
  else
    tar tzf $ARCHIVE >/dev/null && echo 'OK: tar listing succeeded'
  fi
"
```

---

## Step 7 — verify backup contents (poll up to 30s for large archives)

```bash
VERIFIED=0
for i in $(seq 1 6); do
  SIZE=$(ssh "$VPS_USER@$VPS_IP" "stat -c %s $ARCHIVE 2>/dev/null || stat -f %z $ARCHIVE 2>/dev/null" || echo 0)
  if [ "$SIZE" -gt 1024 ]; then
    VERIFIED=1
    echo "OK: backup is $SIZE bytes."
    break
  fi
  sleep 5
done
[ "$VERIFIED" = "1" ] || { echo "FAIL: archive too small or missing after 30s. Rolling back."; rollback; exit 1; }
```

Also confirm the archive contains the expected top-level entries:

```bash
ssh "$VPS_USER@$VPS_IP" "
  case \"\${ARCHIVE##*.}\" in
    zip) unzip -l $ARCHIVE | grep -E '\\.env|config\\.yaml|memory|sessions' | head -10 ;;
    tgz) tar tzf $ARCHIVE | grep -E '\\.env|config\\.yaml|memory|sessions' | head -10 ;;
  esac
"
```

If `.env`, `config.yaml`, `memory`, and `sessions` are all absent, the backup is broken
even if the file size is non-zero.

---

## Step 8 — off-box push (live smoke test of the chosen target)

The archive on the VPS protects against accidental `rm`. It does NOT protect against
disk failure. Push to an off-box target if one was provided.

```bash
case "${OFFBOX_TARGET:-}" in
  "")
    echo "WARN: no OFFBOX_TARGET set. Backup is local-only on the VPS."
    ;;
  git:*)
    REPO="${OFFBOX_TARGET#git:}"
    ssh "$VPS_USER@$VPS_IP" "
      cd $BACKUP_DIR
      git init -q 2>/dev/null || true
      git remote remove origin 2>/dev/null || true
      git remote add origin $REPO
      git add -A
      git -c user.email=hermes@localhost -c user.name=hermes commit -qm 'backup $TODAY' || true
      git push -u origin HEAD:main 2>&1 | tail -5
    "
    ;;
  *)
    ssh "$VPS_USER@$VPS_IP" "rsync -az --partial $ARCHIVE $OFFBOX_TARGET" \
      && echo "OK: rsynced to $OFFBOX_TARGET" \
      || { echo "FAIL: rsync to $OFFBOX_TARGET failed."; exit 1; }
    ;;
esac
```

For HTTP-style targets (S3, GCS, B2), expected response codes:
`200`/`204` = uploaded. `401`/`403` = bad credentials or bucket policy. `404` = bucket missing.

---

## Step 9 — prune old archives (retain $RETAIN_DAYS)

```bash
ssh "$VPS_USER@$VPS_IP" "
  find $BACKUP_DIR -maxdepth 1 -type f \( -name 'hermes-*.zip' -o -name 'hermes-*.tgz' \) \
    -mtime +${RETAIN_DAYS:-14} -print -delete
"
```

This is the only destructive step. It runs only on archive files matching the naming
pattern, never on `~/.hermes` itself.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  # Backup is read-only on source; the only artifact to undo is the half-written archive.
  ssh "$VPS_USER@$VPS_IP" "
    [ -n \"$ARCHIVE\" ] && [ -f \"$ARCHIVE\" ] && rm -f \"$ARCHIVE\" || true
  "
  echo "Rolled back. Partial archive removed; ~/.hermes untouched."
}
```

`~/.hermes` is never modified by this skill, so there is nothing to restore on the
source side. The optional prune in Step 9 is the only destructive action and runs last,
after all verification has passed.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Backup dir world-readable | `~/.hermes/.env` is inside the archive — secrets leak | `chmod 700` on dir, `chmod 600` on archive |
| 2 | `~/.hermes` is multi-GB (~3,000 sessions) | Backup takes 10+ min, archive bloats off-box storage | Prune sessions before backup; warn at Step 1 |
| 3 | Pushing archive to a **public** GitHub repo | The archive contains secrets in `.env` | Must be a **private** repo; verify before `git push` |
| 4 | `git push` from inside `~/hermes-backups` to a non-secret remote | Secrets land in commit history forever | Step 8 git path requires `git:` prefix, points only at user-provided private repo |
| 5 | Using `gateway restart` thinking backup needs it | Backup is read-only; reload is unnecessary | Skip reload entirely; verify archive instead |
| 6 | `echo >> archive` or `cat > archive` to "augment" | Truncates or corrupts the archive | Only `tar` / `hermes backup` write archives |
| 7 | sed with `/` delimiter on remote paths | Paths may contain spaces or special chars | Use `\|` delimiter if sed is ever needed |
| 8 | Restoring via shell `unzip` instead of `hermes import` | Permissions and ownership drift | Always restore with `hermes import <zipfile>` |
| 9 | Container vs host confusion | Backed up the wrong `.hermes` directory | Run `whoami; hostname` check; if container, `docker cp` from inside |
| 10 | Disk full mid-tar | Half-archive left in `$BACKUP_DIR` | Rollback removes partial archive; Step 7 size check catches it |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] `~/.hermes` size and session count surveyed
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `$BACKUP_DIR` created with `chmod 700`
- [ ] Archive written via Path A (`hermes backup`) or Path B (`tar`); `chmod 600`
- [ ] Archive integrity verified (`unzip -tq` or `tar tzf`)
- [ ] Top-level entries (`.env`, `config.yaml`, `memory`, `sessions`) present in archive
- [ ] Archive size > 1 KiB confirmed via stat poll (smoke test)
- [ ] Off-box push succeeded (or `OFFBOX_TARGET` explicitly unset with warning)
- [ ] Old archives older than `$RETAIN_DAYS` pruned
- [ ] Rollback function defined and tested
- [ ] Schedule a recurring run via `/hermes-cron` (this skill does not self-install cron)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
