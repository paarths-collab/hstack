---
name: integration-mem0
description: Set up mem0 on a host-installed Hermes 0.22.5 default profile over SSH, with read-only credential preflight, native integration commands and verified recovery.
---

# /integration-mem0 — connect mem0 to Hermes over SSH

> **Compatibility:** source-verified for Hermes **0.22.5**, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Host-installed default profile only. Vendor live validation is pending; source and sandbox tests do not prove a live connection.

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MEM0_API_KEY` *(Path A — required)* | API key starting with `m0-` | https://app.mem0.ai → Settings → API Keys → Create |
| `$MEM0_ORG_ID` *(Path A — optional)* | Org ID for team-scoped memories | https://app.mem0.ai → Org settings |
| `$MEM0_PROJECT_ID` *(Path A — optional)* | Project ID to scope this agent's memories | https://app.mem0.ai → Project settings |
| `$MEM0_HOST` *(Path B — required)* | Self-hosted OSS host `http://127.0.0.1:8888` | Your Mem0 OSS deploy (docker compose from https://github.com/mem0ai/mem0) |


Use one shell session. `DRY_RUN=1` runs the read-only gates and prints the plan, then exits before snapshot or configuration writes. `FORCE=1` permits replacing existing MCP configuration after snapshot; existing native skill directories are always preserved.


## Step 0 — shared remote, lifecycle and recovery helpers

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=integration-mem0
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
# Reject line breaks, quote/backslash characters and controls: values also become curl config lines.
secret_line_ok() {
  [ -n "$1" ] && printf '%s' "$1" | LC_ALL=C grep -Eq '^[!-~]+$' || return 1
  case "$1" in *'"'*|*"'"*|*'\'*) return 1 ;; esac
}
# No response body or credential is logged. JSON errors on HTTP 200 are failures too.
api_check() {
  local reply
  reply=$(remote 'curl -q -fsS --connect-timeout 10 --max-time 25 --config -' 2>/dev/null) || return 1
  printf '%s' "$reply" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert not (isinstance(d,dict) and (d.get("errors") or d.get("error") or d.get("success") is False))' 2>/dev/null
}
# Extra native-skill artifacts are owned separately; canonical rollback still restores env/config bytes.
restore_native_skill() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
p="$HOME/.hermes/skills/$SKILL_NAME-runtime"
[ -f "$d/native-created" ] || exit 0
[ "$(cat "$d/native-created")" = "$SKILL_NAME-runtime" ] || exit 1
if [ -e "$p/SKILL.md" ] || [ -L "$p/SKILL.md" ]; then
  [ ! -L "$p" ] && [ ! -L "$p/SKILL.md" ] && [ -f "$d/native.cksum" ] || exit 1
  [ "$(cksum < "$p/SKILL.md")" = "$(cat "$d/native.cksum")" ] || { echo "native skill changed; keep the active snapshot and inspect it" >&2; exit 1; }
  # Never recursively delete this directory: a concurrent user file remains intact.
  rm "$p/SKILL.md"
fi
[ ! -d "$p" ] || rmdir "$p"
rm "$d/native-created" "$d/native.cksum"
REMOTE
}
fail_change() {
  echo "FAIL: $1. Restoring the previous configuration."
  restore_native_skill || { echo "Native skill restoration failed; active recovery point retained." >&2; exit 1; }
  rollback || { echo "Rollback incomplete; active recovery point retained." >&2; exit 1; }
  exit 1
}

```

## Step 1 — verify SSH, Hermes version and host prerequisites

```bash
remote 'whoami; hostname' || { echo "ABORT: SSH failed. Nothing was written."; exit 1; }
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 || exit 1
  hermes -p default --version
') || { echo "ABORT: install Hermes on the VPS host first; container-only installations are unsupported. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure supports Hermes 0.22.5 only. Nothing was written."; exit 1;
}
remote 'command -v curl >/dev/null && command -v python3 >/dev/null' || {
  echo "ABORT: install curl and python3 on the host first. Nothing was written."; exit 1;
}

```

## Step 2 — check ownership and an existing healthy integration

```bash
WIRE_PATH=${WIRE_PATH:-A}
# An unchanged runtime file from the previous successful run is safe to reuse.
if ! [ "$WIRE_PATH" = A ] && [ "${FORCE:-0}" != 1 ] && remote 'bash -s' <<'REMOTE'
set -e
p="$HOME/.hermes/skills/integration-mem0-runtime"
d="$HOME/.hermes/.hstack-backup/integration-mem0.prev"
[ ! -L "$HOME/.hermes/skills" ] && [ ! -L "$p" ] && [ ! -L "$p/SKILL.md" ]
[ -f "$d/.complete" ] && [ -f "$d/native.cksum" ] && [ -f "$p/SKILL.md" ] || exit 1
[ "$(cksum < "$p/SKILL.md")" = "$(cat "$d/native.cksum")" ]
hermes -p default skills list --source local --enabled | grep -F -- 'integration-mem0-runtime' >/dev/null
REMOTE
then
  echo "Managed native skill is unchanged and discoverable. Nothing was written."
  exit 0
fi
remote 'test ! -L "$HOME/.hermes/skills"' || { echo "ABORT: skills directory is a symlink; preserved. Nothing was written."; exit 1; }
remote 'test ! -e "$HOME/.hermes/skills/integration-mem0-runtime" && test ! -L "$HOME/.hermes/skills/integration-mem0-runtime"' || {
  echo "ABORT: existing native skill preserved; inspect it rather than replacing it. Nothing was written."; exit 1;
}
if [ "$WIRE_PATH" = A ] && [ "${FORCE:-0}" != 1 ] && remote "hermes -p default mcp list | grep -E '^ *mem0 .*enabled'" >/dev/null 2>&1 && remote 'hermes -p default mcp test mem0' >/dev/null 2>&1; then
  echo "mem0 is enabled and passed native mcp test. Nothing was written."
  exit 0
fi
```

## Step 3 — HARD GATE: read-only credential and consent checks

All vendor calls in this step run from the VPS. Secrets travel over SSH stdin, not SSH
arguments. A failed gate stops before `snapshot` and before any configuration write.
The calls authenticate or read data; none sends a message, changes vendor state or
performs a paid model request.

```bash
WIRE_PATH=${WIRE_PATH:-A}
MEM0_HOST=${MEM0_HOST:-http://127.0.0.1:8888}
case "$WIRE_PATH" in A)
secret_line_ok "${MEM0_API_KEY:-}" || { echo "ABORT: missing or unsafe MEM0_API_KEY. Nothing was written."; exit 1; }
{
  printf 'url = "%s"\n' "https://api.mem0.ai/v1/memories/search/"
  printf 'header = "Authorization: Token %s"\n' "$MEM0_API_KEY"
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' '{\"query\":\"ping\",\"user_id\":\"hstack-preflight\",\"limit\":1}'
} | api_check || { echo "ABORT: read-only vendor credential check failed. Nothing was written."; exit 1; }
;; B)
printf '%s' "$MEM0_HOST" | grep -Eq '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(127[.]0[.]0[.]1|localhost)(:[0-9]+)?)$' || { echo "ABORT: unsafe self-hosted Mem0 URL. Nothing was written."; exit 1; }
{ printf 'url = "%s/search"\n' "$MEM0_HOST"; printf 'header = "Content-Type: application/json"\n'; printf 'data = "%s"\n' '{\"query\":\"ping\",\"user_id\":\"hstack-preflight\"}'; } | api_check || { echo "ABORT: self-hosted Mem0 search failed. Nothing was written."; exit 1; }
MEM0_API_KEY=
;; *) echo "ABORT: WIRE_PATH must be A or B. Nothing was written."; exit 1 ;; esac
```

## Step 4 — review the dry run before the first write

```bash
printf 'DRY RUN: configure %s on %s@%s; credential length=%s (value hidden).\n' "$SKILL_NAME" "$VPS_USER" "$VPS_IP" "${#MEM0_API_KEY}"
printf '%s\n' 'Snapshot env/config; write private values through stdin; register native MCP or publish a native skill; verify discovery; restart and require a new ready gateway instance; retire snapshot.'
[ "${DRY_RUN:-0}" != 1 ] || exit 0
```

Review the concrete plan. Continue under the user's existing setup authorization. Native
OAuth may require the user to approve the vendor login in a browser; never fabricate
that approval. Catalog tool exclusions remain those supplied by the pinned Hermes
manifest. Do not replace OAuth with a short-lived bearer or invent a refresh cron.

## Step 5 — snapshot and write private configuration

```bash
snapshot || { echo "ABORT: snapshot failed. Nothing was written."; exit 1; }
printf '%s\n' "$MEM0_API_KEY" | remote 'IFS= read -r v && hermes -p default config set MCP_MEM0_API_KEY "$v" >/dev/null 2>&1 && chmod 600 "$HOME/.hermes/.env"' || fail_change "writing MCP_MEM0_API_KEY failed"
printf '%s\n' "$MEM0_HOST" | remote 'IFS= read -r v && hermes -p default config set MEM0_HOST "$v" >/dev/null 2>&1 && chmod 600 "$HOME/.hermes/.env"' || fail_change "writing MEM0_HOST failed"
```

Secrets remain in `.env`, mode 600. Any references in `config.yaml` use `${VAR}`
indirection. Never print a configured secret or use `sed` to inline it into YAML.

## Step 6 — install and verify the integration

```bash
if [ "$WIRE_PATH" = A ]; then
printf 'y\n' | remote 'hermes -p default mcp remove mem0' >/dev/null 2>&1 || fail_change "previous MCP removal failed"
printf 'y\ny\n' | remote 'hermes -p default mcp add mem0 --url https://mcp.mem0.ai/mcp --auth header' >/dev/null || fail_change "MCP registration failed"
remote "hermes -p default mcp list | grep -E '^ *mem0 .*enabled'" >/dev/null || fail_change "MCP is absent or disabled (an install/add exit 0 alone is not proof)"
remote 'hermes -p default mcp test mem0' >/dev/null 2>&1 || fail_change "MCP connection or tool discovery failed"
fi
if ! [ "$WIRE_PATH" = A ]; then
# Changing to the REST route retires the old native MCP inside the same env/config transaction.
printf 'y\n' | remote 'hermes -p default mcp remove mem0' >/dev/null 2>&1 || fail_change "previous-route MCP removal failed"
remote 'bash -s' <<'REMOTE' || fail_change "native skill publication failed"
set -e
umask 077
name=integration-mem0
d="$HOME/.hermes/.hstack-backup/$name"
p="$HOME/.hermes/skills/$name-runtime"
[ -f "$d/.complete" ] || exit 1
[ ! -e "$p" ] && [ ! -L "$p" ] || { echo "Refusing to replace an existing native skill" >&2; exit 1; }
mkdir -p "$HOME/.hermes/skills"
t=$(mktemp "$d/native.XXXXXX")
trap 'rm -f "$t"' EXIT
cat > "$t" <<'NATIVE_SKILL'
---
name: integration-mem0-runtime
description: Read mem0 data using the configured private credentials. Use for mem0 requests; require explicit approval before any write or paid action.
---

# mem0 from Hermes

Use the terminal tool on this host. Read credentials privately from ~/.hermes/.env.
Never paste them into a chat, URL, process arguments or logs. The following code performs
only a read-only check. Adapt it to the user's requested read using the same vendor host
and authentication; request approval before POST/PUT/PATCH/DELETE that changes state.
Memory-search POSTs retrieve data only. Adding, editing or deleting a memory requires a separate request.

~~~bash
python3 - <<'PYTHON'
from pathlib import Path
import os,json,shlex,stat,urllib.request,urllib.parse,base64,subprocess
p=Path.home()/".hermes"/".env"
assert p.is_file() and not p.is_symlink() and stat.S_IMODE(p.stat().st_mode)==0o600, "Credentials must be a private regular file (600)"
e={}
wanted=['MCP_MEM0_API_KEY', 'MEM0_HOST']
for line in p.read_text().splitlines():
 if "=" not in line or line.lstrip().startswith("#"): continue
 key,value=line.split("=",1)
 if key.startswith("export "): key=key[7:]
 key=key.strip()
 if key not in wanted: continue
 parts=shlex.split(value,comments=False)
 e[key]=" ".join(parts)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl): return None
opener=urllib.request.build_opener(NoRedirect())
def request_json(req):
 u=urllib.parse.urlsplit(req.full_url)
 assert not u.username and not u.password and not u.fragment
 assert u.scheme=="https" or (u.scheme=="http" and u.hostname in ("127.0.0.1","localhost")), "Use HTTPS or loopback HTTP"
 with opener.open(req,timeout=25) as r:
  assert r.status==200, "Unexpected vendor status"
  data=r.read(1048577)
  assert len(data)<=1048576, "Vendor response exceeds 1 MiB; narrow the read"
  return json.loads(data)
host=e.get("MEM0_HOST","http://127.0.0.1:8888")
url="https://api.mem0.ai/v1/memories/search/" if e.get("MCP_MEM0_API_KEY") else host+"/search"
headers={"Content-Type":"application/json"}
if e.get("MCP_MEM0_API_KEY"): headers["Authorization"]="Token "+e["MCP_MEM0_API_KEY"]
data=json.dumps({"query":"ping","user_id":"hstack-preflight","limit":1}).encode()
req=urllib.request.Request(url,data=data,headers=headers)
try:
 print(json.dumps(request_json(req)))
except Exception:
 raise SystemExit("Read-only vendor request failed; inspect permissions/network without printing credentials.")
PYTHON
~~~

Do not print access tokens or private configuration when troubleshooting. A live read from the intended account is required before claiming vendor compatibility.
NATIVE_SKILL
chmod 600 "$t"
cksum < "$t" > "$d/native.cksum"
# Record intent before publication; rollback removes only the matching new file.
printf '%s\n' "$name-runtime" > "$d/native-created"
mkdir "$p"
# Atomic no-clobber publication; a concurrent existing file cannot be overwritten.
ln "$t" "$p/SKILL.md"
cmp -s "$t" "$p/SKILL.md"
chmod 600 "$p/SKILL.md"
REMOTE
remote "hermes -p default skills list --source local --enabled | grep -F -- 'integration-mem0-runtime'" >/dev/null || fail_change "native skill not discoverable"
fi
```

Catalog MCPs use Hermes's own OAuth flow, endpoint and curated tool filters. Any custom
stdio package is executed on the host with the user's permissions; review its published
package/version before installation. Hermes parser verification establishes argument
syntax, not third-party package behavior. A native REST skill is installed into Hermes's
actual `skills/` directory and checked with `skills list`, rather than saved as inert
API notes. Existing native skill files are preserved. On failure, only the checksummed
file created by this run is removed; an edited or foreign file stops automatic cleanup.

## Step 7 — restart and require native readiness

```bash
gw_reload >/dev/null || fail_change "gateway did not restart into a new ready instance"
```

`gateway ensure --json` must exit 0 and report `"state":"ready"`; pending/draining
states are retried. The helper captures the old instance even during draining and
refuses to call the same process a successful reload. With live sessions, restart may
refuse. Set `GW_INTERRUPT=1` only under the user's explicit permission to interrupt.

## Step 8 — finish and keep recovery evidence

```bash
finish || fail_change "snapshot retirement failed"
echo "Setup complete: native discovery and gateway readiness verified; vendor live proof exists only if these checks actually ran on the user's host."
```

The procedure runs the read-only vendor gate before writing. For an end-to-end user
acceptance check, ask Hermes to use the newly configured integration to read one visible
record. Confirm the account/tenant/region is correct. That live result is separate from
this repository's source/parser and sandbox evidence; do not claim it while authoring.

## Recovery

Before `finish`, call `restore_native_skill` then `rollback` in this same shell to restore
previous env/config bytes and remove only this run's native skill. A failed restoration
keeps the active recovery point; repair the fault and retry. After successful `finish`,
the previous snapshot is private at `.hstack-backup/$SKILL_NAME.prev`. Inspect it before
manual undo; do not replace a newer active snapshot or remove an edited runtime skill.
No vendor records are created by setup, so there is no vendor-side smoke-test data to
clean up. Native OAuth caches are managed by Hermes and are outside the env/config
snapshot: rollback does not revoke tokens or overwrite an existing OAuth authorization.

## Pitfalls

| # | Pitfall | Correct behavior |
|---|---------|------------------|
| 1 | Wrong Hermes release or profile | Exact 0.22.5 host/default gate before writes; other installations need a separately reviewed procedure. |
| 2 | Treating exit 0 from `mcp add`/login as connection proof | Require an enabled entry plus `mcp test`; cancellation and a saved disabled entry do not count. |
| 3 | Putting secrets into SSH arguments or YAML | Send values as stdin, keep `.env` private and use variable references. |
| 4 | Using a missing background flag or log substring as health | Use the shared restart/ensure helpers and require a changed instance ID. |
| 5 | Replacing the previous secret on a failed reconfiguration | Snapshot exact bytes first, then restore both files; never just delete the key. |
| 6 | Skipping the read-only preflight on a missing dependency | Abort before snapshot; install the documented host prerequisite and rerun. |
| 7 | Overwriting a hand-authored Hermes skill | Refuse the existing path, preserve it, and remove only a new file with its recorded checksum. |
| 8 | Confusing source tests with real service evidence | Record actual host/vendor acceptance separately; credentials, browser consent and a server are still required. |
| 9 | Running write or paid smoke tests | Use only the read-only check; a write or paid request requires explicit task authorization. |
| 10 | Confusing read-only-looking usernames with access enforcement | Verify server grants/ACLs; scoped accounts remain the real permission boundary. |

## Definition of done

- [ ] Hermes 0.22.5 host/default release verified before configuration changes.
- [ ] Read-only vendor credential and consent gates passed from the target host.
- [ ] Private credentials written over stdin with mode 600; config uses references.
- [ ] Native catalog/custom MCP is enabled and passes `mcp test`, or the real runtime skill is discoverable.
- [ ] Gateway restart produced a new ready instance through native JSON readiness.
- [ ] Previous env/config bytes remain in a verified private snapshot.
- [ ] User-visible integration read performed on the real host before claiming live success.
