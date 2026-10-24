---
name: integration-github
description: Connect GitHub (code, issues, PRs, CI) to a self-hosted Hermes Agent over SSH via GitHub's first-party remote MCP server. Idempotent, dry-run, and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-github — connect GitHub to a remote Hermes (SSH-first)

You are the engineer connecting GitHub to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0 (a
thin `ssh` wrapper). The token is validated locally and against GitHub BEFORE anything is
written, and travels to the VPS only over ssh STDIN. Run all blocks in ONE shell session:
later steps call the Step 0 functions.

Do everything autonomously; stop only for the one thing a machine cannot do: minting the
user's personal access token in the GitHub UI.

**Honest auth picture (verified 2026-06):** GitHub ships a first-party **remote** MCP
server at `https://api.githubcopilot.com/mcp/`. It supports two auth modes:

- **Static PAT via `Authorization: Bearer <token>`** — works for headless agents. This is
  the path we use for Hermes.
- **One-click OAuth** — interactive browser flow, NOT usable from a headless agent.

We use the PAT path. The MCP server inherits exactly the scopes/permissions on the PAT,
subject to any org PAT policy. For GitHub Enterprise Cloud with data residency, the URL
becomes `https://copilot-api.<subdomain>.ghe.com/mcp` — only use that if the user is on
`ghe.com`.

Source: <https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server>

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GITHUB_TOKEN` | Personal access token (`github_pat_...` or `ghp_...`) | Fine-grained (preferred): <https://github.com/settings/personal-access-tokens/new> — scope to specific repos/org, grant Contents/Issues/Pull requests/Actions as needed (Metadata is mandatory and auto-added). Classic: <https://github.com/settings/tokens/new> — `repo` scope (+ `workflow` if editing Actions). |
| `$GITHUB_MCP_URL` | MCP base URL | Default `https://api.githubcopilot.com/mcp/`; for `ghe.com` data-residency users, `https://copilot-api.<subdomain>.ghe.com/mcp` (the REST preflight/smoke calls in Steps 3 and 9 also target `api.github.com`; ghe.com users must substitute their tenant's REST API host in those two curl lines) |

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
# fails puts the previous working value back), then reload the gateway.
rollback() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 0; }
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
hermes -p default gateway stop
sleep 2
hermes -p default gateway ensure --json --timeout 60 >/dev/null
sleep 3
status_rc=0
st=$(hermes -p default gateway status 2>&1) || status_rc=$?
if [ "$status_rc" != 0 ] || printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
  echo "rollback: files restored, but the gateway did NOT come back — active snapshot retained; inspect the gateway and retry rollback after resolving the fault"
  exit 1
fi
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
REMOTE
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

Rules for calling them:

- A failure BEFORE `snapshot` (SSH check, Hermes check, idempotency, token format, live
  GitHub preflight, user declining the dry run) is `exit 1` with
  `ABORT: ... Nothing was written.` — it does NOT call `rollback`.
- `snapshot` runs immediately before the first write. If it fails, abort. It REFUSES when a
  snapshot dir already exists (a crashed run): run `rollback` first, then re-run.
- Every failure AFTER `snapshot` is `rollback; exit 1`.
- The last step calls `finish` after the smoke test passes.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.
This candidate lifecycle recipe assumes the exclusive default profile and its one host gateway. Inspect other profiles and live work first: the current gateway can serve multiple profiles, so stop/start is not isolated to one bot. Do not use `--force`, `--all` or `--yes` to evade a refusal. Named-profile and shared-host deployment remain outside this recipe.


**Tagged native gateway lifecycle.** v0.22.5 supports `gateway stop` and
`gateway ensure --json --timeout 60`; `gateway run` is foreground and has no
`--daemon` flag. Parser checks do not prove target runtime readiness. Connector registration syntax in this legacy recipe remains separately unverified; prefer native connector/MCP setup when supported.

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
remote '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes -p default --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes -p default --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first. Nothing was written."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(remote "hermes -p default mcp list 2>/dev/null | grep -ci github || true")
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "GitHub is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate the token BEFORE anything is written

Two checks, both before `snapshot` and before the dry run. If either fails, nothing has
touched the VPS and the skill stops.

**3a. Format check (local, no network).** Refuses an empty value, any character that could
break a curl config line or a `.env` line (whitespace, quotes, backslash, `$`, newline),
a token that is not a `github_pat_` / `ghp_` PAT, and an MCP URL that is not plain `https://`.

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
secret_chars_ok "$GITHUB_TOKEN" \
  || { echo "ABORT: GITHUB_TOKEN is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$GITHUB_TOKEN" in github_pat_*|ghp_*) ;; *)
  echo "ABORT: GITHUB_TOKEN must be a personal access token (github_pat_... or ghp_...). Nothing was written."; exit 1 ;;
esac
url_chars_ok "$GITHUB_MCP_URL" \
  || { echo "ABORT: GITHUB_MCP_URL must be a plain https:// URL. Nothing was written."; exit 1; }
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
permissions — see Pitfall 6.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) token format + live GitHub preflight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write GITHUB_TOKEN (length ${#GITHUB_TOKEN}, prefix ${GITHUB_TOKEN:0:4}…) via 'hermes -p default config set', chmod 600
  3. Register MCP: hermes -p default mcp add github --url $GITHUB_MCP_URL --auth header
     Header: Authorization: Bearer \${GITHUB_TOKEN}
  4. Reload gateway: hermes -p default gateway stop && hermes -p default gateway ensure --json --timeout 60
  5. Verify in logs: grep -i "registered.*github"
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
  | remote 'IFS= read -r v && hermes -p default config set GITHUB_TOKEN "$v" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env' \
  || { echo "FAIL: could not write GITHUB_TOKEN."; rollback; exit 1; }
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(remote "grep -c '^GITHUB_TOKEN=' ~/.hermes/.env || true")
[ "$WROTE" = "1" ] || { echo "FAIL: GITHUB_TOKEN not written exactly once (found ${WROTE:-0})."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, replace the write above with this
> (drops any old line, appends the new one with a guaranteed newline, chmod 600):
> ```bash
> printf '%s\n' "$GITHUB_TOKEN" | remote 'IFS= read -r v; umask 077
>   { grep -v "^GITHUB_TOKEN=" ~/.hermes/.env 2>/dev/null; printf "GITHUB_TOKEN=%s\n" "$v"; } > ~/.hermes/.env.new \
>     && mv ~/.hermes/.env.new ~/.hermes/.env && chmod 600 ~/.hermes/.env' \
>   || { echo "FAIL: could not write GITHUB_TOKEN."; rollback; exit 1; }
> ```

---

## Step 6 — register the GitHub MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred — GitHub
ships a real remote MCP server, so there's no need for stdio shims or REST fallbacks.

### Path A (preferred) — first-party remote HTTP MCP with bearer auth

```bash
if [ "${FORCE:-0}" = "1" ]; then remote "hermes -p default mcp remove github >/dev/null 2>&1 || true"; fi
remote "hermes -p default mcp add github --url '$GITHUB_MCP_URL' --auth-header 'Authorization' --auth-scheme 'Bearer' --env 'GITHUB_TOKEN=\${GITHUB_TOKEN}'" \
  || { echo "FAIL: hermes -p default mcp add github."; rollback; exit 1; }
```

The exact flag names vary by Hermes version. If unsure, run `hermes -p default mcp add --help` first
and match its HTTP/header syntax. The token stays in `~/.hermes/.env` and is referenced
via `${GITHUB_TOKEN}` indirection — never inlined into `config.yaml`. The `\$` keeps the
braces literal on the remote side (an unescaped `$GITHUB_TOKEN` would expand to an empty
string there).

Check that the plaintext token did not land in `config.yaml` (and is still in `.env`):

```bash
remote 'v=$(sed -n "s/^GITHUB_TOKEN=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
  || { echo "FAIL: GITHUB_TOKEN missing from .env or found in config.yaml."; rollback; exit 1; }
```

The resulting `config.yaml` block should read (token stays out of it):

```yaml
github:
  url: https://api.githubcopilot.com/mcp/
  headers:
    Authorization: Bearer ${GITHUB_TOKEN}
  enabled: true
```

**Optional — scope down the toolset.** The full GitHub MCP server exposes a large toolset
(repos, issues, PRs, Actions, code scanning, notifications, and more). To narrow surface,
add request headers alongside `Authorization`:

- `X-MCP-Readonly: true` — read-only agent
- `X-MCP-Toolsets: repos,issues,pull_requests` — limit categories

Edit `config.yaml`'s `headers:` block and reload the gateway (Step 7).

### Path B (fallback) — generic HTTP tool against the GitHub REST API

If the Hermes build is stdio-MCP-only and cannot reach a remote HTTP MCP:

- **Base URL:** `https://api.github.com`
- **Auth header:** `Authorization: Bearer ${GITHUB_TOKEN}`
- **Recommended version header:** `X-GitHub-Api-Version: 2022-11-28`
- **Accept:** `Accept: application/vnd.github+json`

Do NOT inline the token into any registered URL or YAML field. Reference it via env.

---

## Step 7 — reload through the native gateway lifecycle

Use checked `gateway stop` followed by `gateway ensure --json --timeout 60`; respect live-work or supervisor refusals instead of starting a second dispatcher.

```bash
remote "hermes -p default gateway stop" || { echo "FAIL: gateway stop refused; preserving recovery point."; rollback; exit 1; }
sleep 2
remote "hermes -p default gateway ensure --json --timeout 60 >/dev/null" || { echo "FAIL: gateway did not start."; rollback; exit 1; }
sleep 5
```

---

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in 1 2 3 4 5 6; do
  if remote "hermes -p default logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*github|MCP server.*github.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: github registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: github not in logs after 30s."; rollback; exit 1; }
```

---

## Step 9 — live API smoke test (token read back from `~/.hermes/.env` on the VPS)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so `$GITHUB_TOKEN`
would be empty there. The block reads the value from the file explicitly — this also
proves it persisted.

```bash
CODE=$(remote 'bash -s' <<'REMOTE'
v=$(sed -n 's/^GITHUB_TOKEN=//p' ~/.hermes/.env | tail -n1)
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

A `200` proves the PAT lands and authenticates. From chat you can then run something like
`@<agent> using github, list the open issues on <owner>/<repo>` — a real list (or a valid
empty result) confirms the MCP path itself is wired, not just the REST credential.

---

## Rollback

Defined once, in Step 0 (no second copy here). It runs automatically
(`rollback; exit 1`) on every failure after `snapshot`, and it RESTORES rather than
deletes:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/integration-github/`. A file that did not exist before is
  removed, so a first-time run leaves nothing behind, and a failed `FORCE=1` re-run gets
  its previous working `GITHUB_TOKEN` and MCP entry back.
- `.env` is set to `chmod 600`; the snapshot moves to `integration-github.prev`; the
  gateway is reloaded with stop + run and `hermes -p default gateway status` is checked. If the gateway is
  not reported running, `rollback` prints `files restored, but the gateway did NOT come back`
  and exits non-zero: start it by hand (`hermes -p default gateway start`) and check `hermes -p default logs`.

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

If your Hermes build keeps MCP registrations outside `config.yaml`, also run
`hermes -p default mcp remove github` on the VPS. The `.prev` folder holds the previous `.env`
(including any old token) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes -p default config set` (or the documented `grep -v` + `printf` fallback) |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, referenced via `${GITHUB_TOKEN}` |
| 4 | Injecting the token with `sed` or `'\"\$GITHUB_TOKEN\"'` | Tokens may contain `/+=`, and an escaped `\$` expands an unset REMOTE variable to an empty string | Never inject the value; reference `\${GITHUB_TOKEN}` literally (Step 6) |
| 5 | Container vs host confusion | Skill assumed wrong layer | Step 1's host/container detection picks the right one |
| 6 | PAT scopes are the ceiling | MCP can only do what the token allows; a fine-grained PAT without Issues/Pull requests perms returns 200 on `/user` but 403/404 on tool calls | Match permissions to the use case BEFORE blaming the wiring |
| 7 | Org PAT policy silently blocks | If the target org restricts/forbids PATs (or requires approval for fine-grained), token returns 401/403 until an org owner approves | Check org SSO/PAT policy; have an org owner approve the token |
| 8 | Fine-grained PATs are org/owner-scoped | A fine-grained token only reaches repos under the owner picked at creation | Use multiple tokens, or fall back to a classic PAT for cross-org reach |
| 9 | Token expiry | Fine-grained PATs expire (max ~1 year, often less); after expiry, calls 401 | When 401s start, mint a fresh PAT and rerun Steps 3-9 with `FORCE=1` |
| 10 | Trying OAuth path on headless agent | GitHub's MCP also supports one-click OAuth, but it needs an interactive browser | Stay on the PAT path for Hermes |
| 11 | Wrong host for GitHub Enterprise | Public URL fails for `ghe.com` data-residency tenants | Use `https://copilot-api.<subdomain>.ghe.com/mcp` for those users, and point the Step 3b / Step 9 curl lines at the tenant's REST host |
| 12 | Rate limits | Authenticated REST/GraphQL is 5,000 req/hr (lower for some resources); bursts get `403` with `X-RateLimit-Remaining: 0` | Backoff on `403` with rate-limit headers; do not tight-loop retry |
| 13 | Smoke test sends `Bearer \$GITHUB_TOKEN` over ssh | The ssh shell never loaded `.env`: empty header, false `401`, and the old rollback deleted a working token | Step 9 reads the token from `~/.hermes/.env` on the VPS |
| 14 | Writing the token before checking it with GitHub | A typo'd or revoked PAT replaces a working one (`FORCE=1`) | Step 3 runs before `snapshot`; failures there write nothing |
| 15 | Rollback that deletes instead of restoring | A failed `FORCE=1` re-run destroys the previous working token | Step 0 `snapshot`/`rollback` restore the pre-skill files |
| 16 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 17 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished; snapshotting again would record its half-written files as "known good" | `snapshot` refuses and aborts. Run `rollback` first (restores the state from before that run), then re-run |
| 18 | `hermes -p default config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` on the VPS during that moment sees it (the local ssh argv stays clean because the value travels over stdin) | Accepted for the primary path; the documented `grep -v` + `printf` fallback avoids it entirely. Output of the write is discarded so Hermes can never echo the value into chat |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] HARD GATE passed: token format OK and the live `GET /user` preflight returned `200` BEFORE any write
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the live preflight passed
- [ ] `GITHUB_TOKEN` in `~/.hermes/.env` (written over stdin), `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` references only `${GITHUB_TOKEN}`
- [ ] MCP registered via Path A (remote HTTP MCP) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'github'` within 30s
- [ ] Smoke test: `GET https://api.github.com/user` on the VPS, token read back from `~/.hermes/.env`, returned `200`
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml` (a failed `FORCE=1` re-run keeps the old working token)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
