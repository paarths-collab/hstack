---
name: hermes-restart
description: Cleanly restart the Hermes gateway on a remote VPS over SSH, clearing stale PID locks that cause restart loops. Use when the gateway is stuck, unresponsive, or after config changes. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI).
---

# /hermes-restart — clean gateway restart (SSH-first)

You are the engineer cleanly restarting the Hermes gateway for the user. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a
remote VPS over SSH as root. Every command runs on the VPS, not on the local machine.

A naive restart hits the stale-PID trap (upstream issue #13655): after a crash or OOM
the gateway will not start, looping with `PID file race lost… Exiting.` Always clear
locks first, then start, then verify.

**Honest picture (verified 2026-06):** `hermes gateway restart` is unreliable for two
reasons — it does not re-read `~/.hermes/.env`, and it does not clear stale PID/lock
files left by a crashed previous instance. This skill uses `stop` + lock-sweep + `run`
instead. On macOS/Windows the kernel-level lock guard is a no-op, so the sweep is
mandatory there. On WSL2, systemd reports unavailable (issue #18032) — autostart uses
tmux/nohup instead.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$AUTOSTART` (optional) | `1` to also (re)install autostart so it survives reboot | Defaults to `0` |
| `$FORCE` (optional) | `1` to restart even if gateway is already healthy | Defaults to `0` |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

Detect whether Hermes runs on the host or inside a Docker container, and capture which
for later steps. The same `whoami; hostname` check from `CLAUDE.md` applies inside any
`ssh` heredoc — if the prompt shows a hex hostname, you are inside a container.

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  whoami; hostname
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$HOME/.local/bin/hermes"
    [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
    "$HERMES" --version
    echo "MODE=host"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
    echo "MODE=docker:$AGENT"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed. Run /hermes-install first."; exit 1; }
```

Expected: a version string like `0.15.x` or `0.17.x` and a `MODE=` line.

---

## Step 2 — idempotency check (skip if already healthy)

If the gateway is already running and healthy and `FORCE` is not set, do nothing.

```bash
HEALTHY=$(ssh "$VPS_USER@$VPS_IP" "hermes gateway status 2>/dev/null | grep -ciE 'running|healthy|ok'" || echo 0)
if [ "$HEALTHY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Gateway already healthy. Set FORCE=1 to restart anyway."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before touching anything)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. hermes gateway stop       (graceful; ignore errors if already stopped)
  2. rm -f ~/.hermes/gateway.pid
  3. rm -f ~/.local/state/hermes/gateway-locks/*.lock
  4. hermes gateway run --daemon   (NOT 'gateway restart')
  5. Poll hermes gateway status up to 30s for 'running'
  6. Tail logs for "gateway listening" / "ready"
  ${AUTOSTART:+7. Reinstall autostart unit (Step 9)}

No secrets are read, written, or printed. Existing config is untouched.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — stop the gateway and sweep stale locks

`stop` is graceful; the sweep handles the case where the previous instance crashed
without releasing its PID file or fcntl lock.

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  HERMES="$HOME/.local/bin/hermes"
  [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
  "$HERMES" gateway stop || true
  sleep 2
  rm -f "$HOME/.hermes/gateway.pid"
  rm -f "$HOME/.local/state/hermes/gateway-locks/"*.lock 2>/dev/null || true
  # Belt-and-suspenders: confirm no hermes gateway process is still alive.
  # Do NOT use pkill -9 -f "hermes.*gateway" on multi-profile hosts — it is profile-blind.
  pgrep -fa "hermes gateway" || echo "no lingering gateway process"
'
```

Verify the lock files are actually gone before continuing:

```bash
LEFTOVER=$(ssh "$VPS_USER@$VPS_IP" "ls -1 ~/.hermes/gateway.pid ~/.local/state/hermes/gateway-locks/*.lock 2>/dev/null | wc -l" || echo 0)
[ "$LEFTOVER" = "0" ] || { echo "FAIL: stale lock files still present. Investigate manually."; exit 1; }
```

---

## Step 5 — start the gateway (NOT `gateway restart`)

`gateway restart` does NOT reliably re-read `.env` and does NOT sweep locks. Always
`stop` + `run`.

```bash
ssh "$VPS_USER@$VPS_IP" '
  HERMES="$HOME/.local/bin/hermes"
  [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
  "$HERMES" gateway run --daemon
'
sleep 5
```

`gateway run` is foreground; the `--daemon` flag (or `nohup`/`tmux` on builds without
`--daemon`) is what keeps it alive across SSH disconnect. For survive-reboot
persistence, see Step 9 (autostart).

---

## Step 6 — poll gateway status (up to 30s)

```bash
HEALTHY=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes gateway status 2>&1" | grep -qiE "running|healthy|ok"; then
    HEALTHY=1
    echo "OK: gateway is running."
    break
  fi
  sleep 5
done
[ "$HEALTHY" = "1" ] || { echo "FAIL: gateway did not report healthy after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 7 — verify in logs (poll up to 30s for ready signal)

```bash
READY=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "gateway listening|gateway ready|gateway started"; then
    READY=1
    echo "OK: gateway ready signal in logs."
    break
  fi
  sleep 5
done
[ "$READY" = "1" ] || { echo "WARN: status reports healthy but no ready line in logs yet. Continuing."; }
```

---

## Step 8 — live health smoke test

Hit the local health endpoint the gateway exposes. The exact port comes from
`hermes gateway status`; fall back to `4000` if not parseable.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  PORT=$(hermes gateway status 2>/dev/null | grep -oE "port[[:space:]:=]+[0-9]+" | grep -oE "[0-9]+" | head -1)
  PORT=${PORT:-4000}
  curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health" || echo 000
')
case "$HTTP" in
  200) echo "OK: gateway /health returned 200." ;;
  401|403) echo "OK: gateway responding (auth-gated $HTTP) — service is up." ;;
  000) echo "FAIL: gateway port not reachable. Rolling back."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from /health. Check manually." ;;
esac
```

---

## Step 9 — (optional) install autostart so it survives reboot

Only run if `AUTOSTART=1`. Platform-specific — the heredoc detects which and acts.

```bash
[ "${AUTOSTART:-0}" = "1" ] && ssh "$VPS_USER@$VPS_IP" '
  set -e
  HERMES="$HOME/.local/bin/hermes"
  [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
  if grep -qi microsoft /proc/version 2>/dev/null; then
    # WSL2: systemd falsely reports unavailable (#18032). Use tmux.
    command -v tmux >/dev/null || { echo "FAIL: tmux not installed on WSL2"; exit 1; }
    tmux kill-session -t hermes 2>/dev/null || true
    tmux new -d -s hermes "$HERMES gateway run"
    echo "Autostart: tmux session hermes (WSL2)"
  elif command -v systemctl >/dev/null 2>&1; then
    # Linux with systemd: install the unit and enable linger so it boots without login.
    # Never hardcode the unit name (varies by version/profile) — query status after install.
    "$HERMES" gateway install
    loginctl enable-linger "$USER" 2>/dev/null || true
    UNIT=$("$HERMES" gateway status 2>/dev/null | grep -oE "[a-z0-9._-]+\.service" | head -1)
    [ -n "$UNIT" ] && systemctl --user daemon-reload && systemctl --user enable "$UNIT"
    echo "Autostart: systemd unit $UNIT"
  else
    echo "WARN: no systemd and not WSL2 — use Docker --restart unless-stopped, or run /hermes-install."
  fi
'
```

For Docker deploys, the equivalent is `--restart unless-stopped` plus
`-v ~/.hermes:/opt/data` on the container — set at install time, not here.

---

## Rollback (auto-runs on any failure above)

A restart rollback cannot "undo" a stop — but it can ensure the gateway is left in a
predictable state (either fully stopped, or running on the last known config). Default
is to attempt a re-start from a clean lock state; if that also fails, leave it stopped
and surface clear next steps.

```bash
rollback() {
  echo "Rolling back: clearing locks and attempting a final clean start."
  ssh "$VPS_USER@$VPS_IP" '
    HERMES="$HOME/.local/bin/hermes"
    [ -x "$HERMES" ] || HERMES="$(command -v hermes)"
    "$HERMES" gateway stop || true
    sleep 2
    rm -f "$HOME/.hermes/gateway.pid"
    rm -f "$HOME/.local/state/hermes/gateway-locks/"*.lock 2>/dev/null || true
    "$HERMES" gateway run --daemon || true
    sleep 3
    "$HERMES" gateway status || echo "Gateway is stopped. Run /hermes-fix or check logs."
  '
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using `hermes gateway restart` | Does NOT re-read `.env`; does NOT sweep stale locks; loops on PID race (#13655) | Use `stop` + lock sweep + `run --daemon` |
| 2 | Skipping the lock sweep on macOS/Windows | Kernel lock guard is a no-op there; stale PID/lock blocks start | Always `rm -f` both PID and `gateway-locks/*.lock` |
| 3 | `gateway run` without `--daemon` (or tmux/nohup) | Runs foreground; dies the moment SSH disconnects | Use `--daemon`, or `tmux new -d`, or `gateway install` for systemd |
| 4 | `pkill -9 -f "hermes.*gateway"` to force-kill | Profile-blind — nukes other Hermes profiles on multi-profile hosts | Use `hermes gateway stop`; only `pgrep -fa` to inspect |
| 5 | Using systemd on WSL2 | Issue #18032 — systemd falsely reports unavailable; unit silently never starts | Use `tmux new -d -s hermes` on WSL2 |
| 6 | Hardcoding the systemd unit name | Unit name varies by version/profile (`hermes-gateway.service`, `hermes@<profile>.service`, etc.) | Parse the unit name from `hermes gateway status` |
| 7 | Missing `loginctl enable-linger` | User systemd unit dies on logout; gateway disappears after reboot | `loginctl enable-linger "$USER"` after `gateway install` |
| 8 | Container vs host confusion | SSHed in but landed in a container; lock sweep hits the wrong filesystem | Run `whoami; hostname` first — hex hostname = container; `exit` and retry |
| 9 | Echoing secrets via `echo >> .env` during restart | Restart does not write secrets, but tempting to "fix env" mid-restart — same merged-line trap as `authorized_keys` | Never edit `.env` here; use `hermes config set` in the relevant integration skill |
| 10 | Hardening the systemd unit by hand without `ExecStartPre` | After OOM, the stale PID survives reboot and the unit loops | Add `ExecStartPre=/bin/rm -f %h/.hermes/gateway.pid` to the unit override |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x), host-vs-container `MODE` known
- [ ] Idempotency check ran (healthy gateway short-circuits unless `FORCE=1`)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `hermes gateway stop` ran; stale `gateway.pid` and `gateway-locks/*.lock` removed and verified gone
- [ ] Gateway started with `gateway run --daemon` (NOT `gateway restart`)
- [ ] `hermes gateway status` reports `running` within 30s
- [ ] Logs show `gateway listening` / `ready` / `started` within 30s (or a clear WARN)
- [ ] `/health` smoke test returned `200` (or auth-gated 401/403 = service up)
- [ ] If `AUTOSTART=1`: systemd unit installed + `linger` enabled (Linux), or tmux session created (WSL2)
- [ ] No secret read, written, or printed by this skill
- [ ] Rollback function defined; failure path leaves gateway in a predictable state

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and PID-race failure modes.
