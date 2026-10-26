---
name: platform-discord
description: "Wire a remote Hermes Agent v0.22.5 to Discord (bot token, Message Content intent, numeric user-ID allowlist) over SSH. Checks the token and intents against Discord from the VPS before any write, refuses open access, reloads the gateway natively, verifies the adapter's own connected log line and rolls back to the previous values on any failure."
---

# /platform-discord — wire Discord to a remote Hermes (SSH-first)

You are the engineer connecting Discord to a self-hosted Hermes Agent on the user's VPS. The agent
(Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) works over SSH as root. The user does
four things a machine cannot:

1. Create the application and its bot in the Discord Developer Portal and copy the bot token (shown once).
2. Switch on **Message Content Intent** (Bot page, Privileged Gateway Intents) and save.
3. Open the invite link (this skill prints it) and add the bot to their server.
4. Copy their own numeric Discord user ID (Settings, Advanced, Developer Mode, right-click yourself, Copy User ID).

Everything else — the live token and intent check, the allowlist gate, token storage, gateway reload, the
connection check, the optional test message — runs on the VPS over SSH, with a snapshot and rollback.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and
reaches the VPS through `remote()` from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on
the remote PATH. The bot token is generated or pasted locally, format-checked locally, and travels to the VPS only
over ssh STDIN (a curl `--config -` for the Discord check, a `read -r` for the write), never in an ssh argument, a
URL on a command line or a quoted remote string. Run all blocks in ONE shell session.

**Honest picture (source-verified against Hermes v0.22.5, not run against a live Hermes or Discord).**

- **The token enables the platform.** Hermes turns Discord on when `DISCORD_BOT_TOKEN` is present. There is no
  `DISCORD_ENABLED` variable (`plugins/platforms/discord/gateway_env.py:6-12`). The only off switch is an explicit
  `platforms.discord.enabled: false` in `config.yaml`, which beats the credential and is only logged once
  (`gateway/config_env.py:84-109`). This skill therefore sets `platforms.discord.enabled true` after the secrets
  are verified, so an old explicit disable cannot silently keep the bot dark.
- **Message Content Intent is mandatory, Server Members is not.** The adapter always requests the Message Content
  intent; if it is off in the Portal, Discord refuses the connection and Hermes records a non-retryable
  `discord_intents_required` error (`adapter.py:1467,1659-1668`). The Server Members intent is requested only for
  username or role allowlists (`adapter.py:405-412`); this skill accepts numeric IDs only, so it is not needed.
- **An empty allowlist is not fail-open at v0.22.5, but this skill still refuses it.** With no allowlist and no
  allow-all switch, Discord messages are denied and one warning is logged (`adapter.py:4122-4139,4178-4194`). Two
  things can still let strangers in: a pairing approval (`hermes pairing approve`), and `DISCORD_ALLOWED_CHANNELS`,
  which admits anyone speaking in the listed server channels when no user or role allowlist exists
  (`adapter.py:4133-4138`). The old text of this skill claimed an empty list "fails open"; that is not what the
  source does. The hard gate stays because a per-user allowlist is the one explicit, auditable grant, and because
  `*`, `DISCORD_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS`, `DISCORD_ALLOW_BOTS` and role grants (checked here in
  `.env` and `config.yaml`) would make it meaningless (`gateway/authz_mixin.py:631-714`, `adapter.py:1687,4141`).
- **Defaults differ from the old text.** Channel messages need an @mention by default and each mention opens a
  thread (`discord.require_mention: true`, `discord.auto_thread: true`, `hermes_cli/config_defaults.py:1555-1559`).
  DMs are never mention-gated (`adapter.py:6127-6160`). Both are optional inputs below, written through
  `hermes config set discord.*` (no hand-edited YAML).
- **A pairing code is not an approval.** Because an allowlist is set, unknown senders get no pairing code
  (`allowlist_suppresses_pairing`, `gateway_env.py:20`, `authz_mixin.py:753-759`). This skill never runs
  `hermes pairing approve`: that command grants access to whoever holds the code, so it is a decision for the
  human (`hermes_cli/pairing.py:56-68`).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$DISCORD_BOT_TOKEN` | Bot token (three dot-separated parts), NOT the numeric application ID | Developer Portal, your application, Bot, Reset Token |
| `$DISCORD_ALLOWED_USERS` | Comma-separated numeric Discord user IDs (17-20 digits). Hermes also accepts usernames, which needs the Server Members intent; this skill takes IDs only | Developer Mode on, right-click a user, Copy User ID |
| `$DISCORD_HOME_CHANNEL` *(optional)* | Channel ID that receives cron output and `hermes send --to discord`. Without it nothing is sent here and you can type `/sethome` in a channel later | Right-click the channel, Copy Channel ID |
| `$DISCORD_AUTO_THREAD` *(optional)* | `true` or `false`. Hermes default is `true`: each @mention in a server channel opens a thread. Only written when you set it | |
| `$DISCORD_REQUIRE_MENTION` *(optional)* | `true` or `false`. Hermes default is `true`: server channels need an @mention (DMs never do). Only written when you set it | |
| `FORCE=1` *(optional)* | Rewire even if Discord already looks wired | |
| `GW_INTERRUPT=1` *(optional)* | Allow the gateway restart to interrupt live chats. Never set by default | |

If `$DISCORD_ALLOWED_USERS` is empty the skill stops in Step 3 and writes nothing.

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
SKILL_NAME=platform-discord
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

# ---- platform-discord helpers (the six functions above are the shared lifecycle helpers) ----

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
  FNR == 1 { yaml = (FILENAME ~ /config\.yaml$/); pend = 0 }
  !yaml {
    line = $0
    sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^(DISCORD_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) { n = line; sub(/=.*/, "", n); if (!off(value(line))) on[n] = 1 }
    if (line ~ /^DISCORD_ALLOW_BOTS=/) { v = tolower(value(line)); gsub(/[[:space:]]/, "", v); if (!off(v) && v != "none") on["DISCORD_ALLOW_BOTS"] = 1 }
    if (line ~ /^DISCORD_ALLOWED_ROLES=/) { v = value(line); gsub(/[[:space:]]/, "", v); if (v != "") on["DISCORD_ALLOWED_ROLES"] = 1 }
    if (line ~ /^GATEWAY_ALLOWED_USERS=/) { if (value(line) ~ /\*/) on["GATEWAY_ALLOWED_USERS"] = 1 }
  }
  yaml {
    line = $0
    sub(/[[:space:]]+#.*$/, "", line)
    if (pend) { if (line ~ /^[[:space:]]*-/) on["config.yaml:allowed_roles"] = 1; if (line !~ /^[[:space:]]*$/) pend = 0 }
    if (line ~ /^[[:space:]]*(allow_all_users|allow_bots|allowed_roles)[[:space:]]*:/) {
      k = line; sub(/^[[:space:]]*/, "", k); sub(/[[:space:]]*:.*$/, "", k)
      v = line; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/[\"\047[:space:]]/, "", v)
      if (k == "allow_all_users") { if (!off(v)) on["config.yaml:allow_all_users"] = 1 }
      else if (k == "allow_bots") { if (!off(v) && tolower(v) != "none") on["config.yaml:allow_bots"] = 1 }
      else if (v == "") pend = 1
      else if (v != "[]" && v != "{}") on["config.yaml:allowed_roles"] = 1
    }
  }
  END { for (n in on) print n }' "$f" "$y"
REMOTE
}

# dc_connected: read `hermes logs gateway` text on stdin; succeed only when the LATEST lines show Discord connected: the
# gateway's own "discord connected" line AND the adapter's "[Discord] Connected as ..." line, with no failure line after them.
dc_connected() {
  awk '
    { l = tolower($0) }
    l ~ /starting.hermes.gateway/ { gw = 0; ad = 0 }
    l ~ /discord (connected|reconnected successfully)[[:space:]]*$/ { gw = 1 }
    l ~ /\[discord\] connected as / { ad = 1 }
    l ~ /\[discord\] (failed to connect|timeout waiting|disconnected|no bot token|discord gateway task exited|discord\.py not installed)/ { ad = 0 }
    l ~ /discord (connected \(degraded\)|failed to connect|error:|disconnected)/ { gw = 0; ad = 0 }
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

Skip setup only when the stored token and numeric allowlist are each defined once, `.env` is private, no open-access setting
exists in `.env` or `config.yaml`, and `platforms.discord.enabled` is not an explicit `false`. An unsafe existing setup aborts
instead of being reported as wired. The check prints a status only, never a stored value.

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
    if (line ~ /^DISCORD_BOT_TOKEN=/) { tokens++; token = value(line) }
    if (line ~ /^DISCORD_ALLOWED_USERS=/) { lists++; users = value(line) }
  }
  END {
    if (tokens == 0 || lists == 0) print "needs_setup"
    else if (tokens > 1 || lists > 1) print "unsafe"
    else if (token ~ /^[0-9]+$/ || token !~ /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/) print "needs_setup"
    else if (!ids_ok(users, "^[0-9]+$", 17, 20)) print "unsafe"
    else print "safe"
  }' "$f"
REMOTE
) || { echo "ABORT: could not check the stored Discord setup. Nothing was written."; exit 1; }
  if [ "$STATE" = safe ]; then
    OPEN=$(open_access_names) || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
    [ -z "$OPEN" ] || STATE=unsafe
  fi
  if [ "$STATE" = safe ]; then
    case $(remote "hermes -p default config get platforms.discord.enabled 2>/dev/null || true" | tr 'A-Z' 'a-z') in
      false*|no*|off*|0*) STATE=needs_setup ;;
    esac
  fi
  case "$STATE" in
    safe) echo "Discord already wired. Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Discord setup is unsafe (check the file mode, duplicate keys, the numeric allowlist and open-access settings). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE: validate everything BEFORE anything is written

Two blocks, both before `snapshot` and before the dry run. If either fails, nothing has touched the VPS.

**3a. Local checks (no network, no ssh).** Normalise the lists, then reject empty values and anything that could break a
curl config line or a `.env` line.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
bool_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' \t\r\n'; }
DISCORD_ALLOWED_USERS=$(printf '%s' "${DISCORD_ALLOWED_USERS:-}" | csv_clean)
DISCORD_HOME_CHANNEL=$(printf '%s' "${DISCORD_HOME_CHANNEL:-}" | csv_clean)
DISCORD_AUTO_THREAD=$(bool_norm "${DISCORD_AUTO_THREAD:-}")
DISCORD_REQUIRE_MENTION=$(bool_norm "${DISCORD_REQUIRE_MENTION:-}")

if [ -z "$DISCORD_ALLOWED_USERS" ]; then
  echo "ABORT: DISCORD_ALLOWED_USERS is empty. This skill never enables Discord without an explicit per-user allowlist."
  echo "Supply your numeric Discord user ID (Developer Mode, right-click yourself, Copy User ID). Nothing was written."
  exit 1
fi
# A wildcard anywhere in the allowlist ("*", "123,*") would open the bot to everyone.
case "$DISCORD_ALLOWED_USERS" in
  *'*'*) echo "ABORT: DISCORD_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac

# check_ids NAME VALUE REGEX: every comma-separated entry must match REGEX.
check_ids() {
  local bad
  bad=$(printf '%s' "$2" | tr ',' '\n' | grep -vE "$3" | cut -c1-24 || true)
  if [ -n "$bad" ]; then
    echo "ABORT: invalid entries in $1:"
    echo "$bad"
    echo "Expected numeric Discord IDs (17-20 digits), no names or mentions. Nothing was written."
    return 1
  fi
}
check_ids DISCORD_ALLOWED_USERS "$DISCORD_ALLOWED_USERS" '^[0-9]{17,20}$' || exit 1
if [ -n "$DISCORD_HOME_CHANNEL" ]; then
  check_ids DISCORD_HOME_CHANNEL "$DISCORD_HOME_CHANNEL" '^[0-9]{17,20}$' || exit 1
  case "$DISCORD_HOME_CHANNEL" in *,*) echo "ABORT: DISCORD_HOME_CHANNEL takes ONE channel ID. Nothing was written."; exit 1 ;; esac
fi
case "$DISCORD_AUTO_THREAD" in ""|true|false) ;; *) echo "ABORT: DISCORD_AUTO_THREAD must be true or false. Nothing was written."; exit 1 ;; esac
case "$DISCORD_REQUIRE_MENTION" in ""|true|false) ;; *) echo "ABORT: DISCORD_REQUIRE_MENTION must be true or false. Nothing was written."; exit 1 ;; esac

# Token shape. The charset check also guarantees no quote, backslash or newline can reach the curl config.
token_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9._-]*) return 1 ;; esac
  return 0
}
token_chars_ok "${DISCORD_BOT_TOKEN:-}" \
  || { echo "ABORT: DISCORD_BOT_TOKEN is empty or has characters a Discord bot token never has (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$DISCORD_BOT_TOKEN" in
  *[!0-9]*) ;;
  *) echo "ABORT: DISCORD_BOT_TOKEN is all digits. That is the application ID (General Information page), not the bot token (Bot page). Nothing was written."; exit 1 ;;
esac
case "$DISCORD_BOT_TOKEN" in *.*) ;; *)
  echo "ABORT: DISCORD_BOT_TOKEN has no dots; a bot token has three dot-separated parts. Nothing was written."; exit 1 ;;
esac
```

**3b. Open access on the VPS, then the live Discord check, run FROM the VPS** (this also proves its egress works).
`GET /applications/@me` with `Authorization: Bot <token>` is what Hermes' own setup uses to check the token and read the
intents (`plugins/platforms/discord/onboarding.py:70-85`, `tools/discord_tool.py:26-33,65`). The token travels over ssh STDIN as a
curl config. `flags` bits 18 and 19 are Message Content (enabled / limited-enabled); bits 14 and 15 are Server Members.

```bash
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)), so people outside the per-user allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

APP=$(printf 'header = "Authorization: Bot %s"\n' "$DISCORD_BOT_TOKEN" \
  | remote "curl -fsS --max-time 15 -H 'User-Agent: DiscordBot (https://github.com/paarths-collab/hstack, 1)' --config - 'https://discord.com/api/v10/applications/@me'" 2>/dev/null) || APP=""
APP_ID=$(printf '%s' "$APP" | json_field id)
case "$APP_ID" in ''|*[!0-9]*)
  echo "ABORT: Discord (GET /applications/@me, run from the VPS) did not accept the bot token, or the VPS cannot reach discord.com. Re-check the token on the Bot page. Nothing was written."; exit 1 ;;
esac
FLAGS=$(printf '%s' "$APP" | json_field flags)
case "$FLAGS" in
  ''|*[!0-9]*)
    echo "WARN: could not read the application flags from Discord. Confirm Message Content Intent is ON (Bot page, Privileged Gateway Intents) or Discord will refuse the connection; the log check in Step 8 will show it if it is not." ;;
  *)
    if [ $((FLAGS & 786432)) -eq 0 ]; then
      echo "ABORT: Message Content Intent is OFF for this application, and Discord refuses the connection until it is on: https://discord.com/developers/applications > your application > Bot > Privileged Gateway Intents > Message Content Intent > Save Changes. Nothing was written."
      exit 1
    fi ;;
esac
echo "Discord accepted the token (application id $APP_ID)."
echo "Invite link (add the bot to a server you share): https://discord.com/oauth2/authorize?client_id=$APP_ID&scope=bot+applications.commands&permissions=309240908864&integration_type=0"
```

If you have no `python3` locally, `json_field` falls back to `sed` (it reads the flat Discord objects correctly).

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$DISCORD_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token format, allowlist, open-access scan, live Discord check, Message Content Intent; nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write DISCORD_ALLOWED_USERS ($USERS_N user(s)) with 'hermes -p default config set' (value over ssh stdin)
  3. Write DISCORD_HOME_CHANNEL (${DISCORD_HOME_CHANNEL:-none}) if supplied
  4. Write DISCORD_BOT_TOKEN (length ${#DISCORD_BOT_TOKEN}) LAST, over ssh stdin; chmod 600; verify each key exists once (counts only)
  5. config.yaml: discord.auto_thread=${DISCORD_AUTO_THREAD:-unchanged}, discord.require_mention=${DISCORD_REQUIRE_MENTION:-unchanged}, platforms.discord.enabled=true
  6. Reload: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
  7. Verify: token read back from ~/.hermes/.env still works; gateway log shows Discord connected (30s)
  8. If a home channel was given: hermes -p default send --to discord sends ONE short test message to it
  9. hermes -p default pairing list (read-only). This skill never approves a pairing code.

The token is NEVER printed in plaintext.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write (allowlist first, token LAST), then verify

The allowlist goes in before the token because the token is what makes Hermes turn Discord on. Each value travels as one
line on ssh stdin and is read by `read -r` on the VPS; the output of `hermes -p default config set` is discarded so Hermes
can never echo a value into chat.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put DISCORD_ALLOWED_USERS "$DISCORD_ALLOWED_USERS" \
  || { echo "FAIL: could not write DISCORD_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$DISCORD_HOME_CHANNEL" ]; then
  put DISCORD_HOME_CHANNEL "$DISCORD_HOME_CHANNEL" \
    || { echo "FAIL: could not write DISCORD_HOME_CHANNEL."; rollback; exit 1; }
fi
put DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN" \
  || { echo "FAIL: could not write DISCORD_BOT_TOKEN."; rollback; exit 1; }
```

`config set` routes an UPPER_SNAKE name to `~/.hermes/.env` and never echoes the value (`hermes_cli/config.py:3417-3440`). Verify
(counts and the non-secret allowlist only, then the open-access scan again, because a write must not have introduced one):

```bash
KEYS="DISCORD_ALLOWED_USERS DISCORD_BOT_TOKEN"
[ -z "$DISCORD_HOME_CHANNEL" ] || KEYS="$KEYS DISCORD_HOME_CHANNEL"
for k in $KEYS; do
  n=$(remote "grep -c '^$k=.' ~/.hermes/.env || true")
  [ "$n" = "1" ] || { echo "FAIL: $k is not in ~/.hermes/.env exactly once (found ${n:-0}). Rolling back."; rollback; exit 1; }
done
GOT_USERS=$(remote 'sed -n "s/^DISCORD_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
[ "$GOT_USERS" = "$DISCORD_ALLOWED_USERS" ] \
  || { echo "FAIL: the stored allowlist differs from the one supplied. Rolling back."; rollback; exit 1; }
case "$GOT_USERS" in *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;; esac
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Discord secrets confirmed in ~/.hermes/.env."
```

Never put the bot token in `config.yaml`, never `echo >> .env`.

---

## Step 6 — behaviour keys and the enable flag (only after Step 5 passed)

`discord.auto_thread` and `discord.require_mention` are known `config.yaml` keys (`hermes_cli/config_defaults.py:1555-1559`);
`hermes config set` coerces `true`/`false` to booleans. They are written only when you supplied a value, so the Hermes
defaults stay untouched otherwise. `platforms.discord.enabled true` removes the explicit-disable trap described above.

```bash
if [ -n "$DISCORD_AUTO_THREAD" ]; then
  remote "hermes -p default config set discord.auto_thread $DISCORD_AUTO_THREAD >/dev/null" \
    || { echo "FAIL: could not set discord.auto_thread."; rollback; exit 1; }
fi
if [ -n "$DISCORD_REQUIRE_MENTION" ]; then
  remote "hermes -p default config set discord.require_mention $DISCORD_REQUIRE_MENTION >/dev/null" \
    || { echo "FAIL: could not set discord.require_mention."; rollback; exit 1; }
fi
remote "hermes -p default config set platforms.discord.enabled true >/dev/null" \
  || echo "WARN: could not set platforms.discord.enabled. This is a WARN on purpose: Hermes enables Discord from the token unless config.yaml disables it, and Step 8 will show whether Discord connected."
```

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a
new `instance_id`. A refusal because of live sessions is reported, not overridden.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify Discord is connected (token read back, then the log, 30s)

Two checks. (1) The token PERSISTED: it is read back from `~/.hermes/.env` on the VPS (the non-interactive ssh shell never
loads that file) and the same `applications/@me` call must return the same application. (2) The gateway log shows Discord
connected. `dc_connected` (Step 0) needs BOTH the gateway's own line (`✓ discord connected`, `gateway/run_startup.py:1352`;
a `(degraded)` suffix does not count) AND the adapter's `[Discord] Connected as <bot>` line (`adapter.py:1506`), and a failure,
disconnect or fresh `Starting Hermes Gateway...` line after them cancels the verdict (`adapter.py:1617,1628,2186`,
`gateway/run_startup.py:1335,1355,1645`, `gateway/run_adapters.py:135`). Hermes writes these to `gateway.log`
(`hermes_logging.py:306-311,399`), which `hermes logs gateway` prints (`hermes_cli/subcommands/logs.py`).

```bash
BACK=$(remote 'bash -s' <<'REMOTE' 2>/dev/null
v=$(sed -n 's/^DISCORD_BOT_TOKEN=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bot %s"\n' "$v" \
  | curl -fsS --max-time 15 -H 'User-Agent: DiscordBot (https://github.com/paarths-collab/hstack, 1)' --config - 'https://discord.com/api/v10/applications/@me'
REMOTE
) || BACK=""
if [ "$(printf '%s' "$BACK" | json_field id)" != "$APP_ID" ]; then
  echo "FAIL: the Discord check with the token stored on the VPS did not return application $APP_ID. Rolling back."
  rollback; exit 1
fi

CONNECTED=0
for i in 1 2 3 4 5 6; do
  LOG=$(remote "hermes -p default logs gateway -n 300 2>&1") || LOG=""
  if printf '%s\n' "$LOG" | dc_connected; then
    CONNECTED=1
    echo "OK: Discord connected (application $APP_ID)."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Discord was not confirmed connected in the gateway log within 30s (needs the gateway's connected line AND the adapter's Connected line, with no failure after them). Rolling back."; rollback; exit 1; }
```

---

## Step 9 — smoke test, pairing view, finish

With a home channel, the native `hermes send --to discord` posts one short message there without a running agent turn
(`hermes_cli/send_cmd.py:194-240`: no target channel means the home channel, `DISCORD_HOME_CHANNEL`). Without a home channel
nothing is sent and the human step below is the smoke test. `hermes pairing list` is read-only.

```bash
if [ -n "$DISCORD_HOME_CHANNEL" ]; then
  remote "hermes -p default send --to discord 'hstack setup check: Hermes is connected to Discord. No reply is needed.'" \
    || { echo "FAIL: hermes send --to discord failed (is the bot in the home channel and allowed to post there?). Rolling back."; rollback; exit 1; }
else
  echo "No home channel was given, so no test message was sent. Type /sethome in a channel to set one."
fi
remote "hermes -p default pairing list" || true
finish || exit 1
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/platform-discord.prev` for a manual undo.

The human smoke test (a machine cannot do this): from an allowlisted account, send the bot a DM, or @mention it in a server
channel it was invited to, and expect a reply within a few seconds. If there is none:

```bash
# Redact first: keep any token-shaped text out of what you show.
remote "hermes -p default logs gateway -n 50 2>&1" \
  | sed -E 's#[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}#<redacted>#g' | grep -i discord | tail -20 || true
```

- The log says `discord_intents_required` or the connection is refused: turn on Message Content Intent (Step 3b) and re-run.
- Messages in a server channel are ignored: @mention the bot (default), or give `DISCORD_REQUIRE_MENTION=false`.
- The bot is not in any server: open the invite link printed in Step 3b.
- The log says messages are denied because no allowlist is configured: the allowlist did not load; check Step 5.

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in Step 0. It restores and verifies the pre-run `~/.hermes/.env` and `config.yaml` from the active
snapshot, reloads the gateway with `gw_reload`, and only then retires the snapshot. If the files were restored but the gateway
did not come back ready it prints `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero:
inspect `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A
restart refused because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.
There is no second, hand-written undo and no full "wipe" function: the snapshot restore IS the undo. A failed `FORCE=1`
re-run therefore gets its previous token and allowlist back, and a failed first run removes the files it created.

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
Removing Discord for good is a separate decision (unset the three `DISCORD_*` keys with `hermes -p default config unset`, then
`gw_reload`); this skill does not ship a wipe.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Message Content Intent off in the Portal | Discord refuses the connection (non-retryable `discord_intents_required`) | Step 3b reads the application flags and aborts before any write |
| 2 | Pasting the application ID instead of the bot token | The General Information page shows a numeric ID; it is not a token | Step 3a rejects an all-digit value and a value without dots |
| 3 | Writing `DISCORD_ENABLED=true` | No such variable exists; the token enables Discord, only `platforms.discord.enabled: false` disables it | Step 6 sets the config flag; nothing writes `DISCORD_ENABLED` |
| 4 | An allowlist with a name, a mention or a `*` | Names need the Server Members intent; `*` is open access | Step 3a accepts 17-20 digit IDs only and refuses `*` |
| 5 | `DISCORD_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS`, `allow_all_users: true`, `DISCORD_ALLOW_BOTS`, role grants | They admit senders outside the allowlist | Step 3b scans `.env` and `config.yaml` (names only), Step 5 re-checks after the write |
| 6 | `DISCORD_ALLOWED_CHANNELS` with no user allowlist | Anyone speaking in those channels is admitted | The skill always writes a user allowlist; the channel list is then only a restriction |
| 7 | Approving a pairing code seen in a log or a DM | `pairing approve` grants access to whoever sent it | The skill never runs `pairing approve`; `pairing list` is read-only |
| 8 | The bot is in no server | The connection works but nobody can reach it | Open the invite link from Step 3b (a human step) |
| 9 | Server channel ignored | `discord.require_mention` defaults to true | @mention the bot, or set `DISCORD_REQUIRE_MENTION=false`; DMs are never gated |
| 10 | Replies land in a new thread | `discord.auto_thread` defaults to true | Set `DISCORD_AUTO_THREAD=false` |
| 11 | Token rotated in the Portal | The old token in `.env` keeps failing | Re-run with `FORCE=1`; if it fails, `rollback` restores the OLD working values |
| 12 | Treating the first matching log line as success | A later disconnect or an old line from the previous process would pass | `dc_connected` needs the gateway line AND the adapter line and honours later failures |
| 13 | Starting the gateway with the foreground `gateway run`, adding a daemon flag, or grepping `gateway status` text | `run` blocks the ssh call, the daemon flag does not exist (argparse exit 2), "✗ Gateway is not running" contains "running" | `gw_reload` / `gw_ready` only |
| 14 | Token in an ssh argument, a URL, or a single-quoted remote string | Leaks into `ps`; breaks on odd characters | The token goes over ssh stdin (curl `--config -`, `read -r`) |
| 15 | `config set KEY value` shows the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` there at that moment sees it (the local ssh argv stays clean) | Accepted; the output is discarded so Hermes never echoes it into chat |
| 16 | Re-running after a crashed run | A leftover `~/.hermes/.hstack-backup/platform-discord` would record half-written files as known-good | `snapshot` refuses; run `rollback`, then re-run |
| 17 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run the Step 0 block first |
| 18 | GNU-only flags in LOCAL commands | macOS ships bash 3.2 / BSD tools | GNU flags stay inside `remote` strings (the VPS is Linux) |
| 19 | Container-only Hermes | This skill writes the host's `~/.hermes` | Step 1 requires `hermes` on the host and aborts otherwise |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded and the Step 0 helpers are defined in this shell
- [ ] Hermes on the VPS host reports `0.22.5`
- [ ] Idempotency check ran (skipped only for a safe stored setup, unless `FORCE=1`)
- [ ] Hard gate passed with nothing written: numeric allowlist (no `*`), token shape, no open-access setting in `.env` or `config.yaml`
- [ ] Live Discord check from the VPS accepted the token and Message Content Intent is on (or the WARN was shown to the user)
- [ ] Dry run shown and approved (or `AUTO_APPROVE=1`); the invite link was given to the user
- [ ] Snapshot taken immediately before the first write
- [ ] `DISCORD_ALLOWED_USERS` written before `DISCORD_BOT_TOKEN`; each key is in `~/.hermes/.env` exactly once, mode 600; no token in `config.yaml`
- [ ] `platforms.discord.enabled` set only after the writes were verified (no `DISCORD_ENABLED` variable)
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] Token read back from `~/.hermes/.env` was accepted by Discord, and `dc_connected` confirmed the connection in the gateway log
- [ ] If a home channel was given, `hermes send --to discord` succeeded; `pairing list` was viewed and nothing was approved
- [ ] `finish` ran; any failure after the snapshot ran `rollback` and restored the previous `.env` and `config.yaml`
- [ ] Human step: an allowlisted user messaged the bot and got a reply

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and Discord failure modes.

---

## Verified against Hermes v0.22.5

Read in the Hermes source at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository.

- Env names and enabling: `plugins/platforms/discord/gateway_env.py:6-21` (`DISCORD_BOT_TOKEN` enables; `DISCORD_HOME_CHANNEL`,
  `DISCORD_REPLY_TO_MODE`; allowlist `DISCORD_ALLOWED_USERS`, allow-all `DISCORD_ALLOW_ALL_USERS`, `DISCORD_ALLOW_BOTS`),
  `plugins/platforms/discord/plugin.yaml`, `gateway/platform_env.py:132-179`, explicit disable `gateway/config_env.py:84-109`.
- Authorization: `gateway/authz_mixin.py:631-714` (order, `*` wildcard at `:714`, `GATEWAY_ALLOW_ALL_USERS` only when no allowlist at
  `:687-694`, pairing store at `:678`), unauthorized-DM default `:716-759`, startup warning `gateway/run_startup.py:1049-1058`,
  YAML `allow_all_users` bridge `gateway/config_loader.py:430-462`; adapter gate `adapter.py:4106-4194` (empty-allowlist branch
  `:4122-4139`, `*` `:4141`, fail-closed warning `:4178-4194`), bots `:1687,5072`, roles `:4143-4163`.
- Intents and token check: `adapter.py:405-412,1466-1470,1659-1668`; `plugins/platforms/discord/onboarding.py:17-31,46-85,167-187`;
  `tools/discord_tool.py:26-33,55-66` (API base, flag bits, `Bot` scheme).
- Defaults and behaviour keys: `hermes_cli/config_defaults.py:1555-1559`; `adapter.py:4927,6127-6170`; `hermes config set` env routing
  `hermes_cli/config.py:3417-3440`; `config get` prints `true`/`false` for booleans `hermes_cli/config.py:884-894`.
- Log lines used by `dc_connected`: `gateway/run_startup.py:1335,1352,1355,1645`, `gateway/run_adapters.py:135,925`,
  `adapter.py:1450,1506,1617,1628,1427,2186`; log files `hermes_logging.py:306-311,399`; `hermes logs` parser `hermes_cli/subcommands/logs.py`.
- `hermes send` and `hermes pairing`: `hermes_cli/send_cmd.py:194-262`, `hermes_cli/subcommands/pairing.py`, `hermes_cli/pairing.py:22-68`.
- Gateway lifecycle: the sources listed in the lifecycle note under Step 0.

Not verified, and not claimed: nothing in this skill was run against a real Hermes, a real VPS, or Discord (the tests use a stub whose
command syntax is the real v0.22.5 argparse and whose behaviour is an assumption). The Discord `applications/@me` response shape and
the `DiscordBot` User-Agent requirement come from the Hermes source and Discord's published conventions, not from a call made here.
The exact text and timestamps of a real `gateway.log` were not observed. `hermes send --to discord` through the home channel was
read, not exercised. The invite permission integer 309240908864 is computed from the ten permission bits in `onboarding.py:19-31`.
