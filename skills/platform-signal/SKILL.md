---
name: platform-signal
description: Wire a remote Hermes Agent to Signal via a linked signal-cli HTTP daemon over SSH. Enforces a hard allowlist gate and a Java/daemon pre-flight check before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-signal — wire Signal to a remote Hermes (SSH-first, linked-device via signal-cli)

You are the engineer connecting Signal to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does three things a machine cannot:

1. Have a phone with Signal installed (the daemon links as a SECONDARY device on it).
2. Scan the QR shown by `signal-cli link` from **Settings → Linked Devices → Link New Device**.
3. Supply the bot's own phone number (the linked phone's number, in E.164 with leading `+`).

Everything else — Java check, signal-cli install probe, daemon startup, allowlist gate,
HTTP health check, gateway reload, smoke test — runs on the VPS via SSH, idempotently with
a rollback path.

**Honest picture (verified 2026-06 on Hermes v0.15.x/0.17.x):** Hermes does NOT embed a
Signal client. It talks HTTP to a **signal-cli** daemon (Java, bound to `127.0.0.1` only).
You link signal-cli as a SECONDARY device on the user's primary Signal account, then point
Hermes at the local daemon. Trade-offs:

- **Java 17+ required on the host** — older JREs fail with cryptic protobuf errors at link time.
- **Linking happens on the HOST, not inside a container** — the per-user data dir
  (`~/.local/share/signal-cli/`) belongs to the host user; linking inside `docker exec`
  silently writes to the container's ephemeral filesystem and the daemon can't find it
  later. This skill explicitly runs link commands via `ssh` on the host shell.
- **Daemon must stay supervised** — if signal-cli dies, Hermes silently stops receiving.
  This skill writes a systemd unit so it survives reboots.
- **No message edits** — Signal protocol doesn't support edits, so Hermes suppresses
  tool-progress bubbles on Signal. Don't debug "missing progress" as a bug.

**Why the hard allowlist matters:** With `SIGNAL_ALLOWED_USERS` empty and
`SIGNAL_ALLOW_ALL_USERS` unset, Signal-side unknown senders get the DM pairing-code flow —
fine for first-touch but easy to forget and walk away from. This skill refuses to enable
Signal until at least one allowed E.164 number is set, and aborts if
`SIGNAL_ALLOW_ALL_USERS=true` is present in the env (footgun for production).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SIGNAL_ACCOUNT` | The BOT's own number in E.164 with `+` (the phone you're linking on) | The Signal app on the phone you'll link → Settings → top of screen |
| `$SIGNAL_ALLOWED_USERS` | Comma-separated E.164 numbers (with `+`) allowed to message the bot | The people who should be able to DM the agent |
| `$SIGNAL_GROUP_ALLOWED_USERS` *(optional)* | Comma-separated E.164 numbers allowed in group chats | Often a wider list than DM allowlist |
| `$SIGNAL_HOME_CHANNEL` *(optional)* | E.164 or group ID for cron pings | The operator's own number for personal notifications |
| `$DAEMON_PORT` *(optional)* | Localhost port for signal-cli HTTP (default `8080`) | Pick something not used by another service on the VPS |

If `$SIGNAL_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes, Java 17+, and signal-cli on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e

  # Hermes
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  else
    echo "FAIL: hermes not found on host (signal-cli must run on host, not in a container)"; exit 1
  fi
  echo "Hermes: $($HERMES --version)"

  # Java 17+
  command -v java >/dev/null 2>&1 || { echo "FAIL: java not installed. Install JRE 17+: apt install openjdk-17-jre-headless"; exit 1; }
  JV=$(java -version 2>&1 | head -1 | grep -oE "[0-9]+" | head -1)
  [ "$JV" -ge 17 ] 2>/dev/null || { echo "FAIL: Java $JV detected; signal-cli requires Java 17+."; exit 1; }
  echo "Java: $(java -version 2>&1 | head -1)"

  # signal-cli
  command -v signal-cli >/dev/null 2>&1 || { echo "FAIL: signal-cli not installed. See https://github.com/AsamK/signal-cli/wiki"; exit 1; }
  echo "signal-cli: $(signal-cli --version)"
' || { echo "ABORT: VPS pre-flight failed (see above)."; exit 1; }
```

If anything is missing, the operator must install it before re-running this skill.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SIGNAL_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_ACCT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^SIGNAL_ACCOUNT=\\+[0-9]' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SIGNAL_HTTP_URL=http' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^SIGNAL_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'SIGNAL_ALLOWED_USERS=\$'" || echo 0)
DAEMON_UP=$(ssh "$VPS_USER@$VPS_IP" "curl -fsS --max-time 3 'http://127.0.0.1:${DAEMON_PORT:-8080}/api/v1/check' >/dev/null 2>&1 && echo 1 || echo 0")
if [ "$ENABLED" = "1" ] && [ "$HAS_ACCT" = "1" ] && [ "$HAS_URL" = "1" ] && [ "$ALLOW" = "1" ] && [ "$DAEMON_UP" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Signal already wired (enabled, account, daemon up, allowlist set). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + E.164 + no SIGNAL_ALLOW_ALL_USERS)

```bash
if [ -z "${SIGNAL_ALLOWED_USERS:-}" ]; then
  echo "ABORT: SIGNAL_ALLOWED_USERS is empty. Unknown senders would trigger DM pairing flow."
  echo "Supply E.164 numbers with leading '+', comma-separated. Example: +15551234567,+447700900001"
  exit 1
fi

# Validate E.164 with leading +: + then 7-15 digits.
INVALID=$(printf '%s' "$SIGNAL_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^\+[0-9]{7,15}$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid Signal allowlist entries (must be E.164 with leading +):"
  echo "$INVALID"
  echo "Note: Signal allowlist uses '+' (unlike WhatsApp which uses bare numbers)."
  exit 1
fi

# Bot account same format
printf '%s' "$SIGNAL_ACCOUNT" | grep -qE '^\+[0-9]{7,15}$' \
  || { echo "ABORT: SIGNAL_ACCOUNT must be E.164 with leading + (the BOT's own number, not the user's)."; exit 1; }

# Refuse SIGNAL_ALLOW_ALL_USERS=true in env (production footgun)
EXISTING_ALL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SIGNAL_ALLOW_ALL_USERS=true' ~/.hermes/.env 2>/dev/null" || echo 0)
[ "$EXISTING_ALL" = "0" ] \
  || { echo "ABORT: SIGNAL_ALLOW_ALL_USERS=true is present in ~/.hermes/.env. Remove it before enabling for production."; exit 1; }

echo "Allowlist + account format OK. SIGNAL_ALLOW_ALL_USERS=true is NOT present."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$SIGNAL_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
PORT=${DAEMON_PORT:-8080}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Run 'signal-cli link -n HermesAgent' on the HOST — outputs a tsdevice:/... URI
     and a QR. USER scans from Signal → Settings → Linked Devices → Link New Device.
  2. Wait up to 120s for ~/.local/share/signal-cli/data/$SIGNAL_ACCOUNT to exist.
  3. Write systemd unit /etc/systemd/system/signal-cli-daemon.service that runs:
        signal-cli --account $SIGNAL_ACCOUNT daemon --http 127.0.0.1:$PORT
     bound to localhost only, restart=always.
  4. systemctl enable --now signal-cli-daemon
  5. Poll http://127.0.0.1:$PORT/api/v1/check up to 30s — expect OK
  6. Write SIGNAL_ACCOUNT, SIGNAL_HTTP_URL, SIGNAL_ALLOWED_USERS via 'hermes config set'
  7. chmod 600 ~/.hermes/.env
  8. ONLY NOW: SIGNAL_ENABLED=true
  9. Reload Hermes: hermes gateway stop && hermes gateway run (NOT restart)
 10. Verify Signal in Hermes logs + smoke test from allowlisted number

Numbers are NEVER printed in plaintext beyond a count + the bot account (already supplied).
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — link signal-cli on the host (HUMAN STEP: user scans QR)

```bash
# Run linking on the HOST as the user that will own ~/.local/share/signal-cli/.
# Show the link URI; user scans it from Signal app within 120s.
ssh -t "$VPS_USER@$VPS_IP" "signal-cli link -n HermesAgent" &
LINK_PID=$!
echo "Scan the QR (or open the tsdevice:/... URI) within 120s."
echo "On the phone: Signal → Settings → Linked Devices → Link New Device → scan."

# Poll for the linked-account data directory to appear
LINKED=0
for i in $(seq 1 24); do
  HAS_DATA=$(ssh "$VPS_USER@$VPS_IP" "test -d ~/.local/share/signal-cli/data && ls ~/.local/share/signal-cli/data 2>/dev/null | grep -F '$SIGNAL_ACCOUNT'" 2>/dev/null)
  if [ -n "$HAS_DATA" ]; then
    LINKED=1
    echo "OK: signal-cli linked for account $SIGNAL_ACCOUNT."
    break
  fi
  sleep 5
done
kill "$LINK_PID" 2>/dev/null || true
[ "$LINKED" = "1" ] || { echo "FAIL: signal-cli link did not complete within 120s. Re-run /platform-signal."; exit 1; }
```

---

## Step 6 — write a supervised systemd unit for the daemon

The daemon MUST stay up. systemd handles restart-on-crash and reboot survival.

```bash
PORT=${DAEMON_PORT:-8080}
ssh "$VPS_USER@$VPS_IP" "cat > /etc/systemd/system/signal-cli-daemon.service" <<EOF
[Unit]
Description=signal-cli HTTP daemon for Hermes
After=network.target

[Service]
Type=simple
User=$VPS_USER
ExecStart=/usr/local/bin/signal-cli --account $SIGNAL_ACCOUNT daemon --http 127.0.0.1:$PORT
Restart=always
RestartSec=10
StandardOutput=append:/var/log/signal-cli-daemon.log
StandardError=append:/var/log/signal-cli-daemon.log

[Install]
WantedBy=multi-user.target
EOF

# Adjust ExecStart path if signal-cli is elsewhere
ssh "$VPS_USER@$VPS_IP" "
  SCLI=\$(command -v signal-cli)
  sed -i \"s|/usr/local/bin/signal-cli|\$SCLI|\" /etc/systemd/system/signal-cli-daemon.service
  systemctl daemon-reload
  systemctl enable --now signal-cli-daemon
"
```

---

## Step 7 — wait for the daemon HTTP endpoint to come up (poll 30s)

```bash
PORT=${DAEMON_PORT:-8080}
DAEMON_UP=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "curl -fsS --max-time 3 'http://127.0.0.1:$PORT/api/v1/check' >/dev/null 2>&1"; then
    DAEMON_UP=1
    echo "OK: signal-cli daemon listening on 127.0.0.1:$PORT"
    break
  fi
  sleep 5
done
[ "$DAEMON_UP" = "1" ] || {
  echo "FAIL: signal-cli daemon did not respond. Check 'journalctl -u signal-cli-daemon -n 50' on the VPS."
  rollback
  exit 1
}
```

---

## Step 8 — write Hermes config (NOT enable yet)

```bash
PORT=${DAEMON_PORT:-8080}
ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_ACCOUNT '$SIGNAL_ACCOUNT'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_HTTP_URL 'http://127.0.0.1:$PORT'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_ALLOWED_USERS '$SIGNAL_ALLOWED_USERS'"
if [ -n "${SIGNAL_GROUP_ALLOWED_USERS:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_GROUP_ALLOWED_USERS '$SIGNAL_GROUP_ALLOWED_USERS'"
fi
if [ -n "${SIGNAL_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_HOME_CHANNEL '$SIGNAL_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

# Verify writes
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(SIGNAL_ACCOUNT=\\+|SIGNAL_HTTP_URL=http|SIGNAL_ALLOWED_USERS=.|SIGNAL_GROUP_ALLOWED_USERS=.|SIGNAL_HOME_CHANNEL=.)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 3 ] || { echo "FAIL: Signal config did not land (got $COUNT, need ≥3). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put account/URL in `config.yaml` — they're env, not behavior.

---

## Step 9 — enable Signal in Hermes (only after Step 8 verified)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 10 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 11 — verify Signal in Hermes + live smoke test

```bash
# Hermes-side: Signal mentioned in gateway status / logs
CONNECTED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes gateway status 2>&1 | grep -i signal" \
       || ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1 | grep -qiE 'signal.*(connected|ready|attached)'"; then
    CONNECTED=1
    echo "OK: Signal attached to Hermes."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Signal did not attach. Check 'hermes logs gateway -n 50' for HTTP errors against 127.0.0.1:$PORT."; rollback; exit 1; }

# Smoke test
FIRST=$(printf '%s' "$SIGNAL_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Signal number $FIRST:
  1. Send "hello" to the bot's account ($SIGNAL_ACCOUNT) via Signal.
  2. Expect a reply within 5s.
  3. Send "hello" from a NON-allowlisted number — expect NO reply (default-deny holds).

If silent: 'journalctl -u signal-cli-daemon -n 50' and 'hermes logs gateway -n 50' on the VPS.
EOF
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set SIGNAL_ENABLED false 2>/dev/null || \
    sed -i 's|^SIGNAL_ENABLED=true|SIGNAL_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Signal disabled in Hermes. signal-cli daemon left running for retry."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    systemctl disable --now signal-cli-daemon 2>/dev/null || true
    rm -f /etc/systemd/system/signal-cli-daemon.service
    systemctl daemon-reload
    sed -i '/^SIGNAL_ACCOUNT=/d;
            /^SIGNAL_HTTP_URL=/d;
            /^SIGNAL_ALLOWED_USERS=/d;
            /^SIGNAL_GROUP_ALLOWED_USERS=/d;
            /^SIGNAL_HOME_CHANNEL=/d;
            /^SIGNAL_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. systemd unit removed, env wiped. signal-cli account data preserved at ~/.local/share/signal-cli/ — delete manually to unlink."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `SIGNAL_ALLOWED_USERS` | Unknown senders get DM pairing-code flow — easy to walk away from | Step 3 hard-abort; Step 9 only after Step 8 |
| 2 | `SIGNAL_ALLOW_ALL_USERS=true` in env on production | Bypasses allowlist entirely | Step 3 grep-fail if present |
| 3 | Allowlist without leading `+` (WhatsApp-style) | Signal identity format uses `+`; matcher fails | Step 3 validator requires `^\+[0-9]{7,15}$` |
| 4 | Linking inside `docker exec` | Data dir lives in container's ephemeral FS; daemon on host can't find it | Step 5 uses host `ssh`, not `docker exec` |
| 5 | `SIGNAL_ACCOUNT` set to a USER's number instead of the BOT's linked number | Daemon up, no replies — #1 silent failure | Step 3 validates format; Step 8 docs the difference |
| 6 | Java <17 | signal-cli fails with cryptic protobuf errors at `link` time | Step 1 hard-aborts if `java -version` < 17 |
| 7 | Daemon dies, never restarts | Hermes silently stops receiving | Step 6 systemd unit with `Restart=always` |
| 8 | Daemon bound to `0.0.0.0` | Anyone on the host network can hit `/api/v1/...` and impersonate the bot | Step 6 unit binds to `127.0.0.1` only |
| 9 | `gateway restart` instead of `stop`+`run` | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 10) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 8), or the documented sed pattern |
| 11 | Tokens in `config.yaml` | n/a for Signal (no token; phone IDs only), but the universal rule applies to future fields | Only `~/.hermes/.env`, `chmod 600` |
| 12 | Tool-progress bubbles "missing" on Signal | Signal protocol has no message edits, so Hermes suppresses them | Document; do not debug as a bug |
| 13 | Daemon port collision (8080 in use by another app) | `signal-cli daemon` exits immediately | Set `$DAEMON_PORT` to a free port; Step 7 polls and fails clearly |
| 14 | sed with `/` delimiter on env values | URLs contain `/` and break sed | Always `\|` delimiter (universal rule) |
| 15 | Container vs host confusion at link time | See pitfall 4 | Step 1 explicitly checks for host hermes, not container |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes (host, not container), Java ≥17, and signal-cli all present on the VPS
- [ ] Idempotency check ran (skipped if enabled + account + URL + daemon up + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every entry is E.164 with `+`, account is E.164, `SIGNAL_ALLOW_ALL_USERS=true` NOT present
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] User scanned the `signal-cli link` QR; data dir for `$SIGNAL_ACCOUNT` exists under `~/.local/share/signal-cli/data/`
- [ ] systemd unit `signal-cli-daemon.service` installed, enabled, and running
- [ ] `http://127.0.0.1:$DAEMON_PORT/api/v1/check` returned OK within 30s
- [ ] Hermes env written (`SIGNAL_ACCOUNT`, `SIGNAL_HTTP_URL`, `SIGNAL_ALLOWED_USERS`) with `chmod 600`
- [ ] `SIGNAL_ENABLED=true` set ONLY after Step 8 verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Signal attached to Hermes (confirmed in `gateway status` or logs)
- [ ] Live smoke: allowlisted number got a reply; non-allowlisted got nothing
- [ ] Rollback function defined (`rollback`: disable in Hermes, daemon stays; `hard_rollback`: full wipe + systemd removal)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
signal-cli, and Java failure modes.
