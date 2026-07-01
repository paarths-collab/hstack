---
name: hermes-cron
description: Add, list, and manage scheduled tasks (cron) for a self-hosted Hermes agent over SSH, including the recommended reliability defaults (nightly gateway restart, nightly backup, weekly session prune). Works from any AI agent — Claude Code, Codex, Cursor, Gemini CLI, or Hermes itself.
---

# /hermes-cron — scheduled tasks (SSH-first)

You are the engineer wiring scheduled tasks on a self-hosted Hermes agent. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a
remote VPS over SSH as root. Every `hermes cron …` command in this skill runs on the
VPS, not on the local machine.

Cron jobs run the agent on a timer and deliver results to the configured home channel.
Schedules accept one-shot durations (`30m`, `2h`), intervals (`every 30m`, `every 2h`,
`every 1d`), classic cron expressions (`0 9 * * 1-5`), or ISO timestamps.

Do everything autonomously; stop only for things a machine cannot do (mint a token,
scan a QR, send the first hello). For cron, that means: confirm the natural-language
prompt + schedule with the user once, then write everything.

**Honest picture (verified 2026-06):** Hermes cron sessions run in a fresh session each
firing — they cannot recursively create more crons, and they cannot read prior session
memory unless you store it explicitly. Scripts live in `~/.hermes/scripts/`. Self-hosted
Hermes also has a known memory-leak / OOM (#25315) which is exactly why the nightly
gateway-restart default exists.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$CRON_SCHEDULE` | Natural-language or cron-expr schedule (e.g. `every 1d`, `0 9 * * 1-5`, `30m`) | Ask the user |
| `$CRON_PROMPT` | What the agent should do each firing, in plain English | Ask the user |
| `$CRON_TZ` | (optional) IANA timezone for human-readable schedules; defaults to UTC | Ask the user if "8am" is mentioned |

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

Expected: a version string like `0.15.x` or `0.17.x`.

If you got `root@<hex-string>` from `hostname`, you are **inside a container** — type
`exit` first. Crons added inside a container disappear when the container restarts.

---

## Step 2 — idempotency check (skip if already wired)

Hermes does not dedupe crons by prompt — if you run this twice you get two crons firing
in parallel. Always grep the existing list first.

```bash
# Slugify the prompt for matching (first 40 chars, lowercase, alnum only)
SLUG=$(printf '%s' "$CRON_PROMPT" | tr '[:upper:]' '[:lower:]' \
       | tr -c 'a-z0-9' ' ' | tr -s ' ' | cut -c1-40)
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes cron list 2>/dev/null" \
          | grep -cFi "$SLUG" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "A cron matching this prompt is already registered. Set FORCE=1 to add anyway."
  ssh "$VPS_USER@$VPS_IP" "hermes cron list"
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. hermes cron create "$CRON_SCHEDULE" "$CRON_PROMPT"
     (timezone: ${CRON_TZ:-UTC}; human-readable schedules are converted to UTC server-side)
  2. hermes cron list (to capture the new cron ID for rollback)
  3. Verify the new cron appears in 'hermes cron list'
  4. Verify the gateway is still healthy after the write

No secrets are written by this skill. The prompt above WILL be visible in
'hermes cron list' output — don't embed tokens in it.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — create the cron (no echo, no logging of internals)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes cron create '$CRON_SCHEDULE' '$CRON_PROMPT'" \
  || { echo "FAIL: hermes cron create returned non-zero. Rolling back."; rollback; exit 1; }
```

Capture the new cron ID so rollback can target it exactly:

```bash
NEW_CRON_ID=$(ssh "$VPS_USER@$VPS_IP" "hermes cron list 2>/dev/null" \
              | grep -F "$CRON_PROMPT" | head -1 | awk '{print $1}')
[ -n "$NEW_CRON_ID" ] || { echo "FAIL: could not locate new cron ID. Rolling back."; rollback; exit 1; }
echo "OK: created cron $NEW_CRON_ID"
```

> If your Hermes build emits the ID on stdout from `cron create`, capture it directly:
> ```bash
> NEW_CRON_ID=$(ssh "$VPS_USER@$VPS_IP" "hermes cron create '$CRON_SCHEDULE' '$CRON_PROMPT'" \
>               | awk '/^cron/{print $2; exit}')
> ```

---

## Step 5 — install the three recommended reliability defaults (idempotent)

These are safe to run on every invocation — each one self-skips if already present.
Skip this step entirely with `SKIP_DEFAULTS=1`.

```bash
if [ "${SKIP_DEFAULTS:-0}" != "1" ]; then
  ssh "$VPS_USER@$VPS_IP" 'bash -s' <<'REMOTE'
    HERMES="$HOME/.local/bin/hermes"
    [ -x "$HERMES" ] || HERMES="hermes"

    install_if_absent() {
      local schedule="$1" prompt="$2" slug="$3"
      if "$HERMES" cron list 2>/dev/null | grep -qFi "$slug"; then
        echo "skip: '$slug' already present"
      else
        "$HERMES" cron create "$schedule" "$prompt" \
          && echo "added: $slug" \
          || echo "warn: could not add '$slug'"
      fi
    }

    # 1) Nightly gateway restart — mitigates OOM (#25315) before it crashes.
    install_if_absent "every 1d" \
      "Run hermes gateway stop then hermes gateway run --daemon to recycle memory" \
      "gateway restart"

    # 2) Nightly backup — push ~/.hermes to a private backup repo.
    install_if_absent "every 1d" \
      "Push changes in ~/.hermes to the backup GitHub repo" \
      "backup github"

    # 3) Weekly session prune — ~/.hermes bloats to multi-GB with ~3000 session files.
    install_if_absent "every 7d" \
      "Prune session files in ~/.hermes older than 14 days" \
      "session prune"
REMOTE
fi
```

---

## Step 6 — reload the gateway (stop + run, NOT restart)

Cron writes don't strictly require a gateway reload, but the gateway must be healthy for
the cron daemon inside Hermes to actually fire. Use stop + run, never `gateway restart`.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify the cron appears in `hermes cron list` (poll up to 30s)

```bash
FOUND=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes cron list 2>&1" \
       | grep -qF "$CRON_PROMPT"; then
    FOUND=1
    echo "OK: cron is listed."
    break
  fi
  sleep 5
done
[ "$FOUND" = "1" ] || { echo "FAIL: cron not in list after 30s. Rolling back."; rollback; exit 1; }
```

Also confirm the gateway came back up and there are no fatal errors in the last 100 log
lines (cron daemon failures show up here):

```bash
ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -100" \
  | grep -qiE "cron.*(loaded|scheduled|started)" \
  || echo "WARN: did not see cron scheduler confirmation in logs — verify manually."
```

---

## Step 8 — live trigger smoke test (run the cron once, immediately)

For non-destructive prompts, run the new cron once to confirm the agent actually picks it
up. Skip with `SKIP_SMOKE=1` if the prompt has side effects (sends email, posts to a
channel, etc.).

```bash
if [ "${SKIP_SMOKE:-0}" != "1" ]; then
  HTTP_OK=$(ssh "$VPS_USER@$VPS_IP" "hermes cron run '$NEW_CRON_ID' 2>&1" \
            | grep -ciE "queued|started|ok|running" || echo 0)
  case "$HTTP_OK" in
    0)  echo "WARN: cron run did not report queued/started. Inspect 'hermes logs'." ;;
    *)  echo "OK: cron $NEW_CRON_ID fired manually." ;;
  esac
fi
```

A successful manual run proves: (a) the schedule parsed, (b) the prompt is valid, and
(c) the home channel delivery works. If it fails, the scheduled firing will fail too.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ -n "${NEW_CRON_ID:-}" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes cron remove '$NEW_CRON_ID' 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Cron $NEW_CRON_ID (if created) is no longer scheduled."
}
```

---

## Managing existing crons

All `hermes cron` subcommands run identically over SSH:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes cron list"
ssh "$VPS_USER@$VPS_IP" "hermes cron pause '<id>'"
ssh "$VPS_USER@$VPS_IP" "hermes cron resume '<id>'"
ssh "$VPS_USER@$VPS_IP" "hermes cron run '<id>'"
ssh "$VPS_USER@$VPS_IP" "hermes cron remove '<id>'"
```

In-chat shortcut for end users: tell the agent in conversation *"every morning at 8am,
summarize my unread emails"* — Hermes writes the cron itself and converts to UTC. This
skill is for the SSH-first, idempotent, agent-driven path.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Cron-run sessions trying to create more crons | Each firing is a fresh session and cannot recurse | Generate the cron up-front; have the firing call a script in `~/.hermes/scripts/` |
| 2 | Human-readable schedule with no timezone | Defaults to UTC — "8am" fires at the wrong hour | Specify `$CRON_TZ` or convert before passing |
| 3 | Duplicate crons from re-running this skill | `cron create` does NOT dedupe by prompt | Idempotency check in Step 2 |
| 4 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 5 | `echo >> .env` instead of `hermes config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (this skill writes no secrets, but the rule still applies if your prompt loads one) |
| 6 | Secrets in `config.yaml` or in the cron prompt | `cron list` is plaintext, world-readable | Reference env vars only; secrets stay in `~/.hermes/.env`, `chmod 600` |
| 7 | sed with `/` delimiter on tokens | Tokens contain `/+=`; sed breaks | Always use `\|` delimiter |
| 8 | Adding the cron inside a container | Disappears on container restart | `whoami; hostname` check first; exit the container if you see a hex name |
| 9 | `~/.hermes` ballooning to multi-GB | ~3000 session files accumulate over months | Install the weekly session-prune default (Step 5) |
| 10 | Gateway OOM mid-week (#25315) | Known memory leak in self-hosted Hermes | Install the nightly gateway-restart default (Step 5) |
| 11 | No backup of `~/.hermes` | Hermes does not auto-backup; one bad disk = total loss of memory, crons, config | Install the nightly backup default (Step 5) |
| 12 | Skipping the verify step | Silent success — cron written but scheduler not loaded | Always poll `cron list` + grep logs |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x), confirmed running on host not container
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] New cron created via `hermes cron create`; ID captured for rollback
- [ ] Three reliability defaults installed or skipped via `SKIP_DEFAULTS=1`
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] `hermes cron list` shows the new cron within 30s
- [ ] Smoke test: manual `hermes cron run <id>` reported queued/started (or `SKIP_SMOKE=1`)
- [ ] No secrets in the cron prompt, in `config.yaml`, or echoed in chat
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, memory-leak, and cron failure modes.
