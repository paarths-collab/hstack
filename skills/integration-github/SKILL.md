---
name: integration-github
description: Connect GitHub (repos, issues, PRs, Actions) to a self-hosted Hermes Agent over SSH with a personal access token, through Hermes' native MCP client. Default is GitHub's hosted MCP over HTTP with a bearer header; a stdio npm server is the alternative. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-github — connect GitHub to a remote Hermes (SSH-first)

You are the engineer connecting GitHub to a self-hosted Hermes agent (v0.22.5) on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only mints the token; everything else — token storage, MCP
registration, gateway reload, verification — is done idempotently on the VPS. Every `bash` block
below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches the VPS through
the `remote` helper from Step 0 (a thin `ssh` wrapper). The token is validated locally and against
GitHub BEFORE anything is written, and travels to the VPS only over ssh STDIN. Run all blocks in ONE
shell session: later steps call the Step 0 functions.

**How the token is stored (native Hermes convention).** For an HTTP MCP server added with `--auth header`, Hermes itself reads the credential from
`MCP_<SERVER_NAME>_API_KEY` in `~/.hermes/.env` (here `MCP_GITHUB_API_KEY`) and stores only `Authorization: Bearer ${MCP_GITHUB_API_KEY}` in
`config.yaml` (`hermes_cli/mcp_config.py:305-336,545-583`). So the PAT you provide as `$GITHUB_TOKEN` locally is written to the VPS under THAT name.
This skill does not write `GITHUB_TOKEN` on the VPS: Hermes uses that name for skills-hub rate limits (`.env.example:480-482`), which is a separate decision.

**Two modes (`GITHUB_MCP_MODE`).**

- `remote` (default): the hosted MCP endpoint over HTTP, `hermes -p default mcp add github --url <GITHUB_MCP_URL> --auth header`.
- `stdio` (non-default): `@modelcontextprotocol/server-github` started with `npx`. The pinned version exists on npm (checked against the registry listing, not smoke-tested), but the registry marks the whole package DEPRECATED ("no longer supported"), so this mode is a fallback only, with the PAT passed as `GITHUB_PERSONAL_ACCESS_TOKEN=${MCP_GITHUB_API_KEY}`. This is
  the shape Hermes' own docs show for GitHub (`website/docs/reference/mcp-config-reference.md:82-88`), pinned as `GITHUB_MCP_PKG` in `VERSIONS.txt`.

Neither vendor endpoint nor package was called while this skill was written: that the hosted endpoint accepts a PAT as a bearer token, that the deprecated npm pin runs, and
which toolsets they expose are vendor facts carried over from the earlier version of this skill and from `VERSIONS.txt`. If one is wrong, `mcp add` fails its own
connection test and the skill rolls back instead of leaving a broken entry. GitHub's OAuth sign-in for the hosted server needs a browser and is not used here.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GITHUB_TOKEN` | Personal access token (`github_pat_...` or `ghp_...`) | Fine-grained (preferred): <https://github.com/settings/personal-access-tokens/new> — scope to specific repos/org, grant Contents/Issues/Pull requests/Actions as needed (Metadata is mandatory and auto-added). Classic: <https://github.com/settings/tokens/new> — `repo` scope (+ `workflow` if editing Actions). |
| `$GITHUB_MCP_MODE` | `remote` (default) or `stdio` | See above |
| `$GITHUB_MCP_URL` | (remote mode) MCP URL | Default `https://api.githubcopilot.com/mcp/`; for `ghe.com` data-residency users, `https://copilot-api.<subdomain>.ghe.com/mcp` (the REST preflight/smoke calls in Steps 3 and 9 also target `api.github.com`; ghe.com users must substitute their tenant's REST API host in those two curl lines) |

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
SKILL_NAME=integration-github
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
ALREADY=$(remote "hermes -p default mcp list 2>/dev/null | grep -cE '^ *github( |\$)' || true")
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "GitHub is already wired (listed by mcp list, enabled or not). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate the token BEFORE anything is written

Two checks, both before `snapshot` and before the dry run. If either fails, nothing has
touched the VPS and the skill stops.

**3a. Format check (local, no network).** Refuses an empty value, any character that could
break a curl config line or a `.env` line (whitespace, quotes, backslash, `$`, newline),
a token that is not a `github_pat_` / `ghp_` PAT, an unknown mode, and (remote mode) an MCP URL that is not plain `https://`.

```bash
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
url_chars_ok() {
  local LC_ALL=C
  case "$1" in *[!A-Za-z0-9._~:/%+=-]*) return 1 ;; https://?*) return 0 ;; esac
  return 1
}
GITHUB_MCP_URL="${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}"
GITHUB_MCP_MODE="${GITHUB_MCP_MODE:-remote}"
secret_chars_ok "$GITHUB_TOKEN" \
  || { echo "ABORT: GITHUB_TOKEN is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$GITHUB_TOKEN" in github_pat_*|ghp_*) ;; *)
  echo "ABORT: GITHUB_TOKEN must be a personal access token (github_pat_... or ghp_...). Nothing was written."; exit 1 ;;
esac
case "$GITHUB_MCP_MODE" in remote|stdio) ;; *)
  echo "ABORT: GITHUB_MCP_MODE must be remote or stdio. Nothing was written."; exit 1 ;;
esac
if [ "$GITHUB_MCP_MODE" = "remote" ]; then
  url_chars_ok "$GITHUB_MCP_URL" \
    || { echo "ABORT: GITHUB_MCP_URL must be a plain https:// URL. Nothing was written."; exit 1; }
fi
```

**3b. Live GitHub preflight, run from the VPS** (proves the server's egress works too).
It uses the same read-only call as the Step 9 smoke test: `GET /user`. The token travels
over ssh STDIN as a curl config, so it never appears in argv or a quoted remote string.

```bash
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" \
  | remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' 'https://api.github.com/user'")
[ "$CODE" = "200" ] || { echo "ABORT: GitHub rejected the token (HTTP ${CODE:-none}; 401 = invalid/expired, 403 = org PAT policy or rate limit). Nothing was written."; exit 1; }
```

A `200` on `/user` proves the PAT authenticates, not that it has the right
permissions — see Pitfall 6. (The endpoint and headers are vendor facts carried over from the earlier version of this skill; they were not called from this repository.)

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token format + live GitHub preflight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write MCP_GITHUB_API_KEY (length ${#GITHUB_TOKEN}, prefix ${GITHUB_TOKEN:0:4}…) via 'hermes -p default config set', chmod 600
  3. Register MCP, mode $GITHUB_MCP_MODE (answers fed on stdin):
     remote: hermes -p default mcp add github --url $GITHUB_MCP_URL --auth header   (Authorization: Bearer \${MCP_GITHUB_API_KEY})
     stdio:  hermes -p default mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN='\${MCP_GITHUB_API_KEY}' --command npx --args -y @modelcontextprotocol/server-github@2025.4.8
     then check it with: hermes -p default mcp list (must show github enabled)
  4. Reload gateway: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready
  5. Verify: hermes -p default mcp test github (exit 0 = connected)
  6. Smoke test: GET https://api.github.com/user with the token read back from ~/.hermes/.env → expect 200
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
printf '%s\n' "$GITHUB_TOKEN" \
  | remote 'IFS= read -r v && hermes -p default config set MCP_GITHUB_API_KEY "$v" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env' \
  || { echo "FAIL: could not write MCP_GITHUB_API_KEY."; rollback; exit 1; }
```

`config set` routes an UPPER_SNAKE name ending in `_API_KEY` to `~/.hermes/.env` and never echoes the value (`hermes_cli/config.py:858-882,3398-3440`).

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(remote "grep -c '^MCP_GITHUB_API_KEY=' ~/.hermes/.env || true")
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_GITHUB_API_KEY not written exactly once (found ${WROTE:-0})."; rollback; exit 1; }
```

---

## Step 6 — register the GitHub MCP server

`hermes mcp add` is interactive. A URL server first asks "Does this server require authentication?" and, with `--auth header` and `MCP_GITHUB_API_KEY` already in
`.env`, takes the token from there instead of prompting for it; it then connects, lists the tools and asks "Enable all N tools? [Y/n/select]". A stdio server
skips the first question. A closed stdin answers "cancel" to the last one, so the entry is silently NOT saved while the command still exits 0
(`hermes_cli/mcp_config.py:545-615,618-721`). The answers are therefore fed on stdin and the result is verified with `mcp list`, never assumed. If the server cannot be
reached the command instead asks "Save config anyway?" (default no); `y` saves it DISABLED, which the `enabled` check below also rejects. `--env` is stdio-only and must
precede `--args`, which swallows every word after it (`hermes_cli/subcommands/mcp.py`, `hermes_cli/mcp_config.py:345-361,641`). The `\$` keeps the braces literal on the remote
side so `config.yaml` stores the reference, not a value. The npm package is the pin `GITHUB_MCP_PKG` from `VERSIONS.txt`.

```bash
if [ "${FORCE:-0}" = "1" ]; then printf 'y\n' | remote "hermes -p default mcp remove github >/dev/null 2>&1 || true"; fi
if [ "$GITHUB_MCP_MODE" = "stdio" ]; then
  printf 'y\n' | remote "hermes -p default mcp add github --env 'GITHUB_PERSONAL_ACCESS_TOKEN=\${MCP_GITHUB_API_KEY}' --command npx --args -y @modelcontextprotocol/server-github@2025.4.8" >/dev/null \
    || { echo "FAIL: hermes -p default mcp add github."; rollback; exit 1; }
else
  printf 'y\ny\n' | remote "hermes -p default mcp add github --url '$GITHUB_MCP_URL' --auth header" >/dev/null \
    || { echo "FAIL: hermes -p default mcp add github."; rollback; exit 1; }
fi
remote "hermes -p default mcp list | grep -E '^ *github .*enabled'" >/dev/null \
  || { echo "FAIL: github is not listed as enabled (add was cancelled, or the server could not be reached or started)."; rollback; exit 1; }
```

Check that the plaintext token did not land in `config.yaml` (and is still in `.env`):

```bash
remote 'v=$(sed -n "s/^MCP_GITHUB_API_KEY=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
  || { echo "FAIL: MCP_GITHUB_API_KEY missing from .env or found in config.yaml."; rollback; exit 1; }
```

The resulting `config.yaml` entry (remote mode) holds the URL and the header template only:

```yaml
mcp_servers:
  github:
    url: https://api.githubcopilot.com/mcp/
    headers:
      Authorization: Bearer ${MCP_GITHUB_API_KEY}
    enabled: true
```

A remote server whose `url` or `headers` still contain an unset `${VAR}` fails closed with the variable named, instead of sending a literal placeholder
(`tools/mcp_tool_config.py:585-599`); that is what you would see if `MCP_GITHUB_API_KEY` were missing from `.env`.

**Optional — scope down the toolset (remote mode).** The hosted server exposes a large toolset (repos, issues, PRs, Actions, code scanning, notifications, and more).
Request headers such as `X-MCP-Readonly: true` or `X-MCP-Toolsets: repos,issues,pull_requests` are documented by the vendor for this; they were not verified here. Add them to the
`headers:` block of the `github` entry in `config.yaml` and run `gw_reload`. Independently of the vendor, Hermes can filter by tool name with `mcp_servers.github.tools.include`.

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
config (`hermes_cli/mcp_config.py:836-880`). Running chats pick the tools up with a new session (or `/reload-mcp`); the
gateway reload in Step 7 already gives new sessions a fresh load.

```bash
CONNECTED=0
for i in 1 2 3; do
  if remote "hermes -p default mcp test github" >/dev/null 2>&1; then CONNECTED=1; echo "OK: github connected."; break; fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: github did not connect within 30s."; rollback; exit 1; }
```

---

## Step 9 — live API smoke test (token read back from `~/.hermes/.env` on the VPS)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so `$GITHUB_TOKEN`
would be empty there. The block reads the value from the file explicitly — this also
proves it persisted.

```bash
CODE=$(remote 'bash -s' <<'REMOTE'
v=$(sed -n 's/^MCP_GITHUB_API_KEY=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - \
      -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
      https://api.github.com/user
REMOTE
)
[ "$CODE" = "200" ] || { echo "FAIL: GitHub smoke test returned HTTP ${CODE:-none} (401 = token on the VPS differs from the one validated in Step 3 or expired, 403 = org PAT policy or missing scope, 404 = check network / Enterprise host)."; rollback; exit 1; }
echo "OK: GitHub API reachable and the token stored on the VPS is valid."
finish || exit 1
```

A `200` proves the PAT lands and authenticates; `mcp test` in Step 8 proves the MCP server connects with it. From chat you can then run something like
`@<agent> using github, list the open issues on <owner>/<repo>` in a new session — a real list (or a valid empty result) confirms a turn really uses the tool.

---

## Rollback

Defined once, in Step 0 (no second copy here). It runs automatically
(`rollback; exit 1`) on every failure after `snapshot`, and it RESTORES rather than
deletes:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/integration-github/`. MCP servers live in the `mcp_servers` map of `config.yaml` (`hermes_cli/mcp_config.py:233-244`), so this also
  removes the new `github` entry or brings back the previous one. A file that did not exist before is
  removed, so a first-time run leaves nothing behind, and a failed `FORCE=1` re-run gets
  its previous working token and MCP entry back.
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `integration-github.prev`. If the gateway does not come back ready, `rollback` prints
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
| 1 | Invented flags for header auth (a separate header-name or scheme option), or `--env` on a URL server | Neither exists at v0.22.5 (`--auth` takes `oauth` or `header`; `--env` is stdio-only): argparse exits 2 or the command refuses | Use exactly the forms in Step 6 |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes -p default config set` |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, referenced as `${MCP_GITHUB_API_KEY}` |
| 4 | Writing the PAT as `GITHUB_TOKEN` and expecting `--auth header` to find it | Hermes looks for `MCP_GITHUB_API_KEY`; without it `mcp add` prompts for the token (and a closed stdin gets none) and the header would hold an unset `${...}` | Step 5 writes `MCP_GITHUB_API_KEY` |
| 5 | Container vs host confusion | Skill assumed wrong layer | Step 1's host/container detection picks the right one |
| 6 | PAT scopes are the ceiling | MCP can only do what the token allows; a fine-grained PAT without Issues/Pull requests perms returns 200 on `/user` but 403/404 on tool calls | Match permissions to the use case BEFORE blaming the wiring |
| 7 | Org PAT policy silently blocks | If the target org restricts/forbids PATs (or requires approval for fine-grained), token returns 401/403 until an org owner approves | Check org SSO/PAT policy; have an org owner approve the token |
| 8 | Fine-grained PATs are org/owner-scoped | A fine-grained token only reaches repos under the owner picked at creation | Use multiple tokens, or fall back to a classic PAT for cross-org reach |
| 9 | Token expiry | Fine-grained PATs expire (max ~1 year, often less); after expiry, calls 401 | When 401s start, mint a fresh PAT and rerun Steps 3-9 with `FORCE=1` |
| 10 | `mcp add` treated as successful because it exited 0 | With a closed stdin it cancels without saving | Feed the answers on stdin and check `mcp list` shows `github` enabled (Step 6) |
| 11 | Wrong host for GitHub Enterprise | Public URL fails for `ghe.com` data-residency tenants | Use `https://copilot-api.<subdomain>.ghe.com/mcp` for those users, and point the Step 3b / Step 9 curl lines at the tenant's REST host |
| 12 | Rate limits | Authenticated REST/GraphQL is 5,000 req/hr (lower for some resources); bursts get `403` with `X-RateLimit-Remaining: 0` | Backoff on `403` with rate-limit headers; do not tight-loop retry |
| 13 | Treating `gateway status` text as health | `✗ Gateway is not running` contains `running` | `gw_reload` / `gw_ready` only (`gateway ensure --json` must exit 0 with `"state":"ready"`) |
| 14 | Smoke test sends `Bearer \$GITHUB_TOKEN` over ssh | The ssh shell never loaded `.env`: empty header, false `401`, and the old rollback deleted a working token | Step 9 reads the token from `~/.hermes/.env` on the VPS |
| 15 | Writing the token before checking it with GitHub | A typo'd or revoked PAT replaces a working one (`FORCE=1`) | Step 3 runs before `snapshot`; failures there write nothing |
| 16 | Rollback that deletes instead of restoring | A failed `FORCE=1` re-run destroys the previous working token | Step 0 `snapshot`/`rollback` restore the pre-skill files |
| 17 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 18 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished; snapshotting again would record its half-written files as "known good" | `snapshot` refuses and aborts. Run `rollback` first (restores the state from before that run), then re-run |
| 19 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` on the VPS during that moment sees it (the local ssh argv stays clean because the value travels over stdin) | Accepted; the write is a single short call and its output is discarded so Hermes can never echo the value into chat |
| 20 | Gateway restart refused because chats are live | `restart` asks y/N on a TTY and refuses without one | Wait for idle, or set `GW_INTERRUPT=1` once you accept interrupting them |

---

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (paths relative to the Hermes repo root); NOT run against a live Hermes, GitHub or npm:

- `mcp add NAME --url U --auth oauth|header`, `--env KEY=VALUE... --command C --args ...`: `hermes_cli/subcommands/mcp.py`; `--env` is rejected for URL servers and kept as the entry's `env` for stdio (`hermes_cli/mcp_config.py:345-361,641,666-675`).
- Header auth: the env name is `MCP_<NAME>_API_KEY` and the stored header is `Authorization: Bearer ${MCP_<NAME>_API_KEY}`; an already-set key skips the token prompt (`hermes_cli/mcp_config.py:305-333,545-583`).
- Prompts and saving: `Does this server require authentication?` (default yes), `Enable all N tools? [Y/n/select]` (EOF or `n` cancels and saves nothing), probe failure asks `Save config anyway?` (default no; `y` saves `enabled: false`), an existing name asks `Overwrite?` (default no) (`hermes_cli/mcp_config.py:545-615,648-721`); `mcp remove` asks `Remove server?` (default yes) (`:724-741`).
- `mcp list` rows with `✓ enabled` / `✗ disabled` (`hermes_cli/mcp_config.py:744-787`); `mcp test` exits 0 / 1 / 3 (`:836-880`).
- `${VAR}` rendering from `.env` for URL, headers and stdio env, and the fail-closed unset check for url/headers (`tools/mcp_tool_config.py:199-227,554-599`, `tools/mcp_tool_discovery.py:162`).
- `config set MCP_GITHUB_API_KEY` goes to `.env` (suffix `_API_KEY`) without echoing the value (`hermes_cli/config.py:858-882,3398-3440`).
- Hermes' own GitHub stdio example: `website/docs/reference/mcp-config-reference.md:82-88`. Gateway lifecycle: see the Step 0 note (`hermes_cli/gateway.py`, `gateway_runtime*.py`, `gateway/run.py:1583-1600`).

NOT verified: that `https://api.githubcopilot.com/mcp/` accepts a PAT as a bearer token and which headers it honours; that `@modelcontextprotocol/server-github@2025.4.8` (exists on npm, deprecated, not smoke-tested) reads `GITHUB_PERSONAL_ACCESS_TOKEN`; the GitHub REST preflight and smoke endpoint; the `ghe.com` URL; that a chat turn really calls the tools.

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (banner names 0.22.5)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] HARD GATE passed: token format OK and the live `GET /user` preflight returned `200` BEFORE any write
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the live preflight passed
- [ ] `MCP_GITHUB_API_KEY` in `~/.hermes/.env` (written over stdin), `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` references only `${MCP_GITHUB_API_KEY}`
- [ ] MCP registered with `hermes -p default mcp add` (answers on stdin; mode `remote` or `stdio`) and listed as enabled by `mcp list`
- [ ] Gateway reloaded with `gw_reload` (restart --detach, ready, new instance)
- [ ] `hermes -p default mcp test github` exits 0
- [ ] Smoke test: `GET https://api.github.com/user` on the VPS, token read back from `~/.hermes/.env`, returned `200`
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml` (a failed `FORCE=1` re-run keeps the old working token)

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
