---
name: platform-teams
description: "Wire a remote Hermes 0.22.5 agent to Microsoft Teams over SSH: Azure AD bot credentials plus an AAD object-ID allowlist, a live Microsoft token preflight before any write, rollback, and log/health verification. A human must provide the public HTTPS endpoint, the bot registration and the first Teams message."
---

# /platform-teams — wire Microsoft Teams to a remote Hermes (SSH-first, Bot Framework webhook)

You are the engineer connecting Microsoft Teams to a self-hosted Hermes agent on the user's VPS.
The agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) works over SSH as
root. This skill is **source-verified against Hermes v0.22.5 only** (see "Verified against Hermes
v0.22.5" at the end); nothing here was run against a live Hermes, Azure tenant or Teams client.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS,
bash 3.2) and reaches the VPS through the `remote` helper from Step 0. Run all blocks in ONE shell
session. The client secret travels only over ssh STDIN: never in an ssh argument, a URL on a
command line, or a single-quoted remote string.

## What is automated and what is not

Teams is not headless the way Telegram is. Be explicit with the user about this up front:

| Part | Who | Notes |
|------|-----|-------|
| Create the Entra app registration / bot and its client secret (Teams CLI `teams app create`, or the Azure portal) | **Human** | Needs tenant rights. Yields the client ID, client secret and tenant ID. |
| A public HTTPS endpoint with a valid (not self-signed) TLS certificate, a reverse proxy that forwards `https://<host>/api/messages` to **plain HTTP** `127.0.0.1:3978` on the VPS, and that URL registered as the bot's messaging endpoint | **Human** | Hermes only listens on plain HTTP and terminates nothing. This skill cannot create DNS, certificates or the proxy, and cannot change the Azure registration. |
| Install the app in Teams and send the first message | **Human** | Only a real message proves the inbound path end to end. |
| The AAD object IDs for the allowlist | **Human** supplies | GUIDs from Entra ID, not e-mails or UPNs. |
| Credential preflight (a real Microsoft token request from the VPS), writes, reload, log and health verification, optional home-channel send | **This skill** | Everything before the first write is read-only. |

**What Hermes v0.22.5 does (source-verified):**

- Teams is a bundled platform plugin. It is enabled by credentials alone: `TEAMS_CLIENT_ID`,
  `TEAMS_CLIENT_SECRET` and `TEAMS_TENANT_ID` all set. There is **no `TEAMS_ENABLED` variable**
  (`gateway/config_env.py:164-225`, `plugins/platforms/teams/adapter.py:152-186`). The only way to turn it off
  while credentials exist is an explicit `platforms.teams.enabled: false` in `config.yaml`
  (`gateway/config_env.py:192-194`); this skill refuses to proceed over one.
- Inbound is the Bot Framework webhook: an aiohttp server on `TEAMS_PORT` (default 3978), route
  `/api/messages`, plus `/health` that answers `ok` (`adapter.py:71,76,410`).
- The Teams SDK (`microsoft-teams-apps`) is **not** in a plain install. The gateway installs the `teams`
  extra on first start through PM, which needs package-index access from the VPS and
  `security.allow_lazy_installs` to be true (`adapter.py:288-318`, `pm/extras.py:188-250`,
  `pm/install.py:164-189`). The first start after this skill can therefore be slow. Step 3 refuses early when lazy installs are off.
- Authorization: with no allowlist and no allow-all switch the default is **deny**, and an unknown direct
  message is answered with a pairing code that only `hermes pairing approve` can accept
  (`gateway/authz_mixin.py:631-714,751-757`). It does not fail open. This skill still requires a
  non-empty allowlist of AAD object IDs (an explicit policy choice), because the allowlist is how the
  operator and the bot agree who may drive it. `*` in any allowlist, `TEAMS_ALLOW_ALL_USERS` or
  `GATEWAY_ALLOW_ALL_USERS` opens the bot to everyone; Step 3 refuses all of them.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TEAMS_CLIENT_ID` | Entra application (client) ID, a GUID | Output of `teams app create`, or Entra ID, App registrations |
| `$TEAMS_CLIENT_SECRET` | The client secret VALUE (shown once) | Same flow. Characters `A-Z a-z 0-9 _ . ~ -` only |
| `$TEAMS_TENANT_ID` | Entra tenant ID, a GUID | Entra ID, Overview |
| `$TEAMS_ALLOWED_USERS` | Comma-separated AAD object IDs (GUIDs), at least one | Entra ID, Users, the user, Object ID (or `teams status --verbose`) |
| `$TEAMS_PUBLIC_URL` *(optional)* | The HTTPS messaging endpoint you registered, ending in `/api/messages` | The human's reverse proxy. Used only for a post-start reachability hint |
| `$TEAMS_PORT` *(optional)* | Local listen port, default 3978 | Whatever the reverse proxy forwards to |
| `$TEAMS_HOME_CHANNEL` *(optional)* | Conversation ID for cron/notification delivery | Only known after the bot has been messaged once. When set, the skill sends one test message there |

The allowlist is compared as an exact, case-sensitive string against the sender's AAD object ID
(`authz_mixin.py:86-87`, `adapter.py:521-522`); the skill lowercases the GUIDs because Entra shows them in lower case.

Confirm SSH access before doing anything:

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
SKILL_NAME=platform-teams
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

Rules used below: a failure BEFORE `snapshot` (Steps 1-3) is `exit 1` with `ABORT: ... Nothing was
written.` and never calls `rollback`. Every failure AFTER `snapshot` (Steps 5-7) is
`rollback; exit 1`. Snapshots are staged privately, checked byte for byte, and published with a
completion marker and checksums; rollback validates the whole recovery point before changing live
files and keeps it active if restoration fails.

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
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  `gateway run` is the foreground command; it has
  no `--daemon` flag.

---

## Step 1 — verify Hermes v0.22.5 on the VPS host

This skill writes the HOST's `~/.hermes/.env`, so `hermes` must be installed on the host, not only inside a container.

```bash
HERMES_BANNER=$(remote '
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

---

## Step 2 — idempotency and safety scan of what is already stored

Skip the rest only when the VPS already holds one set of Teams credentials, a GUID-only allowlist, a private
`.env` and no open-access switch. An unsafe stored setup aborts instead of being reported as "already wired".
This scan reads `~/.hermes/.env` and prints a status word only, never a value. "Already wired" means
**configured**; it does not prove the bot is connected (use Step 7's checks for that).

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
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s)-2)
    }
    return s
  }
  function guid(g) { return length(g) == 36 && g ~ /^[0-9a-fA-F]+(-[0-9a-fA-F]+)+$/ }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^TEAMS_CLIENT_ID=/) { ids++; id = value(line) }
    if (line ~ /^TEAMS_TENANT_ID=/) { tenants++; tenant = value(line) }
    if (line ~ /^TEAMS_CLIENT_SECRET=/) { secrets++; secret = value(line) }
    if (line ~ /^TEAMS_ALLOWED_USERS=/) { lists++; users = value(line) }
    if (line ~ /^(TEAMS_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) {
      v = tolower(value(line)); gsub(/[[:space:]]/, "", v)
      if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") open_access = 1
    }
    if (line ~ /^GATEWAY_ALLOWED_USERS=/) {
      n = split(value(line), parts, ",")
      for (i = 1; i <= n; i++) { p = parts[i]; gsub(/[[:space:]]/, "", p); if (p == "*") open_access = 1 }
    }
  }
  END {
    if (ids == 0 || tenants == 0 || secrets == 0 || lists == 0) { print "needs_setup"; exit }
    if (open_access || ids > 1 || tenants > 1 || secrets > 1 || lists > 1) { print "unsafe"; exit }
    if (!guid(id) || !guid(tenant) || secret !~ /^[A-Za-z0-9_.~-]+$/ || length(secret) < 20) { print "needs_setup"; exit }
    n = split(users, parts, ",")
    for (i = 1; i <= n; i++) if (!guid(parts[i])) { print "unsafe"; exit }
    print "safe"
  }' "$f"
REMOTE
) || { echo "ABORT: could not check the stored Teams setup. Nothing was written."; exit 1; }
  case "$STATE" in
    safe) echo "Teams credentials and allowlist are already stored (configuration only; this does not prove the bot is connected). Set FORCE=1 to rewrite."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Teams setup is unsafe (check file mode, duplicate keys, a GUID-only allowlist and the access overrides). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE: validate everything BEFORE anything is written

Nothing has been written yet, so every failure in Step 3 is a plain `exit 1`. Three parts: local checks
(no ssh, no network), a read-only look at the VPS, and a live Microsoft token request from the VPS.

**3a. Local checks.**

```bash
GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
csv_clean() { LC_ALL=C tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//' | LC_ALL=C tr 'A-Z' 'a-z'; }
is_guid() { printf '%s' "$1" | grep -qE "$GUID_RE"; }
TEAMS_ALLOWED_USERS=$(printf '%s' "${TEAMS_ALLOWED_USERS:-}" | csv_clean)
TEAMS_PORT=$(printf '%s' "${TEAMS_PORT:-}" | tr -d ' \t\r\n')
TEAMS_HOME_CHANNEL=$(printf '%s' "${TEAMS_HOME_CHANNEL:-}" | tr -d ' \t\r\n')
TEAMS_PUBLIC_URL=$(printf '%s' "${TEAMS_PUBLIC_URL:-}" | tr -d ' \t\r\n')

if [ -z "$TEAMS_ALLOWED_USERS" ]; then
  echo "ABORT: TEAMS_ALLOWED_USERS is empty. This skill requires at least one AAD object ID."
  echo "(Hermes itself denies unknown users and offers them a pairing code, but an explicit allowlist is the policy here.)"
  echo "Find object IDs in Entra ID, Users, Object ID. Nothing was written."
  exit 1
fi
case "$TEAMS_ALLOWED_USERS" in
  *'*'*) echo "ABORT: TEAMS_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac
BAD=$(printf '%s' "$TEAMS_ALLOWED_USERS" | tr ',' '\n' | grep -vE "$GUID_RE" | cut -c1-40 || true)
if [ -n "$BAD" ]; then
  echo "ABORT: invalid entries in TEAMS_ALLOWED_USERS (AAD object IDs are GUIDs, not e-mails or UPNs):"
  echo "$BAD"
  echo "Nothing was written."
  exit 1
fi

is_guid "${TEAMS_CLIENT_ID:-}" || { echo "ABORT: TEAMS_CLIENT_ID is not a GUID. Nothing was written."; exit 1; }
is_guid "${TEAMS_TENANT_ID:-}" || { echo "ABORT: TEAMS_TENANT_ID is not a GUID. Nothing was written."; exit 1; }
secret_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics; also keeps quotes, $, newline out of curl/.env lines
  local LC_ALL=C
  case "$1" in ""|-*|*[!A-Za-z0-9_.~-]*) return 1 ;; esac
  [ "${#1}" -ge 20 ]
}
secret_ok "${TEAMS_CLIENT_SECRET:-}" \
  || { echo "ABORT: TEAMS_CLIENT_SECRET is empty, shorter than 20 characters, starts with '-', or has characters an Entra client secret does not have (use the secret VALUE, not its ID). Nothing was written."; exit 1; }

if [ -n "$TEAMS_PORT" ]; then
  case "$TEAMS_PORT" in *[!0-9]*|"") TEAMS_PORT=0 ;; esac
  { [ "${#TEAMS_PORT}" -le 5 ] && [ "$TEAMS_PORT" -ge 1 ] && [ "$TEAMS_PORT" -le 65535 ]; } \
    || { echo "ABORT: TEAMS_PORT must be a number from 1 to 65535. Nothing was written."; exit 1; }
fi
if [ -n "$TEAMS_HOME_CHANNEL" ]; then
  printf '%s' "$TEAMS_HOME_CHANNEL" | grep -qE '^[A-Za-z0-9:@._][A-Za-z0-9:@._-]*$' \
    || { echo "ABORT: TEAMS_HOME_CHANNEL is not a Bot Framework conversation ID (letters, digits and : @ . _ - only, not starting with -). Nothing was written."; exit 1; }
fi
if [ -n "$TEAMS_PUBLIC_URL" ]; then
  printf '%s' "$TEAMS_PUBLIC_URL" | grep -qE '^https://[A-Za-z0-9.-]+(:[0-9]+)?/api/messages$' \
    || { echo "ABORT: TEAMS_PUBLIC_URL must be https://<host>/api/messages (no credentials, query or other path). Nothing was written."; exit 1; }
fi
echo "Local checks passed."
```

**3b. Read-only look at the VPS** (open-access switches, a `platforms.teams` block that would override or
disable the env settings, and whether the Teams SDK can be installed on first start). Only names are printed.

```bash
# open_access_names prints NAMES only (never values). Fail-closed: any value other than an explicit false/0/no/off counts as on.
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || exit 1
awk '
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^(TEAMS_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|GATEWAY_ALLOWED_USERS)=/) next
    n = line; sub(/=.*/, "", n)
    v = line; sub(/^[^=]*=/, "", v)
    gsub(/[\"\047[:space:]]/, "", v); v = tolower(v)
    if (n == "GATEWAY_ALLOWED_USERS") {
      m = split(v, parts, ",")
      for (i = 1; i <= m; i++) if (parts[i] == "*") on[n] = 1
    } else if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") on[n] = 1
  }
  END { for (n in on) print n }' "$f"
REMOTE
}
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env on the VPS to check for allow-all switches. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)), so users outside the allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

# A platforms.teams block in config.yaml wins over the env: an explicit enabled:false disables the platform whatever the credentials,
# and extra.client_id / client_secret / tenant_id / port / allowed_users / allow_from are read BEFORE the env values.
CFG_OUT=$(remote 'hermes -p default config get platforms.teams --json 2>&1') && CFG_RC=0 || CFG_RC=$?
if [ "$CFG_RC" != 0 ]; then
  case "$CFG_OUT" in
    *"Config key not set"*) CFG_OUT="" ;;
    *) echo "ABORT: could not read platforms.teams from the VPS config. Nothing was written."; exit 1 ;;
  esac
fi
if printf '%s' "$CFG_OUT" | grep -qE '"enabled": *false'; then
  echo "ABORT: platforms.teams.enabled is false in config.yaml. An explicit disable beats the credentials, so nothing would connect. Re-enable it deliberately (hermes -p default config set platforms.teams.enabled true), then re-run. Nothing was written."
  exit 1
fi
SHADOW=$(printf '%s' "$CFG_OUT" | grep -oE '"(client_id|client_secret|tenant_id|port|allowed_users|allow_from|group_allow_from)"' | tr -d '"' | sort -u | tr '\n' ' ' || true)
if [ -n "$SHADOW" ]; then
  echo "ABORT: platforms.teams in config.yaml already sets: $SHADOW. Those keys are read before the env values this skill writes, so the result would not be what you asked for. Remove them (hermes -p default config unset platforms.teams.extra.<key>) and re-run. Nothing was written."
  exit 1
fi

# The Teams SDK is installed by the gateway on first start (PM extra "teams"); that needs lazy installs to be allowed.
lazy_env_off() {  # exit 0 when ~/.hermes/.env sets HERMES_DISABLE_LAZY_INSTALLS to 1/true/yes
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
[ -f "$f" ] || exit 1
awk '
  {
    line = $0
    sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^HERMES_DISABLE_LAZY_INSTALLS=/) next
    v = line; sub(/^[^=]*=/, "", v); gsub(/[\"\047[:space:]]/, "", v); v = tolower(v)
    if (v == "1" || v == "true" || v == "yes") found = 1
  }
  END { exit !found }' "$f"
REMOTE
}
LAZY=$(remote 'hermes -p default config get security.allow_lazy_installs 2>/dev/null' | tr -d '[:space:]' | tr 'A-Z' 'a-z') || LAZY=""
LAZY_OFF=0
{ [ "$LAZY" = false ] || lazy_env_off; } && LAZY_OFF=1
if [ "$LAZY_OFF" = 1 ] && [ "${TEAMS_SDK_PREINSTALLED:-0}" != "1" ]; then
  echo "ABORT: lazy installs are off on the VPS (security.allow_lazy_installs / HERMES_DISABLE_LAZY_INSTALLS), so the gateway cannot install the Teams SDK (microsoft-teams-apps) on first start. Install the teams extra yourself, then re-run with TEAMS_SDK_PREINSTALLED=1. Nothing was written."
  exit 1
fi
echo "VPS look-over passed: no open-access switch, no overriding platforms.teams block."
```

**3c. Live Microsoft preflight, run from the VPS** (this also proves the VPS can reach Microsoft). It is the
same client-credentials request Hermes makes for its Bot Framework token (`adapter.py:85-93`): a
side-effect-free token request, which shows up as a sign-in in the tenant's logs. The secret rides ssh
stdin as a curl config; the token that comes back is checked for and never printed.

```bash
aad_token_check() {  # aad_token_check TENANT CLIENT SECRET: 0 = a token was issued; sets AAD_ERROR / AAD_CODES on a rejection
  local body
  AAD_ERROR=""; AAD_CODES=""
  body=$(printf 'url = "https://login.microsoftonline.com/%s/oauth2/v2.0/token"\ndata = "grant_type=client_credentials&client_id=%s&client_secret=%s&scope=https%%3A%%2F%%2Fapi.botframework.com%%2F.default"\n' "$1" "$2" "$3" \
    | remote "curl -sS --max-time 15 --config -" 2>/dev/null) || { AAD_ERROR=unreachable; return 2; }
  case "$body" in *'"access_token"'*) return 0 ;; esac
  AAD_ERROR=$(printf '%s' "$body" | sed -n 's/.*"error" *: *"\([^"]*\)".*/\1/p' | head -n1)
  AAD_CODES=$(printf '%s' "$body" | sed -n 's/.*"error_codes" *: *\[\([0-9, ]*\)\].*/\1/p' | head -n1)
  return 1
}
aad_token_check "$TEAMS_TENANT_ID" "$TEAMS_CLIENT_ID" "$TEAMS_CLIENT_SECRET" && AAD_RC=0 || AAD_RC=$?
if [ "$AAD_RC" != 0 ]; then
  if [ "$AAD_ERROR" = unreachable ]; then
    echo "ABORT: the VPS could not reach login.microsoftonline.com. Check its outbound HTTPS. Nothing was written."
  else
    echo "ABORT: Microsoft rejected the credentials (error: ${AAD_ERROR:-none}, AADSTS code: ${AAD_CODES:-none}). Typical codes: 7000215 wrong secret (paste the secret VALUE), 7000222 secret expired, 700016 client ID not found in this tenant, 90002 tenant not found. Nothing was written."
  fi
  exit 1
fi
echo "Microsoft accepted the credentials (Bot Framework token issued from the VPS)."
```

The AADSTS hints above are Microsoft's published codes, not Hermes source. This preflight proves the
credentials work; it cannot prove the Azure bot registration's messaging endpoint, the app's
installation in Teams, or any user's ability to reach the bot.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$TEAMS_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
if [ -n "$TEAMS_HOME_CHANNEL" ]; then
  HOME_LINE="Send ONE test message to the home channel conversation with 'hermes send --to teams'"
else
  HOME_LINE="No home-channel message (TEAMS_HOME_CHANNEL not set)"
fi
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) local checks, VPS look-over, live Microsoft token request. Nothing written yet.
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Write TEAMS_ALLOWED_USERS ($USERS_N AAD object ID(s)) via 'hermes -p default config set' (value sent over ssh stdin)
  3. Write TEAMS_PORT (${TEAMS_PORT:-default 3978}) and TEAMS_HOME_CHANNEL (${TEAMS_HOME_CHANNEL:-none}) when supplied
  4. Write TEAMS_CLIENT_ID, TEAMS_TENANT_ID, then TEAMS_CLIENT_SECRET (length ${#TEAMS_CLIENT_SECRET}) LAST, over ssh stdin; chmod 600 ~/.hermes/.env
  5. Verify the keys landed (counts only) and that the secret is not in config.yaml
  6. Reload: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
     (the first start installs the Teams SDK and can take a while; the restart is refused when live sessions exist unless GW_INTERRUPT=1 is set)
  7. Verify: gateway log shows teams connected, http://127.0.0.1:${TEAMS_PORT:-3978}/health answers ok (the port stored in .env, else 3978), the stored secret still gets a Microsoft token
  8. $HOME_LINE
  9. Human step afterwards: install the app in Teams and send the bot a message from an allowlisted account

The client secret is NEVER printed in plaintext.
EOF
```

Wait for explicit confirmation (or `AUTO_APPROVE=1`). If the user declines: `echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write (allowlist first, client secret last)

Each value travels as ONE line on ssh stdin and is read by `read -r` on the VPS; the output of
`hermes -p default config set` is discarded so Hermes can never echo a value into chat. No value starts with
`-` (Step 3 checked), so no `--` separator is needed. `config set` routes UPPER_SNAKE names to `~/.hermes/.env`
(`hermes_cli/config.py:3417-3440`); credentials never go to `config.yaml`.

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put TEAMS_ALLOWED_USERS "$TEAMS_ALLOWED_USERS" \
  || { echo "FAIL: could not write TEAMS_ALLOWED_USERS."; rollback; exit 1; }
if [ -n "$TEAMS_PORT" ]; then
  put TEAMS_PORT "$TEAMS_PORT" || { echo "FAIL: could not write TEAMS_PORT."; rollback; exit 1; }
fi
if [ -n "$TEAMS_HOME_CHANNEL" ]; then
  put TEAMS_HOME_CHANNEL "$TEAMS_HOME_CHANNEL" || { echo "FAIL: could not write TEAMS_HOME_CHANNEL."; rollback; exit 1; }
fi
put TEAMS_CLIENT_ID "$TEAMS_CLIENT_ID" \
  || { echo "FAIL: could not write TEAMS_CLIENT_ID."; rollback; exit 1; }
put TEAMS_TENANT_ID "$TEAMS_TENANT_ID" \
  || { echo "FAIL: could not write TEAMS_TENANT_ID."; rollback; exit 1; }
put TEAMS_CLIENT_SECRET "$TEAMS_CLIENT_SECRET" \
  || { echo "FAIL: could not write TEAMS_CLIENT_SECRET."; rollback; exit 1; }
```

Verify the write (counts and the non-secret allowlist only; never prints the secret):

```bash
COUNT=$(remote 'grep -cE "^(TEAMS_CLIENT_ID|TEAMS_TENANT_ID|TEAMS_CLIENT_SECRET|TEAMS_ALLOWED_USERS)=." ~/.hermes/.env 2>/dev/null; true')
GOT_USERS=$(remote 'sed -n "s/^TEAMS_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
if [ "$COUNT" != "4" ] || [ "$GOT_USERS" != "$TEAMS_ALLOWED_USERS" ]; then
  echo "FAIL: Teams settings did not land (key count ${COUNT:-0}, need 4; or the stored allowlist differs). Rolling back."
  rollback; exit 1
fi
case "$GOT_USERS" in
  *'*'*) echo "FAIL: the stored allowlist contains a wildcard (*). Rolling back."; rollback; exit 1 ;;
esac
MODE=$(remote 'stat -c %a ~/.hermes/.env 2>/dev/null || stat -f %Lp ~/.hermes/.env')
[ "$MODE" = "600" ] || { echo "FAIL: ~/.hermes/.env is mode ${MODE:-?}, not 600. Rolling back."; rollback; exit 1; }
remote 'v=$(sed -n "s/^TEAMS_CLIENT_SECRET=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml 2>/dev/null' \
  || { echo "FAIL: the client secret is missing from .env or was found in config.yaml. Rolling back."; rollback; exit 1; }
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  echo "FAIL: after the write, ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
  rollback; exit 1
fi
echo "Teams settings confirmed in ~/.hermes/.env (mode 600)."
```

---

## Step 6 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a
ready gateway with a new `instance_id`. A refusal because of live sessions is reported, not overridden. The
first start also installs the Teams SDK; if that takes longer than the readiness window the reload fails,
the run rolls back, and a re-run is quicker once the install has finished.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 7 — verify the adapter is connected (poll up to 60 s)

Evidence, in order: the gateway log says Teams connected (the strings come from the gateway runner and the
adapter: `✓ teams connected`, `[teams] Webhook server listening`; failures are `✗ teams failed to connect`,
`✗ teams error`, `Fatal teams adapter error`, `[teams] Failed to connect`, and the startup summary `... failed to start and are parked`), the adapter's own `/health` route answers `ok`
on the VPS, and the secret read back from `~/.hermes/.env` still gets a Microsoft token. The latest
status-bearing Teams line wins, so an older success cannot mask a later failure.

```bash
CONNECTED=0
for i in $(seq 1 12); do
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 300 2>&1") || LOG_STATUS=$?
  if [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | awk '
    {
      line = tolower($0)
      if (line !~ /teams/) next
      if (line ~ /disconnected|failed to connect|teams error|fatal teams adapter error|parked|non-retryable|no adapter (available )?for|could not be installed|\(degraded\)|extra .teams. unavailable/) connected = 0
      else if (line ~ /teams connected|\[teams\] webhook server listening/) connected = 1
    }
    END { exit !connected }'; then
    CONNECTED=1
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Teams did not appear as connected in the gateway log within 60s. Rolling back."; rollback; exit 1; }
echo "OK: gateway log reports Teams connected."

# The port Hermes uses is whatever TEAMS_PORT holds now (this run's value, or one stored earlier), else 3978 (adapter.py:71,367).
EFFECTIVE_PORT=$(remote 'sed -n "s/^TEAMS_PORT=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r ")
case "$EFFECTIVE_PORT" in ""|*[!0-9]*) EFFECTIVE_PORT=3978 ;; esac
HEALTH=$(remote "curl -fsS --max-time 5 http://127.0.0.1:$EFFECTIVE_PORT/health" 2>/dev/null) || HEALTH=""
[ "$HEALTH" = "ok" ] || { echo "FAIL: the Teams webhook listener did not answer ok on 127.0.0.1:$EFFECTIVE_PORT/health. Rolling back."; rollback; exit 1; }
echo "OK: the webhook listener answers on 127.0.0.1:$EFFECTIVE_PORT."

remote 'bash -s' <<'REMOTE' || { echo "FAIL: the secret stored on the VPS did not get a Microsoft token. Rolling back."; rollback; exit 1; }
get() { v=$(sed -n "s/^$1=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}; printf '%s' "$v"; }
body=$(printf 'url = "https://login.microsoftonline.com/%s/oauth2/v2.0/token"\ndata = "grant_type=client_credentials&client_id=%s&client_secret=%s&scope=https%%3A%%2F%%2Fapi.botframework.com%%2F.default"\n' \
  "$(get TEAMS_TENANT_ID)" "$(get TEAMS_CLIENT_ID)" "$(get TEAMS_CLIENT_SECRET)" | curl -sS --max-time 15 --config -) || exit 1
case $body in *'"access_token"'*) exit 0 ;; esac
exit 1
REMOTE
echo "OK: the stored credentials still get a Bot Framework token."
```

Optional checks that need the human's inputs. The public-URL probe is a hint only (it runs from the VPS, so
split-DNS or hairpin NAT can differ from what Teams sees); a reply of any HTTP status shows DNS, TLS and the
proxy answer, and 502/503/504 or no answer means the proxy cannot reach Hermes. The home-channel send uses
the native `hermes send` (a standalone Bot Framework post that needs the conversation to exist already) and
posts one message.

```bash
if [ -n "$TEAMS_PUBLIC_URL" ]; then
  EP=$(remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 '$TEAMS_PUBLIC_URL'" 2>/dev/null) || EP=000
  case "$EP" in
    200|400|401|403|404|405) echo "NOTE: $TEAMS_PUBLIC_URL answered HTTP $EP from the VPS (DNS, TLS and the proxy respond). Whether Teams can reach it is NOT verified." ;;
    *) echo "WARN: $TEAMS_PUBLIC_URL gave HTTP ${EP:-none} from the VPS. Teams will not deliver messages until the proxy forwards /api/messages to 127.0.0.1:$EFFECTIVE_PORT." ;;
  esac
fi
if [ -n "$TEAMS_HOME_CHANNEL" ]; then
  remote 'hermes -p default send --to teams "hstack: platform-teams setup check (safe to ignore)"' >/dev/null \
    || { echo "FAIL: hermes send --to teams failed (wrong TEAMS_HOME_CHANNEL, or the app is not installed in that conversation). Rolling back; re-run without TEAMS_HOME_CHANNEL and set it later."; rollback; exit 1; }
  echo "OK: one test message was sent to the Teams home channel."
fi
finish || exit 1
echo "Teams is configured and the gateway reports it connected. A real Teams message from an allowlisted user is still the only proof of the inbound path."
```

---

## Step 8 — human smoke test and day-2

```bash
FIRST_USER=$(printf '%s' "$TEAMS_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted account (AAD object ID $FIRST_USER):
  1. Make sure the app is installed in that user's Teams (teams app get <teamsAppId> --install-link, or an admin upload).
  2. Open a direct message with the bot and send "hello". Expect a reply within seconds.
  3. In group chats and channels the bot answers only when @mentioned (unless TEAMS_REQUIRE_MENTION is changed).

If it stays silent, in this order:
  - hermes -p default logs gateway -n 100 on the VPS: look for "[teams]" lines and "Unauthorized".
  - The sender's AAD object ID must equal an entry in TEAMS_ALLOWED_USERS exactly (an e-mail will never match).
  - The bot's messaging endpoint in Azure must equal the proxy URL and the proxy must forward /api/messages to plain HTTP 127.0.0.1:$EFFECTIVE_PORT.
    A log line like  "UNKNOWN / HTTP/1.0" 400  means the proxy forwarded HTTPS to Hermes' plain-HTTP listener.
EOF
```

Add or remove people later without hand-editing: an unknown user who messages the bot receives a pairing code,
and you approve it (approval also adds the ID to the allowlist; `hermes_cli/pairing.py`, `gateway/pairing.py:62-160`).

```bash
remote 'hermes -p default pairing list'
# approve a code the user was shown:  remote 'hermes -p default pairing approve teams <CODE>'
```

---

## Rollback

Defined once, in Step 0. It runs automatically (`rollback; exit 1`) on every failure after `snapshot`. It does not
delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/platform-teams/` (a file that did not
  exist before is removed, so a first run leaves nothing behind; a `FORCE=1` re-run gets its previous working values back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `platform-teams.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.

Failures before `snapshot` (Steps 1-3, a declined dry run) wrote nothing, so there is nothing to roll back. If a run is interrupted after
`snapshot` (crash, Ctrl-C), the snapshot dir is left in place and the next `snapshot` refuses to run; call `rollback` first.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including old secrets) at mode 600; delete it once you no longer need the undo.

To remove Teams entirely (destructive, only if the user asks), then reload with `gw_reload`:

```bash
for k in TEAMS_CLIENT_SECRET TEAMS_CLIENT_ID TEAMS_TENANT_ID TEAMS_ALLOWED_USERS TEAMS_PORT TEAMS_HOME_CHANNEL; do
  remote "hermes -p default config unset $k >/dev/null 2>&1 || true"
done
gw_reload
```

Also delete the app registration and rotate the client secret in Entra if the credentials were exposed.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Looking for a `TEAMS_ENABLED` switch | It does not exist in v0.22.5: credentials alone enable Teams, and only `platforms.teams.enabled: false` blocks it | Step 3b refuses over an explicit disable; the skill never writes `TEAMS_ENABLED` |
| 2 | `TEAMS_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS` or a `*` in `TEAMS_ALLOWED_USERS` / `GATEWAY_ALLOWED_USERS` | Anyone who can message the bot can drive it | Step 3 refuses before any write and Step 5 re-checks after it (names only) |
| 3 | Allowlist of e-mails or UPNs | The match is an exact string compare against the sender's AAD object ID | Step 3a requires GUIDs |
| 4 | No public HTTPS endpoint, self-signed certificate, or the proxy forwarding HTTPS to Hermes | Teams cannot deliver; the log shows `"UNKNOWN / HTTP/1.0" 400` | Human step; Step 7's URL probe is only a hint from the VPS |
| 5 | Messaging endpoint in Azure differs from the proxy URL | Teams posts to the old URL; Hermes never sees a message | Human step; re-register with `teams app update --id <id> --endpoint <url>` |
| 6 | Teams SDK not installed | First start installs `microsoft-teams-apps` via PM; lazy installs off or no package-index access means `MISSING_SDK` | Step 3b refuses when lazy installs are off; the log shows `could not be installed` otherwise |
| 7 | First start slower than the readiness window | The SDK install runs inside startup, so `gw_reload` can fail and roll back | Re-run: the install has finished, so the second start is fast |
| 8 | Client secret is the secret ID, not the VALUE; or it expired | Microsoft rejects it (AADSTS7000215 / 7000222) | Step 3c fails before any write; mint a new secret and re-run with `FORCE=1` |
| 9 | A `platforms.teams.extra.*` block in `config.yaml` | `extra` credentials, port and allowlists are read before the env values | Step 3b aborts and names the keys |
| 10 | `echo >> .env`, or a secret in `config.yaml`, an ssh argument or a URL | Merge risk and leaks into `ps` / git | `config set` over stdin only; Step 5 checks the secret is not in `config.yaml` |
| 11 | Port 3978 already in use | The adapter's connect fails (`CONNECT_FAILED`) | Set `TEAMS_PORT`; change the proxy to match |
| 12 | Unknown users receive a pairing code | `allowlist_suppresses_pairing` is not set for Teams, so a DM from outside the allowlist is answered with a code (it grants nothing until approved) | Expected; approve with `hermes pairing approve teams <CODE>` or ignore |
| 13 | Container vs host confusion | A container install reads its own data dir, not the host's `~/.hermes/.env` | Step 1 requires `hermes` on the host and aborts otherwise |
| 14 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-teams/` behind | `snapshot` refuses so a half-written state is never captured as known-good | Run `rollback`, then re-run |
| 15 | `hermes config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees it (the local ssh argv stays clean) | Accepted; the write output is discarded so Hermes can never echo it into chat |
| 16 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run the Step 0 block first |
| 17 | Pasting gateway logs into chat | Logs can contain tenant and user identifiers | Review before sharing; the skill prints only matching status lines |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes `0.22.5` verified on the VPS host
- [ ] Idempotency scan ran (stored setup safe, or `FORCE=1`), and an unsafe stored setup aborted
- [ ] HARD GATE passed with nothing written: GUID-only allowlist (no `*`), GUID client and tenant IDs, well-formed secret, no open-access switch, no overriding or disabling `platforms.teams` block, lazy installs allowed (or `TEAMS_SDK_PREINSTALLED=1`)
- [ ] The live Microsoft token request from the VPS succeeded BEFORE the snapshot
- [ ] Dry run shown to the user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write; allowlist written before the client secret; `~/.hermes/.env` is mode 600; the secret is not in `config.yaml`
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] Gateway log reports `teams connected`; `/health` answered `ok`; the stored secret still gets a Microsoft token; `finish` ran
- [ ] If `TEAMS_HOME_CHANNEL` was set, `hermes send --to teams` delivered one test message
- [ ] Any failure after the snapshot ran `rollback` and restored the prior `.env` and `config.yaml`
- [ ] Human, outside this skill: the app is registered with the public HTTPS endpoint, installed in Teams, and an allowlisted user got a reply

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repo root.

- Env names and enablement: `plugins/platforms/teams/plugin.yaml` (`requires_env`, `optional_env`), `adapter.py:152-186` (`_credentials`, `validate_config`, `_env_enablement`), `adapter.py:839-858` (`register`: `required_env`, `cron_deliver_env_var="TEAMS_HOME_CHANNEL"`, `allowed_users_env="TEAMS_ALLOWED_USERS"`, `allow_all_env="TEAMS_ALLOW_ALL_USERS"`). No `TEAMS_ENABLED` anywhere. Enablement pass: `gateway/config_env.py:164-225`, `:286-297`, activation evidence `gateway/platform_activation.py:98-133`; explicit disable `gateway/config_env.py:192-194`. `extra` credentials win: `adapter.py:152-164`.
- Transport: port 3978 and `/api/messages` `adapter.py:71,76`; `/health` route `:410`; connect and log lines `:390-441`, `"[teams] Webhook server listening"` `:436`, `"[teams] Failed to connect"` `:441`, `MISSING_SDK` / `MISSING_CREDENTIALS` `:395-398`. Plain-HTTP listener behind a TLS proxy: `website/docs/user-guide/messaging/teams.md:76,243-259`.
- SDK install: `adapter.py:288-318`; PM extra and lazy-install policy `pm/extras.py:188-250`, `pm/install.py:164-189`, default `hermes_cli/config_defaults.py:1811`; extra definition `pyproject.toml:411-414`; `[all]` does not include `teams` (`pyproject.toml:503-534`).
- Token request that the preflight copies: `adapter.py:85-93` (`login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, `client_credentials`, scope `https://api.botframework.com/.default`).
- Authorization: `gateway/authz_mixin.py:86-87` (`*` and exact match), `:631-714` (allow-all, pairing store, default deny with no allowlist), `:751-757` (pairing DM behavior; Teams does not declare `allowlist_suppresses_pairing`); sender id `adapter.py:521-522`; card-click gate `:660-681`. Pairing approval adds to the allowlist: `gateway/pairing.py:62-160`; CLI `hermes_cli/subcommands/pairing.py`.
- `config set/get/unset`: `hermes_cli/config.py:3417-3440` (env routing, value not echoed), `:3536-3581` (`get`, `--json`, "Config key not set"), `:3589-3640` (`unset`). `hermes send`: `hermes_cli/send_cmd.py:194-240`; home channel `tools/send_message_tool.py:208-255,400-413`; Teams standalone sender `adapter.py:190-245`.
- Logs: `hermes logs gateway` reads `gateway.log`, which includes the `plugins.platforms` loggers (`hermes_logging.py:306-311`); runner lines `gateway/run_startup.py:1352,1355`, `gateway/run_adapters.py:375-376`.

**Not verified:** nothing was run against a real Hermes, Azure tenant, Teams client or reverse proxy. The Microsoft token request is the documented client-credentials grant that the adapter uses, but it was never sent to Microsoft; the AADSTS hints are Microsoft's published codes. Behaviour of every `hermes` command in the offline tests is a stub written from the source's output strings (the argparse syntax is real). Whether `aadObjectId` arrives lower-case in a live activity is assumed. The public endpoint, the Azure bot registration, tenant admin consent and Teams delivery are human steps that this skill cannot check from the VPS. The `hermes pm install --extra teams` command exists (`hermes_cli/main.py:679-682`) but is not called by this skill because the offline parser harness does not cover it.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway failure modes.
