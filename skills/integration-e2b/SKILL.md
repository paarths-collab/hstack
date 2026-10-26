---
name: integration-e2b
description: Connect e2b to a host-installed Hermes assistant over SSH using native supported interfaces, private credentials and verified rollback.
---

# /integration-e2b — connect e2b over SSH

Source-verified for Hermes **0.22.5** at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`.
This procedure targets the exclusive default profile on one host account. Containers,
named profiles and concurrent configuration writers need a separately scoped procedure.
Vendor endpoints, account entitlements and tool behavior have not been tested with live credentials.

## Before you start — gather (ask once)

Collect `$VPS_USER` and `$VPS_IP` with SSH key access. E2B_API_KEY (e2b_...), optional KEEP_ALIVE_MINUTES (default 5). Values above 15 require LONG_LIVED_ACKNOWLEDGED=1. Preflight lists existing sandboxes; it never creates a billed sandbox.
Keep secrets in the local shell or a secret manager; do not paste them into chat.
Confirm the remote account is the host with `whoami` and `hostname` before proceeding.
The code blocks form one shell session; run them in order. Show the concrete preview before changing the server.

## Step 0 — shared lifecycle and recovery helpers

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=integration-e2b
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
MCP_NAME=e2b

if remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" >/dev/null 2>&1 && [ "${FORCE:-0}" != 1 ]; then
  remote "hermes -p default mcp test $MCP_NAME" >/dev/null 2>&1 && { echo "Already enabled and connected."; exit 0; }
  echo "ABORT: existing integration is unhealthy; use FORCE=1 to repair it. Nothing was written."; exit 1
fi
```

## Step 3 — HARD GATE before snapshot or preview

```bash
KEEP_ALIVE_MINUTES=${KEEP_ALIVE_MINUTES:-5}
case "$KEEP_ALIVE_MINUTES" in ""|*[!0-9]*) echo "ABORT: invalid KEEP_ALIVE_MINUTES. Nothing was written."; exit 1 ;; esac
[ "${#KEEP_ALIVE_MINUTES}" -le 4 ] && [ "$KEEP_ALIVE_MINUTES" -ge 1 ] || { echo "ABORT: invalid lifetime. Nothing was written."; exit 1; }
if [ "$KEEP_ALIVE_MINUTES" -gt 15 ] && [ "${LONG_LIVED_ACKNOWLEDGED:-0}" != 1 ]; then echo "ABORT: LONG_LIVED_ACKNOWLEDGED=1 required. Nothing was written."; exit 1; fi
secret_chars_ok() { local LC_ALL=C; case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac; }
secret_chars_ok "${E2B_API_KEY:-}" || { echo "ABORT: E2B_API_KEY is empty or unsafe. Nothing was written."; exit 1; }
case "$E2B_API_KEY" in e2b_*) ;; *) echo "ABORT: E2B API key required. Nothing was written."; exit 1 ;; esac
printf '%s\n' "${E2B_API_KEY:-}" | remote 'python3 -c '"'"'import sys, json, os, stat, urllib.request, urllib.error, urllib.parse, subprocess, base64
d=dict(zip(['"'"'"'"'"'"'"'"'E2B_API_KEY'"'"'"'"'"'"'"'"'],sys.stdin.read().splitlines()))
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl):
  raise RuntimeError("Redirect refused; credentials were not forwarded")
def req(url, headers=None, body=None):
 if not url.startswith("https://"): raise RuntimeError("HTTPS required")
 r=urllib.request.Request(url,headers=headers or {},data=body)
 with urllib.request.build_opener(NoRedirect).open(r,timeout=30) as f:
  if f.status != 200: raise RuntimeError("Non-200 response")
  data=f.read(2 * 1024 * 1024 + 1)
  if len(data)>2 * 1024 * 1024: raise RuntimeError("Response too large")
  return data
req('"'"'"'"'"'"'"'"'https://api.e2b.app/v2/sandboxes'"'"'"'"'"'"'"'"',{'"'"'"'"'"'"'"'"'X-API-Key'"'"'"'"'"'"'"'"':'"'"'"'"'"'"'"'"''"'"'"'"'"'"'"'"'+d['"'"'"'"'"'"'"'"'E2B_API_KEY'"'"'"'"'"'"'"'"']})
print("OK: authenticated read-only vendor probe")
'"'"'' >/dev/null 2>&1 || { echo "ABORT: vendor authentication or read-only probe failed. Nothing was written."; exit 1; }
```

Credentials travel on SSH stdin, with redirects refused, timeout bounded, and response bodies suppressed. No `.env` file is sourced as shell code. No credentials are sent to a different host after an HTTP redirect.

## Step 4 — review the concrete plan

```bash
cat <<EOF
DRY RUN — $VPS_USER@$VPS_IP, default profile only:
  Integration: e2b; path: stdio.
  Preserve previous .env/config bytes in a private completed snapshot.
  Store the selected settings privately and register only the reviewed connector.
  Any post-snapshot failure restores previous local files and checks gateway readiness.
  Vendor state changes are outside local rollback; requests require their own authorization.
EOF
```

Proceed when this work is already authorized; if material scope or account authorization is missing, obtain it before Step 5. Never treat elapsed time as approval.

## Step 5 — snapshot and private settings

```bash
snapshot || { echo "ABORT: snapshot failed. Nothing was written."; exit 1; }
put_env() {
  printf '%s\n' "$2" | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}
put_env E2B_API_KEY "${E2B_API_KEY:-}" || { echo "FAIL: private setting write."; rollback; exit 1; }
```

Only values on stdin reach SSH. The remote `hermes config set` process briefly has its value in its argv; use a trusted exclusive VPS account. `chmod 600` protects the persisted `.env`.

## Step 6 — native registration

```bash
if [ "${FORCE:-0}" = 1 ]; then printf 'y\n' | remote "hermes -p default mcp remove $MCP_NAME" >/dev/null || { rollback; exit 1; }; fi
printf 'y\n' | remote 'hermes -p default mcp add e2b --env '"'"'E2B_API_KEY=${E2B_API_KEY}'"'"' --command uvx --args e2b-mcp-server==0.1.1' >/dev/null 2>&1 || { echo "FAIL: stdio registration."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" >/dev/null || { echo "FAIL: MCP is not enabled."; rollback; exit 1; }
```

The one stdin answer enables discovered tools. `--env` precedes `--args`; every argument is a separate token. Environment references are expanded by Hermes when it starts the server. A zero exit from add does not prove registration. Vendor package compatibility remains live-unverified; failure must roll back.

KEEP_ALIVE_MINUTES is a consent budget, not an invented server environment flag. For each sandbox request, use an explicit timeout no longer than this budget and terminate it after use; no sandbox is created during installation.

## Step 7 — reload and health

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready."; rollback; exit 1; }
remote "hermes -p default mcp test $MCP_NAME" >/dev/null 2>&1 || { echo "FAIL: MCP tools are not reachable."; rollback; exit 1; }
```

## Step 8 — verify persistence and finish

```bash
remote 'python3 -c '"'"'import sys, json, os, stat, urllib.request, urllib.error, urllib.parse, subprocess, base64
d={}
p=os.path.expanduser("~/.hermes/.env")
if os.path.islink(p) or not os.path.isfile(p) or stat.S_IMODE(os.stat(p).st_mode)!=0o600: raise RuntimeError("Private regular .env required")
if os.path.isfile(p):
 for line in open(p):
  k, sep, v=line.rstrip("\n").partition("=")
  if sep:
   v=v.strip()
   if len(v)>1 and v[0]==v[-1] and v[0] in (chr(34),chr(39)): v=v[1:-1]
   d[k]=v
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self, req, fp, code, msg, headers, newurl):
  raise RuntimeError("Redirect refused; credentials were not forwarded")
def req(url, headers=None, body=None):
 if not url.startswith("https://"): raise RuntimeError("HTTPS required")
 r=urllib.request.Request(url,headers=headers or {},data=body)
 with urllib.request.build_opener(NoRedirect).open(r,timeout=30) as f:
  if f.status != 200: raise RuntimeError("Non-200 response")
  data=f.read(2 * 1024 * 1024 + 1)
  if len(data)>2 * 1024 * 1024: raise RuntimeError("Response too large")
  return data
req('"'"'"'"'"'"'"'"'https://api.e2b.app/v2/sandboxes'"'"'"'"'"'"'"'"',{'"'"'"'"'"'"'"'"'X-API-Key'"'"'"'"'"'"'"'"':'"'"'"'"'"'"'"'"''"'"'"'"'"'"'"'"'+d['"'"'"'"'"'"'"'"'E2B_API_KEY'"'"'"'"'"'"'"'"']})
print("OK: authenticated read-only vendor probe")
'"'"'' >/dev/null 2>&1 || { echo "FAIL: persisted credentials failed the read-only probe."; rollback; exit 1; }
finish || { echo "FAIL: recovery point retained for inspection."; exit 1; }
echo "Read-only credential probe passed; validate one real Hermes chat turn before claiming live end-to-end compatibility."
```

## Rollback

For an active failed transaction run `rollback`. Recovery validates backup checksums before replacing files and preserves the active recovery point when restoration or readiness fails.
After a successful run, the previous bytes remain in `~/.hermes/.hstack-backup/integration-e2b.prev`. For manual undo first inspect that backup, ensure no newer transaction or config writer exists, and move `.prev` back to the active name; then call the recovery command above. Do not delete a newer active backup.

## Pitfalls

| # | Symptom | Meaning | Action |
|---|---|---|---|
| 1 | Key type | The SDK expects an E2B API key | Use e2b_ credentials |
| 2 | Preflight cost | Creating a sandbox can incur charges | List existing sandboxes instead |
| 3 | Lifetime budget | More than15minutes requires consent | Require LONG_LIVED_ACKNOWLEDGED=1 |
| 4 | Server flags | The selected server does not implement invented budget env vars | Set an explicit timeout per requested sandbox operation |
| 5 | Resource cleanup | A user-created sandbox can keep running | Terminate it after the requested use |
| 6 | Package route | The published server is a Python uvx package | Use e2b-mcp-server==0.1.1 |

Pinned package metadata: [e2b-mcp-server 0.1.1](https://pypi.org/project/e2b-mcp-server/0.1.1/) documents uvx and E2B_API_KEY. Requires Python 3.10+. No sandbox was created while checking this migration.

The read-only API/header shape is documented by [E2B list sandboxes v2](https://docs.e2b.dev/api-reference/sandboxes/list-sandboxes-v2).

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
