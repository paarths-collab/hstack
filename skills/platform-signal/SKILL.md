---
name: platform-signal
description: Connect Hermes to Signal via a linked signal-cli HTTP daemon. Handles the phone-number allowlist as a hard gate and the daemon link step. Use when wiring Signal.
---

# /platform-signal — wire Signal (linked-device via signal-cli)

Signal in Hermes (v0.15.2) talks to a **signal-cli** daemon over HTTP — Hermes does not embed a
Signal client. You link signal-cli as a secondary device on the user's phone (QR scan, human step),
then Hermes connects to the local daemon. Like WhatsApp, this needs the **user's phone** at link
time, so it's an "add it after Telegram" platform.

## Ask the user (the human-only parts)
1. **A phone with Signal installed** — the daemon links as a *secondary device* on their primary
   Signal account; the user scans a QR from **Settings → Linked Devices → Link New Device**.
2. **The allowed sender(s)** — the bare E.164 phone number(s) of the people allowed to message the
   bot (e.g. `+15551234567`). UUIDs also work but phone numbers are easier to verify.
3. **Java 17+ on the host** — `signal-cli` is Java-based. Confirm `java -version` ≥ 17.

## Procedure

**HARD GATE: do not enable Signal or start the daemon for production traffic until the allowlist
is set.** With `SIGNAL_ALLOWED_USERS` unset and `SIGNAL_ALLOW_ALL_USERS` unset, unknown senders
get a DM pairing-code prompt — fine for first-touch, dangerous if you forget and walk away. Set
the allowlist first, then link, then enable.

```bash
HERMES="$HOME/.local/bin/hermes"

# 1. Set the allowlist FIRST — this is the gate. E.164 with leading '+', comma-separate multiples.
"$HERMES" config set SIGNAL_ALLOWED_USERS "+15551234567"
chmod 600 ~/.hermes/.env

# 2. Refuse to continue if the allowlist is empty (read it back; there is no `config get`).
if ! "$HERMES" config show | grep -qE '^SIGNAL_ALLOWED_USERS *[:=] *\+?[0-9]'; then
  echo "ABORT: SIGNAL_ALLOWED_USERS is unset/empty — unknown senders could trigger DM pairing." >&2
  exit 1
fi

# 3. Link signal-cli as a secondary device (human step: user scans QR from Signal app).
#    This must be done on the host where the daemon will run, NOT inside a container.
signal-cli link -n "HermesAgent"
# → outputs a tsdevice:/... URI as a QR. Have the user open Signal →
#   Settings → Linked Devices → Link New Device → scan it.

# 4. Start the signal-cli HTTP daemon (bind localhost only).
#    Replace +15550000000 with the BOT's account (the linked phone's own number).
nohup signal-cli --account "+15550000000" daemon --http 127.0.0.1:8080 \
  > ~/.hermes/signal-cli.log 2>&1 &

# 5. Point Hermes at the daemon and the bot account.
"$HERMES" config set SIGNAL_HTTP_URL  "http://127.0.0.1:8080"
"$HERMES" config set SIGNAL_ACCOUNT   "+15550000000"
chmod 600 ~/.hermes/.env

# 6. Reload gateway — env changes need a clean re-read; stop + run, NOT restart.
"$HERMES" gateway stop
sleep 3
"$HERMES" gateway run
sleep 8
"$HERMES" gateway status
```

## Pitfalls
- **`SIGNAL_ALLOWED_USERS` is a hard gate** — with it unset *and* `SIGNAL_ALLOW_ALL_USERS` unset,
  unknown senders trigger the DM pairing-code flow (approved via `hermes pairing approve signal <CODE>`).
  Never set `SIGNAL_ALLOW_ALL_USERS=true` on a production deploy.
- **E.164 with the leading `+`** — `+15551234567`, not `15551234567`. Unlike WhatsApp, Signal's
  identity format keeps the plus.
- **`SIGNAL_ACCOUNT` is the bot's own number**, not the user's. It's the phone whose Signal
  account got linked in step 3. Mixing these is the #1 "daemon up, no replies" cause.
- **Link on the host, not in a container** — the signal-cli data dir under `~/.local/share/signal-cli`
  is per-user and won't be visible to the gateway if you linked inside `docker exec`. Run
  `whoami; hostname` first (same VPS rule from CLAUDE.md).
- **Java 17+ required** — older JREs fail with cryptic protobuf errors at `signal-cli link` time.
- **Daemon must stay running** — if signal-cli dies, Hermes silently stops receiving. Supervise it
  (systemd unit, `tmux`, or a `cron @reboot` line via `/hermes-cron`) and tail `~/.hermes/signal-cli.log`.
- **No edited messages** — Signal doesn't support editing sent messages, so Hermes suppresses
  tool-progress bubbles on Signal even when `/verbose` is on. Don't debug "missing progress" as a bug.

## Verify
```bash
# Daemon is reachable
curl -fsS http://127.0.0.1:8080/api/v1/check && echo OK
# Gateway picked Signal up
"$HERMES" gateway status | grep -i signal
```
Then have the allowed phone send "hello" to the bot's number and confirm a reply. Send from a
**non**-allowlisted number and confirm no reply (default-deny holds).

## Definition of done
- [ ] `SIGNAL_ALLOWED_USERS` holds at least one E.164 number (with `+`), set via `hermes config set`, and `~/.hermes/.env` is `chmod 600`.
- [ ] `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT` are set via `hermes config set` (never in `config.yaml` or chat); `SIGNAL_ACCOUNT` is the bot's own E.164 number.
- [ ] `signal-cli` was linked on the **host** (not inside a container), and the daemon is running and reachable at `SIGNAL_HTTP_URL` (`/api/v1/check` returns OK).
- [ ] `SIGNAL_ALLOW_ALL_USERS` is **not** set to true.
- [ ] Gateway was reloaded with `gateway stop` + `gateway run` (not `restart`) and `hermes gateway status` reports it running with Signal attached.
- [ ] An allowed phone messages the bot's number and gets a reply; a non-allowed number gets no reply.

See `reference/TROUBLESHOOTING.md` for gateway and platform failure modes.
