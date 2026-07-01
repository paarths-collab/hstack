---
name: hermes-memory
description: Configure Hermes memory (built-in by default, or an external provider like mem0) on a self-hosted Hermes Agent over SSH. Surfaces the memory-ceiling reality, installs the python dep into the right venv, and verifies via `hermes memory status`. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-memory — configure Hermes memory (SSH-first)

You are the engineer configuring Hermes memory for the user. The agent (Hermes, Codex,
Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over
SSH as root. Every command in this skill runs on the VPS, not on the local machine.

Built-in memory is **always on** and is the safe default. Only add an external provider
if the user explicitly wants larger/searchable memory. Do everything autonomously; stop
only for things a machine cannot do (mint an API key for the external provider, confirm
the user really wants to switch off built-in).

**Honest auth picture (verified 2026-06):** Built-in memory needs no credentials.
External providers (`mem0`, `openviking`, `memori`) need (a) an API key in
`~/.hermes/.env` and (b) the python package installed into Hermes's venv. Issue #25086
means `hermes memory setup` reports success but does **NOT** install the python dep —
the agent then crashes at runtime on the first memory call. We install the dep
explicitly. Cloud providers also fail at runtime if the key is missing or wrong; we
verify with `hermes memory status` before declaring success.

The big honest caveat to tell the user up front: **built-in memory is bounded** —
structured note-taking against a finite character budget, not unbounded learning. The
exact figure isn't called out in the reference docs, so describe it as "limited, will
fill" rather than a number. When it fills, practitioners report the agent **spends
turns consolidating instead of working** — that's your cue to prune or attach an
external provider. This contradicts the "grows with you" marketing. Say so plainly.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$MODE` | `builtin` (default) or `external` | Ask: "Stay on built-in, or switch to mem0?" |
| `$PROVIDER` | Only if `$MODE=external`: `mem0`, `openviking`, or `memori` | User's choice |
| `$MEM0_API_KEY` | Only if `$PROVIDER=mem0` | <https://app.mem0.ai/dashboard/api-keys> |

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

Container vs host: if `whoami; hostname` shows a hex container name, you are inside
Docker — exit and re-run on the host before touching any config.

---

## Step 2 — idempotency check (skip if already wired)

```bash
CURRENT=$(ssh "$VPS_USER@$VPS_IP" "hermes config get memory.provider 2>/dev/null || echo builtin")
echo "Current memory provider on VPS: $CURRENT"

if [ "$MODE" = "builtin" ] && [ "$CURRENT" = "builtin" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Already on built-in memory. Set FORCE=1 to re-verify."
  ssh "$VPS_USER@$VPS_IP" "hermes memory status"
  exit 0
fi

if [ "$MODE" = "external" ] && [ "$CURRENT" = "$PROVIDER" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Provider '$PROVIDER' already configured. Set FORCE=1 to rewire."
  ssh "$VPS_USER@$VPS_IP" "hermes memory status"
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
if [ "$MODE" = "builtin" ]; then
  cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Ensure memory.provider = builtin (unset any external provider)
  2. Reload gateway: hermes gateway stop && hermes gateway run
  3. Verify: hermes memory status

No secrets written. No python dep installed.
EOF
else
  cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write \$${PROVIDER^^}_API_KEY (length: ${#MEM0_API_KEY}, prefix: ${MEM0_API_KEY:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Set memory.provider = $PROVIDER
  4. Install python dep into Hermes venv: ${PROVIDER}ai (issue #25086 workaround)
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify: hermes memory status

The API key is NEVER printed in plaintext.
EOF
fi
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

Skip this step entirely if `$MODE=builtin`.

```bash
if [ "$MODE" = "external" ] && [ "$PROVIDER" = "mem0" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MEM0_API_KEY '$MEM0_API_KEY'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
fi
```

Verify (returns `1`, NEVER the value):

```bash
if [ "$MODE" = "external" ] && [ "$PROVIDER" = "mem0" ]; then
  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MEM0_API_KEY=' ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: MEM0_API_KEY not written. Rolling back."; rollback; exit 1; }
fi
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — provider keys can contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MEM0_API_KEY=' ~/.hermes/.env || printf 'MEM0_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MEM0_API_KEY=.*|MEM0_API_KEY=$MEM0_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never use `echo "MEM0_API_KEY=..." >> ~/.hermes/.env` — it can merge onto the previous
line if the file lacks a trailing newline. Always `hermes config set` (or the sed
fallback above).

---

## Step 5 — switch the provider AND install the python dep

This is the step where most failures happen. Path A (built-in) is preferred unless the
user explicitly chose external.

### Path A — built-in (default)

```bash
if [ "$MODE" = "builtin" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes config set memory.provider builtin
  "
fi
```

### Path B — external provider (mem0 / openviking / memori)

```bash
if [ "$MODE" = "external" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes config set memory.provider $PROVIDER
  "

  # CRITICAL: 'hermes memory setup' reports success but does NOT install the python
  # dep (issue #25086). We install it ourselves into the Hermes venv.
  PKG="${PROVIDER}ai"
  [ "$PROVIDER" = "memori" ] && PKG="memori"
  [ "$PROVIDER" = "openviking" ] && PKG="openviking"

  ssh "$VPS_USER@$VPS_IP" "
    VENV_PY=\$(ls ~/.hermes/hermes-agent/venv/bin/python 2>/dev/null \
              || ls /opt/hermes/venv/bin/python 2>/dev/null \
              || echo MISSING)
    if [ \"\$VENV_PY\" = MISSING ]; then
      echo 'FAIL: could not find Hermes venv python. Check /hermes-install.'
      exit 1
    fi
    if command -v uv >/dev/null 2>&1; then
      uv pip install --python \"\$VENV_PY\" $PKG
    else
      \"\$VENV_PY\" -m pip install $PKG
    fi
  " || { echo "FAIL: pip install $PKG. Rolling back."; rollback; exit 1; }
fi
```

Only ONE external provider may be active at a time. If the user is switching providers,
`hermes config set memory.provider <new>` overwrites the old setting — but the old
python package stays installed (harmless).

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify in logs (poll up to 30s)

```bash
REGISTERED=0
PATTERN="memory.*ready|memory provider.*loaded|memory.*$PROVIDER"
[ "$MODE" = "builtin" ] && PATTERN="memory.*builtin|builtin memory.*ready|memory provider.*loaded"

for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "$PATTERN"; then
    REGISTERED=1
    echo "OK: memory provider visible in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: memory provider not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live memory smoke test

```bash
# `hermes memory status` exits non-zero if the provider cannot initialize (e.g. missing
# python dep, bad API key). This is the load-bearing check for issue #25086.
HTTP=$(ssh "$VPS_USER@$VPS_IP" "hermes memory status >/tmp/mem.out 2>&1; echo \$?")
case "$HTTP" in
  0)
    echo "OK: memory provider initialized."
    ssh "$VPS_USER@$VPS_IP" "cat /tmp/mem.out"
    ;;
  *)
    echo "FAIL: hermes memory status exited $HTTP."
    ssh "$VPS_USER@$VPS_IP" "cat /tmp/mem.out"
    echo "Common causes: missing python dep (#25086), bad API key, gateway not re-read .env."
    rollback
    exit 1
    ;;
esac
```

For `$MODE=external`, do one round-trip write/read to confirm the cloud key works:

```bash
if [ "$MODE" = "external" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes memory write --note 'hstack-smoke-test' 2>&1 | tail -5"
  ssh "$VPS_USER@$VPS_IP" "hermes memory search 'hstack-smoke-test' 2>&1 | tail -5"
fi
```

A `401`/`403`-equivalent error in the provider response = bad/missing API key — go back
to Step 4.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set memory.provider builtin 2>/dev/null || true"
  if [ "$MODE" = "external" ] && [ "$PROVIDER" = "mem0" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes config unset MEM0_API_KEY 2>/dev/null || \
      sed -i '/^MEM0_API_KEY=/d' ~/.hermes/.env"
  fi
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back to built-in memory."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `hermes memory setup` reports success but agent crashes at runtime | Issue #25086: setup does NOT install the python dep | Always run `uv pip install --python <venv> <pkg>` after switching to external |
| 2 | Two external providers active at once | Only ONE may run; the second fails silently or crashes | `hermes config set memory.provider <new>` overwrites; never keep two in `.env` |
| 3 | Cloud provider key missing or wrong | Provider fails at runtime, not at config-set time | Always finish with `hermes memory status` and a write/read round-trip |
| 4 | Built-in memory described as "unlimited" | It is bounded; will fill; agent then consolidates instead of working | Tell the user up front; offer pruning or external when full |
| 5 | Stale memory files | "#1 cause of weird agent behavior" per practitioners | Have the agent read its memory aloud, then prune the bad notes |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | `echo >> .env` to add the API key | Merges onto a prior line without a trailing newline; silently breaks parsing | Always `hermes config set` (or the sed fallback) |
| 8 | API key in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 9 | sed with `/` delimiter on keys | Provider keys contain `/+=` | Use `\|` delimiter |
| 10 | Container vs host confusion | Config written inside container is invisible to host venv (and vice versa) | Always check `whoami; hostname` first; exit container before configuring |
| 11 | Wrong venv path | `~/.hermes/hermes-agent/venv` is the v0.15.2 path; older builds differ | The Step 5 script tries multiple locations and aborts if none match |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] If external: API key written to `~/.hermes/.env`, file is `chmod 600`
- [ ] Secret NOT in `config.yaml` and NOT echoed in chat
- [ ] If external: python dep installed into the Hermes venv (issue #25086 worked around)
- [ ] `memory.provider` set to the chosen value (`builtin` or `$PROVIDER`)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show memory provider initialized within 30s
- [ ] `hermes memory status` exits 0
- [ ] If external: smoke write/read round-trip succeeded
- [ ] User told plainly: built-in is bounded; describe as "limited, will fill"
- [ ] Rollback function defined and tested

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and
memory-provider failure modes.
