---
name: platform-slack
description: "Wire a remote Hermes Agent v0.22.5 to Slack through Socket Mode (bot token xoxb- plus app-level token xapp-, no public endpoint) over SSH. Checks both tokens against Slack from the VPS before any write, refuses open access, reloads the gateway natively, verifies the adapter's own connected log line and rolls back to the previous values on any failure."
---

# /platform-slack — wire Slack to a remote Hermes (SSH-first, Socket Mode)

You are the engineer connecting Slack to a self-hosted Hermes Agent on the user's VPS. The agent
(Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) works over SSH as root. The user does
the things a machine cannot:

1. Create the Slack app (the Hermes-generated manifest does most of it), enable **Socket Mode**, subscribe to the message
   events, turn on the App Home Messages tab and install the app to the workspace.
2. Copy the **bot token** (`xoxb-...`, OAuth & Permissions) and the **app-level token** (`xapp-...`, scope
   `connections:write`, Basic Information).
3. Copy their own Slack **member ID** (profile, more, Copy member ID) for the allowlist.
4. `/invite @YourBot` into every channel it should answer in. The bot never joins channels by itself.

Everything else — the live token checks, the allowlist gate, token storage, gateway reload, the connection check, the
optional test message — runs on the VPS over SSH, with a snapshot and rollback.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and
reaches the VPS through `remote()` from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on
the remote PATH. Both tokens are pasted locally, format-checked locally, and travel to the VPS only over ssh STDIN (a
curl `--config -` for the Slack checks, a `read -r` for the writes), never in an ssh argument, a URL on a command
line or a quoted remote string. Run all blocks in ONE shell session.

**Honest picture (source-verified against Hermes v0.22.5, not run against a live Hermes or Slack).**

- **Two tokens, one of them enables.** `SLACK_BOT_TOKEN` alone enables the platform; there is no `SLACK_ENABLED`
  (`plugins/platforms/slack/gateway_env.py:22-23`). But the adapter also needs `SLACK_APP_TOKEN` and, without it, logs a
  permanent configuration error and never connects (`adapter.py:1792-1797,1854-1862`). Writing only the bot token would
  look enabled and stay dark, so this skill checks and writes both. An explicit `platforms.slack.enabled: false` in
  `config.yaml` beats the credential (`gateway/config_env.py:84-109`); this skill sets it `true` after the writes.
- **Socket Mode: no public URL, no signing secret.** Hermes holds an outbound WebSocket (`website/docs/user-guide/messaging/slack.md:19-28`).
  The old text's "do not set a signing secret" stays true: the skill never asks for one.
- **One workspace per bot token here.** Hermes can serve several workspaces (a comma-separated `SLACK_BOT_TOKEN`, plus
  tokens saved in `~/.hermes/slack_tokens.json`, `adapter.py:6523-6554`) and one allowlist then applies to all of them.
  This skill takes a single `xoxb-` token and warns if `slack_tokens.json` exists.
- **An empty allowlist is not fail-open at v0.22.5, but this skill still refuses it.** With no allowlist and no allow-all
  switch, Slack senders are denied; an unknown DM sender is offered a pairing code instead
  (`gateway/authz_mixin.py:687-694,716-759`). A configured allowlist turns the pairing offer off
  (`allowlist_suppresses_pairing`, `gateway_env.py:31`). `*`, `SLACK_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS`,
  `SLACK_ALLOW_BOTS` and `allow_all_users: true` in `config.yaml` (`gateway/config_loader.py:430-462`) would make the
  allowlist meaningless, so the gate refuses them in `.env` and `config.yaml`.
- **Mentions.** DMs always answer. In channels the bot answers only when @mentioned, and then replies in a thread
  (`slack.require_mention` defaults to true, `hermes_cli/config_defaults.py:1543-1544`; docs `slack.md:374-388`).
- **A pairing code is not an approval.** This skill never runs `hermes pairing approve`: it grants access to whoever holds the code.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$SLACK_BOT_TOKEN` | Bot User OAuth Token, `xoxb-...` (one workspace) | Slack app, OAuth & Permissions, Install App |
| `$SLACK_APP_TOKEN` | App-Level Token for Socket Mode, `xapp-...`, scope `connections:write` | Slack app, Basic Information, App-Level Tokens |
| `$SLACK_ALLOWED_USERS` | Comma-separated Slack member IDs (`U...` or `W...`), NOT handles | Click a person, View full profile, more, Copy member ID |
| `$SLACK_HOME_CHANNEL` *(optional)* | Channel ID (`C...`, `G...` or `D...`) for cron output and `hermes send --to slack`. Without it nothing is sent here and `/sethome` in a channel sets it later | Right-click the channel, Copy link, the last path segment |
| `$SLACK_REQUIRE_MENTION` *(optional)* | `true` or `false`. Hermes default is `true`: channels need an @mention. Only written when you set it | |
| `FORCE=1` *(optional)* | Rewire even if Slack already looks wired | |
| `GW_INTERRUPT=1` *(optional)* | Allow the gateway restart to interrupt live chats. Never set by default | |

Bot scopes, event subscriptions, the Messages tab and the install are done in the Slack UI; the checklist is
`website/docs/user-guide/messaging/slack.md:79-188` (`chat:write`, `app_mentions:read`, `channels:history`, `groups:history`,
`im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `users:read`, `files:read`, `files:write`; events `message.im`,
`message.mpim`, `message.channels`, `message.groups`, `app_mention`). The faster route is the manifest Hermes generates
(`hermes slack manifest --agent-view --write`, `slack.md:37-64`), which this skill does not run. Changing scopes later needs a reinstall.
Slack cannot tell this skill whether the events were subscribed: the symptom of a miss is "works in DMs, silent in channels".

If `$SLACK_ALLOWED_USERS` is empty the skill stops in Step 3 and writes nothing.

Confirm SSH access (first connect: trust the host key once):

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was written."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=platform-slack
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

# ---- platform-slack helpers (the six functions above are the shared lifecycle helpers) ----

# json_field KEY: read a JSON object on stdin and print its top-level scalar KEY (booleans as true/false), or nothing.
json_field() {
  local body
  body=$(cat)
  if command -v python3 >/dev/null 2>&1; then
    printf '%s' "$body" | python3 -I -c 'import json, sys
try:
    v = json.load(sys.stdin).get(sys.argv[1])
    print(str(v).lower() if isinstance(v, bool) else (v if isinstance(v, (str, int)) else ""))
except Exception:
    print("")' "$1" 2>/dev/null
  else
    printf '%s' "$body" | tr -d '\n' | sed -En 's/.*"'"$1"'" *: *("([^"]*)"|([0-9]+|true|false)).*/\2\3/p'
  fi
}

# open_access_names: print the NAMES (never values) of settings in ~/.hermes/.env and ~/.hermes/config.yaml that admit
# senders outside the per-user allowlist. Prints nothing when clean; exits non-zero when a file cannot be read as a regular file.
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"; y="$HOME/.hermes/config.yaml"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then f=/dev/null; fi
if [ ! -e "$y" ] && [ ! -L "$y" ]; then y=/dev/null; fi
for p in "$f" "$y"; do
  [ "$p" = /dev/null ] || { [ -f "$p" ] && [ ! -L "$p" ] && [ -r "$p" ]; } || exit 1
done
awk '
  function value(s) {
    sub(/^[^=]*=/, "", s)
    sub(/\r$/, "", s)
    if (length(s) >= 2) {
      q = substr(s, 1, 1)
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s) - 2)
    }
    return s
  }
  function off(v) {
    v = tolower(v); gsub(/[[:space:]]/, "", v)
    return (v == "" || v == "false" || v == "0" || v == "no" || v == "off")
  }
  FNR == 1 { yaml = (FILENAME ~ /config\.yaml$/) }
  !yaml {
    line = $0
    sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^(SLACK_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) { n = line; sub(/=.*/, "", n); if (!off(value(line))) on[n] = 1 }
    if (line ~ /^SLACK_ALLOW_BOTS=/) { v = tolower(value(line)); gsub(/[[:space:]]/, "", v); if (!off(v) && v != "none") on["SLACK_ALLOW_BOTS"] = 1 }
    if (line ~ /^GATEWAY_ALLOWED_USERS=/) { if (value(line) ~ /\*/) on["GATEWAY_ALLOWED_USERS"] = 1 }
  }
  yaml {
    line = $0
    sub(/[[:space:]]+#.*$/, "", line)
    if (line ~ /^[[:space:]]*(allow_all_users|allow_bots)[[:space:]]*:/) {
      k = line; sub(/^[[:space:]]*/, "", k); sub(/[[:space:]]*:.*$/, "", k)
      v = line; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/[\"\047[:space:]]/, "", v)
      if (k == "allow_all_users") { if (!off(v)) on["config.yaml:allow_all_users"] = 1 }
      else if (!off(v) && tolower(v) != "none") on["config.yaml:allow_bots"] = 1
    }
  }
  END { for (n in on) print n }' "$f" "$y"
REMOTE
}

# slack_connected: read `hermes logs gateway` text on stdin; succeed only when the LATEST lines show Slack connected: the
# gateway's own "slack connected" line AND the adapter's "[Slack] Socket Mode connected" line, with no failure line after them.
slack_connected() {
  awk '
    { l = tolower($0) }
    l ~ /starting.hermes.gateway/ { gw = 0; ad = 0 }
    l ~ /slack (connected|reconnected successfully)[[:space:]]*$/ { gw = 1 }
    l ~ /\[slack\] socket mode connected/ { ad = 1 }
    l ~ /\[slack\] (connection failed|slack_[a-z_]+ not set|slack-bolt not installed|disconnected)/ { ad = 0 }
    l ~ /slack (connected \(degraded\)|failed to connect|error:|disconnected)/ { gw = 0; ad = 0 }
    END { exit !(gw && ad) }'
}
```

Rules for calling them: a failure BEFORE `snapshot` (Steps 1-4) is `exit 1` with "Nothing was written" and never calls
`rollback`. Every failure AFTER `snapshot` (Steps 5-9) is `rollback; exit 1`. `finish` runs last. `rollback` RESTORES the
previous `~/.hermes/.env` and `config.yaml` byte for byte (a file that did not exist is removed again), reloads the
gateway with `gw_reload`, and only then retires the snapshot.

**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires
`gw_ready`, which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id`
than before. Why this shape (source-verified, not live-verified):

- `gateway restart` restarts the installed systemd/launchd service, or, with no service, stops the profile's gateway and
  runs the replacement **in the calling shell**; `--detach` starts it in the background the way `ensure` does, so an ssh call
  cannot hang (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`,
  `hermes_cli/gateway_runtime_start.py:86-97`).
- With live sessions it asks y/N on a TTY and **refuses with exit 1 without one**; `-y`/`--yes` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:97-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y`
  on its own: set `GW_INTERRUPT=1` only when interrupting live chats is acceptable. Do not use `--force` or `--all` to evade a refusal.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the
  gateway is ready (5 deadline/starting, 6 draining, 3 incompatible, 4 authorization, 7 conflict)
  (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`). `instance_id` is a fresh uuid per gateway
  process (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is never used as a health check.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of
  scope. `gateway run` is the foreground command; there is no `--daemon` flag.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS host

This skill writes the HOST's `~/.hermes/.env`, so `hermes` must be installed on the host (a container-only install is not supported).

```bash
HERMES_BANNER=$(remote '
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  hermes -p default --version') \
  || { echo "ABORT: Hermes is not installed on the host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (`HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked against the v0.22.5
source; it has not been run against a live host.

---

## Step 2 — idempotency check (skip if already wired)

Skip setup only when both stored tokens and the numeric allowlist are each defined once, `.env` is private, no open-access
setting exists in `.env` or `config.yaml`, and `platforms.slack.enabled` is not an explicit `false`. An unsafe existing setup
aborts instead of being reported as wired. The check prints a status only, never a stored value.

```bash
if [ "${FORCE:-0}" != "1" ]; then
  STATE=$(remote 'bash -s' <<'REMOTE'
f=$HOME/.hermes/.env
if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo needs_setup; exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || { echo unsafe; exit 0; }
mode=$(stat -c %a "$f" 2>/dev/null) || mode=$(stat -f %Lp "$f" 2>/dev/null) || exit 1
[ "$mode" = 600 ] || { echo unsafe; exit 0; }
awk '
  function value(s) {
    sub(/^[^=]*=/, "", s)
    sub(/\r$/, "", s)
    if (length(s) >= 2) {
      q = substr(s, 1, 1)
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s) - 2)
    }
    return s
  }
  function ids_ok(s, re, lo, hi,    n, i, a) {
    n = split(s, a, ",")
    if (s == "" || n < 1) return 0
    for (i = 1; i <= n; i++) if (a[i] !~ re || length(a[i]) < lo || length(a[i]) > hi) return 0
    return 1
  }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^SLACK_BOT_TOKEN=/) { bots++; bot = value(line) }
    if (line ~ /^SLACK_APP_TOKEN=/) { apps++; app = value(line) }
    if (line ~ /^SLACK_ALLOWED_USERS=/) { lists++; users = value(line) }
  }
  END {
    if (bots == 0 || apps == 0 || lists == 0) print "needs_setup"
    else if (bots > 1 || apps > 1 || lists > 1) print "unsafe"
    else if (bot !~ /^xoxb-[A-Za-z0-9-]+$/ || app !~ /^xapp-[A-Za-z0-9-]+$/) print "needs_setup"
    else if (!ids_ok(users, "^[UW][A-Z0-9]+$", 9, 15)) print "unsafe"
    else print "safe"
  }' "$f"
REMOTE
) || { echo "ABORT: could not check the stored Slack setup. Nothing was written."; exit 1; }
  if [ "$STATE" = safe ]; then
    OPEN=$(open_access_names) || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
    [ -z "$OPEN" ] || STATE=unsafe
  fi
  if [ "$STATE" = safe ]; then
    case $(remote "hermes -p default config get platforms.slack.enabled 2>/dev/null || true" | tr 'A-Z' 'a-z') in
      false*|no*|off*|0*) STATE=needs_setup ;;
    esac
  fi
  case "$STATE" in
    safe) echo "Slack already wired. Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Slack setup is unsafe (check the file mode, duplicate keys, the member-ID allowlist and open-access settings). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE: validate everything BEFORE anything is written

Two blocks, both before `snapshot` and before the dry run. If either fails, nothing has touched the VPS.

**3a. Local checks (no network, no ssh).** Normalise the lists, then reject empty values and anything that could break a
curl config line or a `.env` line, and check each token's documented prefix.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
bool_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' \t\r\n'; }
SLACK_ALLOWED_USERS=$(printf '%s' "${SLACK_ALLOWED_USERS:-}" | csv_clean)
SLACK_HOME_CHANNEL=$(printf '%s' "${SLACK_HOME_CHANNEL:-}" | csv_clean)
SLACK_REQUIRE_MENTION=$(bool_norm "${SLACK_REQUIRE_MENTION:-}")

if [ -z "$SLACK_ALLOWED_USERS" ]; then
  echo "ABORT: SLACK_ALLOWED_USERS is empty. This skill never enables Slack without an explicit per-user allowlist."
  echo "Supply your member ID (starts with U or W): click your name, View full profile, more, Copy member ID. Nothing was written."
  exit 1
fi
# A wildcard anywhere in the allowlist ("*", "U012ABCDE3F,*") would open the bot to the whole workspace.
case "$SLACK_ALLOWED_USERS" in
  *'*'*) echo "ABORT: SLACK_ALLOWED_USERS contains a wildcard (*). That would let anyone in the workspace use the bot. Nothing was written."; exit 1 ;;
esac

# check_ids NAME VALUE REGEX: every comma-separated entry must match REGEX.
check_ids() {
  local bad
  bad=$(printf '%s' "$2" | tr ',' '\n' | grep -vE "$3" | cut -c1-24 || true)
  if [ -n "$bad" ]; then
    echo "ABORT: invalid entries in $1:"
    echo "$bad"
    echo "Expected Slack IDs in capital letters and digits, no @handles. Nothing was written."
    return 1
  fi
}
check_ids SLACK_ALLOWED_USERS "$SLACK_ALLOWED_USERS" '^[UW][A-Z0-9]{8,14}$' || exit 1
if [ -n "$SLACK_HOME_CHANNEL" ]; then
  check_ids SLACK_HOME_CHANNEL "$SLACK_HOME_CHANNEL" '^[CGD][A-Z0-9]{8,14}$' || exit 1
  case "$SLACK_HOME_CHANNEL" in *,*) echo "ABORT: SLACK_HOME_CHANNEL takes ONE channel ID. Nothing was written."; exit 1 ;; esac
fi
case "$SLACK_REQUIRE_MENTION" in ""|true|false) ;; *) echo "ABORT: SLACK_REQUIRE_MENTION must be true or false. Nothing was written."; exit 1 ;; esac

# Token shape. The charset check also guarantees no quote, comma, backslash or newline can reach the curl config
# (a comma-separated list of bot tokens, which Hermes accepts for several workspaces, is refused on purpose).
token_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9-]*) return 1 ;; esac
  return 0
}
token_chars_ok "${SLACK_BOT_TOKEN:-}" \
  || { echo "ABORT: SLACK_BOT_TOKEN is empty or has characters a Slack token never has (spaces, quotes, commas, newline). Nothing was written."; exit 1; }
case "$SLACK_BOT_TOKEN" in xoxb-*) ;; *)
  echo "ABORT: SLACK_BOT_TOKEN must start with xoxb- (OAuth & Permissions, Bot User OAuth Token), not a user token or the app-level token. Nothing was written."; exit 1 ;;
esac
token_chars_ok "${SLACK_APP_TOKEN:-}" \
  || { echo "ABORT: SLACK_APP_TOKEN is empty or has characters a Slack token never has (spaces, quotes, commas, newline). Nothing was written."; exit 1; }
case "$SLACK_APP_TOKEN" in xapp-*) ;; *)
  echo "ABORT: SLACK_APP_TOKEN must start with xapp- (Basic Information, App-Level Tokens; Socket Mode needs it, not the signing secret). Nothing was written."; exit 1 ;;
esac
```

**3b. Open access on the VPS, then the live Slack checks, run FROM the VPS** (this also proves its egress works). The bot token
is checked with `auth.test` and the app-level token with `apps.connections.open`, the call Socket Mode itself makes to obtain
its WebSocket URL; it returns a single-use URL that is never printed. Slack answers HTTP 200 with `{"ok":false,"error":...}` for a
bad token, so the body is checked, not the status. Each token travels over ssh STDIN as a curl config.

```bash
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)), so people outside the per-user allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

AUTH=$(printf 'header = "Authorization: Bearer %s"\n' "$SLACK_BOT_TOKEN" \
  | remote "curl -fsS --max-time 15 -X POST --config - 'https://slack.com/api/auth.test'" 2>/dev/null) || AUTH=""
if [ "$(printf '%s' "$AUTH" | json_field ok)" != true ]; then
  ERR=$(printf '%s' "$AUTH" | json_field error | tr -cd 'a-z_'); ERR=${ERR:-no answer}
  echo "ABORT: Slack auth.test (run from the VPS) did not accept the bot token ($ERR), or the VPS cannot reach slack.com. Re-copy the Bot User OAuth Token after installing the app. Nothing was written."
  exit 1
fi
TEAM_ID=$(printf '%s' "$AUTH" | json_field team_id | tr -cd 'A-Z0-9')
TEAM_NAME=$(printf '%s' "$AUTH" | json_field team | tr -cd 'A-Za-z0-9._ -')
BOT_NAME=$(printf '%s' "$AUTH" | json_field user | tr -cd 'A-Za-z0-9._ -')

CONN=$(printf 'header = "Authorization: Bearer %s"\n' "$SLACK_APP_TOKEN" \
  | remote "curl -fsS --max-time 15 -X POST --config - 'https://slack.com/api/apps.connections.open'" 2>/dev/null) || CONN=""
if [ "$(printf '%s' "$CONN" | json_field ok)" != true ]; then
  ERR=$(printf '%s' "$CONN" | json_field error | tr -cd 'a-z_'); ERR=${ERR:-no answer}
  echo "ABORT: Slack apps.connections.open (run from the VPS) did not accept the app token ($ERR). The app-level token needs the connections:write scope and Socket Mode must be enabled (Settings, Socket Mode). Nothing was written."
  exit 1
fi
echo "Slack accepted both tokens: bot @${BOT_NAME:-unknown} in workspace ${TEAM_NAME:-unknown}."
remote 'test ! -e "$HOME/.hermes/slack_tokens.json"' \
  || echo "WARN: ~/.hermes/slack_tokens.json exists, so Hermes also serves the workspaces saved there, all under the allowlist you are about to write."
```

If you have no `python3` locally, `json_field` falls back to `sed` (it reads the flat Slack answers correctly).

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$SLACK_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token prefixes, allowlist, open-access scan, live auth.test (bot) and apps.connections.open (app); nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write SLACK_ALLOWED_USERS ($USERS_N member(s)) with 'hermes -p default config set' (value over ssh stdin)
  3. Write SLACK_HOME_CHANNEL (${SLACK_HOME_CHANNEL:-none}) if supplied
  4. Write SLACK_APP_TOKEN (length ${#SLACK_APP_TOKEN}), then SLACK_BOT_TOKEN (length ${#SLACK_BOT_TOKEN}) LAST, over ssh stdin; chmod 600; verify each key exists once (counts only)
  5. config.yaml: slack.require_mention=${SLACK_REQUIRE_MENTION:-unchanged}, platforms.slack.enabled=true
  6. Reload: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
  7. Verify: both tokens read back from ~/.hermes/.env still work; gateway log shows Slack connected (30s)
  8. If a home channel was given: hermes -p default send --to slack sends ONE short test message to it
  9. hermes -p default pairing list (read-only). This skill never approves a pairing code.

The tokens are NEVER printed in plaintext.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write (allowlist first, bot token LAST), then verify

The allowlist goes in before the tokens because the bot token is what makes Hermes turn Slack on. Each value travels as one
line on ssh stdin and is read by `read -r` on the VPS; the output of `hermes -p default config set` is discarded so Hermes
can never echo a value into chat.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put SLACK_ALLOWED_USERS "$SLACK_ALLOWED_USERS" \
  || { echo "FAIL: could not write SLACK_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$SLACK_HOME_CHANNEL" ]; then
  put SLACK_HOME_CHANNEL "$SLACK_HOME_CHANNEL" \
    || { echo "FAIL: could not write SLACK_HOME_CHANNEL."; rollback; exit 1; }
fi
put SLACK_APP_TOKEN "$SLACK_APP_TOKEN" \
  || { echo "FAIL: could not write SLACK_APP_TOKEN."; rollback; exit 1; }
put SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN" \
  || { echo "FAIL: could not write SLACK_BOT_TOKEN."; rollback; exit 1; }
```

`config set` routes an UPPER_SNAKE name to `~/.hermes/.env` and never echoes the value (`hermes_cli/config.py:3417-3440`). Verify
(counts and the non-secret allowlist only, then the open-access scan again, because a write must not have introduced one):

```bash
KEYS="SLACK_ALLOWED_USERS SLACK_APP_TOKEN SLACK_BOT_TOKEN"
[ -z "$SLACK_HOME_CHANNEL" ] || KEYS="$KEYS SLACK_HOME_CHANNEL"
for k in $KEYS; do
  n=$(remote "grep -c '^$k=.' ~/.hermes/.env || true")
  [ "$n" = "1" ] || { echo "FAIL: $k is not in ~/.hermes/.env exactly once (found ${n:-0}). Rolling back."; rollback; exit 1; }
done
GOT_USERS=$(remote 'sed -n "s/^SLACK_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
[ "$GOT_USERS" = "$SLACK_ALLOWED_USERS" ] \
  || { echo "FAIL: the stored allowlist differs from the one supplied. Rolling back."; rollback; exit 1; }
case "$GOT_USERS" in *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;; esac
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Slack secrets confirmed in ~/.hermes/.env."
```

Never put a Slack token in `config.yaml`, never `echo >> .env`.

---

## Step 6 — behaviour key and the enable flag (only after Step 5 passed)

`slack.require_mention` is a known `config.yaml` key (`hermes_cli/config_defaults.py:1543-1544`); `hermes config set` coerces
`true`/`false` to a boolean. It is written only when you supplied a value. `platforms.slack.enabled true` removes the
explicit-disable trap described above.

```bash
if [ -n "$SLACK_REQUIRE_MENTION" ]; then
  remote "hermes -p default config set slack.require_mention $SLACK_REQUIRE_MENTION >/dev/null" \
    || { echo "FAIL: could not set slack.require_mention."; rollback; exit 1; }
fi
remote "hermes -p default config set platforms.slack.enabled true >/dev/null" \
  || echo "WARN: could not set platforms.slack.enabled. This is a WARN on purpose: Hermes enables Slack from the bot token unless config.yaml disables it, and Step 8 will show whether Slack connected."
```

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a
new `instance_id`. A refusal because of live sessions is reported, not overridden.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify Slack is connected (tokens read back, then the log, 30s)

Two checks. (1) Both tokens PERSISTED: they are read back from `~/.hermes/.env` on the VPS (the non-interactive ssh shell never
loads that file) and Slack must accept them again, with the same workspace. (2) The gateway log shows Slack connected.
`slack_connected` (Step 0) needs BOTH the gateway's own line (`✓ slack connected`, `gateway/run_startup.py:1352`; a `(degraded)`
suffix does not count) AND the adapter's `[Slack] Socket Mode connected (N workspace(s))` line (`adapter.py:1844`), and a failure,
disconnect or fresh `Starting Hermes Gateway...` line after them cancels the verdict (`adapter.py:1795,1848,1927`,
`gateway/run_startup.py:1335,1355,1645`, `gateway/run_adapters.py:135`). Note that Socket Mode connection is asynchronous, so a
`Socket Mode connected` line is the adapter's own claim; the first real DM is the final proof (Step 9). Hermes writes these lines
to `gateway.log` (`hermes_logging.py:306-311,399`), which `hermes logs gateway` prints.

```bash
BACK=$(remote 'bash -s' <<'REMOTE' 2>/dev/null
v=$(sed -n 's/^SLACK_BOT_TOKEN=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
a=$(sed -n 's/^SLACK_APP_TOKEN=//p' ~/.hermes/.env | tail -n1)
a=${a#\"}; a=${a%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" | curl -fsS --max-time 15 -X POST --config - 'https://slack.com/api/auth.test' || exit 1
printf 'header = "Authorization: Bearer %s"\n' "$a" | curl -fsS --max-time 15 -X POST --config - 'https://slack.com/api/apps.connections.open' >/dev/null || exit 1
REMOTE
) || BACK=""
if [ "$(printf '%s' "$BACK" | json_field ok)" != true ] || { [ -n "$TEAM_ID" ] && [ "$(printf '%s' "$BACK" | json_field team_id)" != "$TEAM_ID" ]; }; then
  echo "FAIL: the Slack checks with the tokens stored on the VPS did not succeed for workspace ${TEAM_ID:-unknown}. Rolling back."
  rollback; exit 1
fi

CONNECTED=0
for i in 1 2 3 4 5 6; do
  LOG=$(remote "hermes -p default logs gateway -n 300 2>&1") || LOG=""
  if printf '%s\n' "$LOG" | slack_connected; then
    CONNECTED=1
    echo "OK: Slack connected (workspace ${TEAM_NAME:-unknown})."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Slack was not confirmed connected in the gateway log within 30s (needs the gateway's connected line AND the adapter's Socket Mode connected line, with no failure after them). Rolling back."; rollback; exit 1; }
```

---

## Step 9 — smoke test, pairing view, finish

With a home channel, the native `hermes send --to slack` posts one short message there without an agent turn
(`hermes_cli/send_cmd.py:194-240`; a home channel is the default target; Slack ID forms `plugins/platforms/slack/send_targets.py:7-22`).
The bot must be a member of that channel (`/invite @YourBot`). Without a home channel nothing is sent and the human step below is
the smoke test. `hermes pairing list` is read-only.

```bash
if [ -n "$SLACK_HOME_CHANNEL" ]; then
  remote "hermes -p default send --to slack 'hstack setup check: Hermes is connected to Slack. No reply is needed.'" \
    || { echo "FAIL: hermes send --to slack failed (is the bot invited to the home channel?). Rolling back."; rollback; exit 1; }
else
  echo "No home channel was given, so no test message was sent. Type /sethome (or /hermes sethome) in a channel to set one."
fi
remote "hermes -p default pairing list" || true
finish || exit 1
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/platform-slack.prev` for a manual undo.

The human smoke test (a machine cannot do this): from an allowlisted account, open a DM with the bot (Apps sidebar), send
`ping` and expect a reply within a few seconds. In a channel, @mention the bot after `/invite @YourBot`. If there is none:

```bash
# Redact first: keep any token-shaped text out of what you show.
remote "hermes -p default logs gateway -n 50 2>&1" \
  | sed -E 's#(xox[a-z]-|xapp-)[A-Za-z0-9-]+#\1<redacted>#g' | grep -i slack | tail -20 || true
```

- Works in DMs but silent in channels: the `message.channels` / `message.groups` event subscriptions or the `channels:history` /
  `groups:history` scopes are missing (reinstall after changing them), or the bot was not invited, or you did not @mention it.
- "Sending messages to this app has been turned off": enable App Home, Messages Tab (`slack.md:160-173`).
- The log says `invalid_auth` or `not_authed`: a token was revoked or the app was reinstalled; copy the new `xoxb-` token and re-run with `FORCE=1`.
- The log says `SLACK_APP_TOKEN not set`: the app-level token did not load; check Step 5.

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in Step 0. It restores and verifies the pre-run `~/.hermes/.env` and `config.yaml` from the active
snapshot, reloads the gateway with `gw_reload`, and only then retires the snapshot. If the files were restored but the gateway
did not come back ready it prints `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero:
inspect `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A
restart refused because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.
There is no second, hand-written undo and no full "wipe" function: the snapshot restore IS the undo. A failed `FORCE=1`
re-run therefore gets its previous tokens and allowlist back, and a failed first run removes the files it created.

Failures in Steps 1-4 wrote nothing. If a run is interrupted after `snapshot`, the next `snapshot` refuses; call `rollback` first.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including old secrets) at mode 600; delete it once you no longer need the undo.
Removing Slack for good is a separate decision (unset the `SLACK_*` keys with `hermes -p default config unset`, then `gw_reload`);
this skill does not ship a wipe.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Writing only the bot token | The bot token alone enables Slack, but without `SLACK_APP_TOKEN` the adapter logs a permanent error and never connects | Step 3 checks both tokens; Step 5 writes both |
| 2 | An app-level token without `connections:write`, or Socket Mode off | `apps.connections.open` fails; Hermes cannot open the WebSocket | Step 3b calls it and aborts with the Slack error code |
| 3 | A signing secret in `SLACK_APP_TOKEN` | The signing secret is for the HTTP Events API, not Socket Mode | Step 3a requires the `xapp-` prefix; nothing asks for a signing secret |
| 4 | Treating Slack's HTTP 200 as success | Slack answers 200 with `"ok":false` for a bad token | The body's `ok` field is what is checked |
| 5 | A user token (`xoxp-`) in the bot slot | Messages from that person would look like bot mentions | Step 3a requires `xoxb-` |
| 6 | Writing `SLACK_ENABLED=true` | No such variable exists; the bot token enables Slack, only `platforms.slack.enabled: false` disables it | Step 6 sets the config flag; nothing writes `SLACK_ENABLED` |
| 7 | An allowlist with `@handle`, a name or `*` | The allowlist is exact member IDs; `*` is open access | Step 3a accepts `U`/`W` IDs only and refuses `*` |
| 8 | `SLACK_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS`, `allow_all_users: true`, `SLACK_ALLOW_BOTS` | They admit senders outside the allowlist | Step 3b scans `.env` and `config.yaml` (names only), Step 5 re-checks after the write |
| 9 | Approving a pairing code seen in a log or a DM | `pairing approve` grants access to whoever sent it | The skill never runs `pairing approve`; `pairing list` is read-only |
| 10 | Bot not invited to a channel | It cannot read or post there; the `hermes send` smoke test fails | `/invite @YourBot` in every channel (a human step) |
| 11 | Missing event subscriptions or scopes | Works in DMs, silent in channels; Slack never delivers the events | Human checklist above; reinstall after changing scopes |
| 12 | Home channel given as `#name` | Hermes needs the channel ID | Step 3a requires `C`, `G` or `D` plus capitals and digits |
| 13 | Several workspaces | `slack_tokens.json` adds workspaces under the same allowlist; Slack user IDs are workspace-local | Step 3b warns when the file exists; this skill takes one `xoxb-` token |
| 14 | Treating the first matching log line as success | A later disconnect or an old line from the previous process would pass | `slack_connected` needs the gateway line AND the adapter line and honours later failures |
| 15 | Starting the gateway with the foreground `gateway run`, adding a daemon flag, or grepping `gateway status` text | `run` blocks the ssh call, the daemon flag does not exist (argparse exit 2), "✗ Gateway is not running" contains "running" | `gw_reload` / `gw_ready` only |
| 16 | A token in an ssh argument, a URL, or a single-quoted remote string | Leaks into `ps`; breaks on odd characters | Tokens go over ssh stdin (curl `--config -`, `read -r`) |
| 17 | `config set KEY value` shows the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` there at that moment sees it (the local ssh argv stays clean) | Accepted; the output is discarded so Hermes never echoes it into chat |
| 18 | Re-running after a crashed run | A leftover `~/.hermes/.hstack-backup/platform-slack` would record half-written files as known-good | `snapshot` refuses; run `rollback`, then re-run |
| 19 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run the Step 0 block first |
| 20 | GNU-only flags in LOCAL commands | macOS ships bash 3.2 / BSD tools | GNU flags stay inside `remote` strings (the VPS is Linux) |
| 21 | Container-only Hermes | This skill writes the host's `~/.hermes` | Step 1 requires `hermes` on the host and aborts otherwise |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded and the Step 0 helpers are defined in this shell
- [ ] Hermes on the VPS host reports `0.22.5`
- [ ] Idempotency check ran (skipped only for a safe stored setup, unless `FORCE=1`)
- [ ] Hard gate passed with nothing written: member-ID allowlist (no `*`), `xoxb-` and `xapp-` prefixes, no open-access setting in `.env` or `config.yaml`
- [ ] Live Slack checks from the VPS accepted the bot token (`auth.test`) and the app token (`apps.connections.open`)
- [ ] Dry run shown and approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `SLACK_ALLOWED_USERS` written before the tokens, bot token last; each key is in `~/.hermes/.env` exactly once, mode 600; no token in `config.yaml`
- [ ] `platforms.slack.enabled` set only after the writes were verified (no `SLACK_ENABLED` variable)
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] Both tokens read back from `~/.hermes/.env` were accepted by Slack, and `slack_connected` confirmed the connection in the gateway log
- [ ] If a home channel was given, `hermes send --to slack` succeeded; `pairing list` was viewed and nothing was approved
- [ ] `finish` ran; any failure after the snapshot ran `rollback` and restored the previous `.env` and `config.yaml`
- [ ] Human steps: the bot was invited to its channels, and an allowlisted member DM'd it and got a reply

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and Slack failure modes.

---

## Verified against Hermes v0.22.5

Read in the Hermes source at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository.

- Env names and enabling: `plugins/platforms/slack/gateway_env.py:6-32` (`SLACK_BOT_TOKEN` enables; `SLACK_HOME_CHANNEL`; allowlist
  `SLACK_ALLOWED_USERS`, allow-all `SLACK_ALLOW_ALL_USERS`, `SLACK_ALLOW_BOTS`), `plugins/platforms/slack/plugin.yaml`,
  `gateway/platform_env.py:132-179`, explicit disable `gateway/config_env.py:84-109`.
- Both tokens are needed at connect: `plugins/platforms/slack/adapter.py:1792-1797,1854-1862`; connected and failure lines
  `adapter.py:1779,1795,1844,1848,1927`; several workspaces `adapter.py:6523-6554`; token-type warning `adapter.py:1584-1600`;
  dashboard prefix rules `plugins/platforms/slack/dashboard_card.py:8-22` (`xoxb-`, `xapp-`, member IDs `[UW][A-Z0-9]`).
- Authorization: `gateway/authz_mixin.py:631-714` (order, `*` at `:714`, `GATEWAY_ALLOW_ALL_USERS` only when no allowlist at `:687-694`),
  unauthorized-DM default `:716-759`, startup warning `gateway/run_startup.py:1049-1058`, YAML `allow_all_users` bridge
  `gateway/config_loader.py:430-462`, Slack env-only fallback `adapter.py:5502-5517`, bots `adapter.py:2856-2863`.
- Behaviour keys: `hermes_cli/config_defaults.py:1543-1553`; `adapter.py:6363-6370`; YAML bridge `adapter.py:6896-6911`; `hermes config set`
  env routing `hermes_cli/config.py:3417-3440`.
- Log lines used by `slack_connected`: `gateway/run_startup.py:1335,1352,1355,1645`, `gateway/run_adapters.py:135,925`; log files
  `hermes_logging.py:306-311,399`; `hermes logs` parser `hermes_cli/subcommands/logs.py`.
- `hermes send` and `hermes pairing`: `hermes_cli/send_cmd.py:194-262`, `plugins/platforms/slack/send_targets.py:7-22`,
  `hermes_cli/subcommands/pairing.py`, `hermes_cli/pairing.py:22-68`.
- Human setup (scopes, events, Socket Mode, Messages tab, member IDs, invite): `website/docs/user-guide/messaging/slack.md:30-252`.
- Gateway lifecycle: the sources listed in the lifecycle note under Step 0.

Not verified, and not claimed: nothing in this skill was run against a real Hermes, a real VPS, or Slack (the tests use a stub whose
command syntax is the real v0.22.5 argparse and whose behaviour is an assumption). The Slack calls `auth.test` and
`apps.connections.open` and their `{"ok":...}` answers come from Slack's published Web API, not from Hermes (Hermes' adapter calls
`auth.test` through slack_sdk at `adapter.py:1766`, and Socket Mode opens its own connection through slack_bolt); no call was
made here. Whether Slack counts a preflight `apps.connections.open` against any limit was not checked. The exact text and timestamps of a
real `gateway.log` were not observed. `hermes send --to slack` through the home channel was read, not exercised.
