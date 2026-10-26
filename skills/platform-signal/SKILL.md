---
name: platform-signal
description: "Wire a remote Hermes Agent 0.22.5 to Signal through a signal-cli HTTP daemon over SSH. Hard allowlist gate, a read-only daemon health check before any write, snapshot and rollback, native gateway reload, log-verified connect. Linking the Signal account (QR) and installing the daemon stay human steps."
---

# /platform-signal — wire Signal to a remote Hermes (SSH-first, allowlist-gated, source-verified for 0.22.5)

You are the engineer connecting Signal to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. Hermes does not embed a Signal client: the Signal plugin talks HTTP to a
**signal-cli daemon** (`signal-cli ... daemon --http`), which receives messages over Server-Sent Events
(`GET /api/v1/events`) and sends over JSON-RPC (`POST /api/v1/rpc`). The user does the parts a machine
cannot (see "Human-only steps"):

1. Install signal-cli on the VPS host and keep its daemon running.
2. Link the daemon to a Signal account by scanning a device-link QR with a phone (or register a number).
3. Tell you which number the daemon serves and who may talk to the agent.

Everything else — format gates, the daemon health check, the allowlist write, the gateway reload, log
verification — runs on the VPS over SSH, with a snapshot/rollback path.

**Where commands run.** Every `bash` block below runs on YOUR machine (possibly macOS with bash 3.2) and
reaches the VPS through `remote()` (Step 0), which puts `~/.local/bin` (where `hermes` lives) on the remote
PATH. Run all blocks in ONE shell session: later steps call the Step 0 functions. Phone numbers are
personal data, so they are treated like secrets: they travel to the VPS over ssh **stdin**, never in an
ssh argument, and they are not echoed back by this skill (counts and masked forms only).

**What the source says about access (Hermes v0.22.5, details in "Verified against").**

- Signal is enabled when BOTH `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT` are set. There is **no `SIGNAL_ENABLED`
  variable** (the older recipe wrote one; it does nothing). Only an explicit `platforms.signal.enabled: false` in
  `config.yaml` overrides the env, so Step 6 sets that key to `true`.
- The sender is checked against `SIGNAL_ALLOWED_USERS` (phone numbers in E.164 form with a leading `+`, or Signal
  UUIDs). With no allowlist, no allow-all switch and no pairing approval, the gateway default-denies, and unknown
  senders who DM the bot are offered a pairing code. With an allowlist set, unknown senders are silently ignored
  (Signal opts in to `allowlist_suppresses_pairing`).
- Open access is one line away: `SIGNAL_ALLOWED_USERS=*`, `SIGNAL_ALLOW_ALL_USERS=true|1|yes`, or
  `GATEWAY_ALLOW_ALL_USERS=true|1|yes`. This skill refuses to run while any of them is present and never writes them.
- `SIGNAL_GROUP_ALLOWED_USERS` is a list of **group IDs** (or `*` for every group), not phone numbers. Groups are
  ignored unless it is set, and a group member must still be in `SIGNAL_ALLOWED_USERS`. This skill accepts group IDs and
  refuses `*`.
- Signal cannot edit messages (`SUPPORTS_MESSAGE_EDITING = False`, `plugins/platforms/signal/adapter.py:185`), so edit-based streaming and progress updates do not apply there. Do not debug "missing progress" as a bug.

---

## Human-only steps (a machine cannot do these)

Do these on the VPS HOST (not inside a container) before running the steps below. They are signal-cli's own procedure;
Hermes only prints the two commands marked "from Hermes' setup wizard". They are shown as plain text on purpose: this skill
never executes them.

```text
# 1. Install signal-cli on the VPS host (it needs a Java runtime; follow the signal-cli project's README for the exact
#    version and download). Hermes does not check Java or signal-cli itself.

# 2. Link it as a secondary device of the Signal account that will be the agent's number (from Hermes' setup wizard):
signal-cli link -n "HermesAgent"
#    It prints a device-link URI. Turn it into a QR code with any QR tool and scan it in Signal:
#    Settings > Linked devices > Link new device. (Registering a dedicated number with signal-cli's own
#    register/verify commands also works; that is signal-cli behaviour, not covered by Hermes source.)

# 3. Start the HTTP daemon bound to loopback only (from Hermes' setup wizard), and keep it running:
signal-cli --account +YOURNUMBER daemon --http 127.0.0.1:8080
```

If the daemon dies, Hermes stops receiving until it is back (the adapter reconnects with backoff but cannot start the
daemon). Run it under a supervisor. This unit file is an EXAMPLE for the operator; it is not applied by this skill, and
the paths and user are assumptions to adapt:

```ini
[Unit]
Description=signal-cli HTTP daemon for Hermes
After=network.target

[Service]
ExecStart=/usr/local/bin/signal-cli --account +YOURNUMBER daemon --http 127.0.0.1:8080
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Two ways to run it, and what each means for the allowlist:

- **A dedicated number** (registered or linked on a spare phone): people message that number; put THEIR numbers in
  `SIGNAL_ALLOWED_USERS`.
- **Your own number** (linked as a secondary device): you talk to the agent through "Note to Self". The adapter accepts
  those sync messages (messages from the account to itself) but drops other messages from the account's own number, so put
  your own number in `SIGNAL_ALLOWED_USERS`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SIGNAL_ACCOUNT` | The number the daemon is registered/linked as, E.164 with a leading `+` | The Signal app of the linked account, or the number registered with signal-cli |
| `$SIGNAL_ALLOWED_USERS` | Comma-separated E.164 numbers (leading `+`) or Signal UUIDs allowed to talk to the agent | The people who should be able to DM it (yourself too, if you use Note to Self) |
| `$SIGNAL_GROUP_ALLOWED_USERS` *(optional)* | Comma-separated Signal **group IDs** to answer in (never `*`) | signal-cli's group listing; leave empty to ignore groups |
| `$SIGNAL_HOME_CHANNEL` *(optional)* | Where cron/notifications go: one `+E164` number or `group:<id>` | Usually the operator's own number |
| `$DAEMON_PORT` *(optional)* | Loopback port of the signal-cli daemon (default `8080`) | The `--http 127.0.0.1:PORT` you started it with |
| `$SMOKE_SEND` *(optional)* | `1` to send one test message to the first E.164 allowlist entry in Step 9 | Default: no message is sent |

If `$SIGNAL_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed. A UUID-only allowlist is allowed but
cannot receive the optional smoke message.

Confirm SSH access (first connect: trust the host key once):

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was written."; exit 1; }
```

---

## Step 0 — helpers (define before anything can fail)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=platform-signal
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
# gw_ready [SECONDS]: native readiness. Succeeds only when `gateway ensure --json` exits 0 and reports "state":"ready"
# (the transient pending/draining codes 5 and 6 are retried twice). It never greps `gateway status` text, because the stopped
# gateway prints "✗ Gateway is not running", which contains "running".
gw_ready() {
  remote "T=${1:-60} bash -s" <<'REMOTE'
n=0
while :; do
  out=$(hermes -p default gateway ensure --json --timeout "$T") && rc=0 || rc=$?
  [ "$rc" = 0 ] && break
  n=$((n + 1))
  { [ "$rc" = 5 ] || [ "$rc" = 6 ]; } && [ "$n" -lt 3 ] || { printf '%s\n' "$out" >&2; exit 1; }
  sleep 3
done
case $out in *'"state":"ready"'*) printf '%s\n' "$out" ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
REMOTE
}
# gw_reload: restart the default-profile gateway natively and require a ready gateway with a NEW instance_id.
# `--detach` keeps `restart` from running the gateway inside the ssh shell when no service is installed. With live
# sessions and no terminal, restart refuses; GW_INTERRUPT=1 adds -y and interrupts them deliberately (never set by default).
# Side effect: the pre-restart `ensure` read that captures the old instance_id STARTS a gateway when none is running (ensure never
# installs a service, but it does start one). A reload implies the gateway should run, so that is accepted; read-only skills never call gw_reload.
gw_reload() {
  local old new out interrupt
  interrupt=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then interrupt=1; fi
  # Keep an endpoint identity even when ensure exits 6 (draining/restart_wait).
  out=$(remote 'hermes -p default gateway ensure --json --timeout 10 2>/dev/null') || :
  old=$(printf '%s\n' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  remote "hermes -p default gateway restart --detach${interrupt:+ -y}" \
    || { echo "gw_reload: gateway restart failed or was refused (live sessions? re-run with GW_INTERRUPT=1 only if interrupting them is acceptable)." >&2; return 1; }
  out=$(gw_ready) || return 1
  new=$(printf '%s' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  if [ -n "$old" ] && [ "$new" = "$old" ]; then echo "gw_reload: the gateway instance did not change, so it was not restarted." >&2; return 1; fi
  printf '%s\n' "$out"
}

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/$SKILL_NAME"
# The active recovery point is published only after every artifact has been verified.
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
lock="$d.creating"
mkdir "$lock" 2>/dev/null || { echo "snapshot: another $SKILL_NAME snapshot is being created; retry after it finishes." >&2; exit 1; }
t=""
trap '[ -z "$t" ] || rm -rf "$t"; rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo "snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
t=$(mktemp -d "$p/.snapshot-$SKILL_NAME.XXXXXX")
for f in .env config.yaml; do
  if [ -f "$HOME/.hermes/$f" ]; then
    cp -p "$HOME/.hermes/$f" "$t/$f"
    cmp -s "$HOME/.hermes/$f" "$t/$f"
    chmod 600 "$t/$f"
  elif [ -e "$HOME/.hermes/$f" ] || [ -L "$HOME/.hermes/$f" ]; then
    echo "snapshot: $f is not a readable regular file; nothing was written." >&2; exit 1
  else
    : > "$t/$f.absent"
    chmod 600 "$t/$f.absent"
  fi
done

for f in .env config.yaml; do
  for entry in "$f" "$f.absent"; do
    if [ -f "$t/$entry" ]; then cksum < "$t/$entry" > "$t/$entry.cksum"; chmod 600 "$t/$entry.cksum"; fi
  done
done
printf 'hstack-snapshot-v1\n' > "$t/.complete"
chmod 600 "$t/.complete"
mv "$t" "$d"
[ -f "$d/.complete" ] && [ ! -d "$t" ] || { echo "snapshot: recovery-point publication failed; nothing was written." >&2; exit 1; }
t=""
REMOTE
}
# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), reload the gateway with gw_reload, then retire the snapshot.
rollback() {
  local rc=0
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE' || rc=$?
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 10; }
# Incomplete legacy snapshots cannot prove that their final copy succeeded. Keep them for manual recovery.
[ -f "$d/.complete" ] && [ "$(cat "$d/.complete")" = hstack-snapshot-v1 ] \
  || { echo "rollback: snapshot is incomplete or legacy; active snapshot retained for manual recovery." >&2; exit 1; }
for f in .env config.yaml; do
  count=0
  for entry in "$f" "$f.absent"; do
    if [ -f "$d/$entry" ]; then
      count=$((count + 1))
      [ -f "$d/$entry.cksum" ] || { echo "rollback: missing checksum for $f; active snapshot retained for recovery." >&2; exit 1; }
      checksum=$(cksum < "$d/$entry")
      expected_checksum=$(cat "$d/$entry.cksum")
      [ "$checksum" = "$expected_checksum" ] \
        || { echo "rollback: corrupt backup for $f; active snapshot retained for recovery." >&2; exit 1; }
    fi
  done
  [ "$count" = 1 ] || { echo "rollback: missing or ambiguous backup for $f; active snapshot retained for recovery." >&2; exit 1; }
done
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then
    cp -p "$d/$f" "$HOME/.hermes/$f"
    cmp -s "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then
    rm -f "$HOME/.hermes/$f"
    [ ! -e "$HOME/.hermes/$f" ] && [ ! -L "$HOME/.hermes/$f" ] || { echo "rollback: file removal failed; active snapshot retained." >&2; exit 1; }
  else
    echo "rollback: missing backup for $f; active snapshot retained for recovery." >&2
    exit 1
  fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
exit 0
REMOTE
  [ "$rc" = 10 ] && return 0
  [ "$rc" = 0 ] || return "$rc"
  gw_reload >/dev/null \
    || { echo "rollback: files restored, but the gateway did NOT come back ready — active snapshot retained; inspect the gateway and retry rollback after resolving the fault" >&2; return 1; }
  finish || return 1
  echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
trap 'echo "finish: could not retire the active snapshot; inspect the recovery point before continuing." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || exit 0
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
REMOTE
}
```

Rules for calling them (every skill follows these):

- A failure BEFORE `snapshot` (SSH check, Hermes check, idempotency, credential format,
  live preflight, user declining the dry run) is `exit 1` with
  `ABORT: ... Nothing was written.` — it does NOT call `rollback`.
- `snapshot` runs immediately before the first write. If it fails, abort. It REFUSES when a
  snapshot dir already exists (a crashed run): run `rollback` first, then re-run.
- Every failure AFTER `snapshot` is `rollback; exit 1`.
- The last step calls `finish` after the smoke test passes.
- `rollback` RESTORES the pre-skill state; it never just deletes keys. Never define a
  second `rollback()` later in the file and never use `bash <(declare -f rollback)` (that
  defines the function in a child shell and runs nothing).

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.
**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`,
which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id` than before. Why this shape
(source-verified, not live-verified):

- `gateway restart` restarts the installed systemd/launchd service, or, with no service, stops the profile's gateway and runs the
  replacement **in the calling shell**; `--detach` starts it in the background the way `ensure` does, so an ssh call cannot hang
  (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`, `hermes_cli/gateway_runtime_start.py:86-97`).
- With live sessions it asks y/N on a TTY and **refuses with exit 1 without one**; `-y`/`--yes` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:97-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y`
  on its own: set `GW_INTERRUPT=1` only when interrupting live chats is acceptable. Do not use `--force` or `--all` to evade a refusal.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the
  gateway is ready (5 deadline/starting, 6 draining, 3 incompatible, 4 authorization, 7 conflict)
  (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`). `instance_id` is a fresh uuid per gateway process
  (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is never used as a health check.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml and MCP changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  `gateway run` is the foreground command and takes no daemon flag.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS host

This skill writes the HOST's `~/.hermes/.env`, so `hermes` must be installed on the host (not only inside a container).

```bash
HERMES_BANNER=$(remote '
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (`HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked against the v0.22.5 source; it has not been run against a live host.

---

## Step 2 — idempotency check (skip if already wired)

Skip setup only when the stored URL, account and allowlist are each defined once, the allowlist is well formed, the file is
private, and no open-access switch or wildcard is on. An unsafe existing setup aborts here; it is never reported as wired. The
check prints a status only, never stored values. `FORCE=1` skips this step and rewires (the previous values are restored if the
re-run fails).

```bash
if [ "${FORCE:-0}" != "1" ]; then
  STATE=$(remote 'bash -s' <<'REMOTE'
f=$HOME/.hermes/.env
if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo needs_setup; exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || { echo unsafe; exit 0; }
mode=$(stat -c %a "$f" 2>/dev/null) || mode=$(stat -f %Lp "$f" 2>/dev/null) || exit 1
state=$(awk '
  function value(s) {
    sub(/^[^=]*=/, "", s)
    sub(/\r$/, "", s)
    if (length(s) >= 2) {
      q = substr(s, 1, 1)
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s)-2)
    }
    return s
  }
  function wild(v) { gsub(/[[:space:]]/, "", v); return v ~ /(^|,)\*(,|$)/ }
  function digits(s) { return s ~ /^[0-9]+$/ }
  function entry_ok(e,   r) {
    if (substr(e, 1, 1) == "+") { r = substr(e, 2); return digits(r) && length(r) >= 7 && length(r) <= 15 }
    return length(e) == 36 && e ~ /^[0-9A-Fa-f-]+$/ && substr(e, 9, 1) == "-" && substr(e, 14, 1) == "-" && substr(e, 19, 1) == "-" && substr(e, 24, 1) == "-"
  }
  function list_ok(l,   n, a, i) {
    if (l == "") return 0
    n = split(l, a, ",")
    for (i = 1; i <= n; i++) if (!entry_ok(a[i])) return 0
    return 1
  }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^SIGNAL_HTTP_URL=/) urls++
    if (line ~ /^SIGNAL_ACCOUNT=/) accts++
    if (line ~ /^SIGNAL_ALLOWED_USERS=/) { lists++; users = value(line); if (wild(users)) open_access = 1 }
    if (line ~ /^(SIGNAL_GROUP_ALLOWED_USERS|GATEWAY_ALLOWED_USERS)=/) { if (wild(value(line))) open_access = 1 }
    if (line ~ /^(SIGNAL_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) {
      v = tolower(value(line)); gsub(/[[:space:]]/, "", v)
      if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") open_access = 1
    }
  }
  END {
    if (urls == 0 || accts == 0 || lists == 0) print "needs_setup"
    else if (open_access || urls > 1 || accts > 1 || lists > 1) print "unsafe"
    else if (!list_ok(users)) print "unsafe"
    else print "safe"
  }' "$f") || exit 1
if [ "$state" = safe ] && [ "$mode" != 600 ]; then state=unsafe; fi
echo "$state"
REMOTE
) || { echo "ABORT: could not check the stored Signal setup. Nothing was written."; exit 1; }
  case "$STATE" in
    safe) echo "Signal already wired (URL, account and allowlist stored, private, no open access). Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Signal setup is unsafe (check the file mode, duplicate keys, the allowlist format, wildcards and allow-all switches). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE (allowlist + formats, open-access switches, daemon health), all BEFORE any write

Nothing has been written yet, so every failure here is a plain `exit 1` with `Nothing was written.`

**3a. Format check (local, no network, no ssh).** The allowlist must be non-empty, free of `*`, and every entry must be an E.164
number with a leading `+` (the WhatsApp-style bare number does not match Signal's identity format) or a UUID. Offending entries are
reported by position only, never echoed.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
SIGNAL_ACCOUNT=$(printf '%s' "${SIGNAL_ACCOUNT:-}" | tr -d ' \t\r\n')
SIGNAL_ALLOWED_USERS=$(printf '%s' "${SIGNAL_ALLOWED_USERS:-}" | csv_clean)
SIGNAL_GROUP_ALLOWED_USERS=$(printf '%s' "${SIGNAL_GROUP_ALLOWED_USERS:-}" | csv_clean)
SIGNAL_HOME_CHANNEL=$(printf '%s' "${SIGNAL_HOME_CHANNEL:-}" | tr -d ' \t\r\n')
DAEMON_PORT=${DAEMON_PORT:-8080}

if [ -z "$SIGNAL_ALLOWED_USERS" ]; then
  echo "ABORT: SIGNAL_ALLOWED_USERS is empty. With no allowlist nobody can use the bot, and strangers who DM it are offered pairing codes."
  echo "Supply E.164 numbers with a leading '+', comma-separated. Nothing was written."
  exit 1
fi
case "$SIGNAL_ALLOWED_USERS" in
  *'*'*) echo "ABORT: SIGNAL_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac
case "$SIGNAL_GROUP_ALLOWED_USERS" in
  *'*'*) echo "ABORT: SIGNAL_GROUP_ALLOWED_USERS contains a wildcard (*), which would open every group the account is in. Nothing was written."; exit 1 ;;
esac

# check_list NAME VALUE REGEX: every comma-separated entry must match REGEX. Entries are personal data, so only their position is shown.
check_list() {
  local bad
  bad=$(printf '%s\n' "$2" | tr ',' '\n' | grep -vnE "$3" | cut -d: -f1 | tr '\n' ' ')
  if [ -n "$bad" ]; then
    echo "ABORT: invalid entries in $1 (entry number(s): $bad). $4 Nothing was written."
    return 1
  fi
}
check_list SIGNAL_ALLOWED_USERS "$SIGNAL_ALLOWED_USERS" '^(\+[0-9]{7,15}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$' \
  "Expected E.164 numbers WITH a leading + (e.g. +15551234567) or Signal UUIDs; no handles, no bare numbers." || exit 1
if [ -n "$SIGNAL_GROUP_ALLOWED_USERS" ]; then
  check_list SIGNAL_GROUP_ALLOWED_USERS "$SIGNAL_GROUP_ALLOWED_USERS" '^[A-Za-z0-9+/=_-]{8,120}$' \
    "Expected Signal group IDs (base64-style), not phone numbers." || exit 1
  # A phone number also fits the group-ID character set, so refuse the E.164 shape explicitly.
  if printf '%s\n' "$SIGNAL_GROUP_ALLOWED_USERS" | tr ',' '\n' | grep -qE '^\+[0-9]{7,15}$'; then
    echo "ABORT: invalid entries in SIGNAL_GROUP_ALLOWED_USERS (a phone number is not a group ID; list people in SIGNAL_ALLOWED_USERS). Nothing was written."
    exit 1
  fi
fi
printf '%s' "$SIGNAL_ACCOUNT" | grep -qE '^\+[0-9]{7,15}$' \
  || { echo "ABORT: SIGNAL_ACCOUNT must be E.164 with a leading + (the number signal-cli is registered or linked as). Nothing was written."; exit 1; }
if [ -n "$SIGNAL_HOME_CHANNEL" ]; then
  printf '%s' "$SIGNAL_HOME_CHANNEL" | grep -qE '^(\+[0-9]{7,15}|group:[A-Za-z0-9+/=_-]{8,120})$' \
    || { echo "ABORT: invalid SIGNAL_HOME_CHANNEL (one +E.164 number or group:<id>). Nothing was written."; exit 1; }
fi
case "$DAEMON_PORT" in
  ''|*[!0-9]*) echo "ABORT: DAEMON_PORT must be a port number (1-65535). Nothing was written."; exit 1 ;;
esac
DAEMON_PORT=$((10#$DAEMON_PORT))
{ [ "$DAEMON_PORT" -ge 1 ] && [ "$DAEMON_PORT" -le 65535 ]; } \
  || { echo "ABORT: DAEMON_PORT must be a port number (1-65535). Nothing was written."; exit 1; }
SIGNAL_URL="http://127.0.0.1:$DAEMON_PORT"
USERS_N=$(printf '%s' "$SIGNAL_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
echo "Format OK: $USERS_N allowed sender(s); daemon expected at $SIGNAL_URL."
```

**3b. Open-access switches already on the VPS.** An allow-all switch or a wildcard in `~/.hermes/.env` makes the allowlist
meaningless. The check prints variable NAMES only, fails closed (any value other than an explicit false/0/no/off counts as on), and
aborts if the file cannot be read.

```bash
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || exit 1
awk '
  function wild(v) { gsub(/[[:space:]]/, "", v); return v ~ /(^|,)\*(,|$)/ }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^(SIGNAL_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|SIGNAL_ALLOWED_USERS|SIGNAL_GROUP_ALLOWED_USERS|GATEWAY_ALLOWED_USERS)=/) next
    n = line; sub(/=.*/, "", n)
    v = line; sub(/^[^=]*=/, "", v)
    gsub(/[\"\047[:space:]]/, "", v)
    if (n ~ /ALLOW_ALL_USERS$/) { v = tolower(v); if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") on[n] = 1 }
    else if (wild(v)) on[n] = 1
  }
  END { for (n in on) print n }' "$f"
REMOTE
}
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env on the VPS to check for open-access switches. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)), so senders outside the allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi
```

**3c. Live preflight against the daemon, run from the VPS.** `GET /api/v1/check` is the health endpoint the adapter itself
calls before it connects (a non-200 makes the adapter refuse to start). It is read-only and needs no credential. A failure means
the daemon is not installed, linked or running, which is a human step.

```bash
CODE=$(remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 10 '$SIGNAL_URL/api/v1/check'" 2>/dev/null) || CODE=""
[ "$CODE" = "200" ] || {
  echo "ABORT: the signal-cli daemon at $SIGNAL_URL did not answer GET /api/v1/check with 200 from the VPS (HTTP ${CODE:-none})."
  echo "Install, link and start it first (see 'Human-only steps'), or set DAEMON_PORT to its port. Nothing was written."
  exit 1
}
echo "signal-cli daemon OK at $SIGNAL_URL (GET /api/v1/check -> 200)."
```

This check proves the daemon is up on that port, not that it serves `$SIGNAL_ACCOUNT`: Hermes reads no account information
from the daemon, so a wrong `SIGNAL_ACCOUNT` is only visible later as silence. See Pitfall 5.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
mask_phone() { printf '%s' "$1" | sed -E 's/^(\+[0-9]{3})[0-9]*([0-9]{2})$/\1******\2/'; }
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) formats, no open-access switch in ~/.hermes/.env, signal-cli daemon healthy at $SIGNAL_URL
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write SIGNAL_ALLOWED_USERS ($USERS_N sender(s)) via 'hermes -p default config set' (value sent over ssh stdin)
  3. Write SIGNAL_GROUP_ALLOWED_USERS / SIGNAL_HOME_CHANNEL only if supplied
  4. Write SIGNAL_ACCOUNT ($(mask_phone "$SIGNAL_ACCOUNT")) and, LAST, SIGNAL_HTTP_URL=$SIGNAL_URL (URL + account together enable Signal)
  5. chmod 600 ~/.hermes/.env; verify the keys landed and re-check for open access (counts and names only)
  6. Set platforms.signal.enabled true in config.yaml (only an explicit false there could override the env)
  7. Reload gateway: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a NEW instance
  8. Verify from 'hermes -p default logs gateway': Signal connected
  9. Optional (SMOKE_SEND=1): one test message to the first E.164 allowlist entry via 'hermes -p default send --to'
 10. Live test (human): an allowlisted number DMs the account; expect a reply

The signal-cli daemon, its systemd unit and its Signal data are NOT touched by this skill or by rollback.
Phone numbers are never printed beyond counts and the masked account.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the allowlist first and the enabling pair last

Signal turns on when `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT` are both present, so the allowlist is written BEFORE them and the URL is
written LAST. Each value is ONE line on ssh stdin, read by `read -r` on the VPS; the `--` keeps a value starting with `-`
(group IDs may) from being parsed as an option. The output of `hermes -p default config set` is discarded so Hermes can never echo a
value into chat. `config set` routes UPPER_SNAKE names to `~/.hermes/.env` (`hermes_cli/config.py:3429-3438`).

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 -- \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put SIGNAL_ALLOWED_USERS "$SIGNAL_ALLOWED_USERS" \
  || { echo "FAIL: could not write SIGNAL_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$SIGNAL_GROUP_ALLOWED_USERS" ]; then
  put SIGNAL_GROUP_ALLOWED_USERS "$SIGNAL_GROUP_ALLOWED_USERS" \
    || { echo "FAIL: could not write SIGNAL_GROUP_ALLOWED_USERS."; rollback; exit 1; }
fi
if [ -n "$SIGNAL_HOME_CHANNEL" ]; then
  put SIGNAL_HOME_CHANNEL "$SIGNAL_HOME_CHANNEL" \
    || { echo "FAIL: could not write SIGNAL_HOME_CHANNEL."; rollback; exit 1; }
fi
put SIGNAL_ACCOUNT "$SIGNAL_ACCOUNT" \
  || { echo "FAIL: could not write SIGNAL_ACCOUNT."; rollback; exit 1; }
put SIGNAL_HTTP_URL "$SIGNAL_URL" \
  || { echo "FAIL: could not write SIGNAL_HTTP_URL."; rollback; exit 1; }
```

Verify what landed (counts and a comparison; the numbers are never printed), and re-check that no wildcard or allow-all switch appeared:

```bash
COUNT=$(remote 'grep -cE "^(SIGNAL_HTTP_URL|SIGNAL_ACCOUNT|SIGNAL_ALLOWED_USERS)=." ~/.hermes/.env 2>/dev/null; true')
GOT_USERS=$(remote 'sed -n "s/^SIGNAL_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
GOT_ACCT=$(remote 'sed -n "s/^SIGNAL_ACCOUNT=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
GOT_URL=$(remote 'sed -n "s/^SIGNAL_HTTP_URL=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
if [ "$COUNT" != "3" ] || [ "$GOT_USERS" != "$SIGNAL_ALLOWED_USERS" ] || [ "$GOT_ACCT" != "$SIGNAL_ACCOUNT" ] || [ "$GOT_URL" != "$SIGNAL_URL" ]; then
  echo "FAIL: the Signal settings did not land as written (key count $COUNT, need 3; the stored values must equal the supplied ones). Rolling back."
  rollback; exit 1
fi
case "$GOT_USERS" in
  *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;;
esac
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Signal settings confirmed in ~/.hermes/.env."
```

Never put numbers or the URL in `config.yaml`; they are environment settings. Never `echo >> .env`.

---

## Step 6 — make sure `config.yaml` does not disable Signal

Env credentials never override an explicit `platforms.signal.enabled: false` (the gateway logs a one-time warning and leaves the
adapter off). Setting the flag to `true` removes that trap. It is the only `config.yaml` edit and it is covered by the snapshot. A
failure is a WARN, not a rollback: the env alone enables Signal, and Step 8 shows whether it connected.

```bash
remote "hermes -p default config set platforms.signal.enabled true && chmod 600 ~/.hermes/.env" \
  || echo "WARN: could not set platforms.signal.enabled. Signal is enabled by SIGNAL_HTTP_URL + SIGNAL_ACCOUNT unless config.yaml says platforms.signal.enabled: false; Step 8 will show whether it connected."
```

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. The gateway re-reads `~/.hermes/.env` at start, so a restart picks up the new Signal settings. A refusal because of live
sessions is reported, not overridden; see the lifecycle note in Step 0.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify from the gateway log (poll up to 30s)

`hermes logs gateway` reads `gateway.log`. When Signal starts the adapter logs `Signal: connected to <url>` and the gateway logs
`✓ signal connected`; failures read `Signal: cannot reach signal-cli at ...`, `Signal: health check failed (status N)`,
`✗ signal failed to connect` or `✗ signal error: ...`. The check uses the LATEST status-bearing Signal line, so an old success cannot
mask a later failure, and a connect after an earlier failure counts. This proves the adapter reached the daemon, not that a message
round trip works; that is Step 9.

```bash
CONNECTED=0
PLATFORM_LOG=""
for i in 1 2 3 4 5 6; do
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 300 --since 10m 2>&1") || LOG_STATUS=$?
  if [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | awk '
    {
      line = tolower($0)
      if (line !~ /(^|[^[:alnum:]_])signal([^[:alnum:]_]|$)/) next
      if (line ~ /cannot reach signal-cli|health check failed|signal: disconnected|are required|signal failed to connect|signal error:|signal sse: (http )?error|\(degraded\)/) connected = 0
      else if (line ~ /signal: connected to|signal sse: connected|signal connected/) connected = 1
    }
    END { exit !connected }'; then
    CONNECTED=1
    echo "OK: Signal connected (gateway log)."
    break
  fi
  sleep 5
done
if [ "$CONNECTED" != "1" ]; then
  # Show the Signal lines with phone numbers masked, so a failure can be diagnosed without leaking them.
  printf '%s\n' "$PLATFORM_LOG" | grep -i signal | sed -E 's/\+[0-9]{7,15}/+<redacted>/g' | tail -n 5
  echo "FAIL: Signal did not appear in gateway logs as connected within 30s. Rolling back."
  rollback; exit 1
fi

finish || exit 1
```

---

## Step 9 — smoke test

**Optional machine smoke (`SMOKE_SEND=1`).** `hermes send` is the native out-of-process sender: it needs no running gateway for
Signal (it posts a JSON-RPC `send` to the daemon with the stored URL and account) and exits 0 on success, 1 on a delivery error. It
sends ONE fixed message to the first E.164 allowlist entry, with the number travelling over ssh stdin. A delivery failure is a WARN:
Step 8 already verified the connection and `finish` already ran.

```bash
FIRST_E164=$(printf '%s' "$SIGNAL_ALLOWED_USERS" | tr ',' '\n' | grep -E '^\+' | head -n 1)
if [ "${SMOKE_SEND:-0}" = "1" ]; then
  if [ -z "$FIRST_E164" ]; then
    echo "Smoke send skipped: the allowlist has no E.164 entry to send to (UUID-only)."
  else
    printf '%s\n' "$FIRST_E164" \
      | remote 'IFS= read -r t && hermes -p default send --to "signal:$t" "hstack platform-signal: Signal is connected (test message, no reply needed)"' >/dev/null 2>&1 \
      && echo "Smoke message sent to the first E.164 allowlist entry." \
      || echo "WARN: the smoke message was not delivered. The connection was verified in Step 8; check 'hermes -p default logs gateway' for send errors."
  fi
fi
```

**Human smoke (required for a real round trip).**

```bash
cat <<EOF
SMOKE TEST — from an allowlisted Signal number:
  1. Send "hello" to the agent's Signal account ($(mask_phone "$SIGNAL_ACCOUNT")).
  2. Expect a reply within a few seconds.
  3. From a number NOT on the allowlist, send "hello": expect NO reply (unknown senders are ignored while an allowlist is set).

If silent: 'hermes -p default logs gateway -n 100' on the VPS, and the signal-cli daemon's own log.
Group chats are ignored unless SIGNAL_GROUP_ALLOWED_USERS lists the group's ID.
EOF
```

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in **Step 0**. It restores and verifies the pre-run `~/.hermes/.env` and `config.yaml` from the active
snapshot, reloads the gateway with `gw_reload`, and only then retires the snapshot to `.prev`. A failed restore exits non-zero with
`restoration failed; active snapshot retained for recovery`; a restore whose reload does not come back ready reports
`files restored, but the gateway did NOT come back` and keeps the snapshot. Neither claims recovery succeeded: fix the fault and run
`rollback` again (a restart refused because of live sessions is the same case; retry with `GW_INTERRUPT=1` only if interrupting them is
acceptable). A failed `FORCE=1` re-run puts the previous URL, account and allowlist back; a failed first run removes the files it created.
Failures in Steps 1-4 happen before the snapshot and change nothing.

Rollback never touches the signal-cli daemon, its unit file or its Signal account data (`~/.local/share/signal-cli/`). To unlink the
device, remove it in Signal (Settings > Linked devices) and delete that directory yourself.

After a successful run the snapshot is kept as `platform-signal.prev` for a manual undo; both directories are `chmod 700` and hold the
previous values, so delete the `.prev` when you no longer need the undo. To undo a run that already finished (with the Step 0 functions
loaded):

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

To remove Signal entirely instead (destructive, only if the user asks): delete the `SIGNAL_*` lines from `~/.hermes/.env`, run
`hermes -p default config set platforms.signal.enabled false`, then reload with `gw_reload`.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `SIGNAL_ALLOWED_USERS` | No allowlist means nobody is authorized, and strangers who DM the account are offered pairing codes | Step 3a hard-aborts; the allowlist is written before the URL |
| 2 | `SIGNAL_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS` or a `*` in `SIGNAL_ALLOWED_USERS` / `GATEWAY_ALLOWED_USERS` | Anyone can use the bot regardless of the allowlist | Step 3a/3b abort before any write; Step 5 re-checks after it (names only); never set them with this skill |
| 3 | Bare numbers without `+` (WhatsApp style) | The sender id is compared as received (`+15551234567` or a UUID), so a bare number never matches | Step 3a requires `+` and 7-15 digits, or a UUID |
| 4 | Writing `SIGNAL_ENABLED` | Not an upstream variable; the pair `SIGNAL_HTTP_URL` + `SIGNAL_ACCOUNT` enables the platform | Never written; only `platforms.signal.enabled: false` in `config.yaml` can disable it (Step 6) |
| 5 | `SIGNAL_ACCOUNT` is not the number the daemon serves | Hermes reads no account data from the daemon; the daemon is "healthy" and nothing ever arrives | Use the number you linked/registered; if the logs show the SSE stream connected but messages never arrive, compare against `signal-cli`'s own account list |
| 6 | `SIGNAL_GROUP_ALLOWED_USERS` filled with phone numbers | It holds group IDs; numbers never match a group | Step 3a validates group-ID shape; groups stay off while it is empty; `*` is refused |
| 7 | Daemon not supervised | If signal-cli dies Hermes cannot receive; it keeps retrying with backoff but does not start the daemon | Run the daemon under systemd or similar (example in "Human-only steps") |
| 8 | Daemon bound to something other than loopback | Anyone who can reach the port can read the event stream and send as the account | Bind `--http 127.0.0.1:PORT`; this skill only ever writes a loopback URL |
| 9 | Linking or running signal-cli in a container whose data is thrown away | The link is lost on the next container start | Keep signal-cli's data directory on a persistent volume; publish a container's port on 127.0.0.1 only. Only the HTTP URL matters to Hermes |
| 10 | Port collision on 8080 | The daemon exits at startup and Step 3c fails | Start the daemon on a free port and pass `DAEMON_PORT` |
| 11 | A bbernhard REST-bridge URL as `SIGNAL_HTTP_URL` | The adapter speaks signal-cli's own `daemon --http` API (`/api/v1/check`, `/api/v1/events`, `/api/v1/rpc`); whether the REST bridge serves those paths is unverified | Use `signal-cli daemon --http` |
| 12 | Pairing approvals and `GATEWAY_ALLOWED_USERS` also authorize | A pairing approval and the cross-platform `GATEWAY_ALLOWED_USERS` list are unioned with `SIGNAL_ALLOWED_USERS` | `hermes -p default pairing list` shows approvals; `hermes -p default pairing revoke signal <user_id>` removes one; review `GATEWAY_ALLOWED_USERS` |
| 13 | `echo >> .env` | Merges onto a line with no trailing newline | Always `hermes -p default config set` (Step 5) |
| 14 | Treating `✓ signal connected` as proof of delivery | It means the adapter reached the daemon's health endpoint and opened the event stream | Step 9 human smoke is the round trip |
| 15 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-signal/` | `snapshot` refuses so half-written state is never captured as known-good | Run `rollback` (restores the pre-crash files), then re-run |
| 16 | Phone numbers in logs or chat | PII; unauthorized-sender log lines contain the sender's id | Step 8 masks numbers in anything it prints; do the same before pasting logs |
| 17 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees the numbers (the local ssh argv stays clean) | Accepted; the output is discarded so Hermes cannot echo values into chat |
| 18 | Fresh shell per command in your harness | Step 0 functions are undefined later | Re-run the Step 0 block first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes `0.22.5` verified on the VPS host
- [ ] Human-only steps done: signal-cli installed, account linked/registered, daemon running on loopback (the skill checks the last, not the rest)
- [ ] Idempotency check ran (skipped if URL + account + a safe allowlist were already stored, unless `FORCE=1`)
- [ ] HARD GATE passed with nothing written: allowlist non-empty, no `*`, every entry E.164-with-`+` or UUID; account E.164; no allow-all switch or wildcard in the VPS `.env`; `GET /api/v1/check` returned 200 from the VPS
- [ ] Dry-run shown to the user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `SIGNAL_ALLOWED_USERS` written first, `SIGNAL_ACCOUNT` then `SIGNAL_HTTP_URL` last, all in `~/.hermes/.env` (`chmod 600`), over stdin, verified by count and comparison (nothing printed), open-access re-check clean
- [ ] `platforms.signal.enabled` set to `true` (no `SIGNAL_ENABLED` anywhere)
- [ ] Gateway reloaded with `gw_reload` (restart --detach, ensure ready, new instance)
- [ ] Gateway log shows Signal connected (latest status line), then `finish` ran
- [ ] Live smoke: an allowlisted number got a reply; a non-allowlisted number got nothing
- [ ] Any failure after the snapshot ran `rollback` (Step 0) and restored the prior `.env` + `config.yaml`

---

## Verified against Hermes v0.22.5

Source-verified, **not** live-verified: everything below was read from the Hermes v0.22.5 source (tag `v0.22.5`, commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`) and exercised only against test doubles (`tests/skills/platform-signal.test.mjs`: the real bash of
this skill, the real v0.22.5 argparse for every `hermes` call, stubbed `ssh`/`curl`/`hermes` behaviour). It has not been run against a
real Hermes, a real signal-cli daemon, or a real Signal account. Paths are relative to the Hermes repository root.

- Env names and what enables Signal: `plugins/platforms/signal/gateway_env.py:7-17` (`SIGNAL_HTTP_URL` + `SIGNAL_ACCOUNT` both required, `SIGNAL_IGNORE_STORIES`, `SIGNAL_HOME_CHANNEL`),
  `:21-25` (authorization names `SIGNAL_ALLOWED_USERS`, `SIGNAL_ALLOW_ALL_USERS`, `allowlist_suppresses_pairing`), `plugins/platforms/signal/plugin.yaml:13-50` (the full list, including
  `SIGNAL_GROUP_ALLOWED_USERS` = group IDs and `SIGNAL_REQUIRE_MENTION`). No `SIGNAL_ENABLED` exists in the plugin.
- Home channel: `gateway_env.py:16`, `register.py:68` (`cron_deliver_env_var`), target forms `+E.164` and `group:<id>` at `register.py:43-49` and `tools/send_message_targets.py:10-11,40-41`.
  This resolves the "unverified `SIGNAL_HOME_CHANNEL`" flag that `/hermes-deploy` carries.
- What the adapter connects to: `plugins/platforms/signal/adapter.py:1-3` (signal-cli `daemon --http`, SSE in, JSON-RPC out), `:168-173` (needs URL and account), `:246-260` (connect = `GET /api/v1/check`
  must be 200, then `Signal: connected to <url>`), `:299-309` (`GET /api/v1/events?account=...`, `Signal SSE: connected`), `:340-352` (health monitor), `:248-252` (failure log lines),
  `:423-433` (sender = `sourceNumber`/`sourceUuid`; the account's own messages are dropped except Note to Self), `:497-506` (groups ignored unless `SIGNAL_GROUP_ALLOWED_USERS` lists the group or `*`),
  `plugins/platforms/signal/standalone.py:72-84` (out-of-process send posts JSON-RPC `send` to `/api/v1/rpc`), `plugins/platforms/signal/setup.py:36-46,57-61,90-96` (the install/link/daemon commands
  and the health URL the wizard tests).
- Authorization: `gateway/authz_mixin.py:670-671` (allow-all env), `:677-679` (pairing store), `:686-694` (no allowlist: default-deny unless `GATEWAY_ALLOW_ALL_USERS`), `:707-714` (allowlist match,
  `*` allows all; `GATEWAY_ALLOWED_USERS` and group lists are unioned), `:27` (truthy = `true`/`1`/`yes`), `:747-757` (pairing offered unless an allowlist is configured), `gateway/run_inbound.py:220-239`
  (`Unauthorized user` log lines). The configured-allowlist-or-ignore behaviour for strangers depends on that code path; it was not observed running.
- Enabling and the explicit-disable rule: `gateway/platform_env.py:139-178` (`EnvCred`), `gateway/config_env.py:84-109` (an explicit `platforms.<x>.enabled: false` wins and is warned once).
- `hermes config set` routes UPPER_SNAKE names to `.env` and does not echo values: `hermes_cli/config.py:3398-3439`; positional syntax `hermes_cli/subcommands/config.py:27-33` (the `--` separator is checked
  by the vendored argparse in the tests).
- Logs: `hermes logs gateway -n N --since T` (`hermes_cli/subcommands/logs.py:34-52`), file `gateway.log` and line format `hermes_logging.py:107,399`, gateway connect lines `gateway/run_startup.py:1352,1355`.
- `hermes send --to TARGET MESSAGE` (exit 0 ok, 1 delivery error, 2 usage): `hermes_cli/send_cmd.py:194-240,244-262,291`; `signal:+E164` is an explicit target (`tools/send_message_targets.py:40-41`).
- Gateway lifecycle: see the note under Step 0 (citations there).
- `hermes pairing list|approve|revoke` (used only as a pointer in Pitfall 12): `hermes_cli/subcommands/pairing.py:8-29`.

**Still unverified (nothing here was run against real Signal).** That the daemon behind `SIGNAL_HTTP_URL` serves the account you named (Hermes never asks it); signal-cli's own install, link and register
procedure and Java requirements (external software, not in Hermes source); whether a bbernhard `signal-cli-rest-api` bridge answers the three paths the adapter uses; the exact bytes `gateway.log`
contains on a real host (the match strings above are the adapter's and gateway's own format strings); `hermes send` output on success (only its exit codes are read from source); that unknown senders really
receive no reply with an allowlist set (read from `authz_mixin.py`, not observed); the systemd unit example.
