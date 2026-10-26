---
name: integration-notion
description: Connect Notion (docs, CRM-lite, memory, SOPs) to a self-hosted Hermes Agent over SSH with the official Notion MCP server and a static internal integration token. The hosted OAuth catalog entry is documented as the interactive alternative. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-notion — connect Notion to a remote Hermes (SSH-first)

You are the engineer connecting Notion to a self-hosted Hermes agent (v0.22.5) on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the integration token in the Notion UI.
2. Share each target page or database with the integration.

Everything else — token storage, MCP registration, gateway reload, verification — is
done idempotently on the VPS. Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0
(a thin `ssh` wrapper). The token is validated locally and against Notion BEFORE anything
is written, and travels to the VPS only over ssh STDIN. Run all blocks in ONE shell session:
later steps call the Step 0 functions.

**Two native ways to connect Notion at Hermes v0.22.5.** This skill automates the first because it is the one a headless VPS can complete:

1. **Internal integration token + the official stdio server (this skill).** `hermes -p default mcp add notion --env NOTION_TOKEN='${NOTION_TOKEN}' --command npx --args -y @notionhq/notion-mcp-server@1`.
   Hermes stores only the `${NOTION_TOKEN}` reference in `config.yaml`; it renders the reference from `~/.hermes/.env` each time it starts the
   server, and passes the server its own filtered environment plus exactly the `env` entries of the config (`tools/mcp_tool_config.py:199-227,554-582`).
   `npx` is an ordinary stdio command: the save-time and spawn-time security check blocks only known attacker indicators and shell interpreters with
   network egress or persistence writes (`hermes_cli/mcp_security.py:89-135`).
2. **The hosted catalog entry (OAuth 2.1 with dynamic client registration), not automated here.** `hermes -p default mcp install notion` installs
   `optional-mcps/notion/manifest.yaml` (`https://mcp.notion.com/mcp`, `auth: oauth`). It needs a person: install writes the entry before any token exists and
   cannot complete the sign-in itself without a terminal (`hermes_cli/mcp_catalog.py:777-847`, `:615-672`; `tools/mcp_oauth.py:334-353,797-824`). The token is
   obtained by `hermes -p default mcp login notion` run in an INTERACTIVE terminal on the VPS (`ssh -t`): it prints the authorization URL, you open it in your own
   browser, and paste the redirect URL back at the prompt (`tools/mcp_oauth.py:719-795`, `hermes_cli/mcp_config.py:883-1003`). `--flow device` (RFC 8628) works only if
   Notion's authorization server advertises a device endpoint; that was not checked. Do not give that entry a bearer token: the manifest declares OAuth.
   After a successful login, finish with Steps 7 and 8 of this skill (reload, then `mcp test notion`).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$NOTION_TOKEN` | Internal integration token (`ntn_...`) | <https://www.notion.com/my-integrations> → Build → Internal connections → Create → Configuration tab |
| Shared pages | Pages/DBs the integration can see | In each Notion page: `...` → **+ Add Connections** → select the integration |

Optional switches: `FORCE=1` (rewire an existing entry), `AUTO_APPROVE=1` (skip the dry-run question), `GW_INTERRUPT=1` (let the gateway restart interrupt live chats; never set by default).

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
SKILL_NAME=integration-notion
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

```bash
ALREADY=$(remote "hermes -p default mcp list 2>/dev/null | grep -cE '^ *notion( |\$)' || true")
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Notion is already wired (listed by mcp list, enabled or not). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate the token BEFORE anything is written

Two checks, both before `snapshot` and before the dry run. If either fails, nothing has
touched the VPS and the skill stops.

**3a. Format check (local, no network).** Refuses an empty value and any character that
could break a curl config line or a `.env` line (whitespace, quotes, backslash, `$`,
newline). Internal integration tokens start with `ntn_`; tokens minted before that prefix
change start with `secret_` — both are accepted here and the live check below is the real
test.

```bash
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
secret_chars_ok "$NOTION_TOKEN" \
  || { echo "ABORT: NOTION_TOKEN is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$NOTION_TOKEN" in ntn_*|secret_*) ;; *)
  echo "ABORT: NOTION_TOKEN must be an internal integration token (ntn_...). Nothing was written."; exit 1 ;;
esac
```

**3b. Live Notion preflight, run from the VPS** (proves the server's egress works too).
It uses the same read-only call as the Step 9 smoke test: `POST /v1/search` with
`page_size` 1. The token travels over ssh STDIN as a curl config, so it never appears in
argv or a quoted remote string. (The endpoint, the `Notion-Version` header and the `ntn_` prefix are vendor facts carried over from the earlier version of
this skill; they are not verified against the vendor from this repository.)

```bash
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$NOTION_TOKEN" \
  | remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - -X POST -H 'Notion-Version: 2025-09-03' -H 'Content-Type: application/json' -d '{\"page_size\":1}' 'https://api.notion.com/v1/search'")
[ "$CODE" = "200" ] || { echo "ABORT: Notion rejected the token (HTTP ${CODE:-none}). Nothing was written."; exit 1; }
```

`200` with an empty `results` array still means the token is good — nothing is shared yet
(Pitfall 2), which is a user step, not a wiring failure.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token format + live Notion preflight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write NOTION_TOKEN (length ${#NOTION_TOKEN}, prefix ${NOTION_TOKEN:0:4}…) via 'hermes -p default config set', chmod 600
  3. Register MCP (answers fed on stdin): hermes -p default mcp add notion --env NOTION_TOKEN='\${NOTION_TOKEN}' --command npx --args -y @notionhq/notion-mcp-server@1
     then check it with: hermes -p default mcp list (must show notion enabled)
  4. Reload gateway: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready
  5. Verify: hermes -p default mcp test notion (exit 0 = connected)
  6. Smoke test: POST https://api.notion.com/v1/search with the token read back from ~/.hermes/.env → expect 200
  Any failure after step 1 restores the snapshot.

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the secret (chmod 600, over stdin, no logging)

```bash
snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
printf '%s\n' "$NOTION_TOKEN" \
  | remote 'IFS= read -r v && hermes -p default config set NOTION_TOKEN "$v" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env' \
  || { echo "FAIL: could not write NOTION_TOKEN."; rollback; exit 1; }
```

`config set` routes an UPPER_SNAKE name ending in `_TOKEN` to `~/.hermes/.env` and never echoes the value (`hermes_cli/config.py:858-882,3398-3440`).

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(remote "grep -c '^NOTION_TOKEN=' ~/.hermes/.env || true")
[ "$WROTE" = "1" ] || { echo "FAIL: NOTION_TOKEN not written exactly once (found ${WROTE:-0})."; rollback; exit 1; }
```

---

## Step 6 — register the Notion MCP server (stdio, token by reference)

`hermes mcp add` is interactive. For a stdio server it asks one thing, "Enable all N tools? [Y/n/select]", after it has started the server and
listed its tools; a closed stdin answers "cancel", so the entry is silently NOT saved while the command still exits 0
(`hermes_cli/mcp_config.py:586-615,618-721`). The answer is therefore fed on stdin, and the result is verified with `mcp list`, never assumed.
If the server cannot be started the command instead asks "Save config anyway?" (default no); `y` saves it DISABLED, which the `enabled` check
below also rejects. `--env` is stdio-only and must come before `--args`, which swallows every word after it (`hermes_cli/subcommands/mcp.py`,
`hermes_cli/mcp_config.py:345-361,641`). The `\$` keeps the braces literal on the remote side so `config.yaml` stores the reference, not a value.
The package is the pin `NOTION_MCP_PKG` from `VERSIONS.txt`.

```bash
if [ "${FORCE:-0}" = "1" ]; then printf 'y\n' | remote "hermes -p default mcp remove notion >/dev/null 2>&1 || true"; fi
printf 'y\n' | remote "hermes -p default mcp add notion --env 'NOTION_TOKEN=\${NOTION_TOKEN}' --command npx --args -y @notionhq/notion-mcp-server@1" >/dev/null \
  || { echo "FAIL: hermes -p default mcp add notion."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *notion .*enabled'" >/dev/null \
  || { echo "FAIL: notion is not listed as enabled (add was cancelled, the server could not start, or npx could not fetch the package)."; rollback; exit 1; }
```

Check that the plaintext token did not land in `config.yaml` (and is still in `.env`):

```bash
remote 'v=$(sed -n "s/^NOTION_TOKEN=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
  || { echo "FAIL: NOTION_TOKEN missing from .env or found in config.yaml."; rollback; exit 1; }
```

The resulting `config.yaml` entry holds `command: npx`, `args: [-y, @notionhq/notion-mcp-server@1]` and `env: {NOTION_TOKEN: ${NOTION_TOKEN}}`; nothing else about the secret.
All discovered tools are enabled. To narrow them, set `mcp_servers.notion.tools.include` in `config.yaml` (or run `hermes -p default mcp configure notion` in an interactive terminal) and reload the gateway.

The vendor package, the environment variable it reads (`NOTION_TOKEN`) and the pin are carried over from `VERSIONS.txt` and the earlier version of this skill; nothing here
confirms them against the package itself. If `npx` cannot fetch the pin or the variable name is wrong, `mcp add` fails its own connection test and this step rolls back.

---

## Step 7 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. A refusal because of live sessions is reported, not overridden; see the lifecycle note in Step 0.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — verify the connection natively (`mcp test`, within 30s)

`hermes mcp test` starts the server and lists its tools; its exit code is 0 connected, 1 connection failed, 3 server not in the
config (`hermes_cli/mcp_config.py:836-880`). Running chats pick the tools up with a new session (or `/reload-mcp`); the
gateway reload in Step 7 already gives new sessions a fresh load.

```bash
CONNECTED=0
for i in 1 2 3; do
  if remote "hermes -p default mcp test notion" >/dev/null 2>&1; then CONNECTED=1; echo "OK: notion connected."; break; fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: notion did not connect within 30s."; rollback; exit 1; }
```

---

## Step 9 — live API smoke test (token read back from `~/.hermes/.env` on the VPS)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so `$NOTION_TOKEN`
would be empty there. The block reads the value from the file explicitly — this also
proves it persisted.

```bash
CODE=$(remote 'bash -s' <<'REMOTE'
v=$(sed -n 's/^NOTION_TOKEN=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - \
      -X POST -H 'Notion-Version: 2025-09-03' -H 'Content-Type: application/json' \
      -d '{"page_size":1}' https://api.notion.com/v1/search
REMOTE
)
[ "$CODE" = "200" ] || { echo "FAIL: Notion smoke test returned HTTP ${CODE:-none} (401 = token on the VPS differs from the one validated in Step 3, 403 = no access)."; rollback; exit 1; }
echo "OK: Notion API reachable and the token stored on the VPS is valid."
finish || exit 1
```

`200` with an empty `results` array means the token works but nothing is shared yet —
not a failure of wiring, just a user step (Pitfall 2). `mcp test` in Step 8 proves the MCP
server starts and lists tools; this call proves the stored token reaches the Notion API. Neither
proves that a chat turn uses the tool: ask the agent to search Notion once in a new session.

---

## Rollback

Defined once, in Step 0 (no second copy here). It runs automatically
(`rollback; exit 1`) on every failure after `snapshot`, and it RESTORES rather than
deletes:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/integration-notion/`. MCP servers live in the `mcp_servers` map of `config.yaml` (`hermes_cli/mcp_config.py:233-244`), so this also
  removes the new `notion` entry or brings back the previous one. A file that did not exist before is
  removed, so a first-time run leaves nothing behind, and a failed `FORCE=1` re-run gets
  its previous working `NOTION_TOKEN` and MCP entry back.
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `integration-notion.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.

Failures in Steps 1–4 (Hermes check, token format, live preflight, declined dry run) wrote
nothing, so there is nothing to roll back.
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

The `.prev` folder holds the previous `.env` (including any old token) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Giving the hosted `mcp.notion.com` catalog entry a bearer token | Its manifest declares OAuth; a static token is not what it accepts | Use this skill's stdio server for tokens, or `mcp install notion` + an interactive `mcp login notion` for OAuth |
| 2 | Token set but every call returns empty / 404 | Integration not **shared** with target pages/DBs | In Notion: `...` → **+ Add Connections** on each target |
| 3 | Missing `Notion-Version` header | Notion API rejects unversioned requests | Always send `Notion-Version: 2025-09-03` on the REST calls this skill makes |
| 4 | Internal vs OAuth/public token confusion | Public tokens behave differently and can expire | Use an **internal** integration token (`ntn_...`) |
| 5 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set`; `config.yaml` holds `${NOTION_TOKEN}` only |
| 6 | `mcp add` run with a closed stdin, or treated as successful because it exited 0 | It cancels without saving and still exits 0 | Feed the answers on stdin and check `mcp list` shows `notion` enabled (Step 6) |
| 7 | `--args` before `--env`, or the arguments joined into one comma-separated word | `--args` takes every remaining word, so `--env` after it becomes an argument of `npx`; a comma-joined word is one bogus argument | `--env ... --command npx --args -y <pkg>` with `--args` last |
| 8 | Search returns partial results | `/search` only spans shared content; paginated | Confirm sharing; follow `next_cursor` |
| 9 | Rate limits | Notion throttles ~3 req/sec; bursts get `429` | Backoff on `429`; batch via DB queries |
| 10 | Treating `gateway status` text as health | `✗ Gateway is not running` contains `running` | `gw_reload` / `gw_ready` only (`gateway ensure --json` must exit 0 with `"state":"ready"`) |
| 11 | Smoke test sends `Bearer \$NOTION_TOKEN` over ssh | The ssh shell never loaded `.env`: empty header, false `401`, and the old rollback deleted a working token | Step 9 reads the token from `~/.hermes/.env` on the VPS |
| 12 | Writing the token before checking it with Notion | A typo'd or revoked token replaces a working one (`FORCE=1`) | Step 3 runs before `snapshot`; failures there write nothing |
| 13 | Rollback that deletes instead of restoring | A failed `FORCE=1` re-run destroys the previous working token | Step 0 `snapshot`/`rollback` restore the pre-skill files |
| 14 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 15 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished; snapshotting again would record its half-written files as "known good" | `snapshot` refuses and aborts. Run `rollback` first (restores the state from before that run), then re-run |
| 16 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` on the VPS during that moment sees it (the local ssh argv stays clean because the value travels over stdin) | Accepted; the write is a single short call and its output is discarded so Hermes can never echo the value into chat |
| 17 | Gateway restart refused because chats are live | `restart` asks y/N on a TTY and refuses without one | Wait for idle, or set `GW_INTERRUPT=1` once you accept interrupting them |

---

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (paths relative to the Hermes repo root); NOT run against a live Hermes, Notion or npm:

- `hermes mcp add NAME --env KEY=VALUE... --command C --args ...` flags: `hermes_cli/subcommands/mcp.py` (`--args` is `argparse.REMAINDER` and "must be the last option"; `--env` is `nargs="*"`; `--auth` is `oauth|header`); `--env` is rejected for URL servers and stored as the entry's `env` (`hermes_cli/mcp_config.py:345-361,641,666-675`).
- Prompts and saving: the stdio path asks only `Enable all N tools? [Y/n/select]`; EOF or `n` cancels and saves nothing; probe failure asks `Save config anyway?` (default no), `y` saves `enabled: false`; an existing name asks `Overwrite?` (default no) (`hermes_cli/mcp_config.py:586-615,648-721`). `mcp remove` asks `Remove server?` (default yes) (`:724-741`).
- `mcp list` prints one row per server with `✓ enabled` / `✗ disabled` (`hermes_cli/mcp_config.py:744-787`); `mcp test` exits 0 / 1 / 3 (`:836-880`).
- `${VAR}` in a stdio `env` is rendered from the profile's `.env` when the server starts and in the `mcp add`/`mcp test` probe (`tools/mcp_tool_config.py:554-582,690-720`, `hermes_cli/mcp_config.py:391-413`); the child process gets a filtered environment plus the config's `env` (`tools/mcp_tool_config.py:199-227`).
- Security validation runs at save and at spawn; `npx` passes (`hermes_cli/mcp_security.py:89-135`, `tools/mcp_tool_config.py:643-659`).
- `config set NOTION_TOKEN` writes `.env` (suffix `_TOKEN`) without echoing the value: `hermes_cli/config.py:858-882,3398-3440`.
- Catalog and OAuth facts: `optional-mcps/notion/manifest.yaml`, `hermes_cli/mcp_picker.py:209-220`, `hermes_cli/mcp_catalog.py:615-672,777-847`, `tools/mcp_oauth.py:334-353,719-824`, `hermes_cli/mcp_config.py:883-1003`.
- Gateway lifecycle: see the Step 0 note (`hermes_cli/gateway.py`, `gateway_runtime*.py`, `gateway/run.py:1583-1600`).

NOT verified: that `@notionhq/notion-mcp-server@1` exists, starts under Hermes' managed Node, and reads `NOTION_TOKEN`; the Notion REST preflight/smoke endpoint and headers; whether Notion's authorization server supports the device flow; that a chat turn actually calls the tools.

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (banner names 0.22.5)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] HARD GATE passed: token format OK and the live `POST /v1/search` preflight returned `200` BEFORE any write
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the live preflight passed
- [ ] `NOTION_TOKEN` in `~/.hermes/.env` (written over stdin), `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` references only `${NOTION_TOKEN}`
- [ ] Target Notion pages/DBs shared with the integration (+ Add Connections done)
- [ ] MCP registered with `hermes -p default mcp add` (answers on stdin) and listed as enabled by `mcp list`
- [ ] Gateway reloaded with `gw_reload` (restart --detach, ready, new instance)
- [ ] `hermes -p default mcp test notion` exits 0
- [ ] Smoke test: `POST /v1/search` on the VPS, token read back from `~/.hermes/.env`, returned `200`
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml` (a failed `FORCE=1` re-run keeps the old working token)

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
