---
name: hermes-update
description: Safely update Hermes on a remote VPS over SSH — back up first, bump the pinned version, reload the gateway, then re-verify each wired platform. Use when upgrading Hermes versions from Claude Code, Codex, Cursor, Hermes itself, or Gemini CLI.
---

# /hermes-update — safe in-place Hermes update (SSH-first)

You are the engineer updating a self-hosted Hermes agent on the user's VPS. The agent
(Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) talks to the VPS
over SSH as root. Every command in this skill runs on the VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do (confirm a destructive
bump across a minor version, or re-mint a token that the new version invalidates).

**Honest version picture (verified 2026-06):** Hermes ships from two channels — a pinned
PyPI package (`hermes-agent==<version>`) and a moving `install.sh` that tracks `main`.
The pinned path is reproducible and safe to roll back; the curl path is not. The Docker
image `v2026.4.23` has a UID-perms regression — **never** pin to it. The current stable
default is `v0.15.2`; `0.17.x` is the latest with new gateway flags. Config keys can change
between minors, so we **re-verify every wired platform** after the bump.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$TARGET_VERSION` | Hermes version to install (e.g. `0.15.2`, `0.17.0`) | <https://pypi.org/project/hermes-agent/#history> — avoid `v2026.4.23` |
| `$UPDATE_METHOD` | `pip` (default, pinned, reproducible) or `installer` (curl, moving) | Default `pip` unless user insists |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

Detect host vs container layer first — updating inside a container that's about to be
recreated wastes work.

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  whoami; hostname
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$HOME/.local/bin/hermes"
    [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
    "$HERMES" --version
    echo "LAYER=host"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
    echo "LAYER=container AGENT=$AGENT"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: a version string like `0.15.x` or `0.17.x`, plus the layer marker.

---

## Step 2 — idempotency check (skip if already on target version)

```bash
CURRENT=$(ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes --version 2>/dev/null | awk '{print \$NF}'" || echo unknown)
if [ "$CURRENT" = "$TARGET_VERSION" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Already on $TARGET_VERSION. Set FORCE=1 to reinstall."
  exit 0
fi
echo "Will update: $CURRENT -> $TARGET_VERSION"
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. hermes backup            (config + sessions snapshot to ~/.hermes/backups/)
  2. Capture current MCP list and platform wiring for re-verify
  3. Install Hermes $TARGET_VERSION via $UPDATE_METHOD
     - pip:       pip install --upgrade "hermes-agent==$TARGET_VERSION"
     - installer: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup
  4. hermes --version          (confirm new version)
  5. hermes gateway stop && hermes gateway run --daemon  (NOT restart)
  6. hermes -z 'reply with OK' (reachability smoke test)
  7. Re-verify each wired platform still responds

No secrets are read or printed. Backup is local to the VPS at ~/.hermes/backups/.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — back up FIRST, then capture the pre-update state

The backup is the rollback. Don't proceed without it.

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  HERMES="$HOME/.local/bin/hermes"
  "$HERMES" backup
  ls -1t ~/.hermes/backups/ | head -1
' || { echo "FAIL: backup did not produce an artifact. Aborting before any change."; exit 1; }

# Capture the pre-update wiring so Step 8 can re-verify the same set
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes mcp list 2>/dev/null" > /tmp/hermes-mcp-before.txt
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes platform list 2>/dev/null || true" > /tmp/hermes-platform-before.txt
```

Sanity-check `.env` is `chmod 600` before any restart — a botched permission now would
fail the gateway run silently after the bump.

```bash
ssh "$VPS_USER@$VPS_IP" "stat -c '%a' ~/.hermes/.env" | grep -q '^600$' \
  || ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 5 — install the target version

Pick the method the user chose. Default is `pip` (pinned, reproducible, rollback-safe).

### Path A (preferred) — pinned pip install

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  pip install --upgrade --no-input \"hermes-agent==$TARGET_VERSION\"
  \$HOME/.local/bin/hermes --version
"
```

### Path B (fallback) — official installer (tracks moving `main`)

Use only if the user insists or the pinned wheel is unavailable for the target.

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup
  \$HOME/.local/bin/hermes --version
"
```

Verify the binary actually moved (don't trust pip's exit code alone):

```bash
NEW=$(ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes --version 2>/dev/null | awk '{print \$NF}'")
[ "$NEW" = "$TARGET_VERSION" ] || { echo "FAIL: still on $NEW, expected $TARGET_VERSION. Rolling back."; rollback; exit 1; }
```

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env` or refreshed binaries — use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify the gateway came up cleanly (poll up to 30s)

```bash
HEALTHY=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes logs 2>&1 | tail -200" \
       | grep -qiE "gateway.*(ready|started|listening)|MCP server.*ok"; then
    HEALTHY=1
    echo "OK: gateway healthy on $TARGET_VERSION."
    break
  fi
  sleep 5
done
[ "$HEALTHY" = "1" ] || { echo "FAIL: gateway did not come up in 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live reachability smoke test + re-verify wired platforms

First, the agent-loop smoke test (the original one-liner, hardened):

```bash
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes -z 'reply with OK'" \
  | grep -qi 'OK' \
  || { echo "FAIL: agent loop did not reply OK after update. Rolling back."; rollback; exit 1; }
echo "OK: agent loop responsive after update."
```

Then re-verify every MCP and platform that was wired before the bump still is:

```bash
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes mcp list 2>/dev/null"      > /tmp/hermes-mcp-after.txt
ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes platform list 2>/dev/null || true" > /tmp/hermes-platform-after.txt

diff -u /tmp/hermes-mcp-before.txt      /tmp/hermes-mcp-after.txt      || echo "WARN: MCP list changed across update — re-run the relevant /integration-* skill."
diff -u /tmp/hermes-platform-before.txt /tmp/hermes-platform-after.txt || echo "WARN: platform list changed — re-run the relevant /platform-* skill."
```

Any drift is a real signal (config keys often change between minors). Re-run the affected
skill rather than hand-editing `config.yaml`.

Exit codes the smoke test can return:

- `0` = updated + reachable + wiring intact
- `1` (after rollback) = update failed; system is back on the previous version
- `0` with `WARN` lines = updated + reachable but a wired integration drifted; re-run that skill

---

## Rollback (auto-runs on any failure above)

The backup from Step 4 is the rollback point. Re-pin the previous version and restore.

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes gateway stop || true"
  ssh "$VPS_USER@$VPS_IP" "pip install --no-input \"hermes-agent==$CURRENT\" 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    LATEST_BACKUP=\$(ls -1t ~/.hermes/backups/ 2>/dev/null | head -1)
    [ -n \"\$LATEST_BACKUP\" ] && \$HOME/.local/bin/hermes restore \"~/.hermes/backups/\$LATEST_BACKUP\" || true
  "
  sleep 2
  ssh "$VPS_USER@$VPS_IP" "\$HOME/.local/bin/hermes gateway run --daemon"
  echo "Rolled back to $CURRENT. Verify with: hermes --version && hermes -z 'reply with OK'"
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using the curl `install.sh` path for production | Tracks moving `main` — not reproducible, not rollback-safe | Pin via `pip install "hermes-agent==<version>"` |
| 2 | Pinning Docker image `v2026.4.23` | UID-perms regression — gateway can't read `.env` | Pin a known-good release; `v0.15.2` is the current stable default |
| 3 | Skipping `hermes backup` before the bump | No rollback artifact; broken update is unrecoverable | Step 4 hard-aborts if backup fails |
| 4 | Not re-verifying platforms after update | Config keys can change between minors — silently broken integrations | Step 8 diffs pre/post wiring lists |
| 5 | `gateway restart` to pick up the new binary | Restart does NOT reliably re-read env or refreshed binary | Always `stop` + `run --daemon` |
| 6 | `echo >> ~/.hermes/.env` to patch new keys | Can merge onto a prior line lacking trailing newline | Always `hermes config set` |
| 7 | Secret in `config.yaml` instead of `.env` | New version may relocate config; world-readable | Only `~/.hermes/.env`, `chmod 600` |
| 8 | sed with `/` delimiter when fixing tokens | Tokens contain `/+=` | Use `\|` delimiter |
| 9 | Updating inside a Docker container that gets recreated | Work lost on next `docker compose up` | Step 1 detects layer (`whoami; hostname`); update on the host |
| 10 | Assuming command-line flags are stable | Flags evolve across minors | Re-check `hermes <cmd> --help` if behaviour changes |
| 11 | Running the update during active platform traffic | In-flight messages drop during the stop window | Pause platforms or schedule during quiet window |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS pre-update; layer (host vs container) identified
- [ ] Idempotency check passed (or `FORCE=1` overrode the same-version skip)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `hermes backup` produced an artifact in `~/.hermes/backups/` before any change
- [ ] `.env` re-checked at `chmod 600`; no secret echoed in chat
- [ ] Target version installed; `hermes --version` matches `$TARGET_VERSION`
- [ ] Gateway reloaded with `stop` + `run --daemon` (NOT `restart`)
- [ ] Logs show `gateway ready` / `started` within 30s
- [ ] Smoke test: `hermes -z 'reply with OK'` returned `OK`
- [ ] MCP and platform lists diffed pre/post; drift surfaced as `WARN` for re-run
- [ ] Rollback function defined; backup file exists for one-command revert

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
