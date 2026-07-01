---
name: hermes-fix
description: Diagnose and repair common Hermes failures (gateway down, model not configured, bot silent, PATH, Docker UID, RSS leak) on a remote VPS over SSH. Use when Hermes is broken. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-fix — diagnose + repair a remote Hermes (SSH-first)

You are the engineer fixing a broken self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command runs on the VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do (mint a missing API
key, change DNS, decide whether to wipe state).

**Honest picture:** `hermes doctor` is the source of truth but its exit code is not
reliable — some warnings (e.g. #13301 "Not configured" for gateway tools) are cosmetic.
Capture its output, parse the symptoms, then apply the matching fix. The full
symptom catalogue lives in `reference/TROUBLESHOOTING.md`.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$SYMPTOM` | Optional: what's broken in one line (`gateway down`, `bot silent`, `OOM`, `command not found`) | The user — lets you skip diagnosis |

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
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    "$HOME/.local/bin/hermes" --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes binary not found on host or in container"; exit 1
  fi
' || { echo "DIAGNOSED: hermes not installed or PATH broken — jump to Fix-A below."; }
```

Expected: a version string like `0.15.x` or `0.17.x`. If this step fails, the diagnosis
is already done (PATH / install) — apply **Fix-A** in Step 5.

---

## Step 2 — idempotency check (skip if already healthy)

If the gateway is up and responding, there is nothing to fix — exit early unless the
user passed `FORCE=1` (e.g. to apply a preventive cron).

```bash
HEALTHY=$(ssh "$VPS_USER@$VPS_IP" "
  hermes gateway status 2>/dev/null | grep -ciE 'running|active|ok' || echo 0
")
if [ "$HEALTHY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Hermes gateway already reports healthy. Set FORCE=1 to run fixes anyway."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before mutating)

Run `hermes doctor` first to gather symptoms, then list the fix plan. Never start
mutating before the user sees the plan.

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" doctor 2>&1 | tee /tmp/hermes_doctor.log
  tail -50 ~/.hermes/logs/gateway.log 2>/dev/null || true
" | tee /tmp/hermes_doctor.local.log

cat <<EOF
DRY RUN — based on doctor output and supplied symptom "${SYMPTOM:-auto-detect}",
the following will happen on $VPS_USER@$VPS_IP:

  Diagnosis: see /tmp/hermes_doctor.local.log
  Planned fixes (only those matching detected symptoms will run):
    A. PATH / 'command not found'   -> export PATH; re-source ~/.bashrc
    B. Gateway down / restart loop  -> stop, clear stale gateway.pid + locks, run
    C. Bot silent                   -> verify allowlist is numeric ID; tail gateway.log
    D. Model 400                    -> 'hermes model' reconfigure; verify provider key
    E. Vision/web silent-degrade    -> add missing auxiliary provider key
    F. RSS OOM / leak (#25315)      -> restart; install nightly restart cron
    G. Docker chown EPERM           -> set HERMES_UID/HERMES_GID; avoid v2026.4.23
    H. 'Not configured' cosmetic    -> log + ignore if tools work (#13301)

No secrets will be printed. Each fix verifies before moving on.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — write any config changes (chmod 600, no echo, no logging)

If the chosen fix needs a new env var (e.g. missing provider key for Fix-D or Fix-E),
write it via `hermes config set` — never `echo >>`.

```bash
# Example: add OPENAI_API_KEY for Fix-D. Skip block if no key changes needed.
if [ -n "${NEW_KEY_NAME:-}" ] && [ -n "${NEW_KEY_VALUE:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set $NEW_KEY_NAME '$NEW_KEY_VALUE'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c \"^${NEW_KEY_NAME}=\" ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: ${NEW_KEY_NAME} not written. Rolling back."; rollback; exit 1; }
fi
```

> If the Hermes build has no `config set` subcommand, use the safe sed pattern with
> the `|` delimiter (provider keys often contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^OPENAI_API_KEY=' ~/.hermes/.env || printf 'OPENAI_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^OPENAI_API_KEY=.*|OPENAI_API_KEY=PLACEHOLDER|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — apply the matching fix

Pick by detected symptom. Each fix is idempotent and self-verifying.

### Fix A — `hermes: command not found` after install

```bash
ssh "$VPS_USER@$VPS_IP" "
  grep -q 'HOME/.local/bin' ~/.bashrc 2>/dev/null \
    || echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc
  # shellcheck disable=SC1090
  . ~/.bashrc
  \"\$HOME/.local/bin/hermes\" --version
"
```

Never `sudo` to fix install perms — sudo install is usually the cause. Remove the
sudo-installed copy and reinstall as the user (see `/hermes-install`).

### Fix B — gateway won't start / restart loop

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway stop || true
  sleep 2
  rm -f ~/.hermes/gateway.pid ~/.hermes/*.lock 2>/dev/null || true
  \"\$HERMES\" gateway run --daemon
"
sleep 5
```

### Fix C — bot doesn't reply

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway status
  grep -iE 'allowlist|allowed' ~/.hermes/config.yaml | head -5
  tail -100 ~/.hermes/logs/gateway.log
"
```

Allowlist must be the **numeric** chat / user ID, not a handle. If `gateway status` is
not `running`, do Fix B first.

### Fix D — model error 400

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" model
"
```

OpenAI keys do NOT work against OpenRouter and vice-versa. If the configured model name
belongs to a different provider, reconfigure via `/hermes-model`. If a key is missing,
write it via Step 4 with `NEW_KEY_NAME` set appropriately.

### Fix E — vision / web / compression "don't work"

This is the silent-degradation gotcha: the auxiliary model has no provider key. Add the
missing key via Step 4 (e.g. `NEW_KEY_NAME=OPENAI_API_KEY`) and reload the gateway in
Step 6.

### Fix F — RSS many GB / OOM after a day (leak #25315)

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway stop; sleep 2; \"\$HERMES\" gateway run --daemon
  # Install nightly restart cron (idempotent)
  CRON_LINE='0 4 * * * \$HOME/.local/bin/hermes gateway stop; sleep 5; \$HOME/.local/bin/hermes gateway run --daemon'
  ( crontab -l 2>/dev/null | grep -v 'hermes gateway run --daemon' ; echo \"\$CRON_LINE\" ) | crontab -
"
```

### Fix G — Docker `chown … not permitted`

```bash
ssh "$VPS_USER@$VPS_IP" "
  id -u; id -g
  grep -E 'HERMES_(UID|GID)' ~/.hermes/.env 2>/dev/null || true
"
```

Set `HERMES_UID` / `HERMES_GID` in `~/.hermes/.env` to match the host user (via Step 4),
and verify the running image is not `v2026.4.23`. Same UID must own both CLI and
gateway processes.

### Fix H — "Not configured" for gateway tools (#13301)

Cosmetic. If `hermes mcp list` shows the tool and a smoke call succeeds, log and ignore.
Document it; do not "fix" by rewriting MCP config.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

After any fix that touched `.env`, config, or state (Fixes B / D / E / F / G), reload:

```bash
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway stop || true
"
sleep 2
ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway run --daemon
"
sleep 5
```

`gateway restart` does NOT reliably re-read `.env`. Always stop + run.

---

## Step 7 — verify the fix landed (poll logs up to 30s)

```bash
HEALED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "gateway.*(started|running|ready)|mcp.*registered"; then
    HEALED=1
    echo "OK: gateway is back and reading config."
    break
  fi
  sleep 5
done
[ "$HEALED" = "1" ] || { echo "FAIL: gateway did not come healthy after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live health smoke test

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
  \"\$HERMES\" gateway status 2>&1 | grep -ciE 'running|active|ok'
")
case "$HTTP" in
  [1-9]*) echo "OK: gateway healthy after fix." ;;
  0)      echo "FAIL: gateway still not healthy. Re-read /tmp/hermes_doctor.local.log."; rollback; exit 1 ;;
  *)      echo "WARN: unexpected status output. Check manually." ;;
esac
```

A healthy status plus the original symptom no longer reproducing = fix landed. If the
user reported a bot-silent symptom, ask them to send one test message to confirm.

---

## Rollback (auto-runs on any failure above)

Rollback for a fix skill means: undo any config change we wrote, then restart the
gateway cleanly so the user is left in the state they started in (broken but
non-destructive). Never wipe `~/.hermes` — that nukes their state.

```bash
rollback() {
  if [ -n "${NEW_KEY_NAME:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes config unset $NEW_KEY_NAME 2>/dev/null || \
      sed -i '/^${NEW_KEY_NAME}=/d' ~/.hermes/.env"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    HERMES=\$(command -v hermes || echo \"\$HOME/.local/bin/hermes\")
    \"\$HERMES\" gateway stop || true
    sleep 2
    \"\$HERMES\" gateway run --daemon || true
  "
  echo "Rolled back. State restored to pre-fix."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` after a config change | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 2 | `echo >> ~/.hermes/.env` to add a key | Can merge onto a prior line without trailing newline; silently invalid | Always `hermes config set` |
| 3 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 4 | sed with `/` delimiter on tokens | Tokens contain `/+=`; sed breaks | Use `\|` delimiter |
| 5 | Container vs host confusion | `whoami; hostname` reveals which layer you're on | Always check before editing config |
| 6 | Trusting `hermes doctor` exit code | Some warnings (#13301) are cosmetic; exit ≠ 0 doesn't mean broken | Parse output, don't gate on `$?` |
| 7 | `sudo` to "fix" install perms | Sudo install is usually the **cause** of the perms issue | Reinstall as the user, no sudo |
| 8 | Adding provider key but model name is wrong | OpenAI key against an OpenRouter model name returns 400 | Run `hermes model` to reconfigure together |
| 9 | Silent degradation on vision/web | Auxiliary model needs its own key; failure is silent | Add the auxiliary provider key, not just the main one |
| 10 | RSS leak (#25315) ignored | Process grows unbounded, OOM after ~1 day | Install nightly restart cron in Fix F |
| 11 | Docker `chown … not permitted` | UID mismatch; image `v2026.4.23` regressed | Set `HERMES_UID`/`HERMES_GID`; avoid that tag |
| 12 | Treating cosmetic "Not configured" as a bug | #13301 prints even when tools work | If `mcp list` + smoke call pass, ignore |
| 13 | Wiping `~/.hermes` to "reset" | Destroys memory, allowlists, personas | Rollback unsets keys; never `rm -rf ~/.hermes` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on VPS (0.15.x / 0.17.x) — OR Fix A applied if missing
- [ ] Idempotency check ran (healthy gateway exits early unless `FORCE=1`)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Any new secret written via `hermes config set`, file is `chmod 600`
- [ ] Secret NOT in `config.yaml` and NOT echoed in chat
- [ ] Matching fix (A–H) applied; gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show gateway healthy / MCP registered within 30s
- [ ] Live smoke test: `hermes gateway status` reports running
- [ ] Rollback function defined; `~/.hermes` not wiped
- [ ] If Fix F applied: nightly restart cron installed and visible in `crontab -l`

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for the full
symptom -> cause -> fix catalogue.
