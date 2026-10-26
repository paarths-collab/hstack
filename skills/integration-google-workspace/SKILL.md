---
name: integration-google-workspace
description: Connect google-workspace to a host-installed Hermes assistant over SSH using native supported interfaces, private credentials and verified rollback.
---

# /integration-google-workspace — connect google-workspace over SSH

Source-verified for Hermes **0.22.5** at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`.
This procedure targets the exclusive default profile on one host account. Containers,
named profiles and concurrent configuration writers need a separately scoped procedure.
Vendor endpoints, account entitlements and tool behavior have not been tested with live credentials.

## Before you start — gather (ask once)

Collect `$VPS_USER` and `$VPS_IP` with SSH key access. Select the Google services you need. Hermes ships google-workspace with native OAuth and optional gws CLI; follow that bundled skill for first-time authorization. No service-account key or public MCP container is copied by this recipe.
Keep secrets in the local shell or a secret manager; do not paste them into chat.
Confirm the remote account is the host with `whoami` and `hostname` before proceeding.
The code blocks form one shell session; run them in order. Show the concrete preview before changing the server.

## Step 0 — shared lifecycle and recovery helpers

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=integration-google-workspace
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

The shared snapshot restores the prior `.env` and `config.yaml` bytes, rather than deleting keys.

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
remote 'whoami; hostname' || exit 1
# Existing local skill files are checked for ownership before any replacement.
```

## Step 3 — HARD GATE before snapshot or preview

```bash
remote 'hermes -p default skills list --enabled-only | grep -F "google-workspace"' >/dev/null || { echo "ABORT: bundled google-workspace skill unavailable or disabled. Nothing was written."; exit 1; }
```

Use the **installed bundled** `google-workspace` instructions for authorization and narrow service scopes. Its `scripts/setup.py --check` must report AUTHENTICATED before use. Execute that script with the Hermes environment Python specified by the installed skill. Do not install dependencies using an unrelated system Python.

## Step 4 — review the concrete plan

```bash
cat <<EOF
DRY RUN — $VPS_USER@$VPS_IP, default profile only:
  Integration: google-workspace; path: bundled.
  Preserve previous .env/config bytes in a private completed snapshot.
  Use the existing Hermes-bundled Google Workspace skill and native OAuth setup.
  Any post-snapshot failure restores previous local files and checks gateway readiness.
  Vendor state changes are outside local rollback; requests require their own authorization.
EOF
```

Proceed when this work is already authorized; if material scope or account authorization is missing, obtain it before Step 5. Never treat elapsed time as approval.

## Step 5 — snapshot and private settings

```bash
echo "Using the bundled connector; this recipe has no configuration writes or duplicate server to install."
```

## Step 6 — native registration

```bash
remote 'hermes -p default skills list --enabled-only | grep -F "google-workspace"' >/dev/null || exit 1
```

## Step 7 — reload and health

```bash
echo "Native skills are discovered by Hermes; no separate MCP server or gateway restart is required for installation."
```

## Step 8 — verify persistence and finish

Use the bundled `google-workspace` skill to run `scripts/setup.py --check` in the Hermes environment. Then request one permitted read-only operation (for example, list one Drive file) through its `scripts/google_api.py` wrapper. OAuth completion, refresh and the optional gws backend belong to Hermes. Do not report this connection ready until both the authenticated check and the read succeed.

## Rollback

This routing/check procedure writes nothing. The installed Google Workspace skill owns its OAuth credential files and setup recovery. Before running its first-time setup, read that skill and preserve existing native credential files as it instructs. Do not run shared rollback without a snapshot or delete a user's existing Google token.

## Pitfalls

| # | Symptom | Meaning | Action |
|---|---|---|---|
| 1 | Bundled connector | Hermes already ships google-workspace | Use that skill instead of a duplicate MCP container |
| 2 | OAuth files | Native setup owns google_token.json and google_client_secret.json | Preserve existing files and follow native setup recovery |
| 3 | Service scope | The native setup supports selected Google services | Choose only the requested service set |
| 4 | Python environment | An unrelated Python may miss Hermes dependencies | Use the Hermes environment documented by the bundled skill |
| 5 | Optional gws | The bundled wrapper supports gws and a Python fallback | Keep that native backend choice |
| 6 | Readiness | Presence in skills list does not prove OAuth access | Require setup.py --check and one real permitted read |

## Verified against

Official pinned Hermes source: [`v0.22.5`](https://github.com/NousResearch/hermes-agent/tree/bf0203a794a07aac3ff764972ab9087baa4e4f4e), `hermes_cli/subcommands/mcp.py`, `hermes_cli/mcp_catalog.py`, `hermes_cli/mcp_config.py`, `hermes_cli/subcommands/skills.py`, `gateway/run.py` and `tools/mcp_tool_config.py`.
Local model tests and exact-parser checks prove procedure shape and recovery assumptions. They do not prove vendor auth, package availability, real service readiness or delivery through a chat platform. No live credentials or paid APIs were used during this migration.

## Definition of done

- [ ] Pinned host/default profile confirmed; correct account and consent selected.
- [ ] Read-only credential or catalogue preflight passed before configuration writes.
- [ ] Native registration/discovery verified; zero exit from install/add/login was not treated as proof.
- [ ] Private values stayed on SSH stdin and in mode-600 credential files.
- [ ] Exact previous values and extra owned artifacts recover on failure.
- [ ] A real account read through Hermes is recorded separately as pending until observed.
