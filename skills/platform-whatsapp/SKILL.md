---
name: platform-whatsapp
description: "Wire a remote Hermes Agent 0.22.5 to WhatsApp through the bundled Baileys/Node bridge (QR pairing, no Meta developer account) over SSH. Hard allowlist gate, strict allowlist DM policy, snapshot and rollback, native gateway reload, log and bridge-health verification. The QR pairing is a human step; the Meta Cloud API integration is a different path this skill does not cover."
---

# /platform-whatsapp — wire WhatsApp (Baileys bridge) to a remote Hermes (SSH-first, allowlist-gated, source-verified for 0.22.5)

You are the engineer connecting WhatsApp to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does the two things a machine cannot:

1. Run the pairing wizard in a real terminal (`hermes whatsapp` needs a TTY) and **scan its QR code** with the phone
   (WhatsApp > Settings > Linked Devices > Link a Device).
2. Tell you which phone numbers may talk to the agent.

Everything else — allowlist and policy storage, the open-access gate, the gateway reload, log and bridge-health
verification — runs on the VPS over SSH, with a snapshot/rollback path.

**Where commands run.** Every `bash` block below runs on YOUR machine (possibly macOS with bash 3.2) and reaches the VPS
through `remote()` (Step 0), which puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Run all blocks in ONE shell
session: later steps call the Step 0 functions. Phone numbers are personal data: they travel over ssh **stdin**, never in an
ssh argument, and are not echoed back (counts and masked forms only).

## Which WhatsApp integration this is

Hermes v0.22.5 ships TWO WhatsApp platforms that can run side by side on different numbers
(`plugins/platforms/whatsapp_cloud/gateway_env.py:7`):

| | **Baileys bridge** (this skill) | **Cloud API** (not this skill) |
|---|---|---|
| Hermes command | `hermes whatsapp` | `hermes whatsapp-cloud` |
| Needs | A phone with WhatsApp (a spare or WhatsApp Business number is recommended) and Node.js | A Meta developer app and WhatsApp Business account, a System User access token, and a **public webhook URL** |
| Auth | QR scan, session stored under `~/.hermes` | `WHATSAPP_CLOUD_ACCESS_TOKEN` + `WHATSAPP_CLOUD_PHONE_NUMBER_ID` (+ app secret/verify token for the webhook) |
| Enabled by | `WHATSAPP_ENABLED=true` | the phone-number-id + access-token pair |
| Allowlist | `WHATSAPP_ALLOWED_USERS` | `WHATSAPP_CLOUD_ALLOWED_USERS` |
| Machine-automatable over SSH? | Everything except the QR scan | Only after a human has created the Meta app, token and public webhook; the wizard also needs a TTY |

The old recipe (QR, "no Meta dev account") describes the bridge, so that is what this skill does. The Cloud API needs a separate skill; its
facts are in `plugins/platforms/whatsapp_cloud/` (`gateway_env.py:6-28`, `plugin.yaml`) and `hermes_cli/main_platform_setup.py:226-232`.

**There is no vendor-side preflight for the bridge.** WhatsApp has no token to test against an API before writing: the credential is the
QR-paired session, which only exists after the human step. The only online check is the bridge's own loopback `/health` after the
reload (Step 9). (The Cloud path would have the Graph API; that is not covered here.)

**What the source says about access (Hermes v0.22.5, details in "Verified against").**

- The bridge is enabled by the flag `WHATSAPP_ENABLED=true`, and the adapter refuses to start a bridge that has no `creds.json`
  (the pairing wizard therefore sets the flag only after a successful pairing). An explicit `platforms.whatsapp.enabled: false`
  in `config.yaml` beats the env flag, so Step 7 sets that key to `true`.
- The older recipe claimed that an empty allowlist leaves the bot open to everyone. In v0.22.5 it does not: the Node bridge rejects incoming messages when
  no allowlist is set (unless the policy is `pairing`, where the bridge forwards unknown senders to the gateway for pairing)
  and the gateway default-denies. Open access needs an explicit switch: `WHATSAPP_ALLOWED_USERS=*` (the wizard offers it),
  `WHATSAPP_ALLOW_ALL_USERS=true|1|yes`, `GATEWAY_ALLOW_ALL_USERS=true|1|yes`, or `WHATSAPP_DM_POLICY=open`. This skill refuses
  to run while any of them is present and never writes them. The hard allowlist gate stays: it keeps the bot usable by exactly the
  people you named.
- The default `WHATSAPP_DM_POLICY` is `pairing`: every DM reaches the gateway and a stranger can be sent a pairing code even when an
  allowlist exists. This skill writes `WHATSAPP_DM_POLICY=allowlist`, so only the allowlisted numbers get through. Groups default to
  policy `pairing`, which never forwards group traffic, and this skill leaves that alone.
- Allowlist entries are bare phone numbers (country code + number, digits only, no `+`). The old "LID bug" caveat is stale for v0.22.5:
  phone numbers and `@lid` identities are matched through the bridge's `lid-mapping` files.

---

## Human-only steps (a machine cannot do these)

The pairing wizard is interactive (mode and allowlist prompts, an `npm install` that can take minutes, then the QR) and refuses to run
without a terminal, so it is shown as plain text and never executed by this skill. Preferred sequence: this skill writes the allowlist
and policy FIRST (Step 5), so the wizard already shows them, and then waits for you to pair (Step 6). If your harness cannot hold one
command for that long, pair first and then run the skill: it finds the session and skips the wait.

```text
# From the user's own terminal (a real TTY is required; the PATH export is needed because non-login ssh shells miss ~/.local/bin):
ssh -t USER@HOST 'export PATH="$HOME/.local/bin:$PATH"; hermes -p default whatsapp'

# In the wizard:
#   - the mode is already stored by this skill, so it is not asked again (bot = a separate number people message;
#     self-chat = you message yourself on your own number)
#   - "Allowed users: ... Update allowed users? [y/N]"  ->  answer N (answering with other numbers, or "*", is caught
#     and rolled back by Step 7)
#   - wait for the bridge dependencies to install, then scan the QR with the phone:
#     WhatsApp (or WhatsApp Business) > Settings > Linked Devices > Link a Device
#   - the wizard prints "WhatsApp paired successfully!" and stores WHATSAPP_ENABLED=true; this skill then takes over
```

A paired session is the file `~/.hermes/whatsapp/session/creds.json` (older layout, written by the wizard) or
`~/.hermes/platforms/whatsapp/session/creds.json` (dashboard pairing); Step 3 and Step 6 treat either one as paired. Rollback never deletes it, so a failed run does not cost a second
QR scan. To unlink, remove the linked device in WhatsApp and delete that directory yourself.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WHATSAPP_ALLOWED_USERS` | Comma-separated bare phone numbers (country code + number, digits only, NO `+`, no spaces, 7-15 digits) e.g. `15551234567,447700900001` | The phones that may DM the agent (in self-chat mode: your own number) |
| `$WHATSAPP_MODE` | `bot` (people message a separate bot number) or `self-chat` (you message yourself) | The user's choice; asked by the wizard otherwise |
| `$WHATSAPP_HOME_CHANNEL` *(optional)* | One bare number for cron/notification delivery | Usually the operator's own number |
| `$BRIDGE_PORT` *(optional)* | Loopback port of the bridge (default: the port Hermes recorded, else `3000`) | Only if `platforms.whatsapp.extra.bridge_port` was changed |
| `$PAIR_TRIES` *(optional)* | How many 5-second polls to wait for the human pairing (default `100`, about 8 minutes) | Lower it in tests; raise it only if your harness allows a long command |
| `$SMOKE_SEND` *(optional)* | `1` to send one test message to the first allowlisted number in Step 10 | Default: no message is sent |

If `$WHATSAPP_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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
SKILL_NAME=platform-whatsapp
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

Skip setup only when `WHATSAPP_ENABLED` is true, the allowlist is stored once and well formed, a paired session exists, the file is private,
and no open-access switch, open policy or wildcard is on. An unsafe existing setup aborts here; it is never reported as wired. The check
prints a status only, never stored values. `FORCE=1` skips this step and rewires (the previous values are restored if the re-run fails).

```bash
if [ "${FORCE:-0}" != "1" ]; then
  STATE=$(remote 'bash -s' <<'REMOTE'
f=$HOME/.hermes/.env
if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo needs_setup; exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || { echo unsafe; exit 0; }
mode=$(stat -c %a "$f" 2>/dev/null) || mode=$(stat -f %Lp "$f" 2>/dev/null) || exit 1
paired=0
for p in whatsapp/session platforms/whatsapp/session; do [ -s "$HOME/.hermes/$p/creds.json" ] && paired=1; done
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
  function list_ok(l,   n, a, i) {
    if (l == "") return 0
    n = split(l, a, ",")
    for (i = 1; i <= n; i++) if (!(digits(a[i]) && length(a[i]) >= 7 && length(a[i]) <= 15)) return 0
    return 1
  }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^WHATSAPP_ENABLED=/) { enabled_n++; ev = tolower(value(line)); gsub(/[[:space:]]/, "", ev); if (ev == "true" || ev == "1" || ev == "yes") enabled = 1 }
    if (line ~ /^WHATSAPP_ALLOWED_USERS=/) { lists++; users = value(line); if (wild(users)) open_access = 1 }
    if (line ~ /^(WHATSAPP_GROUP_ALLOWED_USERS|GATEWAY_ALLOWED_USERS)=/) { if (wild(value(line))) open_access = 1 }
    if (line ~ /^(WHATSAPP_DM_POLICY|WHATSAPP_GROUP_POLICY)=/) { v = tolower(value(line)); gsub(/[[:space:]]/, "", v); if (v == "open") open_access = 1 }
    if (line ~ /^(WHATSAPP_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) {
      v = tolower(value(line)); gsub(/[[:space:]]/, "", v)
      if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") open_access = 1
    }
  }
  END {
    if (!enabled || lists == 0) print "needs_setup"
    else if (open_access || lists > 1 || enabled_n > 1) print "unsafe"
    else if (!list_ok(users)) print "unsafe"
    else print "safe"
  }' "$f") || exit 1
if [ "$state" = safe ] && [ "$mode" != 600 ]; then state=unsafe; fi
if [ "$state" = safe ] && [ "$paired" != 1 ]; then state=needs_setup; fi
echo "$state"
REMOTE
) || { echo "ABORT: could not check the stored WhatsApp setup. Nothing was written."; exit 1; }
  case "$STATE" in
    safe) echo "WhatsApp already wired (enabled, allowlist stored, session paired, private, no open access). Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored WhatsApp setup is unsafe (check the file mode, duplicate keys, the allowlist format, wildcards, open policies and allow-all switches). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE (allowlist + formats, open-access switches), all BEFORE any write

Nothing has been written yet, so every failure here is a plain `exit 1` with `Nothing was written.` There is no vendor call to make (see
above).

**3a. Format check (local, no network, no ssh).** The allowlist must be non-empty, free of `*`, and every entry a bare number of 7-15 digits.
Offending entries are reported by position only, never echoed.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
WHATSAPP_ALLOWED_USERS=$(printf '%s' "${WHATSAPP_ALLOWED_USERS:-}" | csv_clean)
WHATSAPP_HOME_CHANNEL=$(printf '%s' "${WHATSAPP_HOME_CHANNEL:-}" | tr -d ' \t\r\n')
WHATSAPP_MODE=$(printf '%s' "${WHATSAPP_MODE:-}" | tr -d ' \t\r\n')

if [ -z "$WHATSAPP_ALLOWED_USERS" ]; then
  echo "ABORT: WHATSAPP_ALLOWED_USERS is empty. Supply bare phone numbers (country code + number, digits only, NO '+'), comma-separated."
  echo "Example: WHATSAPP_ALLOWED_USERS='15551234567,447700900001'. Nothing was written."
  exit 1
fi
case "$WHATSAPP_ALLOWED_USERS" in
  *'*'*) echo "ABORT: WHATSAPP_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac
BAD=$(printf '%s\n' "$WHATSAPP_ALLOWED_USERS" | tr ',' '\n' | grep -vnE '^[0-9]{7,15}$' | cut -d: -f1 | tr '\n' ' ')
if [ -n "$BAD" ]; then
  echo "ABORT: invalid entries in WHATSAPP_ALLOWED_USERS (entry number(s): $BAD). Each must be digits only, 7-15 long: no '+', no dashes, no @lid or JID suffix. Nothing was written."
  exit 1
fi
case "$WHATSAPP_MODE" in
  bot|self-chat) ;;
  *) echo "ABORT: WHATSAPP_MODE must be 'bot' (people message a separate bot number) or 'self-chat' (you message yourself). Nothing was written."; exit 1 ;;
esac
if [ -n "$WHATSAPP_HOME_CHANNEL" ]; then
  printf '%s' "$WHATSAPP_HOME_CHANNEL" | grep -qE '^[0-9]{7,15}$' \
    || { echo "ABORT: invalid WHATSAPP_HOME_CHANNEL (one bare number, 7-15 digits). Nothing was written."; exit 1; }
fi
if [ -n "${BRIDGE_PORT:-}" ]; then
  case "$BRIDGE_PORT" in
    *[!0-9]*) echo "ABORT: BRIDGE_PORT must be a port number (1-65535). Nothing was written."; exit 1 ;;
  esac
  BRIDGE_PORT=$((10#$BRIDGE_PORT))
  { [ "$BRIDGE_PORT" -ge 1 ] && [ "$BRIDGE_PORT" -le 65535 ]; } \
    || { echo "ABORT: BRIDGE_PORT must be a port number (1-65535). Nothing was written."; exit 1; }
fi
USERS_N=$(printf '%s' "$WHATSAPP_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
echo "Format OK: $USERS_N allowed number(s), mode $WHATSAPP_MODE."
```

**3b. Open-access switches already on the VPS, and whether a session is already paired.** An allow-all switch, an open policy or a wildcard in
`~/.hermes/.env` makes the allowlist meaningless. The check prints variable NAMES only, fails closed (any value other than an explicit
false/0/no/off counts as on for the allow-all switches), and aborts if the file cannot be read.

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
    if (line !~ /^(WHATSAPP_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|WHATSAPP_DM_POLICY|WHATSAPP_GROUP_POLICY|WHATSAPP_ALLOWED_USERS|WHATSAPP_GROUP_ALLOWED_USERS|GATEWAY_ALLOWED_USERS)=/) next
    n = line; sub(/=.*/, "", n)
    v = line; sub(/^[^=]*=/, "", v)
    gsub(/[\"\047[:space:]]/, "", v)
    if (n ~ /ALLOW_ALL_USERS$/) { v = tolower(v); if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") on[n] = 1 }
    else if (n ~ /_POLICY$/) { if (tolower(v) == "open") on[n] = 1 }
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

# 1 when a paired session (creds.json) exists in either session layout, else 0.
wa_paired() {
  remote 'for p in whatsapp/session platforms/whatsapp/session; do [ -s "$HOME/.hermes/$p/creds.json" ] && { echo 1; exit 0; }; done; echo 0'
}
PAIRED=$(wa_paired) || { echo "ABORT: could not look for the WhatsApp session on the VPS. Nothing was written."; exit 1; }
if [ "$PAIRED" = "1" ]; then echo "A paired WhatsApp session already exists on the VPS."; else echo "No paired WhatsApp session yet: a human QR scan will be needed (Step 6)."; fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) formats, no open-access switch/policy/wildcard in ~/.hermes/.env. No vendor call exists for the bridge.
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write WHATSAPP_MODE=$WHATSAPP_MODE, WHATSAPP_ALLOWED_USERS ($USERS_N number(s)) and, if supplied, WHATSAPP_HOME_CHANNEL via
     'hermes -p default config set' (values sent over ssh stdin)
  3. Write WHATSAPP_DM_POLICY=allowlist (only the allowlisted numbers get through; strangers are not offered pairing codes)
  4. chmod 600 ~/.hermes/.env; verify the keys landed and re-check for open access (counts and names only)
  5. Pairing: $( [ "$PAIRED" = "1" ] && echo "already paired, no QR needed" || echo "HUMAN STEP, you run the wizard in a terminal and scan the QR; waiting up to ${PAIR_TRIES:-100} polls of 5s" )
  6. Re-check the allowlist is still exactly what was written (the wizard can change it), then WHATSAPP_ENABLED=true and platforms.whatsapp.enabled true
  7. Reload gateway: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a NEW instance
  8. Verify: gateway log says whatsapp connected AND the bridge's loopback /health says status connected
  9. Optional (SMOKE_SEND=1): one test message to the first allowlisted number via 'hermes -p default send --to'
 10. Live test (human): an allowlisted phone messages the account; expect a reply

The paired session is NOT touched by this skill or by rollback. Phone numbers are never printed beyond counts.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write mode, allowlist and policy (NOT the enable flag yet)

The enable flag comes last (Step 7), after pairing and after the allowlist has been re-checked. Each value is ONE line on ssh stdin, read by
`read -r` on the VPS. The output of `hermes -p default config set` is discarded so Hermes can never echo a value into chat. `config set`
routes UPPER_SNAKE names to `~/.hermes/.env` (`hermes_cli/config.py:3429-3438`).

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 -- \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put WHATSAPP_MODE "$WHATSAPP_MODE" \
  || { echo "FAIL: could not write WHATSAPP_MODE."; rollback; exit 1; }
put WHATSAPP_ALLOWED_USERS "$WHATSAPP_ALLOWED_USERS" \
  || { echo "FAIL: could not write WHATSAPP_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$WHATSAPP_HOME_CHANNEL" ]; then
  put WHATSAPP_HOME_CHANNEL "$WHATSAPP_HOME_CHANNEL" \
    || { echo "FAIL: could not write WHATSAPP_HOME_CHANNEL."; rollback; exit 1; }
fi
put WHATSAPP_DM_POLICY allowlist \
  || { echo "FAIL: could not write WHATSAPP_DM_POLICY."; rollback; exit 1; }
```

Verify what landed (counts and a comparison; the numbers are never printed), and re-check that no wildcard, open policy or allow-all switch appeared:

```bash
COUNT=$(remote 'grep -cE "^(WHATSAPP_MODE|WHATSAPP_ALLOWED_USERS|WHATSAPP_DM_POLICY)=." ~/.hermes/.env 2>/dev/null; true')
GOT_USERS=$(remote 'sed -n "s/^WHATSAPP_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
GOT_MODE=$(remote 'sed -n "s/^WHATSAPP_MODE=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
GOT_POLICY=$(remote 'sed -n "s/^WHATSAPP_DM_POLICY=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
if [ "$COUNT" != "3" ] || [ "$GOT_USERS" != "$WHATSAPP_ALLOWED_USERS" ] || [ "$GOT_MODE" != "$WHATSAPP_MODE" ] || [ "$GOT_POLICY" != "allowlist" ]; then
  echo "FAIL: the WhatsApp settings did not land as written (key count $COUNT, need 3; the stored values must equal the supplied ones). Rolling back."
  rollback; exit 1
fi
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "WhatsApp allowlist and policy confirmed in ~/.hermes/.env (WHATSAPP_ENABLED is not set yet)."
```

Never put numbers in `config.yaml`; they are environment settings. Never `echo >> .env`.

---

## Step 6 — pairing (HUMAN STEP: the user runs the wizard and scans the QR)

If a session already exists this step does nothing. Otherwise it prints the instructions and polls the VPS for `creds.json`. It gives up after
`PAIR_TRIES` polls and rolls back (the snapshot restores `.env`, including anything the wizard stored; the session, if it got that far, is kept).

```bash
case "${PAIR_TRIES:-}" in ''|*[!0-9]*) PAIR_TRIES=100 ;; esac
if [ "$PAIRED" = "1" ]; then
  echo "Session already paired: no QR scan needed."
else
  cat <<EOF
HUMAN STEP — pair WhatsApp. An agent cannot do this: the wizard needs a terminal and the QR needs the phone.
  1. In your own terminal run:
       ssh -t $VPS_USER@$VPS_IP 'export PATH="\$HOME/.local/bin:\$PATH"; hermes -p default whatsapp'
  2. If it asks "Update allowed users? [y/N]", answer N (the list is already stored).
  3. Let the bridge dependencies install, then scan the QR: WhatsApp > Settings > Linked Devices > Link a Device.
  4. Wait for "WhatsApp paired successfully!". This skill is polling the VPS and continues by itself.
(Waiting up to $PAIR_TRIES polls of 5 seconds.)
EOF
  i=0
  while [ "$i" -lt "$PAIR_TRIES" ]; do
    PAIRED=$(wa_paired) || PAIRED=0
    [ "$PAIRED" = "1" ] && break
    i=$((i + 1))
    sleep 5
  done
  if [ "$PAIRED" != "1" ]; then
    echo "FAIL: no WhatsApp session appeared within $PAIR_TRIES polls of 5s (the QR was not scanned or the wizard did not finish). Rolling back; run this skill again when the phone is ready."
    rollback; exit 1
  fi
  echo "OK: WhatsApp session paired."
fi
```

---

## Step 7 — re-check the allowlist, then enable

The wizard may have changed the allowlist (it offers "any number" with `*`, and a blank answer stores nothing). Before turning WhatsApp on, the
stored allowlist must still be exactly what was written in Step 5, defined once, with no open-access name. Only then is `WHATSAPP_ENABLED` set.
`platforms.whatsapp.enabled` is set to `true` as well: an explicit `false` there would beat the env flag; a failure of that second write is a
WARN, because Step 9 shows whether the bridge connected.

```bash
GOT_USERS=$(remote 'sed -n "s/^WHATSAPP_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
COUNT_A=$(remote 'grep -c "^WHATSAPP_ALLOWED_USERS=" ~/.hermes/.env 2>/dev/null; true')
if [ "$COUNT_A" != "1" ] || [ "$GOT_USERS" != "$WHATSAPP_ALLOWED_USERS" ]; then
  echo "FAIL: the allowlist on the VPS no longer matches the one supplied (the pairing wizard may have changed it). Rolling back."
  rollback; exit 1
fi
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
put WHATSAPP_ENABLED true \
  || { echo "FAIL: could not write WHATSAPP_ENABLED."; rollback; exit 1; }
remote "hermes -p default config set platforms.whatsapp.enabled true && chmod 600 ~/.hermes/.env" \
  || echo "WARN: could not set platforms.whatsapp.enabled. The env flag enables WhatsApp unless config.yaml says platforms.whatsapp.enabled: false; Step 9 will show whether it connected."
```

---

## Step 8 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. The gateway re-reads `~/.hermes/.env` at start. On start the WhatsApp adapter launches the Node bridge itself (and
installs its npm dependencies if needed), so the first start can take a while. A refusal because of live sessions is reported, not overridden;
see the lifecycle note in Step 0.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — verify: gateway log AND the bridge's own health (poll up to 60s)

Two independent signals are required. (1) `hermes logs gateway` must show the LATEST WhatsApp status line as connected (`✓ whatsapp connected`; failures
read `✗ whatsapp failed to connect`, `✗ whatsapp error: ...`, `WhatsApp is enabled but not paired` or `Failed to start bridge`). (2) The bridge's loopback
`GET /health` must say `"status":"connected"`. The second is needed because the adapter reports "connected" to the gateway even when the bridge is
still waiting for WhatsApp after its 30-second wait; the bridge status is the one that reflects the WhatsApp session. Neither proves a message round
trip; that is Step 10.

```bash
# Bridge port: BRIDGE_PORT if given, else the port Hermes recorded for this profile, else the default 3000.
if [ -z "${BRIDGE_PORT:-}" ]; then
  BRIDGE_PORT=$(remote 'cat ~/.hermes/platforms/whatsapp/bridge_port 2>/dev/null' | tr -d ' \r\n')
fi
case "$BRIDGE_PORT" in ''|*[!0-9]*) BRIDGE_PORT=3000 ;; esac

READY=0
PLATFORM_LOG=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  HEALTH=$(remote "curl -fsS --max-time 5 'http://127.0.0.1:$BRIDGE_PORT/health'" 2>/dev/null) || HEALTH=""
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 300 --since 10m 2>&1") || LOG_STATUS=$?
  case "$HEALTH" in *'"status":"connected"'*) BRIDGE_OK=1 ;; *) BRIDGE_OK=0 ;; esac
  if [ "$BRIDGE_OK" = 1 ] && [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | awk '
    {
      line = tolower($0)
      if (line !~ /(^|[^[:alnum:]_])whatsapp([^[:alnum:]_]|$)/) next
      if (line ~ /whatsapp failed to connect|whatsapp error:|enabled but not paired|failed to start bridge|node\.js not found|bridge process died|\(degraded\)/) connected = 0
      else if (line ~ /whatsapp connected|whatsapp reconnected successfully/) connected = 1
    }
    END { exit !connected }'; then
    READY=1
    echo "OK: WhatsApp connected (gateway log and bridge /health on port $BRIDGE_PORT)."
    break
  fi
  sleep 5
done
if [ "$READY" != "1" ]; then
  # Show the WhatsApp lines with long digit runs (phone numbers) masked, so a failure can be diagnosed without leaking them.
  printf '%s\n' "$PLATFORM_LOG" | grep -i whatsapp | sed -E 's/[0-9]{7,15}/<n>/g' | tail -n 5
  echo "FAIL: WhatsApp did not become ready within 60s (needs a connected gateway log line AND bridge /health status connected). Rolling back."
  rollback; exit 1
fi

finish || exit 1
```

---

## Step 10 — smoke test

**Optional machine smoke (`SMOKE_SEND=1`).** `hermes send` is the native out-of-process sender: for WhatsApp it posts to the running bridge's loopback API, so it
needs the bridge up (Step 9). It exits 0 on success and 1 on a delivery error. It sends ONE fixed message to the first allowlisted number, travelling
over ssh stdin. A delivery failure is a WARN: Step 9 already verified the connection and `finish` already ran.

```bash
FIRST_NUM=$(printf '%s' "$WHATSAPP_ALLOWED_USERS" | cut -d',' -f1)
if [ "${SMOKE_SEND:-0}" = "1" ]; then
  printf '%s\n' "$FIRST_NUM" \
    | remote 'IFS= read -r t && hermes -p default send --to "whatsapp:+$t" "hstack platform-whatsapp: WhatsApp is connected (test message, no reply needed)"' >/dev/null 2>&1 \
    && echo "Smoke message sent to the first allowlisted number." \
    || echo "WARN: the smoke message was not delivered. The connection was verified in Step 9; check 'hermes -p default logs gateway' for send errors."
fi
```

**Human smoke (required for a real round trip).**

```bash
cat <<EOF
SMOKE TEST — from an allowlisted phone:
  1. Send "ping" to the linked WhatsApp account (in self-chat mode: open "Message yourself" and type there).
  2. The agent should reply within a few seconds (replies start with the "Hermes Agent" prefix).
  3. From a number NOT on the allowlist, send "ping": expect NO reply (the DM policy is allowlist).

If silent: 'hermes -p default logs gateway -n 100' on the VPS, and the bridge log at ~/.hermes/platforms/whatsapp/bridge.log
(or ~/.hermes/whatsapp/bridge.log with the older session layout). Confirm the number in the phone's chat is in WHATSAPP_ALLOWED_USERS
as digits only (country code + number, no '+').
EOF
```

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in **Step 0**. It restores and verifies the pre-run `~/.hermes/.env` and `config.yaml` from the active
snapshot, reloads the gateway with `gw_reload`, and only then retires the snapshot to `.prev`. A failed restore exits non-zero with
`restoration failed; active snapshot retained for recovery`; a restore whose reload does not come back ready reports
`files restored, but the gateway did NOT come back` and keeps the snapshot. Neither claims recovery succeeded: fix the fault and run
`rollback` again (a restart refused because of live sessions is the same case; retry with `GW_INTERRUPT=1` only if interrupting them is
acceptable). A failed `FORCE=1` re-run puts the previous mode, allowlist, policy and flag back; a failed first run removes the files it created.
Failures in Steps 1-4 happen before the snapshot and change nothing.

Rollback never deletes the paired session or the bridge's files, so a retry does not need a second QR scan. A hard wipe (stolen phone, wrong
account) is a separate, deliberate act: unlink the device in WhatsApp (Settings > Linked Devices), then on the VPS delete
`~/.hermes/whatsapp/session/` and `~/.hermes/platforms/whatsapp/session/`.

After a successful run the snapshot is kept as `platform-whatsapp.prev` for a manual undo; both directories are `chmod 700` and hold the
previous values, so delete the `.prev` when you no longer need the undo. To undo a run that already finished (with the Step 0 functions loaded):

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

To turn WhatsApp off instead (only if the user asks): `hermes -p default config set WHATSAPP_ENABLED false` and `hermes -p default config set platforms.whatsapp.enabled false`,
then reload with `gw_reload`.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Open access via `WHATSAPP_ALLOWED_USERS=*`, `WHATSAPP_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS` or `WHATSAPP_DM_POLICY=open` | Anyone who messages the number can use the agent (the pairing wizard itself offers `*`) | Step 3 aborts before any write; Step 5 and Step 7 re-check (names only); never set them with this skill |
| 2 | An empty allowlist | In v0.22.5 it is not open: the bridge rejects (or, in bot mode with the default policy, forwards unknown senders for pairing) and the gateway default-denies, so the bot is simply useless or hands out pairing codes | Step 3a hard-aborts |
| 3 | Default policy `pairing` with an allowlist | Strangers' DMs still reach the gateway and can be offered pairing codes | Step 5 writes `WHATSAPP_DM_POLICY=allowlist` |
| 4 | Allowlist with `+`, spaces, dashes, `@lid` or a JID | The documented form is bare digits; other forms are not what the wizard stores | Step 3a requires 7-15 digits per entry |
| 5 | The wizard overwrote the allowlist (a different list, or `*`, or nothing) | The enable flag would then turn on a different audience than the one you approved | Step 7 compares the stored allowlist to the supplied one before enabling and rolls back otherwise |
| 6 | Running `hermes whatsapp` through a pipe or a non-interactive ssh | It exits with "requires an interactive terminal" | The human runs it with `ssh -t` (Step 6); no block here does |
| 7 | Enabling before pairing | The adapter has no `creds.json`, logs `WhatsApp is enabled but not paired` and does not retry, and the gateway sits without WhatsApp | `WHATSAPP_ENABLED` is written only after a session exists (Step 7) |
| 8 | QR expiry | The QR rotates; a slow scan fails and the wizard ends without a session | Re-run the wizard; the skill keeps waiting until `PAIR_TRIES` runs out |
| 9 | `✓ whatsapp connected` in the log is not proof the phone is linked | The adapter proceeds after 30 seconds even when the bridge is still waiting for WhatsApp | Step 9 also requires the bridge `/health` status `connected` |
| 10 | Two profiles or two numbers on one host | Each bridge needs its own port; a bridge on the port serving another session is never adopted or killed | Give each profile its own `platforms.whatsapp.extra.bridge_port`; this skill covers only the default profile's bridge (`BRIDGE_PORT` selects the port Step 9 probes) |
| 11 | Pairing approvals and `GATEWAY_ALLOWED_USERS` also authorize | A pairing approval and the cross-platform list are unioned with the allowlist | `hermes -p default pairing list` shows approvals; `hermes -p default pairing revoke whatsapp <user_id>` removes one |
| 12 | Losing or selling the phone | The linked session stays valid until it is unlinked | Unlink in WhatsApp (Linked Devices) and delete the session directories (see Rollback) |
| 13 | Wrong number format across borders | A leading trunk `0` is not part of the country-code form | Use country code + subscriber number (UK `447700900001`, not `07700900001`) |
| 14 | `echo >> .env` | Merges onto a line with no trailing newline | Always `hermes -p default config set` (Steps 5 and 7) |
| 15 | Numbers in logs or chat | PII; unauthorized-sender log lines carry the sender's id | Step 9 masks long digit runs in anything it prints; do the same before pasting logs |
| 16 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-whatsapp/` | `snapshot` refuses so half-written state is never captured as known-good | Run `rollback` (restores the pre-crash files), then re-run |
| 17 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees the numbers (the local ssh argv stays clean) | Accepted; the output is discarded so Hermes cannot echo values into chat |
| 18 | Fresh shell per command in your harness | Step 0 functions are undefined later | Re-run the Step 0 block first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes `0.22.5` verified on the VPS host
- [ ] Idempotency check ran (skipped if enabled + a safe allowlist + a paired session were already stored, unless `FORCE=1`)
- [ ] HARD GATE passed with nothing written: allowlist non-empty, no `*`, every entry 7-15 digits; mode valid; no allow-all switch, open policy or wildcard in the VPS `.env`
- [ ] Dry-run shown to the user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `WHATSAPP_MODE`, `WHATSAPP_ALLOWED_USERS` and `WHATSAPP_DM_POLICY=allowlist` written (plus `WHATSAPP_HOME_CHANNEL` if supplied) in `~/.hermes/.env` (`chmod 600`), over stdin, verified (nothing printed)
- [ ] A paired session exists (`creds.json`): the human ran `hermes whatsapp` and scanned the QR, or one was already there
- [ ] The allowlist was re-read after pairing and still equals the supplied one; open-access re-check clean
- [ ] `WHATSAPP_ENABLED=true` written only after pairing; `platforms.whatsapp.enabled` set to `true`
- [ ] Gateway reloaded with `gw_reload` (restart --detach, ensure ready, new instance)
- [ ] Gateway log shows WhatsApp connected AND the bridge `/health` says `"status":"connected"`, then `finish` ran
- [ ] Live smoke: an allowlisted phone got a reply; a non-allowlisted number got nothing
- [ ] Any failure after the snapshot ran `rollback` (Step 0) and restored the prior `.env` + `config.yaml`, leaving the paired session in place

---

## Verified against Hermes v0.22.5

Source-verified, **not** live-verified: everything below was read from the Hermes v0.22.5 source (tag `v0.22.5`, commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`) and exercised only against test doubles (`tests/skills/platform-whatsapp.test.mjs`: the real bash of this skill, the
real v0.22.5 argparse for every `hermes` call it runs, stubbed `ssh`/`curl`/`hermes` behaviour, and a simulated human for the QR step). It has not been run
against a real Hermes, a real bridge, or a real WhatsApp account. Paths are relative to the Hermes repository root.

- Which integrations exist and how they differ: `hermes_cli/subcommands/whatsapp.py:8-24` (`hermes whatsapp` = Baileys bridge for personal accounts; `hermes whatsapp-cloud` = Meta Cloud API, Business account and public webhook),
  `plugins/platforms/whatsapp/plugin.yaml` (Node.js bridge over HTTP), `plugins/platforms/whatsapp_cloud/gateway_env.py:6-28` and `plugin.yaml` (the `WHATSAPP_CLOUD_*` names).
- Enabling: `plugins/platforms/whatsapp/gateway_env.py:8-22` (the flag `WHATSAPP_ENABLED`; true never beats an explicit YAML disable), `:26-31` (authorization names `WHATSAPP_ALLOWED_USERS`, `WHATSAPP_ALLOW_ALL_USERS`,
  `WHATSAPP_DM_POLICY`, `WHATSAPP_GROUP_POLICY`), `gateway/config_env.py:84-109` (explicit disable wins, warned once), `plugins/platforms/whatsapp/adapter.py:578-590` (no `creds.json` = fatal, not retried).
- The pairing wizard: `hermes_cli/main_platform_setup.py:28-91` (mode, allowed-users prompts, `*` accepted), `:133-223` (`cmd_whatsapp`: session dir `whatsapp/session`, `npm install`, QR, `WHATSAPP_ENABLED=true` only after a session exists, `:145-148,205-210`),
  `hermes_cli/main.py:411-420` (`_require_tty`: refuses without a terminal).
- Session location: `plugins/platforms/whatsapp/adapter.py:61-65` with `hermes_constants.py:492-504` (`platforms/whatsapp/session`, or the legacy `whatsapp/session` when it has content). Bridge port: `plugins/platforms/whatsapp/bridge_ownership.py:73-89`
  (explicit config, else the recorded `platforms/whatsapp/bridge_port`, else 3000).
- Access policy: `plugins/platforms/whatsapp/adapter.py:377-379` (default `pairing`), `gateway/platforms/access_policy_mixin.py:51-69` (`allowlist` admits only the list; `pairing` admits everyone for the handshake; groups only under `allowlist`/`open`),
  `scripts/whatsapp-bridge/bridge.js:123-128,640-660` (intake gating, `pairing` forwards unknown DMs) and `:1159-1171` (no allowlist: "incoming messages are rejected"), `gateway/run_startup.py:64-75,1061-1069` (refuses to start with an open policy and no allow-all opt-in),
  `gateway/authz_mixin.py:168-174,670-671,677-679,686-694,706-714,747-748` (alias expansion, allow-all env, pairing store, default-deny, allowlist match, "pair" for the `pairing` policy), `gateway/platforms/whatsapp_common.py:160-178` and
  `gateway/whatsapp_identity.py:29-32,69-99` (phone/LID alias matching).
- Health and status: `scripts/whatsapp-bridge/bridge.js:1128-1139` (`GET /health` returns JSON with `status`), `plugins/platforms/whatsapp/adapter.py:405-407,478-481` (the adapter reads the same endpoint), `:560-576` (it proceeds after 30s even if not connected),
  gateway log lines `gateway/run_startup.py:1352,1355`, `hermes_logging.py:107,399` (format, `gateway.log`), `hermes logs gateway -n N --since T` (`hermes_cli/subcommands/logs.py:34-52`).
- `hermes send --to TARGET MESSAGE` (exit 0 ok, 1 delivery error, 2 usage): `hermes_cli/send_cmd.py:194-240,244-262,291`; `whatsapp:+digits` is an explicit target (`tools/send_message_targets.py:10-11,40-41`); the standalone WhatsApp send talks to the
  bridge on `localhost` (`plugins/platforms/whatsapp/adapter.py:1104-1148`).
- `hermes config set` routes UPPER_SNAKE names to `.env` and does not echo values: `hermes_cli/config.py:3398-3439`; `hermes pairing list|approve|revoke` (Pitfall 11): `hermes_cli/subcommands/pairing.py:8-29`.
- Gateway lifecycle: see the note under Step 0 (citations there).

**Parser gap.** The vendored argparse fixtures under `tests/skills/fixtures/hermes-v0.22.5/` do not include `hermes whatsapp` or `hermes whatsapp-cloud` (`hermes_cli/subcommands/whatsapp.py`). Neither is run by any block here; the wizard
command appears only in a plain-text instruction, so its syntax (no arguments) is read from the source above, not checked by the harness.

**Still unverified (nothing here was run against real WhatsApp).** The wizard's real prompts and timing (read from source); that the Node bridge starts and pairs on the target host (Node/npm availability, network access to WhatsApp);
that a QR scanned from a phone produces `creds.json` where this skill looks; the exact bytes `gateway.log` contains on a real host (the match strings are the adapter's and gateway's own format strings, and the adapter's
`name` in `[name]` log prefixes was not checked); `hermes send` success output (only exit codes are read from source); that strangers receive no reply under `WHATSAPP_DM_POLICY=allowlist`; WhatsApp's own terms for linked-device bots and the
account-ban risk of an unofficial client; the Cloud API path (not covered).
