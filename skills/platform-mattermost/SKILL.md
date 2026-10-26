---
name: platform-mattermost
description: "Wire a remote Hermes Agent v0.22.5 to a Mattermost server (server URL plus bot or personal-access token) over SSH. Checks the token against the server's /api/v4/users/me from the VPS before any write, refuses open access, reloads the gateway natively, verifies the adapter's own connected log line and rolls back to the previous values on any failure."
---

# /platform-mattermost — wire Mattermost to a remote Hermes (SSH-first)

You are the engineer connecting Mattermost to a self-hosted Hermes Agent on the user's VPS. The agent
(Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) works over SSH as root. The user does
the things a machine cannot:

1. Enable bot accounts (System Console, Integrations, Bot Accounts) and create the bot account, or create a personal access token.
2. Copy the token (a bot token is shown ONCE) and give you the server URL.
3. Copy their own Mattermost user ID (profile, click the ID to copy).
4. Add the bot to every channel it should answer in (channel name, Add Members).

Everything else — the live token check, the allowlist gate, storage, gateway reload, the connection check, the optional
test message — runs on the VPS over SSH, with a snapshot and rollback.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and
reaches the VPS through `remote()` from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on
the remote PATH. The token is pasted locally, format-checked locally, and travels to the VPS only over ssh STDIN (a
curl `--config -` for the server check, a `read -r` for the write), never in an ssh argument, a URL on a command line
or a quoted remote string. Run all blocks in ONE shell session.

**Honest picture (source-verified against Hermes v0.22.5, not run against a live Hermes or Mattermost).**

- **Token plus URL.** `MATTERMOST_TOKEN` enables the platform and `MATTERMOST_URL` supplies the server; Hermes warns when the
  token is set without the URL (`plugins/platforms/mattermost/gateway_env.py:6-14`, `adapter.py:92-102`). There is no
  `MATTERMOST_ENABLED`. An explicit `platforms.mattermost.enabled: false` in `config.yaml` beats the credential
  (`gateway/config_env.py:84-109`); this skill sets it `true` after the writes. The URL is written before the token.
- **The check Hermes itself makes.** On connect the adapter calls `GET {url}/api/v4/users/me` with `Authorization: Bearer <token>`
  and treats a missing `id` as "failed to authenticate" (`adapter.py:132-133,233-250`). Step 3b makes the same call from the VPS
  first. A bot token or a personal access token both work (`plugin.yaml`).
- **A trailing slash is harmless.** The adapter strips it (`adapter.py:113`), and Hermes' own setup strips it before saving
  (`adapter.py:672`); the old "double slash gives a 404" warning does not apply. This skill strips it too so the stored URL is canonical.
- **No Docker network step.** The old text linked the Hermes container to the Mattermost container's Docker network and ran the
  ping from inside the container. This skill requires Hermes on the host (Step 1), so the check runs from the host: use a URL the
  host can reach (a published port such as `http://127.0.0.1:8065` if Mattermost is a container on the same VPS, or its public
  `https://` address).
- **An empty allowlist is not fail-open at v0.22.5, but this skill still refuses it.** With no allowlist and no allow-all switch,
  Mattermost senders are denied (`gateway/authz_mixin.py:687-694`, docs `website/docs/user-guide/messaging/mattermost.md:328-331`),
  and an unknown DM sender is offered a pairing code. A configured allowlist turns that offer off (`allowlist_suppresses_pairing`,
  `gateway_env.py:21`). Hermes' own setup wizard says "leave empty for open access" (`adapter.py:682-686`); the source does not
  implement that. `*`, `MATTERMOST_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS` and `allow_all_users: true` in `config.yaml`
  (`gateway/config_loader.py:430-462`) would make the allowlist meaningless, so the gate refuses them in `.env` and `config.yaml`.
- **The old auto-approve of a pairing code is gone.** It scraped a code from the logs and ran `pairing approve`, which authorizes
  whoever created the code. This skill never approves anyone (`hermes_cli/pairing.py:56-68`); `pairing list` is read-only.
- **Mentions and replies.** DMs always answer; in channels the bot answers only when @mentioned (`mattermost.require_mention`
  defaults to true, `hermes_cli/config_defaults.py:1658-1662`). `MATTERMOST_REPLY_MODE` is `thread` or `off` (default `off`,
  flat messages; `adapter.py:121-123`).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$MATTERMOST_URL` | Server URL the VPS host can reach, `http(s)://host[:port][/prefix]` (trailing slashes are stripped) | `https://chat.example.com`, or `http://127.0.0.1:8065` for a container on the same VPS |
| `$MATTERMOST_TOKEN` | Bot account token (shown once) or personal access token | System Console, Integrations, Bot Accounts, Add Bot Account |
| `$MATTERMOST_ALLOWED_USERS` | Comma-separated Mattermost user IDs (26 lowercase letters and digits), NOT `@usernames` | Profile, the ID shown there; or `GET /api/v4/users/me` |
| `$MATTERMOST_HOME_CHANNEL` *(optional)* | Channel ID for cron output and `hermes send --to mattermost`. Without it nothing is sent here and `/sethome` in a channel sets it later | Channel name, View Info, copy the ID |
| `$MATTERMOST_REPLY_MODE` *(optional)* | `thread` or `off`. Hermes default is `off` (flat). Only written when you set it | |
| `$MATTERMOST_REQUIRE_MENTION` *(optional)* | `true` or `false`. Hermes default is `true`: channels need an @mention. Only written when you set it | |
| `FORCE=1` *(optional)* | Rewire even if Mattermost already looks wired | |
| `GW_INTERRUPT=1` *(optional)* | Allow the gateway restart to interrupt live chats. Never set by default | |

If `$MATTERMOST_ALLOWED_USERS` is empty the skill stops in Step 3 and writes nothing.

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
SKILL_NAME=platform-mattermost
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

# ---- platform-mattermost helpers (the six functions above are the shared lifecycle helpers) ----

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
    if (line ~ /^(MATTERMOST_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) { n = line; sub(/=.*/, "", n); if (!off(value(line))) on[n] = 1 }
    if (line ~ /^GATEWAY_ALLOWED_USERS=/) { if (value(line) ~ /\*/) on["GATEWAY_ALLOWED_USERS"] = 1 }
  }
  yaml {
    line = $0
    sub(/[[:space:]]+#.*$/, "", line)
    if (line ~ /^[[:space:]]*(allow_all_users)[[:space:]]*:/) {
      k = line; sub(/^[[:space:]]*/, "", k); sub(/[[:space:]]*:.*$/, "", k)
      v = line; sub(/^[^:]*:[[:space:]]*/, "", v); gsub(/[\"\047[:space:]]/, "", v)
      if (!off(v)) on["config.yaml:allow_all_users"] = 1
    }
  }
  END { for (n in on) print n }' "$f" "$y"
REMOTE
}

# mm_connected: read `hermes logs gateway` text on stdin; succeed only when the LATEST lines show Mattermost connected: the
# gateway's own "mattermost connected" line AND the adapter's "WebSocket connected and authenticated" line, with no failure after them.
mm_connected() {
  awk '
    { l = tolower($0) }
    l ~ /starting.hermes.gateway/ { gw = 0; ad = 0 }
    l ~ /mattermost (connected|reconnected successfully)[[:space:]]*$/ { gw = 1 }
    l ~ /mattermost: websocket connected and authenticated/ { ad = 1 }
    l ~ /mattermost: (failed to authenticate|websocket closed|disconnected|url or token not configured|aiohttp not installed)|mattermost ws (auth failed|error)/ { ad = 0 }
    l ~ /mattermost (connected \(degraded\)|failed to connect|error:|disconnected)/ { gw = 0; ad = 0 }
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

Skip setup only when the stored URL, token and numeric allowlist are each defined once, `.env` is private, no open-access
setting exists in `.env` or `config.yaml`, and `platforms.mattermost.enabled` is not an explicit `false`. An unsafe existing
setup aborts instead of being reported as wired. The check prints a status only, never a stored value.

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
    if (line ~ /^MATTERMOST_TOKEN=/) { tokens++; token = value(line) }
    if (line ~ /^MATTERMOST_URL=/) { urls++; url = value(line) }
    if (line ~ /^MATTERMOST_ALLOWED_USERS=/) { lists++; users = value(line) }
  }
  END {
    if (tokens == 0 || urls == 0 || lists == 0) print "needs_setup"
    else if (tokens > 1 || urls > 1 || lists > 1) print "unsafe"
    else if (token !~ /^[A-Za-z0-9]+$/ || length(token) < 20 || length(token) > 64 || url !~ /^https?:\/\/[A-Za-z0-9]/) print "needs_setup"
    else if (!ids_ok(users, "^[a-z0-9]+$", 26, 26)) print "unsafe"
    else print "safe"
  }' "$f"
REMOTE
) || { echo "ABORT: could not check the stored Mattermost setup. Nothing was written."; exit 1; }
  if [ "$STATE" = safe ]; then
    OPEN=$(open_access_names) || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
    [ -z "$OPEN" ] || STATE=unsafe
  fi
  if [ "$STATE" = safe ]; then
    case $(remote "hermes -p default config get platforms.mattermost.enabled 2>/dev/null || true" | tr 'A-Z' 'a-z') in
      false*|no*|off*|0*) STATE=needs_setup ;;
    esac
  fi
  case "$STATE" in
    safe) echo "Mattermost already wired. Set FORCE=1 to rewire."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Mattermost setup is unsafe (check the file mode, duplicate keys, the 26-character user-ID allowlist and open-access settings). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE: validate everything BEFORE anything is written

Two blocks, both before `snapshot` and before the dry run. If either fails, nothing has touched the VPS.

**3a. Local checks (no network, no ssh).** Normalise the values, then reject empty values and anything that could break a curl
config line or a `.env` line.

```bash
# Normalise the comma lists: drop whitespace, empty entries, leading/trailing commas.
csv_clean() { tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//'; }
bool_norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d ' \t\r\n'; }
MATTERMOST_ALLOWED_USERS=$(printf '%s' "${MATTERMOST_ALLOWED_USERS:-}" | csv_clean)
MATTERMOST_HOME_CHANNEL=$(printf '%s' "${MATTERMOST_HOME_CHANNEL:-}" | csv_clean)
MATTERMOST_REPLY_MODE=$(bool_norm "${MATTERMOST_REPLY_MODE:-}")
MATTERMOST_REQUIRE_MENTION=$(bool_norm "${MATTERMOST_REQUIRE_MENTION:-}")

if [ -z "$MATTERMOST_ALLOWED_USERS" ]; then
  echo "ABORT: MATTERMOST_ALLOWED_USERS is empty. This skill never enables Mattermost without an explicit per-user allowlist."
  echo "Supply your 26-character user ID (profile, click the ID to copy). Nothing was written."
  exit 1
fi
# A wildcard anywhere in the allowlist ("*", "abc...,*") would open the bot to everyone on the server.
case "$MATTERMOST_ALLOWED_USERS" in
  *'*'*) echo "ABORT: MATTERMOST_ALLOWED_USERS contains a wildcard (*). That would let anyone on the server use the bot. Nothing was written."; exit 1 ;;
esac

# check_ids NAME VALUE REGEX: every comma-separated entry must match REGEX.
check_ids() {
  local bad
  bad=$(printf '%s' "$2" | tr ',' '\n' | grep -vE "$3" | cut -c1-30 || true)
  if [ -n "$bad" ]; then
    echo "ABORT: invalid entries in $1:"
    echo "$bad"
    echo "Expected 26-character IDs (lowercase letters and digits), not @usernames. Nothing was written."
    return 1
  fi
}
check_ids MATTERMOST_ALLOWED_USERS "$MATTERMOST_ALLOWED_USERS" '^[a-z0-9]{26}$' || exit 1
if [ -n "$MATTERMOST_HOME_CHANNEL" ]; then
  check_ids MATTERMOST_HOME_CHANNEL "$MATTERMOST_HOME_CHANNEL" '^[a-z0-9]{26}$' || exit 1
  case "$MATTERMOST_HOME_CHANNEL" in *,*) echo "ABORT: MATTERMOST_HOME_CHANNEL takes ONE channel ID. Nothing was written."; exit 1 ;; esac
fi
case "$MATTERMOST_REPLY_MODE" in ""|thread|off) ;; *) echo "ABORT: MATTERMOST_REPLY_MODE must be thread or off. Nothing was written."; exit 1 ;; esac
case "$MATTERMOST_REQUIRE_MENTION" in ""|true|false) ;; *) echo "ABORT: MATTERMOST_REQUIRE_MENTION must be true or false. Nothing was written."; exit 1 ;; esac

# Server URL: http(s)://host[:port][/prefix], no credentials, query or fragment (the charset check also keeps quotes and spaces
# out of the curl config). Trailing slashes are removed, as Hermes' own setup does.
MATTERMOST_URL=$(printf '%s' "${MATTERMOST_URL:-}" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
while [ "${MATTERMOST_URL%/}" != "$MATTERMOST_URL" ]; do MATTERMOST_URL=${MATTERMOST_URL%/}; done
url_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9._~:/%+-]*) return 1 ;; esac
  case "$1" in http://[A-Za-z0-9]*|https://[A-Za-z0-9]*) return 0 ;; esac
  return 1
}
url_ok "$MATTERMOST_URL" \
  || { echo "ABORT: MATTERMOST_URL must be http(s)://host[:port][/prefix] with no spaces, quotes, credentials, query or fragment. Nothing was written."; exit 1; }

# Token shape. The charset check also guarantees no quote, backslash or newline can reach the curl config.
token_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9]*) return 1 ;; esac
  return 0
}
token_chars_ok "${MATTERMOST_TOKEN:-}" && [ "${#MATTERMOST_TOKEN}" -ge 20 ] \
  || { echo "ABORT: MATTERMOST_TOKEN is empty, too short or has characters a Mattermost token never has (spaces, quotes, newline). Nothing was written."; exit 1; }
```

**3b. Open access on the VPS, then the live Mattermost check, run FROM the VPS** (this also proves its egress and the URL work).
`GET /api/v4/users/me` with `Authorization: Bearer <token>` is the call the adapter makes on connect and the one Hermes' docs
use to test a token (`adapter.py:132-133,241-248`, `website/docs/user-guide/messaging/mattermost.md:116-119,286-297`). The token travels over
ssh STDIN as a curl config; the URL is not secret and was validated above.

```bash
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env or config.yaml on the VPS to check for open access. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)), so people outside the per-user allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

ME=$(printf 'header = "Authorization: Bearer %s"\n' "$MATTERMOST_TOKEN" \
  | remote "curl -fsS --max-time 15 --config - '$MATTERMOST_URL/api/v4/users/me'" 2>/dev/null) || ME=""
BOT_ID=$(printf '%s' "$ME" | json_field id | tr -cd 'A-Za-z0-9')
BOT_NAME=$(printf '%s' "$ME" | json_field username | tr -cd 'A-Za-z0-9._-')
[ -n "$BOT_ID" ] || {
  echo "ABORT: Mattermost $MATTERMOST_URL/api/v4/users/me (run from the VPS) did not accept the token, or the VPS cannot reach the server. Check the URL, that the token was not regenerated, and that the bot account is active. Nothing was written."
  exit 1
}
echo "Mattermost accepted the token: @${BOT_NAME:-unknown} on $MATTERMOST_URL."
```

If you have no `python3` locally, `json_field` falls back to `sed` (it reads the flat Mattermost answer correctly).

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$MATTERMOST_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token and URL format, allowlist, open-access scan, live /api/v4/users/me check; nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write MATTERMOST_ALLOWED_USERS ($USERS_N user(s)) with 'hermes -p default config set' (value over ssh stdin)
  3. Write MATTERMOST_HOME_CHANNEL (${MATTERMOST_HOME_CHANNEL:-none}) and MATTERMOST_REPLY_MODE (${MATTERMOST_REPLY_MODE:-unchanged}) if supplied
  4. Write MATTERMOST_URL ($MATTERMOST_URL), then MATTERMOST_TOKEN (length ${#MATTERMOST_TOKEN}) LAST, over ssh stdin; chmod 600; verify each key exists once (counts only)
  5. config.yaml: mattermost.require_mention=${MATTERMOST_REQUIRE_MENTION:-unchanged}, platforms.mattermost.enabled=true
  6. Reload: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
  7. Verify: the token read back from ~/.hermes/.env still works; gateway log shows Mattermost connected (30s)
  8. If a home channel was given: hermes -p default send --to mattermost sends ONE short test message to it
  9. hermes -p default pairing list (read-only). This skill never approves a pairing code.

The token is NEVER printed in plaintext.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write (allowlist first, URL, token LAST), then verify

The allowlist goes in before the URL and token because the token is what makes Hermes turn Mattermost on. Each value travels as
one line on ssh stdin and is read by `read -r` on the VPS; the output of `hermes -p default config set` is discarded so Hermes can
never echo a value into chat.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put MATTERMOST_ALLOWED_USERS "$MATTERMOST_ALLOWED_USERS" \
  || { echo "FAIL: could not write MATTERMOST_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$MATTERMOST_HOME_CHANNEL" ]; then
  put MATTERMOST_HOME_CHANNEL "$MATTERMOST_HOME_CHANNEL" \
    || { echo "FAIL: could not write MATTERMOST_HOME_CHANNEL."; rollback; exit 1; }
fi
if [ -n "$MATTERMOST_REPLY_MODE" ]; then
  put MATTERMOST_REPLY_MODE "$MATTERMOST_REPLY_MODE" \
    || { echo "FAIL: could not write MATTERMOST_REPLY_MODE."; rollback; exit 1; }
fi
put MATTERMOST_URL "$MATTERMOST_URL" \
  || { echo "FAIL: could not write MATTERMOST_URL."; rollback; exit 1; }
put MATTERMOST_TOKEN "$MATTERMOST_TOKEN" \
  || { echo "FAIL: could not write MATTERMOST_TOKEN."; rollback; exit 1; }
```

`config set` routes an UPPER_SNAKE name to `~/.hermes/.env` and never echoes the value (`hermes_cli/config.py:3417-3440`). Verify
(counts and the non-secret values only, then the open-access scan again, because a write must not have introduced one):

```bash
KEYS="MATTERMOST_ALLOWED_USERS MATTERMOST_URL MATTERMOST_TOKEN"
[ -z "$MATTERMOST_HOME_CHANNEL" ] || KEYS="$KEYS MATTERMOST_HOME_CHANNEL"
for k in $KEYS; do
  n=$(remote "grep -c '^$k=.' ~/.hermes/.env || true")
  [ "$n" = "1" ] || { echo "FAIL: $k is not in ~/.hermes/.env exactly once (found ${n:-0}). Rolling back."; rollback; exit 1; }
done
GOT_USERS=$(remote 'sed -n "s/^MATTERMOST_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
[ "$GOT_USERS" = "$MATTERMOST_ALLOWED_USERS" ] \
  || { echo "FAIL: the stored allowlist differs from the one supplied. Rolling back."; rollback; exit 1; }
case "$GOT_USERS" in *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;; esac
GOT_URL=$(remote 'sed -n "s/^MATTERMOST_URL=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
[ "$GOT_URL" = "$MATTERMOST_URL" ] \
  || { echo "FAIL: the stored server URL differs from the one supplied. Rolling back."; rollback; exit 1; }
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env or config.yaml turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Mattermost secrets confirmed in ~/.hermes/.env."
```

Never put the token in `config.yaml`, never `echo >> .env`.

---

## Step 6 — behaviour key and the enable flag (only after Step 5 passed)

`mattermost.require_mention` is a known `config.yaml` key (`hermes_cli/config_defaults.py:1658-1662`); `hermes config set` coerces
`true`/`false` to a boolean. It is written only when you supplied a value (the reply mode went to `.env` in Step 5).
`platforms.mattermost.enabled true` removes the explicit-disable trap described above.

```bash
if [ -n "$MATTERMOST_REQUIRE_MENTION" ]; then
  remote "hermes -p default config set mattermost.require_mention $MATTERMOST_REQUIRE_MENTION >/dev/null" \
    || { echo "FAIL: could not set mattermost.require_mention."; rollback; exit 1; }
fi
remote "hermes -p default config set platforms.mattermost.enabled true >/dev/null" \
  || echo "WARN: could not set platforms.mattermost.enabled. This is a WARN on purpose: Hermes enables Mattermost from the token unless config.yaml disables it, and Step 8 will show whether Mattermost connected."
```

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a
new `instance_id`. A refusal because of live sessions is reported, not overridden.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify Mattermost is connected (token read back, then the log, 30s)

Two checks. (1) The token and URL PERSISTED: both are read back from `~/.hermes/.env` on the VPS (the non-interactive ssh shell
never loads that file) and the same `users/me` call must return the same account. (2) The gateway log shows Mattermost connected.
`mm_connected` (Step 0) needs BOTH the gateway's own line (`✓ mattermost connected`, `gateway/run_startup.py:1352`; a `(degraded)`
suffix does not count) AND the adapter's `Mattermost: WebSocket connected and authenticated` line (`adapter.py:480`; the earlier
`authenticated as @name` line comes from the REST call alone), and a failure, closed socket, disconnect or fresh
`Starting Hermes Gateway...` line after them cancels the verdict (`adapter.py:243,264,455,468,493`,
`gateway/run_startup.py:1335,1355,1645`, `gateway/run_adapters.py:135`). A transient socket drop that the adapter reconnects by
itself logs a new connected line, which restores the verdict. Hermes writes these lines to `gateway.log`
(`hermes_logging.py:306-311,399`), which `hermes logs gateway` prints.

```bash
BACK=$(remote 'bash -s' <<'REMOTE' 2>/dev/null
u=$(sed -n 's/^MATTERMOST_URL=//p' ~/.hermes/.env | tail -n1)
u=${u#\"}; u=${u%\"}
v=$(sed -n 's/^MATTERMOST_TOKEN=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" | curl -fsS --max-time 15 --config - "$u/api/v4/users/me"
REMOTE
) || BACK=""
if [ "$(printf '%s' "$BACK" | json_field id | tr -cd 'A-Za-z0-9')" != "$BOT_ID" ]; then
  echo "FAIL: the Mattermost check with the token stored on the VPS did not return the same account ($BOT_ID). Rolling back."
  rollback; exit 1
fi

CONNECTED=0
for i in 1 2 3 4 5 6; do
  LOG=$(remote "hermes -p default logs gateway -n 300 2>&1") || LOG=""
  if printf '%s\n' "$LOG" | mm_connected; then
    CONNECTED=1
    echo "OK: Mattermost connected (@${BOT_NAME:-unknown})."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Mattermost was not confirmed connected in the gateway log within 30s (needs the gateway's connected line AND the adapter's WebSocket line, with no failure after them). Rolling back."; rollback; exit 1; }
```

---

## Step 9 — smoke test, pairing view, finish

With a home channel, the native `hermes send --to mattermost` posts one short message there without an agent turn
(`hermes_cli/send_cmd.py:194-240`; a home channel is the default target and Mattermost registers an out-of-process sender,
`adapter.py:596-651,741`). The bot must be a member of that channel. Without a home channel nothing is sent and the human step
below is the smoke test. `hermes pairing list` is read-only.

```bash
if [ -n "$MATTERMOST_HOME_CHANNEL" ]; then
  remote "hermes -p default send --to mattermost 'hstack setup check: Hermes is connected to Mattermost. No reply is needed.'" \
    || { echo "FAIL: hermes send --to mattermost failed (is the bot a member of the home channel?). Rolling back."; rollback; exit 1; }
else
  echo "No home channel was given, so no test message was sent. Type /sethome in a channel to set one."
fi
remote "hermes -p default pairing list" || true
finish || exit 1
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/platform-mattermost.prev` for a manual undo.

The human smoke test (a machine cannot do this): from an allowlisted account, open a direct message with the bot, send `ping`
and expect a reply within a few seconds; in a channel, add the bot and @mention it. If there is none:

```bash
remote "hermes -p default logs gateway -n 50 2>&1" | grep -i mattermost | tail -20 || true
```

- `failed to authenticate`: wrong URL or token, or the bot account is deactivated; re-check Step 3b's output.
- WebSocket reconnect loops: a reverse proxy must forward the WebSocket upgrade for `/api/v4/websocket`
  (`website/docs/user-guide/messaging/mattermost.md:269-285`).
- The bot ignores a channel: it is not a member of it, or the message had no @mention.
- The bot ignores you: your user ID is not in the allowlist (the ID, not the `@username`).

---

## Rollback (automatic on any failure after the snapshot)

`rollback` is defined once, in Step 0. It restores and verifies the pre-run `~/.hermes/.env` and `config.yaml` from the active
snapshot, reloads the gateway with `gw_reload`, and only then retires the snapshot. If the files were restored but the gateway
did not come back ready it prints `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero:
inspect `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A
restart refused because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.
There is no second, hand-written undo and no full "wipe" function: the snapshot restore IS the undo. A failed `FORCE=1`
re-run therefore gets its previous token, URL and allowlist back, and a failed first run removes the files it created.

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
Removing Mattermost for good is a separate decision (unset the `MATTERMOST_*` keys with `hermes -p default config unset`, then
`gw_reload`); this skill does not ship a wipe.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Token without URL (or the reverse) | The token enables the platform; without the URL the adapter cannot connect | Step 3 validates both; Step 5 writes the URL before the token |
| 2 | A URL the VPS host cannot reach | The adapter connects from the host, not from your laptop | Step 3b makes the real call from the VPS and aborts on failure |
| 3 | Mattermost in a container, URL given as its Docker name | The host cannot resolve a container name | Use a published port (`http://127.0.0.1:8065`) or the public URL; no Docker commands are run |
| 4 | Writing `MATTERMOST_ENABLED=true` | No such variable exists; the token enables Mattermost, only `platforms.mattermost.enabled: false` disables it | Step 6 sets the config flag; nothing writes `MATTERMOST_ENABLED` |
| 5 | An allowlist with `@username` or `*` | The allowlist is exact 26-character user IDs; `*` is open access | Step 3a accepts `[a-z0-9]{26}` only and refuses `*` |
| 6 | `MATTERMOST_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS`, `allow_all_users: true` | They admit senders outside the allowlist | Step 3b scans `.env` and `config.yaml` (names only), Step 5 re-checks after the write |
| 7 | Approving a pairing code seen in a log or a DM | `pairing approve` grants access to whoever sent it | The skill never runs `pairing approve`; `pairing list` is read-only |
| 8 | The bot token was regenerated or shown only once and lost | The old token fails with 401 | Create a new token, re-run with `FORCE=1`; if it fails, `rollback` restores the OLD working values |
| 9 | Bot not a member of the channel | It cannot read or post there; the `hermes send` smoke test fails | Add the bot to each channel (a human step) |
| 10 | Reverse proxy without WebSocket upgrade headers | The REST call works, the WebSocket never opens | Forward `Upgrade`/`Connection` for `/api/v4/websocket` |
| 11 | Treating the first matching log line as success | The REST check passes before the WebSocket does; a later close or an old line would pass | `mm_connected` needs the gateway line AND the WebSocket line and honours later failures |
| 12 | Starting the gateway with the foreground `gateway run`, adding a daemon flag, or grepping `gateway status` text | `run` blocks the ssh call, the daemon flag does not exist (argparse exit 2), "✗ Gateway is not running" contains "running" | `gw_reload` / `gw_ready` only |
| 13 | A token in an ssh argument, a URL, or a single-quoted remote string | Leaks into `ps`; breaks on odd characters | The token goes over ssh stdin (curl `--config -`, `read -r`) |
| 14 | `config set KEY value` shows the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` there at that moment sees it (the local ssh argv stays clean) | Accepted; the output is discarded so Hermes never echoes it into chat |
| 15 | Re-running after a crashed run | A leftover `~/.hermes/.hstack-backup/platform-mattermost` would record half-written files as known-good | `snapshot` refuses; run `rollback`, then re-run |
| 16 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run the Step 0 block first |
| 17 | GNU-only flags in LOCAL commands | macOS ships bash 3.2 / BSD tools | GNU flags stay inside `remote` strings (the VPS is Linux) |
| 18 | Container-only Hermes | This skill writes the host's `~/.hermes` | Step 1 requires `hermes` on the host and aborts otherwise |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded and the Step 0 helpers are defined in this shell
- [ ] Hermes on the VPS host reports `0.22.5`
- [ ] Idempotency check ran (skipped only for a safe stored setup, unless `FORCE=1`)
- [ ] Hard gate passed with nothing written: 26-character user-ID allowlist (no `*`), URL and token shape, no open-access setting in `.env` or `config.yaml`
- [ ] Live `GET /api/v4/users/me` from the VPS accepted the token and returned the account
- [ ] Dry run shown and approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write
- [ ] `MATTERMOST_ALLOWED_USERS` written first, URL then token last; each key is in `~/.hermes/.env` exactly once, mode 600; no token in `config.yaml`
- [ ] `platforms.mattermost.enabled` set only after the writes were verified (no `MATTERMOST_ENABLED` variable)
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] Token read back from `~/.hermes/.env` returned the same account, and `mm_connected` confirmed the connection in the gateway log
- [ ] If a home channel was given, `hermes send --to mattermost` succeeded; `pairing list` was viewed and nothing was approved
- [ ] `finish` ran; any failure after the snapshot ran `rollback` and restored the previous `.env` and `config.yaml`
- [ ] Human steps: the bot was added to its channels, and an allowlisted user messaged it and got a reply

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and Mattermost failure modes.

---

## Verified against Hermes v0.22.5

Read in the Hermes source at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository.

- Env names and enabling: `plugins/platforms/mattermost/gateway_env.py:6-22` (`MATTERMOST_TOKEN` enables, `MATTERMOST_URL` is the server,
  `MATTERMOST_HOME_CHANNEL`; allowlist `MATTERMOST_ALLOWED_USERS`, allow-all `MATTERMOST_ALLOW_ALL_USERS`),
  `plugins/platforms/mattermost/plugin.yaml` (also `MATTERMOST_REPLY_MODE`, `MATTERMOST_REQUIRE_MENTION`),
  `gateway/platform_env.py:132-179`, explicit disable `gateway/config_env.py:84-109`.
- Adapter: URL and token resolution and requirements `plugins/platforms/mattermost/adapter.py:75-102`, reply mode `:121-123`,
  connect and the `users/me` authentication `:132-133,233-250`, disconnect `:264`, WebSocket loop and its log lines
  `:441-493`, mention gating `:498-512`, out-of-process sender `:596-651`, setup wizard `:655-697`, YAML bridge `:700-712`.
- Authorization: `gateway/authz_mixin.py:631-714` (order, `*` at `:714`, `GATEWAY_ALLOW_ALL_USERS` only when no allowlist at `:687-694`),
  unauthorized-DM default `:716-759`, startup warning `gateway/run_startup.py:1049-1058`, YAML `allow_all_users` bridge
  `gateway/config_loader.py:430-462`; documented default-deny `website/docs/user-guide/messaging/mattermost.md:328-331`.
- Behaviour key: `hermes_cli/config_defaults.py:1658-1663`; `hermes config set` env routing `hermes_cli/config.py:3417-3440`.
- Log lines used by `mm_connected`: `gateway/run_startup.py:1335,1352,1355,1645`, `gateway/run_adapters.py:135,925`; log files
  `hermes_logging.py:306-311,399`; `hermes logs` parser `hermes_cli/subcommands/logs.py`.
- `hermes send` and `hermes pairing`: `hermes_cli/send_cmd.py:194-262`, `hermes_cli/subcommands/pairing.py`, `hermes_cli/pairing.py:22-68`.
- Human setup (bot accounts, token, user ID, channels, proxy): `website/docs/user-guide/messaging/mattermost.md:56-146,269-285`.
- Gateway lifecycle: the sources listed in the lifecycle note under Step 0.

Not verified, and not claimed: nothing in this skill was run against a real Hermes, a real VPS, or a Mattermost server (the tests use a
stub whose command syntax is the real v0.22.5 argparse and whose behaviour is an assumption). The `users/me` response shape comes from
the adapter's use of it and Hermes' docs; no server was called. The 26-character lowercase ID format is Mattermost's, stated in the
Hermes docs (`mattermost.md:108`), not enforced by Hermes. The exact text and timestamps of a real `gateway.log` were not observed.
`hermes send --to mattermost` through the home channel was read, not exercised.
