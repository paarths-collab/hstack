---
name: hermes-mcp-add
description: Add any MCP server to a self-hosted Hermes v0.22.5 over SSH. Uses the native catalog (`mcp install`) when the server is in it, otherwise probes the endpoint from the VPS before writing anything, stores the credential in .env over ssh stdin, registers it with `mcp add` or `config set`, and verifies with `mcp test`. Use when no integration-specific skill exists. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-mcp-add — add any MCP server to a remote Hermes (SSH-first)

You are the engineer wiring an MCP server into a self-hosted Hermes agent on the user's VPS. The agent (Hermes, Codex,
Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches
the VPS through the `remote` helper from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the
remote PATH. Secrets are pasted or generated locally, validated locally, and travel to the VPS only over ssh STDIN. Run
all blocks in ONE shell session: later steps call the Step 0 functions.

Do everything autonomously; stop only for what a machine cannot do: mint the token, confirm the MCP URL, and (for OAuth
servers) approve the sign-in in a browser.

**The native picture (v0.22.5, read from source).**

- **Catalog first.** `hermes mcp catalog` lists the vetted servers shipped with Hermes (66 manifests under `optional-mcps/`),
  `hermes mcp install NAME` installs one. All 66 are remote HTTP servers: 56 use OAuth, 10 need no authentication, none
  takes an API key. So a no-auth entry is one headless command; an OAuth entry installs but still needs a human sign-in
  (`hermes mcp login NAME --flow device`), and the CLI exits 0 whether or not that sign-in worked: only `mcp test` tells.
- **`mcp add` flags** are exactly `--url`, `--command`, `--args` (swallows everything after it, so it goes last),
  `--auth {oauth,header}`, `--preset`, `--connect-timeout` and, for stdio servers only, `--env KEY=VALUE...`. There is no
  `--auth-header`, `--auth-scheme`, `--placeholder-token` or `--yes`.
- **`mcp add` is interactive.** It asks "Does this server require authentication? [Y/n]", then connects and asks
  "Enable all N tools? [Y/n/select]". With stdin closed the second question CANCELS: nothing is saved and the exit code
  is still 0. So this skill feeds the answers on stdin and verifies with `mcp list` and `mcp test`.
- **Header auth is one shape only:** `Authorization: Bearer ${MCP_<NAME>_API_KEY}`. If that variable is already in
  `~/.hermes/.env` the token prompt is skipped and only the reference lands in `config.yaml`. A different header name
  (`x-api-key`), or a token in the URL path or query string, cannot be expressed by `mcp add`. This skill writes those with
  `hermes config set mcp_servers.<name>.*`, which Hermes accepts for this open mapping and which resolves `${VAR}`
  references in `url` and `headers` at connect time. That path is derived from source, not from a documented command: the
  verification step decides whether it worked.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$MCP_NAME` | Short name in Hermes: lowercase letters, digits, dashes (at most 32) | User picks, e.g. `linear`, `deepwiki` |
| `$MCP_URL` | Endpoint, `https://...`, no token in it. Leave empty to install a catalog entry of that name | Vendor docs |
| `$MCP_AUTH` | `auto` (default: probe), `bearer`, `header`, `path`, `query`, `none` or `oauth` | `auto` unless the vendor says otherwise |
| `$MCP_HEADER_NAME` | Header for `MCP_AUTH=header` (default `x-api-key`) | Vendor docs |
| `$MCP_TOKEN` | The API token, for every `MCP_AUTH` except `none`/`oauth` | Vendor's dashboard |

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
SKILL_NAME=hermes-mcp-add
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

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked
against the v0.22.5 source; it has not been run against a live host. Run `whoami; hostname` on the target once: a hex
hostname means you are inside a container and `hermes` state lives on the Docker host.

---

## Step 2 — validate the inputs locally and choose the route

Nothing is sent anywhere until this passes. Names and URLs end up inside single-quoted remote commands and a YAML file, so
only plain characters are accepted.

```bash
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
MCP_AUTH="${MCP_AUTH:-auto}"
MCP_HEADER_NAME="${MCP_HEADER_NAME:-x-api-key}"
case "$MCP_NAME" in ""|*[!a-z0-9-]*|-*|*-)
  echo "ABORT: MCP_NAME must be lowercase letters, digits and dashes, not starting or ending with a dash. Nothing was written."; exit 1 ;;
esac
[ "${#MCP_NAME}" -le 32 ] || { echo "ABORT: MCP_NAME is longer than 32 characters. Nothing was written."; exit 1; }
case "$MCP_AUTH" in auto|bearer|header|path|query|none|oauth) ;; *)
  echo "ABORT: MCP_AUTH must be auto, bearer, header, path, query, none or oauth (got: $MCP_AUTH). Nothing was written."; exit 1 ;;
esac
case "$MCP_HEADER_NAME" in ""|*[!A-Za-z0-9-]*)
  echo "ABORT: MCP_HEADER_NAME may contain only letters, digits and dashes. Nothing was written."; exit 1 ;;
esac
ENV_VAR="MCP_$(printf '%s' "$MCP_NAME" | tr 'a-z-' 'A-Z_')_API_KEY"

if [ -n "${MCP_URL:-}" ]; then
  case "$MCP_URL" in https://*) ;; *)
    echo "ABORT: MCP_URL must start with https://. Nothing was written."; exit 1 ;;
  esac
  case "$MCP_URL" in *[!A-Za-z0-9._~:/?#@!%+=,\&-]*)
    echo "ABORT: MCP_URL has characters that do not belong in a plain URL (spaces, quotes, \$, braces, backticks). Nothing was written."; exit 1 ;;
  esac
fi

IN_CATALOG=$(remote 'hermes -p default mcp catalog' </dev/null 2>/dev/null | awk -v n="$MCP_NAME" '$1==n && $2!="custom"{print "yes"; exit}')
if [ "$MCP_AUTH" = oauth ]; then
  [ -n "${MCP_URL:-}" ] || { echo "ABORT: MCP_AUTH=oauth needs MCP_URL (a catalog entry needs no MCP_AUTH). Nothing was written."; exit 1; }
  ROUTE=oauth
elif [ "$IN_CATALOG" = yes ] && [ -z "${MCP_URL:-}" ]; then
  ROUTE=catalog
elif [ -n "${MCP_URL:-}" ]; then
  ROUTE=custom
else
  echo "ABORT: $MCP_NAME is not in the Hermes catalog (hermes mcp catalog) and MCP_URL is empty. Nothing was written."; exit 1
fi
if [ "$ROUTE" = custom ] && [ "$MCP_AUTH" != none ]; then
  secret_chars_ok "${MCP_TOKEN:-}" \
    || { echo "ABORT: MCP_TOKEN is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
fi
echo "Route: $ROUTE (name=$MCP_NAME, secret variable=$ENV_VAR)"
```

Routes: `catalog` (no credential from you), `oauth` (a custom OAuth server, attended sign-in), `custom` (token or no auth,
decided by the probe in Step 4). Stdio servers (`--command npx --args ...`) are Path D in Step 7.

---

## Step 3 — idempotency check (skip if already configured)

The match is on the exact server name in the first column of `mcp list`, not a substring (`git` must not match `github`).

```bash
ALREADY=$(remote 'hermes -p default mcp list' </dev/null 2>/dev/null | awk -v n="$MCP_NAME" '$1==n{print "yes"; exit}')
if [ "$ALREADY" = yes ] && [ "${FORCE:-0}" != 1 ]; then
  echo "$MCP_NAME is already configured (hermes mcp list). Re-run with FORCE=1 to rewire it."
  exit 0
fi
```

---

## Step 4 — HARD GATE: probe the endpoint from the VPS BEFORE anything is written

Only for `ROUTE=custom`. A catalog entry carries its own vetted transport, and an OAuth server cannot be probed headlessly.
The probe is what tells an unknown server's auth shape: docs and pasted URL forms are unreliable (a documented
`/mcp/<token>` path may 404 while a bearer header works). Each variant sends one JSON-RPC `initialize` POST from the VPS
(proving its egress too); the credential travels as a curl config on ssh STDIN, so it never appears in argv, in a URL on
a command line, or in a quoted remote string. Nothing has touched `~/.hermes` yet.

```bash
SHAPE=""
if [ "$ROUTE" = custom ]; then
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hstack-probe","version":"0"}}}'
  # probe_code SHAPE: HTTP status of an initialize POST sent with that credential placement (none, bearer, header, path, query).
  probe_code() {
    local cfg sep
    case "$1" in
      none)   cfg="url = \"$MCP_URL\"" ;;
      bearer) cfg="url = \"$MCP_URL\"
header = \"Authorization: Bearer $MCP_TOKEN\"" ;;
      header) cfg="url = \"$MCP_URL\"
header = \"$MCP_HEADER_NAME: $MCP_TOKEN\"" ;;
      path)   cfg="url = \"${MCP_URL%/}/$MCP_TOKEN\"" ;;
      query)  case "$MCP_URL" in *\?*) sep='&' ;; *) sep='?' ;; esac
              cfg="url = \"$MCP_URL${sep}token=$MCP_TOKEN\"" ;;
    esac
    printf '%s\n' "$cfg" \
      | remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '$INIT' --config -"
  }
  UNAUTH=$(probe_code none)
  echo "probe: initialize without credentials -> HTTP ${UNAUTH:-none}"
  case "$MCP_AUTH" in
    none)
      [ "$UNAUTH" = 200 ] \
        || { echo "ABORT: the server did not accept an unauthenticated initialize (HTTP ${UNAUTH:-none}). Nothing was written."; exit 1; }
      SHAPE=none ;;
    auto)
      if [ "$UNAUTH" = 200 ]; then
        echo "ABORT: this server answers initialize without credentials, so probing cannot reveal its auth shape. Set MCP_AUTH to bearer, header, path or query (vendor docs), or none. Nothing was written."
        exit 1
      fi
      for s in bearer header path query; do
        c=$(probe_code "$s"); echo "probe: $s -> HTTP ${c:-none}"
        if [ "$c" = 200 ]; then SHAPE=$s; break; fi
      done
      [ -n "$SHAPE" ] \
        || { echo "ABORT: no auth shape was accepted (bearer, header, path, query). Check the token and the URL. Nothing was written."; exit 1; } ;;
    *)
      c=$(probe_code "$MCP_AUTH"); echo "probe: $MCP_AUTH -> HTTP ${c:-none}"
      [ "$c" = 200 ] \
        || { echo "ABORT: the server rejected the credential sent as $MCP_AUTH (HTTP ${c:-none}). Nothing was written."; exit 1; }
      [ "$UNAUTH" != 200 ] || echo "WARN: initialize also answers 200 without credentials, so this probe does not prove the token is valid."
      SHAPE=$MCP_AUTH ;;
  esac
  echo "Auth shape: $SHAPE"
fi
```

`initialize` succeeding is NOT proof that tools are reachable: many servers answer the handshake and enforce auth later.
That is why `auto` refuses to guess when the unauthenticated call also returns 200, and why Step 9 runs `mcp test`
(which lists the server's tools) after registration. If the vendor documents no usable endpoint at all, say so; do not fake
a probe.

---

## Step 5 — DRY RUN preview (always show before writing)

```bash
case "$ROUTE:$SHAPE" in
  catalog:*)   WHAT="hermes -p default mcp install $MCP_NAME   (vetted catalog entry; you give it no credential)" ;;
  oauth:*)     WHAT="hermes -p default mcp add $MCP_NAME --url $MCP_URL --auth oauth, then an attended sign-in (mcp login)" ;;
  custom:none) WHAT="hermes -p default mcp add $MCP_NAME --url $MCP_URL   (no authentication)" ;;
  custom:bearer) WHAT="write $ENV_VAR (length ${#MCP_TOKEN}) to ~/.hermes/.env, then mcp add $MCP_NAME --url $MCP_URL --auth header" ;;
  custom:*)    WHAT="write $ENV_VAR (length ${#MCP_TOKEN}) to ~/.hermes/.env, then config set mcp_servers.$MCP_NAME.* using a \${$ENV_VAR} reference ($SHAPE)" ;;
esac
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) inputs validated, route=$ROUTE, auth shape=${SHAPE:-n/a}, live probe from the VPS, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. $WHAT
  3. Reload the gateway (restart --detach, then gateway ensure --json until ready with a new instance)
  4. Verify: mcp list shows $MCP_NAME enabled; mcp test $MCP_NAME exits 0 (connects and lists tools)
  Any failure after step 1 restores the snapshot. The token is NEVER printed.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 6 — snapshot, then write the credential (chmod 600, over stdin, no logging)

`MCP_<NAME>_API_KEY` is the variable Hermes itself derives for the server's header (`hermes_cli/mcp_config.py:305-309`).
`config set` routes an UPPER_SNAKE name ending in `_API_KEY` to `.env` and never echoes the value
(`hermes_cli/config.py:3416-3440`). A catalog or OAuth route has no credential to write; the snapshot is still taken
because the registration edits `config.yaml`.

```bash
snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
case "$SHAPE" in
  bearer|header|path|query)
    printf '%s\n' "$MCP_TOKEN" \
      | remote "IFS= read -r v && hermes -p default config set $ENV_VAR \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env" \
      || { echo "FAIL: could not write $ENV_VAR."; rollback; exit 1; }
    WROTE=$(remote "grep -c '^$ENV_VAR=' ~/.hermes/.env || true")
    [ "$WROTE" = 1 ] || { echo "FAIL: $ENV_VAR not written exactly once (found ${WROTE:-0})."; rollback; exit 1; } ;;
esac
```

---

## Step 7 — register the server (run the path that matches the route)

`FORCE=1` removes the old entry first, so `mcp add` does not stop on its "already exists. Overwrite? [y/N]" question. Every
`mcp` call that can prompt reads `</dev/null` or an explicit stdin, never the terminal of the harness.

### Path A — catalog entry (`ROUTE=catalog`)

```bash
if [ "${FORCE:-0}" = 1 ]; then remote "hermes -p default mcp remove $MCP_NAME >/dev/null 2>&1 || true" </dev/null; fi
OUT=$(remote "hermes -p default mcp install $MCP_NAME" </dev/null 2>&1) \
  || { printf '%s\n' "$OUT"; echo "FAIL: hermes -p default mcp install $MCP_NAME."; rollback; exit 1; }
printf '%s\n' "$OUT" | tail -n 12
NEEDS_LOGIN=0
printf '%s\n' "$OUT" | grep -q 'OAuth' && NEEDS_LOGIN=1
remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" </dev/null >/dev/null \
  || { echo "FAIL: $MCP_NAME is not listed as enabled after install."; rollback; exit 1; }
```

An OAuth entry is installed but not signed in: its probe could not run, and Hermes says "Couldn't probe server". That is
expected; Path E below finishes it.

### Path B — token as `Authorization: Bearer` (`SHAPE=bearer`)

`MCP_<NAME>_API_KEY` is already in `.env` (Step 6), so Hermes skips the token prompt and stores only
`Authorization: Bearer ${MCP_<NAME>_API_KEY}` in `config.yaml`. The two `y` answers are "requires authentication" and
"enable all tools". `mcp add` exits 0 even when it saved nothing, so the result is verified, not assumed.

```bash
if [ "${FORCE:-0}" = 1 ]; then remote "hermes -p default mcp remove $MCP_NAME >/dev/null 2>&1 || true" </dev/null; fi
printf 'y\ny\n' | remote "hermes -p default mcp add $MCP_NAME --url '$MCP_URL' --auth header" >/dev/null \
  || { echo "FAIL: hermes -p default mcp add."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" </dev/null >/dev/null \
  || { echo "FAIL: $MCP_NAME is not listed as enabled (the add was cancelled or the connection failed)."; rollback; exit 1; }
```

If the connection fails, the second `y` answers "Save config anyway?" and the server is saved DISABLED; the `enabled` check
above catches it.

### Path C — custom header, path token, query token, or no auth (`SHAPE=header|path|query|none`)

`mcp add` cannot place a credential anywhere but the `Authorization: Bearer` header, so these shapes are written with
`config set` on the open `mcp_servers` mapping. The secret is NOT in these values: they carry only a `${VAR}` reference that
Hermes resolves from `.env` when it connects. A reference whose variable is unset makes Hermes refuse to connect instead of
sending the literal text (`tools/mcp_tool_config.py:585-599`).

```bash
cfg_set() {  # KEY VALUE: the value travels on stdin; it holds at most a ${VAR} reference, never a secret
  printf '%s\n' "$2" | remote "IFS= read -r v && hermes -p default config set '$1' \"\$v\" >/dev/null"
}
if [ "${FORCE:-0}" = 1 ]; then remote "hermes -p default mcp remove $MCP_NAME >/dev/null 2>&1 || true" </dev/null; fi
REF="\${$ENV_VAR}"
case "$SHAPE" in
  header) URLV="$MCP_URL"; cfg_set "mcp_servers.$MCP_NAME.headers.$MCP_HEADER_NAME" "$REF" || { echo "FAIL: could not write the header."; rollback; exit 1; } ;;
  path)   URLV="${MCP_URL%/}/$REF" ;;
  query)  case "$MCP_URL" in *\?*) sep='&' ;; *) sep='?' ;; esac; URLV="$MCP_URL${sep}token=$REF" ;;
  none)   URLV="$MCP_URL" ;;
esac
cfg_set "mcp_servers.$MCP_NAME.url" "$URLV" && cfg_set "mcp_servers.$MCP_NAME.enabled" true \
  || { echo "FAIL: could not write mcp_servers.$MCP_NAME."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" </dev/null >/dev/null \
  || { echo "FAIL: $MCP_NAME is not listed as enabled."; rollback; exit 1; }
```

Before it counts, Step 9 must show `mcp test` exiting 0: `config set` skips the connection probe that `mcp add` runs, so
the test is the only check that Hermes can really connect with this shape.

### Path D — a stdio server (`npx`, `uvx`, a local script)

`--args` swallows everything after it, so it is the last option; `--env` is for stdio only and its values are stored in
`config.yaml` as given. Pass a `${VAR}` reference and keep the real secret in `.env` (write it over stdin exactly as in
Step 6, with the variable name the server expects). Hermes refuses shell commands that combine egress tools with
exfiltration-shaped arguments (`hermes_cli/mcp_security.py`).

```bash
printf 'y\n' | remote "hermes -p default mcp add $MCP_NAME --env 'EXAMPLE_API_KEY=\${EXAMPLE_API_KEY}' --command npx --args -y @example/mcp-server" >/dev/null \
  || { echo "FAIL: hermes -p default mcp add (stdio)."; rollback; exit 1; }
```

### Path E — sign in to an OAuth server (a human step)

For `ROUTE=oauth` register the server first (the add cannot sign in without a person, so its probe fails and the entry is
saved disabled; the one `y` answers "Save config anyway?"). Then let the user approve the device code and enable it:

```bash
if [ "$ROUTE" = oauth ]; then
  if [ "${FORCE:-0}" = 1 ]; then remote "hermes -p default mcp remove $MCP_NAME >/dev/null 2>&1 || true" </dev/null; fi
  printf 'y\n' | remote "hermes -p default mcp add $MCP_NAME --url '$MCP_URL' --auth oauth" >/dev/null \
    || { echo "FAIL: hermes -p default mcp add (oauth)."; rollback; exit 1; }
  NEEDS_LOGIN=1
fi
```

Ask the user to run, in an attended terminal (`ssh -t user@host`):

```text
hermes -p default mcp login NAME --flow device
```

It prints a URL and a code on stderr; the user opens the URL on any device and approves. (`--flow browser` needs the
redirect to reach the VPS: paste the redirect URL back at its prompt, or forward the port with `ssh -N -L`.) If the server
does not advertise device authorization, the command says so and only the browser flow works. When the sign-in is done, a
custom OAuth server saved by Path E must also be switched on: `hermes -p default config set mcp_servers.NAME.enabled true`.
Then continue with Step 8 and Step 9.

---

## Step 8 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway
with a new `instance_id`. A refusal because of live sessions is reported, not overridden.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — verify the connection natively (`mcp test`, within 30s)

`hermes mcp test NAME` connects and lists the server's tools. Exit 0 is connected, 1 connection failed, 3 not in the
config (`hermes_cli/mcp_config.py:836-880`); `mcp login` and `mcp add` exit 0 whatever happened, so never judge them by
their exit status.

```bash
CONNECTED=0
for i in 1 2 3; do
  if remote "hermes -p default mcp test $MCP_NAME" </dev/null >/dev/null 2>&1; then CONNECTED=1; echo "OK: $MCP_NAME connected."; break; fi
  sleep 5
done
if [ "$CONNECTED" != 1 ] && [ "${NEEDS_LOGIN:-0}" = 1 ]; then
  echo "PENDING: $MCP_NAME is installed but not signed in (OAuth). Have the user run \`hermes -p default mcp login $MCP_NAME --flow device\` in an attended terminal, then re-run this block. The snapshot stays active until then."
  exit 3
fi
[ "$CONNECTED" = 1 ] || { echo "FAIL: $MCP_NAME did not connect within 30s."; rollback; exit 1; }
remote "hermes -p default mcp list | grep -E '^ *$MCP_NAME .*enabled'" </dev/null >/dev/null \
  || { echo "FAIL: $MCP_NAME is not enabled."; rollback; exit 1; }
if [ -n "$SHAPE" ] && [ "$SHAPE" != none ]; then
  remote "VAR='$ENV_VAR' bash -s" <<'REMOTE' \
    || { echo "FAIL: the secret is missing from .env or found in config.yaml."; rollback; exit 1; }
v=$(sed -n "s/^$VAR=//p" ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
[ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml
REMOTE
fi
```

New chat sessions load the tools at their start; a running chat needs `/reload-mcp`.

---

## Step 10 — live smoke test with the value read back from `~/.hermes/.env`

The ssh shell is non-interactive and has NOT loaded `.env`, so `$MCP_TOKEN` would be empty there. Read the value from the
file on the VPS: this also proves it persisted. Only for a stored credential; `mcp test` above is the smoke test for the
rest.

```bash
if [ -n "$SHAPE" ] && [ "$SHAPE" != none ]; then
  CODE=$(remote "SHAPE='$SHAPE' URL='$MCP_URL' VAR='$ENV_VAR' HDR='$MCP_HEADER_NAME' bash -s" <<'REMOTE'
v=$(sed -n "s/^$VAR=//p" ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
sep='?'; [ "${URL#*\?}" != "$URL" ] && sep='&'
{
  if [ "$SHAPE" = bearer ]; then printf 'url = "%s"\nheader = "Authorization: Bearer %s"\n' "$URL" "$v"
  elif [ "$SHAPE" = header ]; then printf 'url = "%s"\nheader = "%s: %s"\n' "$URL" "$HDR" "$v"
  elif [ "$SHAPE" = path ]; then printf 'url = "%s/%s"\n' "${URL%/}" "$v"
  else printf 'url = "%s%stoken=%s"\n' "$URL" "$sep" "$v"
  fi
} | curl -sS -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"hstack-smoke","version":"0"}}}' --config -
REMOTE
)
  [ "$CODE" = 200 ] || { echo "FAIL: smoke test returned HTTP ${CODE:-none} (401 = bad token, 403 = scope missing)."; rollback; exit 1; }
  echo "OK: $MCP_NAME reachable with the credential stored on the VPS."
fi
finish || exit 1
```

`finish` keeps the pre-run state as `~/.hermes/.hstack-backup/hermes-mcp-add.prev` for a manual undo (see Rollback).

---

## Rollback

Defined once, in Step 0. It runs automatically (`rollback; exit 1`) on every failure after `snapshot`. It does not delete
keys; it RESTORES the exact pre-run state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/hermes-mcp-add/` (a file that
  did not exist before is removed; a `FORCE=1` re-run gets its previous working value back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload`, and only then does the snapshot move to `hermes-mcp-add.prev`. If the gateway
  does not come back ready, `rollback` says so, keeps the snapshot and exits non-zero: inspect
  `hermes -p default gateway status` and `hermes -p default logs gateway -n 50`, then run `rollback` again. A restart refused
  because of live sessions is the same case (`GW_INTERRUPT=1` only if interrupting them is acceptable).

Failures before `snapshot` (inputs, probe, declined dry run) wrote nothing. If a run is interrupted after `snapshot`, the
next `snapshot` refuses to run: call `rollback` first. OAuth tokens a sign-in cached are not part of the snapshot; remove a
server and its tokens with `hermes -p default mcp remove NAME`.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including old secrets) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using `--auth-header`, `--auth-scheme`, `--placeholder-token` or `--yes` | They do not exist: argparse exits 2 | `--auth header` plus stdin answers (Path B), or `config set` (Path C) |
| 2 | `mcp add` with stdin closed | The "Enable all N tools?" question cancels; nothing is saved; exit 0 | Answer on stdin and verify with `mcp list` and `mcp test` |
| 3 | Typing a header name on stdin ("Authorization") | There is no header-name prompt; if the key is not in `.env` that line is read as the TOKEN and saved as the secret | Write `MCP_<NAME>_API_KEY` first (Step 6); only `y` lines go to stdin |
| 4 | Passing the token as `--env KEY=secret` or in a URL on a command line | Visible in `ps` on both machines and stored in `config.yaml` | Secret on ssh stdin into `.env`; `config.yaml` holds `${VAR}` only |
| 5 | Wiring an OAuth server with a static bearer token | Every request is rejected | `ROUTE=oauth`/catalog plus `mcp login`; check `mcp test` |
| 6 | Trusting `mcp login` or `mcp add` exit codes | Both exit 0 on failure | Judge only `mcp test` (0/1/3) and `mcp list` |
| 7 | Stopping at `initialize` success | The handshake is often unauthenticated | `auto` refuses to guess; Step 9 lists tools |
| 8 | Probing before the credential check, or writing before the probe | A typo'd token or wrong URL replaces working config | Step 4 runs before `snapshot` and writes nothing |
| 9 | Substring match on `mcp list` | `git` matches `github` | Match the exact first column (Steps 2, 3) |
| 10 | `mcp configure` over ssh | Requires a TTY: exits 1 | Choose tools with `config set mcp_servers.NAME.tools.include`, or run it attended |
| 11 | Expecting the catalog to hold an API-key server | None of the 66 entries uses one (all HTTP: 56 OAuth, 10 no-auth) | Route `custom` with the probe |
| 12 | A `${VAR}` reference with no value in `.env` | Hermes refuses to connect (fail closed) | Step 6 writes it; Step 9 greps for it |
| 13 | A fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run Step 0 first |
| 14 | Re-running after an interrupted run | A leftover snapshot means the earlier run wrote something | `snapshot` refuses; run `rollback`, then re-run |
| 15 | Chat sessions still showing the old tool list | MCP tools load when a session starts | New session, or `/reload-mcp` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed; Hermes banner names `0.22.5`
- [ ] Inputs validated locally; route chosen (catalog, oauth or custom); idempotency check passed (or `FORCE=1`)
- [ ] Custom route: the live probe from the VPS found an auth shape BEFORE anything was written
- [ ] Dry run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write
- [ ] The credential is in `~/.hermes/.env` (chmod 600), written over stdin; `config.yaml` holds only `${VAR}` references
- [ ] The server is registered (`mcp install`, `mcp add` or `config set`) and `mcp list` shows it enabled
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] `hermes -p default mcp test NAME` exits 0 (for OAuth: after the attended sign-in)
- [ ] Stored-credential smoke test returned `200`, or `mcp test` was the smoke test (no credential)
- [ ] `finish` ran; Rollback restores the pre-run `.env` and `config.yaml`

---

## Verified against Hermes v0.22.5

Read from the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the
repository root of that tag.

- `mcp` subcommands and flags (`add --url --command --args(REMAINDER) --auth {oauth,header} --preset --connect-timeout --env`,
  `remove|rm`, `list|ls`, `test`, `configure`, `login --flow {browser,device}`, `reauth`, `picker`, `catalog`, `install`):
  `hermes_cli/subcommands/mcp.py:19-68`.
- `mcp add` flow, questions and the cancel-without-saving path: `hermes_cli/mcp_config.py:618-721` (`--env` with `--url`
  refused `:640-642`), `_configure_http_auth` `:545-584` (skips the token prompt when `MCP_<NAME>_API_KEY` is set), `_choose_tools`
  `:586-615`, `_confirm` returns its default on EOF `:194-201`. Header template and variable name:
  `_env_key_for_server` `:305-309`, `_bearer_auth_headers` `:327-333`. Unsafe stdio commands are refused:
  `hermes_cli/mcp_security.py` (`validate_mcp_server_entry`), called from `_save_mcp_server` `:233-244`.
- `mcp test` exit codes 0/1/3: `:836-880`. `mcp login` and `mcp reauth` return nothing (exit 0): `:972-980`, device flow
  `tools/mcp_oauth_device.py:204`, output on stderr `:85-86`. `mcp configure` needs a TTY: `:1047-1050`. `mcp list` columns and
  `enabled/disabled`: `:744-805`.
- Catalog: `hermes mcp catalog` / `install NAME`: `hermes_cli/mcp_picker.py:187-190,209-220`; install order (credentials, entry, probe,
  tool selection) `hermes_cli/mcp_catalog.py:777-847`; non-TTY skips the checklist `:615-720`. Counted from
  `optional-mcps/*/manifest.yaml`: 66 entries, all `transport.type: http`, 56 `auth.type: oauth`, 10 `none`, 0 `api_key`. OAuth without a TTY
  fails fast: `tools/mcp_oauth.py:334-352,1257-1262`.
- `${VAR}` references in `url`, `headers` and `env` are resolved at connect time and an unresolved one in `url`/`headers` fails
  closed: `tools/mcp_tool_config.py:554-599`. `config set` writes UPPER_SNAKE `_API_KEY` names to `.env` without echoing them and treats
  `mcp_servers.*` as an open mapping: `hermes_cli/config.py:3416-3440,3026-3030`.

**Not verified:** nothing here was run against a real Hermes, a vendor endpoint or a browser sign-in; the stubs in
`tests/skills/stubs/` model the prompts and exit codes listed above from this source. Unknown: whether a given vendor server
accepts any of the probe shapes; the device flow against a specific OAuth server; and how `config set mcp_servers.*` behaves
after a Hermes update that changes the `mcp_servers` schema.

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
