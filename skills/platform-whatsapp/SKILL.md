---
name: platform-whatsapp
description: Wire a remote Hermes Agent to WhatsApp via QR pairing (Baileys, no Meta dev account) over SSH. Enforces a hard allowlist gate before enabling — refuses to proceed if the allowlist is empty. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-whatsapp — wire WhatsApp to a remote Hermes (SSH-first, hard-gated)

You are the engineer connecting WhatsApp to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Provide the bare phone numbers that are allowed to message the bot.
2. Scan the QR code with their phone (WhatsApp → Linked Devices → Link a Device).

Everything else — allowlist storage, hard-gate verification, QR generation, session
checks, smoke test — runs on the VPS via SSH, idempotently and with a rollback path.

**Honest picture (verified 2026-06):** Hermes uses **Baileys** (WhatsApp Web emulation) for
WhatsApp, NOT Meta's Cloud Business API. That means: no Meta developer account, no template
approval, QR pairing on the user's phone — but also no official SLA, occasional reconnect
churn, and a known **LID resolution bug** (issues #14486 / #15108) that breaks the internal
`@lid` allowlist format. The documented and reliable format is **bare phone numbers**.

**Why the hard allowlist gate matters:** WhatsApp received via Baileys is a chat bot any
phone number can DM. If `WHATSAPP_ENABLED=true` lands before `WHATSAPP_ALLOWED_USERS` is
populated, the bot fails OPEN — anyone with the number can talk to the agent and burn
through tokens, leak memory, or trigger tool calls. This skill **refuses to enable
WhatsApp** until the allowlist is set and verified.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ALLOWED_USERS` | Comma-separated bare phone numbers (country code + number, NO `+`, NO spaces) — e.g. `15551234567,447700900001` | The phones that should be able to DM the bot |
| `$HOME_CHANNEL` *(optional)* | Single bare phone number for cron pings / nightly summaries | Usually the operator's own number |

If `$ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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

Expected: `0.15.x` or `0.17.x`. Prefer the absolute `~/.local/bin/hermes` path — non-
interactive SSH has a stripped PATH and bare `hermes` may not resolve.

---

## Step 2 — idempotency check (skip if already wired and healthy)

WhatsApp is wired when `WHATSAPP_ENABLED=true`, the allowlist is non-empty, and the
session file exists on disk. If all three hold, skip — unless `FORCE=1`.

```bash
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^WHATSAPP_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^WHATSAPP_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'WHATSAPP_ALLOWED_USERS=\$'" || echo 0)
SESSION=$(ssh "$VPS_USER@$VPS_IP" "test -s ~/.hermes/platforms/whatsapp/session/creds.json && echo 1 || echo 0")
if [ "$ENABLED" = "1" ] && [ "$ALLOW" = "1" ] && [ "$SESSION" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "WhatsApp is already wired (enabled, allowlist set, session present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD ALLOWLIST GATE (this is the security boundary — refuse to proceed if empty)

This is the single most important step. Hermes WhatsApp fails OPEN if `WHATSAPP_ENABLED=true`
is set before `WHATSAPP_ALLOWED_USERS` is populated. We refuse to even start the wire-up
unless the operator has supplied at least one number.

```bash
if [ -z "${ALLOWED_USERS:-}" ]; then
  echo "ABORT: WHATSAPP_ALLOWED_USERS is empty. WhatsApp would fail OPEN."
  echo "Supply bare phone numbers (country code + number, NO '+', NO spaces), comma-separated."
  echo "Example: ALLOWED_USERS='15551234567,447700900001'"
  exit 1
fi

# Validate every number is digits-only, 7-15 chars (E.164 range without the +)
INVALID=$(printf '%s' "$ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && (!/^[0-9]+$/ || length($0) < 7 || length($0) > 15) { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid phone numbers in ALLOWED_USERS:"
  echo "$INVALID"
  echo "Each must be digits only, 7-15 chars, no '+', no spaces, no dashes."
  exit 1
fi
echo "Allowlist OK: $(printf '%s' "$ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ') number(s) supplied."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
NUMS=$(printf '%s' "$ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write WHATSAPP_ALLOWED_USERS ($NUMS number(s)) via 'hermes config set'
  2. Write WHATSAPP_HOME_CHANNEL (${HOME_CHANNEL:-none}) if supplied
  3. chmod 600 ~/.hermes/.env
  4. Verify allowlist landed (grep -c)
  5. ONLY NOW: WHATSAPP_ENABLED=true (gated on allowlist verification above)
  6. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  7. Start QR pairing: hermes whatsapp (prints QR to stdout)
  8. USER SCAN — WhatsApp → Settings → Linked Devices → Link a Device
  9. Wait up to 60s for ~/.hermes/platforms/whatsapp/session/creds.json to appear
 10. Smoke test: send self-DM from the first allowlisted number; expect reply

Numbers are NEVER printed in plaintext beyond a count + length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the allowlist first (NOT enable yet)

The order matters: allowlist before enable, with a verification gate in between. Never the
other way around.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set WHATSAPP_ALLOWED_USERS '$ALLOWED_USERS'"
if [ -n "${HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set WHATSAPP_HOME_CHANNEL '$HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify the allowlist actually landed in the env file before enabling:

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^WHATSAPP_ALLOWED_USERS=.+' ~/.hermes/.env | grep -cv 'WHATSAPP_ALLOWED_USERS=\$'" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: allowlist did not land. Rolling back, NOT enabling."; rollback; exit 1; }
echo "Allowlist confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, fall back to the safe sed pattern. Use the `|`
> delimiter — comma-separated phone lists are safe but the pattern is universal:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^WHATSAPP_ALLOWED_USERS=' ~/.hermes/.env || printf 'WHATSAPP_ALLOWED_USERS=\n' >> ~/.hermes/.env
>   sed -i 's|^WHATSAPP_ALLOWED_USERS=.*|WHATSAPP_ALLOWED_USERS=$ALLOWED_USERS|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>` into `.env` — it can merge onto a previous line without a trailing
newline and silently corrupt the file. Never put the allowlist in `config.yaml`.

---

## Step 6 — enable WhatsApp (only after the allowlist verification passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set WHATSAPP_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

# Re-verify both keys are present together — the only valid persistent state.
BOTH=$(ssh "$VPS_USER@$VPS_IP" "
  grep -c '^WHATSAPP_ENABLED=true' ~/.hermes/.env;
  grep -E '^WHATSAPP_ALLOWED_USERS=.+' ~/.hermes/.env | grep -cv 'WHATSAPP_ALLOWED_USERS=\$'
")
echo "$BOTH" | grep -q '^1$' || { echo "FAIL: enabled flag and allowlist not both set. Rolling back."; rollback; exit 1; }
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use `stop` + `run`.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — start QR pairing (HUMAN STEP: user scans on their phone)

`hermes whatsapp` prints a QR code to stdout. Stream it to the user's terminal and tell
them to scan with: **WhatsApp → Settings → Linked Devices → Link a Device**.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes whatsapp" &
QR_PID=$!
echo "Scan the QR above with your phone within 60 seconds."
echo "WhatsApp → Settings → Linked Devices → Link a Device."
```

If pairing succeeds, Hermes writes the session under `~/.hermes/platforms/whatsapp/session/`
(typically `creds.json` plus per-device sub-keys). If pairing times out, the QR rotates —
re-run the command.

---

## Step 9 — verify pairing landed (poll up to 90s for session file)

```bash
PAIRED=0
for i in $(seq 1 18); do
  if ssh "$VPS_USER@$VPS_IP" "test -s ~/.hermes/platforms/whatsapp/session/creds.json && echo 1" \
       | grep -q '^1$'; then
    PAIRED=1
    echo "OK: WhatsApp session created."
    break
  fi
  sleep 5
done
[ "$PAIRED" = "1" ] || { echo "FAIL: QR not scanned / session not written within 90s. Rolling back."; rollback; exit 1; }
```

---

## Step 10 — live smoke test (self-message from an allowlisted number)

The user sends one short message ("ping") from the first allowlisted phone number to the
linked WhatsApp account. Confirm the bot replies. There is no agent-only smoke path —
this requires a real WhatsApp client.

```bash
FIRST_NUM=$(printf '%s' "$ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from your phone (number $FIRST_NUM):
  1. Open WhatsApp on $FIRST_NUM.
  2. Send "ping" to the linked WhatsApp account.
  3. The bot should reply within 5s.

If no reply: check 'hermes logs gateway -n 50' on the VPS for WhatsApp errors,
and confirm the number in your phone is in WHATSAPP_ALLOWED_USERS exactly
(country code + number, no '+', no spaces).
EOF
```

Optional: tail the recent gateway log for the first message to land:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -iE 'whatsapp|baileys'" | tail -20
```

---

## Rollback (auto-runs on any failure above)

Rollback DISABLES WhatsApp and clears the env, but preserves the session file so a later
re-attempt can pair without a fresh QR if the operator wants to resume.

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set WHATSAPP_ENABLED false 2>/dev/null || \
    sed -i 's|^WHATSAPP_ENABLED=true|WHATSAPP_ENABLED=false|' ~/.hermes/.env"
  # Keep the allowlist and home channel in place — they're not the safety problem.
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. WhatsApp disabled. Session file preserved for retry."
}
```

If the operator wants a hard wipe (re-pair from scratch, e.g. after a stolen phone):

```bash
hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "rm -rf ~/.hermes/platforms/whatsapp/session/"
  echo "Hard-rolled back. Session wiped. Next /platform-whatsapp will require a fresh QR scan."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `WHATSAPP_ENABLED=true` set before allowlist | Bot fails OPEN — any phone can DM and burn tokens / leak memory | Step 3 hard-gate; Step 6 only fires after Step 5 verification |
| 2 | `WHATSAPP_ALLOWED_USERS` with `+`, spaces, or dashes | Allowlist matcher does a literal string compare; `+15551234567` ≠ `15551234567` | Step 3 validator rejects anything non-digit / outside 7-15 chars |
| 3 | Using `@lid` format in the allowlist | Open LID resolution bug (#14486 / #15108) — messages from LID-format users are not matched | Always use bare phone numbers, never `@lid` |
| 4 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env`; the QR pairs but messages don't route | Always `stop` + `run` (Step 7) |
| 5 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline → corrupted env | Always `hermes config set` (Step 5), or the documented sed pattern |
| 6 | Allowlist in `config.yaml` | `config.yaml` is checked into git in some setups → public exposure of phone numbers | Only `~/.hermes/.env`, `chmod 600` |
| 7 | QR rotation timeout | Default Baileys QR rotates every ~20s; user fumbles → fails | Tell user up front; re-run `hermes whatsapp` if it rotates |
| 8 | Stolen phone / lost device | Session is on the VPS but pairs to the user's phone — losing the phone doesn't revoke | Run `hard_rollback` and re-pair from a new phone |
| 9 | Container vs host confusion | `hermes` inside a container is invisible to the host SSH session | Step 1 detects both via `docker ps` |
| 10 | sed with `/` delimiter on env values | Phone lists are safe but the universal rule prevents future bugs | Always use `\|` delimiter |
| 11 | Number-format mismatch on cross-border numbers | Some countries' WhatsApp clients send a leading `0` that's NOT in the country-code form | Always use full E.164 minus the `+` (e.g. UK `447700900001`, not `07700900001`) |
| 12 | Two QRs in flight from rapid re-runs | Second `hermes whatsapp` invalidates the first → user scans the wrong one | Kill any prior `hermes whatsapp` PID before starting a new one |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + allowlist + session, unless `FORCE=1`)
- [ ] HARD ALLOWLIST GATE passed: `$ALLOWED_USERS` non-empty, every number digits-only and 7-15 chars
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `WHATSAPP_ALLOWED_USERS` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `WHATSAPP_HOME_CHANNEL` written if supplied
- [ ] `WHATSAPP_ENABLED=true` set ONLY after allowlist verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] `hermes whatsapp` printed a QR; user scanned within 60s
- [ ] `~/.hermes/platforms/whatsapp/session/creds.json` exists and is non-empty
- [ ] Live smoke: user DM'd the bot from an allowlisted number and got a reply
- [ ] Rollback function defined (graceful: disables enable flag, keeps session; `hard_rollback` wipes session)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, allowlist,
and Baileys pairing failure modes.
