---
name: <skill-name>
description: <one-sentence what it does + when to use it>
---

# /<skill-name> — <short title>

You are the engineer doing <X> for the user. The agent (Hermes, Codex, Claude Code,
Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0,
which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Secrets are generated or pasted locally, validated locally, and travel
to the VPS only over ssh STDIN. Run all blocks in ONE shell session — later steps call the
Step 0 functions.

Do everything autonomously; stop only for things a machine cannot do (mint a token,
scan a QR code, send the first message).

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$<SECRET>` | The integration's API token | `<mint-url-here>` |

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
SKILL_NAME=<skill-name>
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
  The foreground command is `gateway run`; no daemon flag exists on any gateway subcommand.

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

```bash
ALREADY=$(remote "hermes -p default mcp list 2>/dev/null | grep -ci '<skill-name>' || true")
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Already wired. Re-run with FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate the credential BEFORE anything is written

Two checks, both before `snapshot` and before the dry run. If either fails, nothing has
touched the VPS and the skill stops.

**3a. Format check (local, no network).** Reject empty values and any character that could
break a curl config line or a `.env` line (whitespace, quotes, backslash, `$`, newline).
Add the vendor's documented prefix check here.

```bash
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
secret_chars_ok "$<SECRET>" \
  || { echo "ABORT: <SECRET> is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$<SECRET>" in <expected_prefix>*) ;; *)
  echo "ABORT: <SECRET> does not start with <expected_prefix>. Nothing was written."; exit 1 ;;
esac
```

**3b. Live vendor preflight, run from the VPS** (proves the server's egress works too).
The secret travels over ssh STDIN as a curl config, so it never appears in argv, a URL on
a command line, or a quoted remote string. Use an endpoint the skill already documents
that has no side effects (`/me`, `/user`, `/ping`, list-1-item).

```bash
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$<SECRET>" \
  | remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - '<REST_BASE>/me'")
[ "$CODE" = "200" ] || { echo "ABORT: <vendor> rejected the credential (HTTP ${CODE:-none}). Nothing was written."; exit 1; }
```

Other auth shapes — only the `printf` line changes:

- URL-embedded token (Telegram style): `printf 'url = "https://api.example.com/bot%s/getMe"\n' "$<SECRET>" | remote "curl -fsS --max-time 15 --config -"`
- Basic auth: `printf 'user = "%s:%s"\n' "$USER_ID" "$<SECRET>"`
- Custom header: `printf 'header = "X-Api-Key: %s"\n' "$<SECRET>"`
- Extra non-secret headers or a request body go on the `curl` command line, not in the config.

If the vendor documents no side-effect-free endpoint, keep 3a and say in one line here
that no live pre-write check exists. Do not fake one.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) credential format + live <vendor> preflight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write <SECRET_NAME> (length: ${#<SECRET>}) to ~/.hermes/.env via 'hermes -p default config set', chmod 600
  3. Register MCP: hermes -p default mcp add <skill-name> --url <URL> --auth header (token reference only)
  4. Reload gateway: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready
  5. Verify: hermes -p default mcp test <skill-name> (exit 0 = connected)
  6. Smoke test with the value read back from ~/.hermes/.env on the VPS
  Any failure after step 1 restores the snapshot.

The secret will NEVER be printed in plaintext.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user
declines: `echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the secret (chmod 600, over stdin, no logging)

```bash
snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
printf '%s\n' "$<SECRET>" \
  | remote 'IFS= read -r v && hermes -p default config set <SECRET_NAME> "$v" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env' \
  || { echo "FAIL: could not write <SECRET_NAME>."; rollback; exit 1; }
```

For an HTTP MCP server with header auth, `<SECRET_NAME>` is `MCP_<SERVER_NAME>_API_KEY` (name upper-cased, non-alphanumerics to `_`): that is the
variable Hermes itself reads for the server's `Authorization: Bearer ${…}` header (`hermes_cli/mcp_config.py:305-336`). `config set` routes an
UPPER_SNAKE name to `.env` and never echoes the value (`hermes_cli/config.py:3417-3440`).

Verify the write (prints a count, never the value):

```bash
WROTE=$(remote "grep -c '^<SECRET_NAME>=' ~/.hermes/.env || true")
[ "$WROTE" = "1" ] || { echo "FAIL: <SECRET_NAME> not written exactly once (found ${WROTE:-0})."; rollback; exit 1; }
```

---

## Step 6 — register the MCP server (or REST endpoint if no MCP exists)

`hermes mcp add` is interactive: it asks whether the server needs authentication and whether to enable all discovered tools, and
a closed stdin answers "cancel" to the second question, so the server is silently NOT saved. Answer both on stdin. Because
`MCP_<SERVER_NAME>_API_KEY` is already in `.env` (Step 5), Hermes skips the token prompt and stores only the
`Authorization: Bearer ${MCP_<SERVER_NAME>_API_KEY}` reference in `config.yaml` (`hermes_cli/mcp_config.py:545-584,618-722`).
`mcp add` exits 0 even when it saved nothing, so the result is verified, not assumed.

```bash
if [ "${FORCE:-0}" = "1" ]; then remote "hermes -p default mcp remove <skill-name> >/dev/null 2>&1 || true"; fi
printf 'y\ny\n' | remote "hermes -p default mcp add <skill-name> --url '<MCP_URL>' --auth header" >/dev/null \
  || { echo "FAIL: hermes -p default mcp add."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *<skill-name> .*enabled'" >/dev/null \
  || { echo "FAIL: <skill-name> is not listed as enabled (add was cancelled or the connection failed)."; rollback; exit 1; }
```

Stdio servers use `hermes -p default mcp add <skill-name> --env KEY='${VAR}' --command npx --args -y <package>`; `--args` swallows
everything after it, so it must be the last option. Check the secret did not land in `config.yaml` (and is still in `.env`):

```bash
remote 'v=$(sed -n "s/^<SECRET_NAME>=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
  || { echo "FAIL: secret missing from .env or found in config.yaml."; rollback; exit 1; }
```

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. A refusal because of live sessions is reported, not overridden; see the lifecycle note in Step 0.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify the connection natively (`mcp test`, within 30s)

`hermes mcp test` connects to the server and lists its tools; its exit code is 0 connected, 1 connection failed, 3 server not in the
config (`hermes_cli/mcp_config.py:836-880`). Start a new session (or `/reload-mcp`) for running chats to see the tools; the
gateway reload in Step 7 already gives new sessions a fresh load.

```bash
CONNECTED=0
for i in 1 2 3; do
  if remote "hermes -p default mcp test <skill-name>" >/dev/null 2>&1; then CONNECTED=1; echo "OK: <skill-name> connected."; break; fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: <skill-name> did not connect within 30s."; rollback; exit 1; }
```

---

## Step 9 — live tool-call smoke test (value read back from `~/.hermes/.env`)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so `$<SECRET_NAME>`
would be empty there. Read the value from the file explicitly — this also proves it
persisted. Replace the URL with a real, side-effect-free call.

```bash
CODE=$(remote 'bash -s' <<'REMOTE'
v=$(sed -n 's/^<SECRET_NAME>=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - '<REST_BASE>/me'
REMOTE
)
[ "$CODE" = "200" ] || { echo "FAIL: smoke test returned HTTP ${CODE:-none} (401 = bad token, 403 = scope missing)."; rollback; exit 1; }
echo "OK: <vendor> reachable with the token stored on the VPS."
finish || exit 1
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/<skill-name>.prev` for a
manual undo (see Rollback).

---

## Rollback

Defined once, in Step 0. It runs automatically (`rollback; exit 1`) on every failure after
`snapshot`. It does not delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/<skill-name>/` (a file that did not exist before is removed,
  so a first-time run leaves nothing behind; a `FORCE=1` re-run gets its previous working
  value back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `<skill-name>.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.

Failures before `snapshot` (format check, live preflight, declined dry run) wrote nothing,
so there is nothing to roll back.
If a run is interrupted after `snapshot` (crash, Ctrl-C), the snapshot dir is left in place and
the next `snapshot` refuses to run; call `rollback` first to restore the pre-crash state.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0
functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

If your Hermes build keeps MCP registrations outside `config.yaml`, also run
`hermes -p default mcp remove <skill-name>` on the VPS. The `.prev` folder holds the previous `.env`
(including old secrets) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating a substring `running` in `gateway status` as healthy, or inventing a daemon flag for the foreground `gateway run` | `✗ Gateway is not running` contains `running`; `gateway run` blocks in the foreground and no daemon flag exists (argparse exit 2) | `gw_reload`/`gw_ready` only (`gateway restart --detach`, then `gateway ensure --json` must exit 0 with `"state":"ready"`) |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes -p default config set` (or the documented `grep -v` + `printf` fallback) |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`; `config.yaml` holds `${VAR}` only |
| 4 | Injecting the secret with `sed 's/.../'"$VAR"'/'` | Tokens contain `/+=`; and `'\"\$VAR\"'` expands an unset REMOTE variable to an empty string | Never inject the value. Use the remote-literal `\${VAR}` with the `\|` delimiter |
| 5 | Container vs host confusion | Skill assumed wrong layer | Always check `whoami; hostname` first |
| 6 | Skipping the verify step | "Silent success" — config written, never picked up | `mcp list` must show the server enabled and `mcp test` must exit 0 |
| 7 | Writing before the live preflight passes | A typo'd or revoked token replaces a working one | Step 3 runs before `snapshot`; failures there write nothing |
| 8 | Smoke test uses `\$TOKEN` over ssh | The ssh shell never loaded `.env`: empty header, false `401`, rollback of a good token | Read the value from `~/.hermes/.env` on the VPS (Step 9) |
| 9 | Secret in ssh argv, a URL, or a single-quoted remote string | Leaks into `ps`; breaks on tokens containing `'` | Send it over STDIN (`printf ... \| remote ...`, curl `--config -`) |
| 10 | `rollback` that deletes instead of restoring, or defined after it is called | A failed `FORCE=1` re-run destroys the working value; or rollback never runs | Define `snapshot`/`rollback`/`finish` in Step 0; rollback restores the snapshot |
| 11 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 12 | GNU-only flags in LOCAL commands | macOS ships bash 3.2 / BSD tools: `base64 -w0`, `sed -i` on local files, `readlink -f`, `date -d` fail | Keep GNU flags inside `remote` strings only (the VPS is Linux) |
| 13 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished; snapshotting again would record its half-written files as "known good" | `snapshot` refuses and aborts. Run `rollback` first (restores the state from before that run), then re-run |
| 14 | Bare `hermes` over ssh: `hermes: command not found` | Non-login ssh shells do not have `~/.local/bin` on PATH, where the Hermes installer puts the binary | `remote()` (Step 0) exports `PATH="$HOME/.local/bin:$PATH"` for every call; never bypass it with a raw `ssh` for hermes commands |
| 15 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` on the VPS during that moment sees it (the local ssh argv stays clean because the value travels over stdin) | Accepted for the primary path; the documented `grep -v` + `printf` fallback avoids it entirely. Output of the write is discarded so Hermes can never echo the value into chat |
| 16 | <integration-specific pitfall> | <why> | <fix> |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (exact pinned 0.22.5 target)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] HARD GATE passed: credential format OK and the live vendor preflight returned `200` BEFORE any write
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the live preflight passed
- [ ] Secret written to `~/.hermes/.env` over stdin, file is `chmod 600`
- [ ] `config.yaml` holds only `${<SECRET_NAME>}`; secret NOT in `config.yaml` and NOT echoed in chat
- [ ] MCP registered via `hermes -p default mcp add` (listed as enabled); gateway reloaded with `gw_reload` (ready, new instance); `mcp test` exits 0
- [ ] Logs show `registered N tool(s) for '<skill-name>'` within 30s
- [ ] Live smoke test (value read back from `~/.hermes/.env`) returned `200`
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml` (a failed `FORCE=1` re-run keeps the old working value)

See `docs/reference/TROUBLESHOOTING.md` in the repository root for gateway and MCP failure modes.
