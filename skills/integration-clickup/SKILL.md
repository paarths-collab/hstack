---
name: integration-clickup
description: Connect clickup to a host-installed Hermes assistant over SSH using native supported interfaces, private credentials and verified rollback.
---

# /integration-clickup — connect clickup over SSH

Source-verified for Hermes **0.22.5** at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`.
This procedure targets the exclusive default profile on one host account. Containers,
named profiles and concurrent configuration writers need a separately scoped procedure.
Vendor endpoints, account entitlements and tool behavior have not been tested with live credentials.

## Before you start — gather (ask once)

Collect `$VPS_USER` and `$VPS_IP` with SSH key access. Authorize the intended ClickUp workspace through native OAuth; a personal API token is not used by this path.
Keep secrets in the local shell or a secret manager; do not paste them into chat.
Confirm the remote account is the host with `whoami` and `hostname` before proceeding.
The code blocks form one shell session; run them in order. Show the concrete preview before changing the server.

## Step 0 — shared lifecycle and recovery helpers

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=integration-clickup
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

```bash
# Extra local artifacts are restored before the shared .env/config rollback.
extra_snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
b="$HOME/.hermes/.hstack-backup/$SKILL_NAME/extra"
mkdir "$b" && chmod 700 "$b"
for rel in mcp-tokens/clickup.json mcp-tokens/clickup.client.json mcp-tokens/clickup.meta.json mcp-tokens/clickup.cimd-off; do
  parent=$(dirname "$HOME/.hermes/$rel")
  while [ "$parent" != "$HOME/.hermes" ]; do [ ! -L "$parent" ] || exit 1; parent=$(dirname "$parent"); done
  p="$HOME/.hermes/$rel"; k=$(printf '%s' "$rel" | tr / _)
  [ ! -L "$p" ] || { echo 'Refusing symlink artifact' >&2; exit 1; }
  if [ -f "$p" ]; then cp -p "$p" "$b/$k"; cmp -s "$p" "$b/$k"; chmod 600 "$b/$k"; cksum < "$b/$k" > "$b/$k.cksum"
  elif [ -e "$p" ]; then exit 1
  else : > "$b/$k.absent"; fi
done
printf 'complete\n' > "$b/.complete"
REMOTE
}
extra_restore() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
b="$HOME/.hermes/.hstack-backup/$SKILL_NAME/extra"
[ -f "$b/.complete" ] || { echo 'Incomplete extra backup retained for manual recovery' >&2; exit 1; }
# Validate all copies before restoring any artifact.
for rel in mcp-tokens/clickup.json mcp-tokens/clickup.client.json mcp-tokens/clickup.meta.json mcp-tokens/clickup.cimd-off; do
  parent=$(dirname "$HOME/.hermes/$rel")
  while [ "$parent" != "$HOME/.hermes" ]; do [ ! -L "$parent" ] || exit 1; parent=$(dirname "$parent"); done
  k=$(printf '%s' "$rel" | tr / _)
  if [ -f "$b/$k" ]; then [ "$(cksum < "$b/$k")" = "$(cat "$b/$k.cksum")" ]; else [ -f "$b/$k.absent" ]; fi
done
for rel in mcp-tokens/clickup.json mcp-tokens/clickup.client.json mcp-tokens/clickup.meta.json mcp-tokens/clickup.cimd-off; do
  parent=$(dirname "$HOME/.hermes/$rel")
  while [ "$parent" != "$HOME/.hermes" ]; do [ ! -L "$parent" ] || exit 1; parent=$(dirname "$parent"); done
  p="$HOME/.hermes/$rel"; k=$(printf '%s' "$rel" | tr / _)
  [ ! -L "$p" ] || exit 1
  if [ -f "$b/$k" ]; then mkdir -p "$(dirname "$p")"; cp -p "$b/$k" "$p"; cmp -s "$p" "$b/$k"; chmod 600 "$p"
  else rm -f "$p"; [ ! -e "$p" ]; fi
done
REMOTE
}
fail_transaction() { extra_restore && rollback; exit 1; }
```

The shared snapshot restores the prior `.env` and `config.yaml` bytes, rather than deleting keys.
OAuth cache files are also backed up. A local rollback cannot revoke authorization granted at the vendor; revoke a new grant in the vendor UI if desired. OAuth callback ports need forwarding from the browser to the VPS; Asana uses 27890 exactly.

## Step 1 — verify the pinned Hermes host

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

## Step 2 — inspect the existing integration

```bash
MCP_NAME=clickup

if remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" >/dev/null 2>&1 && [ "${FORCE:-0}" != 1 ]; then
  remote "hermes -p default mcp test $MCP_NAME" >/dev/null 2>&1 && { echo "Already enabled and connected."; exit 0; }
  echo "ABORT: existing integration is unhealthy; use FORCE=1 to repair it. Nothing was written."; exit 1
fi
```

## Step 3 — HARD GATE before snapshot or preview

```bash
[ "${OAUTH_ACKNOWLEDGED:-0}" = 1 ] || { echo "ABORT: OAUTH_ACKNOWLEDGED=1 required for native browser authorization. Nothing was written."; exit 1; }
remote "hermes -p default mcp catalog | grep -E '(^|[[:space:]])clickup([[:space:]]|$)'" >/dev/null || { echo "ABORT: pinned native catalogue entry unavailable. Nothing was written."; exit 1; }
```

Catalogue and consent checks are read-only. This OAuth path has no PAT preflight: the account authentication happens through Hermes after snapshot; `mcp test` must then prove access.

## Step 4 — review the concrete plan

```bash
cat <<EOF
DRY RUN — $VPS_USER@$VPS_IP, default profile only:
  Integration: clickup; path: catalog.
  Preserve previous .env/config bytes in a private completed snapshot.
  Use the pinned native MCP catalogue and native OAuth refresh.
  Any post-snapshot failure restores previous local files and checks gateway readiness.
  Vendor state changes are outside local rollback; requests require their own authorization.
EOF
```

Proceed when this work is already authorized; if material scope or account authorization is missing, obtain it before Step 5. Never treat elapsed time as approval.

## Step 5 — snapshot and private settings

```bash
snapshot || { echo "ABORT: snapshot failed. Nothing was written."; exit 1; }
extra_snapshot || { echo "FAIL: extra snapshot incomplete; retain active backup for manual recovery. No integration settings were written."; exit 1; }
put_env() {
  printf '%s\n' "$2" | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}
```

Only values on stdin reach SSH. The remote `hermes config set` process briefly has its value in its argv; use a trusted exclusive VPS account. `chmod 600` protects the persisted `.env`.

## Step 6 — native registration

```bash
remote 'hermes -p default mcp install clickup' >/dev/null 2>&1 || { echo "FAIL: catalogue installation."; fail_transaction; }
remote "hermes -p default mcp list | grep -E '^ *clickup .*enabled'" >/dev/null || { echo "FAIL: catalogue entry is not enabled."; fail_transaction; }
```

Run native OAuth login in an **interactive SSH terminal**, with callback forwarding as required by the installed manifest. The browser must reach the VPS loopback callback. Complete it before running Step 7:

`hermes -p default mcp login clickup`

`mcp install` can save an entry despite a failed probe, and `mcp login` can exit 0 after failure. Neither is health evidence. If authorization is cancelled, run `extra_restore && rollback` in the original shell; retain the active backup if recovery fails.

## Step 7 — reload and health

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready."; fail_transaction; }
remote "hermes -p default mcp test $MCP_NAME" >/dev/null 2>&1 || { echo "FAIL: MCP tools are not reachable."; fail_transaction; }
```

## Step 8 — verify persistence and finish

```bash
finish || { echo "FAIL: recovery point could not be retired; inspect it before continuing."; exit 1; }
echo "Native catalogue entry is enabled, gateway ready, and MCP tools reachable. A real chat-turn read still requires live validation."
```

## Rollback

For an active failed transaction run `extra_restore && rollback`. Recovery validates backup checksums before replacing files and preserves the active recovery point when restoration or readiness fails.
After a successful run, the previous bytes remain in `~/.hermes/.hstack-backup/integration-clickup.prev`. For manual undo first inspect that backup, ensure no newer transaction or config writer exists, and move `.prev` back to the active name; then call the recovery command above. Do not delete a newer active backup.

## Pitfalls

| # | Symptom | Meaning | Action |
|---|---|---|---|
| 1 | Token confusion | The old personal token proxy is replaced by OAuth | Use the native ClickUp grant |
| 2 | Workspace mismatch | The OAuth account controls accessible workspaces | Check the chosen workspace |
| 3 | Extra proxy | mcp-remote duplicates Hermes HTTP support | Use the native catalogue entry |
| 4 | Task mutations | Connected tools can change work data | Only execute requested changes |
| 5 | Refresh failures | Hermes owns OAuth token refresh | Diagnose with native mcp login and test |
| 6 | Partial installation | Catalogue installation can succeed without tools | Require the explicit native health check |

## Verified against

Official pinned Hermes source: [`v0.22.5`](https://github.com/NousResearch/hermes-agent/tree/bf0203a794a07aac3ff764972ab9087baa4e4f4e), `hermes_cli/subcommands/mcp.py`, `hermes_cli/mcp_catalog.py`, `hermes_cli/mcp_config.py`, `hermes_cli/subcommands/skills.py`, `gateway/run.py` and `tools/mcp_tool_config.py`.
The native manifest is [`optional-mcps/clickup/manifest.yaml`](https://github.com/NousResearch/hermes-agent/blob/bf0203a794a07aac3ff764972ab9087baa4e4f4e/optional-mcps/clickup/manifest.yaml). Its OAuth settings, endpoint and tool exclusions are retained by native install.
Local model tests and exact-parser checks prove procedure shape and recovery assumptions. They do not prove vendor auth, package availability, real service readiness or delivery through a chat platform. No live credentials or paid APIs were used during this migration.

## Definition of done

- [ ] Pinned host/default profile confirmed; correct account and consent selected.
- [ ] Read-only credential or catalogue preflight passed before configuration writes.
- [ ] Native registration/discovery verified; zero exit from install/add/login was not treated as proof.
- [ ] Private values stayed on SSH stdin and in mode-600 credential files.
- [ ] Exact previous values and extra owned artifacts recover on failure.
- [ ] A real account read through Hermes is recorded separately as pending until observed.
