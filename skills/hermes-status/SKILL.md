---
name: hermes-status
description: Health-check a self-hosted Hermes Agent over SSH — gateway, platforms, memory, recent logs, end-to-end smoke. Use when the user asks "is my agent ok?" or to diagnose a remote VPS. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI).
---

# /hermes-status — health check a remote Hermes (SSH-first)

You are the engineer running a health check on a self-hosted Hermes agent on the user's
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work
over SSH as root against the VPS. Every command in this skill runs on the VPS, not on
the local machine.

This is a read-only diagnostic skill — no secrets are written, no MCP registrations are
changed. The "rollback" in this skill is a no-op because nothing is mutated; the only
side effect is a `-z` self-message used to confirm end-to-end reachability.

**Honest picture:** `hermes status --deep`, `hermes memory status`, and `hermes logs`
flag names are stable across `0.15.x` and `0.17.x`. If a subcommand is missing on an
older build, fall back to the plain `hermes status` / `hermes logs gateway -n 30`
forms shown inline.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |

No secrets required — this skill is read-only.

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

Expected: a version string like `0.15.x` or `0.17.x`.

Always prefer the absolute path `~/.local/bin/hermes` when present — it avoids PATH
surprises under non-interactive SSH sessions.

---

## Step 2 — idempotency check (skip if already healthy in the last 60s)

A health check is cheap, but repeated `-z` self-messages spam the log. Skip if a
recent run already wrote a `status: healthy` marker — unless `FORCE=1`.

```bash
RECENT=$(ssh "$VPS_USER@$VPS_IP" "
  test -f /tmp/hermes-status.ok && \
  test \$(( \$(date +%s) - \$(stat -c %Y /tmp/hermes-status.ok 2>/dev/null || echo 0) )) -lt 60
" && echo 1 || echo 0)
if [ "$RECENT" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Recent healthy check < 60s ago. Set FORCE=1 to re-check."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before running)

```bash
cat <<EOF
DRY RUN — the following read-only checks will run on $VPS_USER@$VPS_IP:
  1. hermes --version
  2. hermes gateway status        (running? which unit?)
  3. hermes status --deep         (overall)
  4. hermes memory status         (backend + usage vs ceiling)
  5. hermes logs gateway -n 30    (recent gateway log)
  6. hermes -z 'reply with OK'    (end-to-end self-message smoke)

No secrets are written. No MCP servers are added or removed.
The only side effect is one self-message in the agent's own log.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — gateway + deep status (no secrets, but redact anything sensitive)

```bash
ssh "$VPS_USER@$VPS_IP" '
  HERMES="${HOME}/.local/bin/hermes"
  command -v hermes >/dev/null 2>&1 && HERMES="hermes"
  $HERMES gateway status || true
  echo "---"
  $HERMES status --deep 2>/dev/null || $HERMES status
'
```

Read the output for: which gateway unit is active, which platforms are live (telegram,
discord, slack, etc.), and any "degraded" or "stopped" markers.

---

## Step 5 — memory backend + usage

```bash
ssh "$VPS_USER@$VPS_IP" '
  HERMES="${HOME}/.local/bin/hermes"
  command -v hermes >/dev/null 2>&1 && HERMES="hermes"
  $HERMES memory status
'
```

Note the **backend** (sqlite / postgres / qdrant), **usage**, and the **ceiling**.
If usage is approaching the ceiling, recommend `/hermes-memory` to expand or prune.

---

## Step 6 — recent gateway log (last 30 lines)

```bash
ssh "$VPS_USER@$VPS_IP" '
  HERMES="${HOME}/.local/bin/hermes"
  command -v hermes >/dev/null 2>&1 && HERMES="hermes"
  $HERMES logs gateway -n 30 2>/dev/null || $HERMES logs -n 30
'
```

Scan for: `ERROR`, `panic`, `OOM`, repeated reconnect cycles on any platform,
and any `register` failures.

---

## Step 7 — end-to-end smoke (self-message)

`hermes -z` sends the agent a message and prints the reply. If the reply contains
`OK`, the full pipeline (gateway → router → model → memory → reply) works.

```bash
SMOKE=$(ssh "$VPS_USER@$VPS_IP" '
  HERMES="${HOME}/.local/bin/hermes"
  command -v hermes >/dev/null 2>&1 && HERMES="hermes"
  $HERMES -z "reply with OK" 2>&1
')
if printf '%s' "$SMOKE" | grep -qi 'OK'; then
  echo "end-to-end: OK"
  ssh "$VPS_USER@$VPS_IP" "touch /tmp/hermes-status.ok"
else
  echo "end-to-end: FAILED"
  echo "$SMOKE" | tail -20
fi
```

---

## Step 8 — RSS / uptime check (catch the OOM leak)

Long-running Hermes processes have historically leaked — if RSS is many GB after
a day or two, schedule a `/hermes-restart`.

```bash
ssh "$VPS_USER@$VPS_IP" '
  pgrep -af "hermes gateway" | head -3
  echo "---"
  ps -eo pid,etime,rss,cmd --sort=-rss | grep -E "[h]ermes" | head -5
'
```

Rule of thumb: RSS > 3 GB after < 24h uptime = leak; recommend restart.

---

## Reporting in plain language

After all steps, report back to the user in plain language, in this order:

- **Online/offline** — overall verdict
- **Platforms live** — telegram ✅ / discord ✅ / whatsapp ❌ (etc.)
- **Memory** — backend + usage vs ceiling
- **RSS / uptime** — flag if leaky
- **Errors in log** — any non-benign lines from Step 6
- **End-to-end** — OK or FAILED, with the last lines if FAILED

---

## Rollback (no-op — this skill mutates nothing)

```bash
rollback() {
  # Status is read-only. The only side effect is the /tmp marker and one self-message.
  ssh "$VPS_USER@$VPS_IP" "rm -f /tmp/hermes-status.ok 2>/dev/null || true"
  echo "Nothing to roll back — /hermes-status is read-only."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Running `hermes` without the absolute path | Non-interactive SSH has a stripped PATH; `hermes` may not resolve | Prefer `~/.local/bin/hermes` (per global rule) |
| 2 | `gateway restart` confused with `gateway status` | Restart mutates state; status is read-only | This skill only uses `status`; for restarts use `/hermes-restart` |
| 3 | Tailing logs without `-n` | Huge logs hang the SSH session | Always cap with `-n 30` |
| 4 | RSS leak goes unnoticed | Long uptime + high RSS = OOM kill at 2am | Step 8 explicit threshold check |
| 5 | `-z` self-message disabled by safe-mode | Some builds gate `-z` behind a flag | Fall back to platform-side ping if `-z` errors |
| 6 | Container vs host confusion | `hermes` inside a container is invisible to the host | Step 1 detects both; uses `docker exec` if needed |
| 7 | `echo >>` ever used here | Not used in this skill, but a universal rule | Always `hermes config set`, never `echo >>` |
| 8 | Secret accidentally surfaced in log output | Logs may include redacted-but-not-quite tokens | Never paste raw log lines containing `_TOKEN=` back to chat |
| 9 | sed with `/` delimiter on tokens | Not used here, but a universal rule | Always use `\|` delimiter on tokens with `/+=` |
| 10 | Reading `config.yaml` for secrets | Secrets live in `.env`, not `config.yaml` | Never grep `config.yaml` for tokens |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (`0.15.x` or `0.17.x`)
- [ ] Idempotency check ran (skipped if healthy < 60s ago, unless `FORCE=1`)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `gateway status` + `status --deep` reported
- [ ] `memory status` reported (backend + usage vs ceiling)
- [ ] Last 30 gateway log lines scanned for errors
- [ ] `-z` end-to-end smoke returned `OK` (or failure mode captured)
- [ ] RSS / uptime checked; leak threshold flagged if exceeded
- [ ] Plain-language summary delivered to user
- [ ] Rollback function defined (no-op for this read-only skill)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
memory, and platform failure modes.
