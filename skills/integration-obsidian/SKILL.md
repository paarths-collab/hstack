---
name: integration-obsidian
description: Connect an Obsidian vault to a self-hosted Hermes agent over SSH. Obsidian is a local desktop app with no first-party API or MCP, so this skill offers two paths. Path A points Hermes' bundled obsidian skill at a vault directory on the VPS, which is the default for headless agents. Path C registers the community mcp-obsidian server against the Local REST API plugin over a private tunnel. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and any AI agent.
---

# /integration-obsidian — connect an Obsidian vault to a remote Hermes (SSH-first)

You are the engineer connecting an Obsidian vault to a self-hosted Hermes agent (v0.22.5) on the
user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of
them) work over SSH as root against the VPS. Every `bash` block below runs on the agent's
LOCAL machine (possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from
Step 0 (a thin `ssh` wrapper). Secrets are validated locally and travel to the VPS only over ssh STDIN.
Run all blocks in ONE shell session: later steps call the Step 0 functions.

Do everything autonomously; stop only for things a machine cannot do — syncing the vault onto the VPS, installing the
Local REST API plugin in the desktop app, starting an OS-level tunnel (Tailscale / Cloudflare Tunnel).

**Honest picture.** Obsidian ships **no first-party MCP** and no first-party API. What exists, and what Hermes v0.22.5 can use:

- **Path A, vault as files (default).** Hermes bundles an `obsidian` skill ("Read, search, create, and edit notes in the Obsidian vault") that is filesystem-first and takes
  the vault location from the `OBSIDIAN_VAULT_PATH` environment variable, for example from `~/.hermes/.env`, falling back to `~/Documents/Obsidian Vault`
  (`skills/note-taking/obsidian/SKILL.md:14-26`). So the native wiring is one variable. The vault directory itself must already be on the VPS, kept in sync by a tool of
  the user's choice (see the sync notes below). This skill does not clone, sync, install cron entries or write helper scripts: the earlier version of this skill did, outside
  anything that rollback could restore, and Hermes has no hook that reads them.
- **Path C, Local REST API plugin through `mcp-obsidian`.** The community plugin `coddingtonbear/obsidian-local-rest-api` runs an authenticated HTTPS server inside the desktop app
  (default `https://127.0.0.1:27124`, self-signed certificate), and `mcp-obsidian` (MarkusPfundstein) is a stdio MCP server wrapping it. Both exist only while the desktop app is open, so
  the VPS needs a private tunnel to the laptop. Hermes registers it with its ordinary stdio `mcp add`. Everything about the plugin and the wrapper (endpoints, variable names, the pin) is
  carried over from the earlier version of this skill and `VERSIONS.txt`; it was not checked against the vendors.
- **Retired:** the former "Path B" (a hand-written REST description under `/opt/data`). Hermes has no component that loads such a document, so it connected nothing. The letters A and C are kept so existing runbooks still make sense.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$OBSIDIAN_PATH` | Path selector: `A` (vault files) or `C` (Local REST API via mcp-obsidian) | Ask the user |
| `$OBSIDIAN_VAULT_PATH` | (Path A) Absolute path of the vault directory ON THE VPS, which must already exist (e.g. `/opt/data/vault`) | User's choice; the sync tool puts the vault there |
| `$OBSIDIAN_HOST` | (Path C) Tunnel host name only, no scheme or port, e.g. `vault.tail-xxxx.ts.net` | Tailscale MagicDNS / Cloudflare Tunnel dashboard |
| `$OBSIDIAN_PORT` | (Path C) Port of the plugin's HTTPS server, default `27124` | Plugin settings |
| `$OBSIDIAN_API_KEY` | (Path C) API key from the Local REST API plugin | Obsidian desktop → Settings → Community plugins → Local REST API → API Key |
| `$OBSIDIAN_TLS_MODE` | (Path C) `insecure` (default: the preflight passes `-k` for the plugin's self-signed certificate) or `strict` | Advanced users pick `strict` after installing the plugin's CA on the VPS |
| `$WRITES_ACKNOWLEDGED` | Set to `1` to confirm the agent may CREATE and MODIFY notes | Consent gate — the data destination is the user's notes |

Optional switches: `FORCE=1` (rewire), `AUTO_APPROVE=1` (skip the dry-run question), `GW_INTERRUPT=1` (let the gateway restart interrupt live chats; never set by default; Path C only).

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=integration-obsidian
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
  `gateway run` is the foreground command; it has no daemon flag.


---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked against the v0.22.5
source; it has not been run against a live host.

---

## Step 2 — idempotency check (skip if already wired)

Path A is wired when `OBSIDIAN_VAULT_PATH` is in `~/.hermes/.env`; Path C when `mcp list` shows an `obsidian` server.

```bash
if [ "${OBSIDIAN_PATH:-}" = "C" ]; then
  ALREADY=$(remote "hermes -p default mcp list 2>/dev/null | grep -cE '^ *obsidian( |\$)' || true")
else
  ALREADY=$(remote "grep -c '^OBSIDIAN_VAULT_PATH=' ~/.hermes/.env 2>/dev/null || true")
fi
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Obsidian is already wired (Path ${OBSIDIAN_PATH:-A}). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate + live pre-flight per chosen path

Nothing is written until the checks for the chosen path pass. All of it happens before `snapshot` and before the dry run; a failure here
is `ABORT: ... Nothing was written.`

**3a. Consent, path selector and format checks (local, no network).** Every value that reaches a curl config, a remote command string or `.env` is checked
against a short allow-list first, so a quote, `$`, backtick, backslash, `;` or newline never gets that far.

```bash
[ "${WRITES_ACKNOWLEDGED:-0}" = "1" ] \
  || { echo "ABORT: WRITES_ACKNOWLEDGED=1 required. The agent will create and modify notes in the vault. Nothing was written."; exit 1; }
case "${OBSIDIAN_PATH:-}" in A|C) ;; *)
  echo "ABORT: OBSIDIAN_PATH must be A or C (the former Path B no longer exists). Nothing was written."; exit 1 ;;
esac
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
vault_path_ok() {  # absolute; letters, digits, space and . _ ~ / + = @ , - only; no trailing space
  local LC_ALL=C
  case "$1" in /?*) ;; *) return 1 ;; esac
  case "$1" in *[!A-Za-z0-9._~/+=@,\ -]*|*\ ) return 1 ;; esac
  return 0
}
host_ok() {  # a host name or address: letters, digits, dots, hyphens; no scheme, port or path
  local LC_ALL=C
  case "$1" in ""|-*|.*|*[!A-Za-z0-9.-]*) return 1 ;; esac
  return 0
}
port_ok() {
  case "$1" in ""|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}
if [ "$OBSIDIAN_PATH" = "A" ]; then
  vault_path_ok "${OBSIDIAN_VAULT_PATH:-}" \
    || { echo "ABORT: OBSIDIAN_VAULT_PATH must be an absolute path made of letters, digits, spaces and . _ ~ / + = @ , - . Nothing was written."; exit 1; }
else
  OBSIDIAN_PORT="${OBSIDIAN_PORT:-27124}"
  OBSIDIAN_TLS_MODE="${OBSIDIAN_TLS_MODE:-insecure}"
  host_ok "${OBSIDIAN_HOST:-}" \
    || { echo "ABORT: OBSIDIAN_HOST must be a bare host name (letters, digits, dots, hyphens; no scheme, port or path). Nothing was written."; exit 1; }
  port_ok "$OBSIDIAN_PORT" \
    || { echo "ABORT: OBSIDIAN_PORT must be a number from 1 to 65535. Nothing was written."; exit 1; }
  case "$OBSIDIAN_TLS_MODE" in insecure|strict) ;; *)
    echo "ABORT: OBSIDIAN_TLS_MODE must be insecure or strict. Nothing was written."; exit 1 ;;
  esac
  secret_chars_ok "${OBSIDIAN_API_KEY:-}" && [ "${#OBSIDIAN_API_KEY}" -ge 20 ] \
    || { echo "ABORT: OBSIDIAN_API_KEY is empty, too short, or has characters a key never contains. Nothing was written."; exit 1; }
fi
```

### Path A — the vault directory exists on the VPS

The path travels over ssh STDIN. Nothing is created or cloned: the vault is the user's data and its sync is theirs to run.

```bash
if [ "$OBSIDIAN_PATH" = "A" ]; then
  printf '%s\n' "$OBSIDIAN_VAULT_PATH" \
    | remote 'IFS= read -r p && [ -d "$p" ] && [ -r "$p" ] && [ -w "$p" ] && [ -x "$p" ]' \
    || { echo "ABORT: the vault directory $OBSIDIAN_VAULT_PATH does not exist or is not readable and writable on the VPS. Sync the vault there first (see the sync notes). Nothing was written."; exit 1; }
  echo "OK: vault directory is present on the VPS."
fi
```

### Path C — the Local REST API answers through the tunnel

A live, side-effect-free request from the VPS with the key on ssh STDIN as a curl config. `/vault/` lists files and requires the key, so a wrong key is a `401`/`403`
here (this and the `-k` default are plugin facts carried over from the earlier version of this skill, not verified).

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  CURL_TLS=""; [ "$OBSIDIAN_TLS_MODE" = "insecure" ] && CURL_TLS="-k"
  CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$OBSIDIAN_API_KEY" \
    | remote "curl -sS $CURL_TLS -o /dev/null -w '%{http_code}' --max-time 15 --config - 'https://$OBSIDIAN_HOST:$OBSIDIAN_PORT/vault/'") || CODE=""
  case "$CODE" in
    200) echo "OK: Local REST API reachable at https://$OBSIDIAN_HOST:$OBSIDIAN_PORT/." ;;
    401|403) echo "ABORT: the Local REST API answered HTTP $CODE: the API key was rejected. Copy it again from Obsidian → Settings → Local REST API. Nothing was written."; exit 1 ;;
    ""|000) echo "ABORT: no response (HTTP none). Confirm the tunnel is up AND Obsidian desktop is running with the plugin enabled. Nothing was written."; exit 1 ;;
    *) echo "ABORT: unexpected HTTP $CODE from the Obsidian API. Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP (Path $OBSIDIAN_PATH):
  0. (already passed) consent, format checks and the live pre-flight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
$( [ "$OBSIDIAN_PATH" = "A" ] && echo "  2. Write OBSIDIAN_VAULT_PATH ($OBSIDIAN_VAULT_PATH) via 'hermes -p default config set', chmod 600" )
$( [ "$OBSIDIAN_PATH" = "A" ] && echo "  3. Nothing else: Hermes' bundled obsidian skill reads that variable; no MCP server, no gateway restart, no cron" )
$( [ "$OBSIDIAN_PATH" = "C" ] && echo "  2. Write OBSIDIAN_API_KEY (length ${#OBSIDIAN_API_KEY}), OBSIDIAN_HOST and OBSIDIAN_PORT via 'hermes -p default config set', chmod 600" )
$( [ "$OBSIDIAN_PATH" = "C" ] && echo "  3. Register MCP (answer fed on stdin): hermes -p default mcp add obsidian --env <3 \${VAR} references> --command uvx --args --from mcp-obsidian==0.2.3 mcp-obsidian" )
$( [ "$OBSIDIAN_PATH" = "C" ] && echo "     then check it with mcp list; reload the gateway (restart --detach, ensure --json); verify with mcp test obsidian" )
  4. Smoke test: $( [ "$OBSIDIAN_PATH" = "A" ] && echo "write, read back and delete one hidden probe note in the vault" || echo "GET /vault/ with the key read back from ~/.hermes/.env" )
  Any failure after step 1 restores the snapshot.

Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the settings (chmod 600, over stdin, no logging)

Each value, secret or not, travels over ssh STDIN into `hermes config set`. An UPPER_SNAKE name goes to `~/.hermes/.env` and the value is not echoed
(`hermes_cli/config_env_routing.py:36-64`, `hermes_cli/config.py:3398-3440`).

```bash
snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
put_env() {  # put_env NAME VALUE
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}
if [ "$OBSIDIAN_PATH" = "A" ]; then
  put_env OBSIDIAN_VAULT_PATH "$OBSIDIAN_VAULT_PATH" || { echo "FAIL: could not write OBSIDIAN_VAULT_PATH."; rollback; exit 1; }
else
  put_env OBSIDIAN_API_KEY "$OBSIDIAN_API_KEY" || { echo "FAIL: could not write OBSIDIAN_API_KEY."; rollback; exit 1; }
  put_env OBSIDIAN_HOST "$OBSIDIAN_HOST" || { echo "FAIL: could not write OBSIDIAN_HOST."; rollback; exit 1; }
  put_env OBSIDIAN_PORT "$OBSIDIAN_PORT" || { echo "FAIL: could not write OBSIDIAN_PORT."; rollback; exit 1; }
fi
```

Verify (prints a count per key, NEVER a value):

```bash
if [ "$OBSIDIAN_PATH" = "A" ]; then KEYS="OBSIDIAN_VAULT_PATH"; else KEYS="OBSIDIAN_API_KEY OBSIDIAN_HOST OBSIDIAN_PORT"; fi
for K in $KEYS; do
  N=$(remote "grep -c '^$K=' ~/.hermes/.env || true")
  [ "$N" = "1" ] || { echo "FAIL: $K not written exactly once (found ${N:-0})."; rollback; exit 1; }
done
```

---

## Step 6 — register the MCP server (Path C only)

Path A has no MCP server: the bundled skill uses Hermes' file tools on the vault path.

`hermes mcp add` is interactive. For a stdio server it asks one thing, "Enable all N tools? [Y/n/select]", after it has started the server and
listed its tools; a closed stdin answers "cancel", so the entry is silently NOT saved while the command still exits 0 (`hermes_cli/mcp_config.py:586-615,618-721`).
The answer is therefore fed on stdin and the result is verified with `mcp list`. `--env` must precede `--args`, which swallows every word after it; the three
`${VAR}` references are rendered from `~/.hermes/.env` when the server starts, so `config.yaml` never holds the key (`tools/mcp_tool_config.py:199-227,554-582`).
`uvx` is one of the launchers Hermes provisions itself (`tools/mcp_tool_config.py:260`), and the pin `OBSIDIAN_MCP_PKG` from `VERSIONS.txt` is passed with `uvx --from`.
The environment variable names `mcp-obsidian` reads (`OBSIDIAN_API_KEY`, `OBSIDIAN_HOST`, `OBSIDIAN_PORT`) are vendor facts that were not checked here (the pin `mcp-obsidian==0.2.3` exists on PyPI, checked against the registry listing, but was not smoke-tested): if they
are wrong, `mcp add` fails its own connection test and this step rolls back.

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  if [ "${FORCE:-0}" = "1" ]; then printf 'y\n' | remote "hermes -p default mcp remove obsidian >/dev/null 2>&1 || true"; fi
  printf 'y\n' | remote "hermes -p default mcp add obsidian --env 'OBSIDIAN_API_KEY=\${OBSIDIAN_API_KEY}' 'OBSIDIAN_HOST=\${OBSIDIAN_HOST}' 'OBSIDIAN_PORT=\${OBSIDIAN_PORT}' --command uvx --args --from mcp-obsidian==0.2.3 mcp-obsidian" >/dev/null \
    || { echo "FAIL: hermes -p default mcp add obsidian."; rollback; exit 1; }
  remote "hermes -p default mcp list | grep -E '^ *obsidian .*enabled'" >/dev/null \
    || { echo "FAIL: obsidian is not listed as enabled (add was cancelled, or the server could not start or reach the plugin)."; rollback; exit 1; }
else
  echo "Path A: no MCP server to register."
fi
```

Check that the key did not land in `config.yaml` (Path C) and that the vault setting is still in `.env`:

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  remote 'v=$(sed -n "s/^OBSIDIAN_API_KEY=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
    [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
    || { echo "FAIL: OBSIDIAN_API_KEY missing from .env or found in config.yaml."; rollback; exit 1; }
fi
```

---

## Step 7 — reload the gateway (Path C only)

Path A needs no reload: the gateway re-reads `~/.hermes/.env` for every turn outside multiplex mode (`gateway/run.py:1588-1600`), and no config or MCP entry changed.
Path C changed `config.yaml` and the MCP list, so `gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway
with a new `instance_id`. A refusal because of live sessions is reported, not overridden; see the lifecycle note in Step 0.

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
else
  echo "Path A: no gateway reload needed."
fi
```

---

## Step 8 — verify natively

Path C: `hermes mcp test` starts the server and lists its tools; exit code 0 connected, 1 failed, 3 not in the config (`hermes_cli/mcp_config.py:836-880`).
Path A: read the setting back from `~/.hermes/.env` and check the directory it names (this proves persistence; whether a chat turn finds the variable is Hermes' side, see "Verified against").

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  CONNECTED=0
  for i in 1 2 3; do
    if remote "hermes -p default mcp test obsidian" >/dev/null 2>&1; then CONNECTED=1; echo "OK: obsidian connected."; break; fi
    sleep 5
  done
  [ "$CONNECTED" = "1" ] || { echo "FAIL: obsidian did not connect within 30s."; rollback; exit 1; }
else
  remote 'v=$(sed -n "s/^OBSIDIAN_VAULT_PATH=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}; [ -n "$v" ] && [ -d "$v" ]' \
    || { echo "FAIL: OBSIDIAN_VAULT_PATH in ~/.hermes/.env does not name an existing directory."; rollback; exit 1; }
  echo "OK: OBSIDIAN_VAULT_PATH persisted and points at a directory."
fi
```

---

## Step 9 — live smoke test (values read back from `~/.hermes/.env` on the VPS)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so each value is read from the file explicitly — this also proves it persisted.
Path A creates, reads back and deletes one hidden probe note (the reason for `WRITES_ACKNOWLEDGED`); a sync tool may pick it up for a moment.
Path C repeats the pre-flight request with the key stored on the VPS.

```bash
if [ "$OBSIDIAN_PATH" = "A" ]; then
  remote 'bash -s' <<'REMOTE' || { echo "FAIL: could not write, read back and delete a probe note in the vault from ~/.hermes/.env."; rollback; exit 1; }
v=$(sed -n 's/^OBSIDIAN_VAULT_PATH=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
f="$v/.hermes-wire-test.md"
[ -d "$v" ] || exit 1
printf 'hermes wire test\n' > "$f" && [ "$(cat "$f")" = "hermes wire test" ] && rm -f "$f"
REMOTE
  echo "OK: Path A vault write succeeded and the probe note was removed."
else
  CURL_TLS=""; [ "$OBSIDIAN_TLS_MODE" = "insecure" ] && CURL_TLS="-k"
  CODE=$(remote "CURL_TLS='$CURL_TLS' bash -s" <<'REMOTE'
k=$(sed -n 's/^OBSIDIAN_API_KEY=//p' ~/.hermes/.env | tail -n1); k=${k#\"}; k=${k%\"}
h=$(sed -n 's/^OBSIDIAN_HOST=//p' ~/.hermes/.env | tail -n1); h=${h#\"}; h=${h%\"}
p=$(sed -n 's/^OBSIDIAN_PORT=//p' ~/.hermes/.env | tail -n1); p=${p#\"}; p=${p%\"}
printf 'header = "Authorization: Bearer %s"\n' "$k" \
  | curl -sS $CURL_TLS -o /dev/null -w '%{http_code}' --max-time 15 --config - "https://$h:$p/vault/"
REMOTE
)
  [ "$CODE" = "200" ] || { echo "FAIL: Obsidian smoke test returned HTTP ${CODE:-none} (401 = key on the VPS differs from the validated one, none = tunnel down or desktop app closed)."; rollback; exit 1; }
  echo "OK: GET /vault/ with the stored key returned 200."
fi
finish || exit 1
```

---

## Sync notes (Path A)

The vault must reach the VPS some other way, and the sync tool decides who is the writer of record. This skill installs none of them.

- **git**: one writer at a time. Pull on a schedule, commit and push the agent's changes; two sides editing the same file stop the pull with a conflict a human resolves.
  Use a deploy key with write access for the vault repo only.
- **Syncthing**: genuine multi-writer. Conflicts become `*.sync-conflict-*` sibling files; treat them as read-only and show them to the user.
- **rclone**: one-way agent → cloud, for output the user only reads in Obsidian. Two-way `rclone sync` is fragile.
- **Obsidian Sync (paid)**: runs inside the desktop app, not on the VPS. Do not combine it with a second sync tool on the same vault.

Hermes can schedule a plain script natively (`hermes -p default cron create <schedule> --script <file under ~/.hermes/scripts> --no-agent --name ...`, see `/hermes-cron`), which suits a
periodic `git pull`/`push`; that is a separate, user-approved step and is not done here. Never write under `.obsidian/workspace*.json` (per-device UI state), keep `~/.hermes` outside the
vault directory, and if Hermes runs in a container, bind-mount the vault so the path means the same thing inside it.

## Reachability (Path C)

The plugin exists only while the desktop app runs, so expect interruptions: laptop asleep or off the tunnel, app closed, plugin disabled after an update. `mcp test` then fails and the
tools disappear until the connection returns. A `000` / no-response result means tunnel or app, a `401` means a rotated key. Do not use Path C for time-critical agent work.

**Rotating the key:** regenerate it in the plugin settings (this invalidates the old one), then re-run this skill with `FORCE=1` and the new `OBSIDIAN_API_KEY`.

**Settings left by the earlier version of this skill** (`OBSIDIAN_PATH`, `OBSIDIAN_VAULT_DIR`, `OBSIDIAN_SYNC_MODE`, `OBSIDIAN_GIT_REMOTE`, `OBSIDIAN_API_URL`, `OBSIDIAN_TLS_MODE` in `.env`,
`/usr/local/bin/obsidian-vault-sync` with its crontab line, `/opt/data/obsidian-*.md`) are not read by anything and are not touched by this run. Remove them by hand if present
(`hermes -p default config unset NAME` for the `.env` keys).

---

## Rollback

Defined once, in Step 0 (no second copy here). It runs automatically
(`rollback; exit 1`) on every failure after `snapshot`, and it RESTORES rather than
deletes:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/integration-obsidian/` (MCP servers live in the `mcp_servers` map of `config.yaml`, `hermes_cli/mcp_config.py:233-244`, so the `obsidian` entry goes with it).
  A file that did not exist before is removed, so a first-time run leaves nothing behind, and a failed `FORCE=1` re-run gets its previous working values back.
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload`, and only then does the snapshot move to `integration-obsidian.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault,
  and run `rollback` again. A restart refused because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.

The rollback never touches the vault directory: it is user data and may be syncing to their laptop. (This run creates nothing outside `~/.hermes` except the probe note, which Step 9 deletes.)
Failures in Steps 1–4 wrote nothing, so there is nothing to roll back. If a run is interrupted after `snapshot` (crash, Ctrl-C), the snapshot dir is left in place and
the next `snapshot` refuses to run; call `rollback` first to restore the pre-crash state.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including any old key) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Assuming Obsidian has a hosted API | It doesn't. It's a desktop app; every "API" is a community plugin running on the user's laptop | Default to Path A for headless VPS agents |
| 2 | Writing a different variable name than Hermes' bundled skill reads | The bundled `obsidian` skill looks for `OBSIDIAN_VAULT_PATH`; the old `OBSIDIAN_VAULT_DIR` was read by nothing | Step 5 writes `OBSIDIAN_VAULT_PATH` |
| 3 | Path C without a tunnel | `localhost:27124` on a laptop is unreachable from the VPS | Require a Tailscale / Cloudflare Tunnel / SSH reverse-tunnel host name |
| 4 | Path C while the desktop app is closed | The plugin dies with the app; connection refused | Step 3 detects no response; tell the user to keep the app open or use Path A |
| 5 | Self-signed certificate breaks curl | The plugin's default certificate is not trusted | `OBSIDIAN_TLS_MODE=insecure` passes `-k` to the skill's own curl calls only; what `mcp-obsidian` does about it is up to that package |
| 6 | `mcp add` treated as successful because it exited 0 | With a closed stdin it cancels without saving | Feed the answer on stdin and check `mcp list` shows `obsidian` enabled (Step 6) |
| 7 | `--args` before `--env` | `--args` takes every remaining word, so `--env` after it becomes an argument of `uvx` | `--env ... --command uvx --args ...` with `--args` last |
| 8 | Writing to `.obsidian/workspace*.json` | Per-device UI state; corrupts sync | Never edit under `.obsidian/` |
| 9 | Two sync systems on one vault | Obsidian Sync plus git/Syncthing race and produce conflicts | Pick one sync mode |
| 10 | Vault path not visible to Hermes in a container | The directory is on the host only | Bind-mount it so the same path exists inside the container |
| 11 | Wikilink case-sensitivity | Obsidian resolves `[[Foo]]` case-insensitively; ext4 does not | Case-fold when resolving links; avoid names that differ only in case |
| 12 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`; `config.yaml` holds `${VAR}` references |
| 13 | Treating `gateway status` text as health | `✗ Gateway is not running` contains `running` | `gw_reload` / `gw_ready` only |
| 14 | Committing `.env` into the vault repo | If `~/.hermes` lives inside the vault directory the repo leaks secrets | Keep `~/.hermes` outside `$OBSIDIAN_VAULT_PATH` |
| 15 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 16 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished | `snapshot` refuses and aborts. Run `rollback` first, then re-run |

---

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (paths relative to the Hermes repo root); NOT run against a live Hermes, Obsidian, the plugin or uv:

- The bundled Obsidian skill and its `OBSIDIAN_VAULT_PATH` convention (including "for example from `~/.hermes/.env`"): `skills/note-taking/obsidian/SKILL.md:14-26`. Whether the agent's tool environment actually carries the variable from `.env` is that skill's concern and was not exercised.
- `config set` of an UPPER_SNAKE name goes to `.env` and is not echoed: `hermes_cli/config_env_routing.py:36-64`, `hermes_cli/config.py:858-882,3398-3440`.
- `.env` is loaded when the gateway starts and re-read per turn outside multiplex mode: `gateway/run.py:1583-1600`.
- `mcp add` stdio flow, prompts, saving, `--env` / `--args` shapes: `hermes_cli/subcommands/mcp.py`, `hermes_cli/mcp_config.py:345-361,586-615,618-721`; `mcp list` / `mcp test`: `:744-787`, `:836-880`.
- `${VAR}` rendering of a stdio `env` from `.env`, filtered child environment, Hermes-managed `uvx`: `tools/mcp_tool_config.py:199-227,554-582` and `:260` (`_MANAGED_LAUNCHERS`).
- Native scheduled script jobs (`cron create --script ... --no-agent`): `hermes_cli/subcommands/cron.py`.
- Gateway lifecycle: see the Step 0 note.

NOT verified: the Local REST API plugin's endpoints and authentication, `mcp-obsidian`'s variable names whether `uvx --from mcp-obsidian==0.2.3` (exists on PyPI, not smoke-tested) resolves and starts, how it treats the self-signed certificate, and that a chat turn uses the tools.

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (banner names 0.22.5)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] `WRITES_ACKNOWLEDGED=1` consent gate passed
- [ ] Path picked (A or C); every input passed its format check locally BEFORE any ssh call
- [ ] Path A: the vault directory exists and is readable and writable on the VPS
- [ ] Path C: the live `GET /vault/` pre-flight from the VPS returned 200 with the bearer key
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the pre-flight passed
- [ ] Path A: `OBSIDIAN_VAULT_PATH` in `~/.hermes/.env`, `chmod 600`; no MCP server, no gateway reload, no cron
- [ ] Path C: `OBSIDIAN_API_KEY`, `OBSIDIAN_HOST`, `OBSIDIAN_PORT` in `~/.hermes/.env` (key written over stdin); `config.yaml` holds only `${VAR}` references, never the key or chat
- [ ] Path C: MCP registered with `hermes -p default mcp add` (answer on stdin), listed as enabled, gateway reloaded with `gw_reload`, `mcp test obsidian` exits 0
- [ ] Smoke test passed: probe note written, read back and removed (A) or `GET /vault/` = 200 with the stored key (C)
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml`

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
