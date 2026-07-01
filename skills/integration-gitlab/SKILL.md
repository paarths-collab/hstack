---
name: integration-gitlab
description: Connect GitLab (repos, MRs, issues, CI/CD pipelines) to a self-hosted Hermes Agent over SSH. Wires the community static-token MCP server or REST API, with the OAuth-only first-party MCP documented as a hands-on alternative. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-gitlab — connect GitLab to a remote Hermes (SSH-first)

You are the engineer connecting GitLab (GitLab.com, Self-Managed, or Dedicated) to a
self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code,
Codex, Cursor, Gemini, any of them) work over SSH as root against the VPS. The user only
does the things a machine cannot:

1. Mint the personal access token (PAT) in the GitLab UI and pick scopes.
2. (Path B only) Approve the OAuth Dynamic Client Registration consent in a browser.

Everything else — token validation, sidecar boot, MCP registration, gateway reload,
verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** GitLab has two MCP realities:

- The **official GitLab MCP server** (`<base>/api/v4/mcp`, GitLab 18.6+) is **OAuth 2.0
  Dynamic Client Registration only** — static `glpat-` tokens are rejected. It also
  requires GitLab Duo plus beta/experimental features on the instance. Hermes' generic
  header-auth wiring cannot mint or refresh OAuth tokens, so this is **Path C**, not the
  default.
- The **one-click path** is the community server `@zereight/mcp-gitlab` running as a
  sidecar with a static PAT, exposing a streamable-HTTP endpoint Hermes can register
  normally. This is **Path A**.
- The **always-works fallback** is storing the PAT and calling `<base>/api/v4` directly
  with `PRIVATE-TOKEN`. This is **Path B**.

Default to Path A. Choose Path C only if the user explicitly wants first-party OAuth.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GITLAB_BASE` | Base URL, e.g. `https://gitlab.com` or self-managed host | The user |
| `$GITLAB_TOKEN` | Personal access token (`glpat-...`) | `$GITLAB_BASE/-/user_settings/personal_access_tokens` → Add new token. Scopes: `read_api` for read-only agents, `api` if the agent must write/comment/trigger pipelines. Set a short expiry. |

Set `GITLAB_API="$GITLAB_BASE/api/v4"` once gathered.

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

Before any wiring, validate the PAT against the REST API — one curl confirms token,
base URL, and scope in a single shot, and gives a clean error if any of the three is
wrong:

```bash
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /tmp/gl_user -w 'user=%{http_code}\n' \
    -H 'PRIVATE-TOKEN: $GITLAB_TOKEN' '$GITLAB_API/user'
  grep -o '\"username\":\"[^\"]*\"' /tmp/gl_user || true
"
```

`200` on `/user` → token + base URL are correct. `401` → bad/expired token or wrong
base URL. Abort and re-mint before continuing.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci gitlab" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "GitLab is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Validate PAT against $GITLAB_API/user (already done in Step 1)
  2. Write GITLAB_TOKEN (length ${#GITLAB_TOKEN}, prefix ${GITLAB_TOKEN:0:6}...) via 'hermes config set'
  3. Write GITLAB_API_URL=$GITLAB_API via 'hermes config set'
  4. chmod 600 ~/.hermes/.env
  5. Path A: docker run @zereight/mcp-gitlab@2.1.28 sidecar on :3000
     Register MCP: hermes mcp add gitlab --url http://gitlab-mcp:3000/mcp
  6. Reload gateway: hermes gateway stop && hermes gateway run
  7. Verify in logs: grep -i "registered.*gitlab"
  8. Smoke test: GET $GITLAB_API/projects?membership=true&per_page=1 -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set GITLAB_TOKEN '$GITLAB_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set GITLAB_API_URL '$GITLAB_API'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GITLAB_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: GITLAB_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — `glpat-` tokens are alnum/`-` but the pattern stays safe if GitLab
> ever changes format):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^GITLAB_TOKEN=' ~/.hermes/.env || printf 'GITLAB_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^GITLAB_TOKEN=.*|GITLAB_TOKEN=$GITLAB_TOKEN|' ~/.hermes/.env
>   grep -q '^GITLAB_API_URL=' ~/.hermes/.env || printf 'GITLAB_API_URL=\n' >> ~/.hermes/.env
>   sed -i 's|^GITLAB_API_URL=.*|GITLAB_API_URL=$GITLAB_API|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server

Pick the path that matches your auth posture. Path A is the default one-click flow.

### Path A (preferred) — community static-token MCP via HTTP sidecar

Run `@zereight/mcp-gitlab` as a sidecar on the host (or in the same compose network as
Hermes), pinned to a verified version. Set `GITLAB_READ_ONLY_MODE=true` when the PAT is
`read_api` so the server refuses writes that would 403 anyway.

```bash
ssh "$VPS_USER@$VPS_IP" "
  docker rm -f gitlab-mcp 2>/dev/null || true
  docker run -d --name gitlab-mcp \
    -e GITLAB_PERSONAL_ACCESS_TOKEN='$GITLAB_TOKEN' \
    -e GITLAB_API_URL='$GITLAB_API' \
    -e STREAMABLE_HTTP=true \
    -p 3000:3000 \
    node:20-alpine \
    npx -y @zereight/mcp-gitlab@2.1.28
"
```

Then register the sidecar endpoint with Hermes. The sidecar holds the PAT itself, so the
Hermes-side endpoint usually needs no extra bearer — but if you front it with a gateway
that requires one, use placeholder injection with the `|` sed delimiter:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add gitlab \
    --url 'http://gitlab-mcp:3000/mcp' \
    --transport streamable-http
"
```

If your sidecar is behind a TLS gateway that requires `Authorization: Bearer <token>`,
register with a placeholder and inject:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add gitlab \
    --url 'https://<your-host>/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
  sed -i 's|placeholder|'\"\$GITLAB_TOKEN\"'|g' ~/.hermes/config.yaml
"
```

### Path B (always-works fallback) — REST API direct, no MCP

The PAT is already written to `~/.hermes/.env`. Any generic HTTP tool/skill can now hit
`$GITLAB_API/...` with `PRIVATE-TOKEN: $GITLAB_TOKEN`. Useful URL building blocks:

- `GET $GITLAB_API/user` — identity check
- `GET $GITLAB_API/projects?membership=true` — your projects
- `GET $GITLAB_API/projects/:id/merge_requests?state=opened` — open MRs
- `GET $GITLAB_API/projects/:id/issues?state=opened` — open issues
- `POST $GITLAB_API/projects/:id/pipeline` — trigger CI (needs `api` scope)

Auth header: `PRIVATE-TOKEN: $GITLAB_TOKEN` (recommended) or `Authorization: Bearer $GITLAB_TOKEN`.

### Path C (first-party, hands-on) — official OAuth MCP

The first-party server lives at `$GITLAB_BASE/api/v4/mcp` (HTTP transport, GitLab 18.6+).
It is **OAuth 2.0 Dynamic Client Registration only** — no static-token mode. Prereqs the
GitLab admin must enable first: **GitLab Duo** + **beta and experimental features** on
the instance. Then point an OAuth-capable MCP client at `$GITLAB_BASE/api/v4/mcp`; the
client performs DCR and the user approves the app in the browser. Hermes' generic
header-auth wiring cannot mint or refresh that token, so this path is hands-on and not
set-and-forget. Do **not** attempt to register `/api/v4/mcp` with the `glpat-` token —
it will be rejected.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*gitlab|MCP server.*gitlab.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: gitlab registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gitlab not in logs after 30s. Rolling back."; rollback; exit 1; }
```

(Path B users: skip this step — there's no MCP to register. Go straight to Step 8.)

---

## Step 8 — live API smoke test

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET '$GITLAB_API/projects?membership=true&per_page=1' \
    -H \"PRIVATE-TOKEN: \$GITLAB_TOKEN\"
")
case "$HTTP" in
  200) echo "OK: GitLab API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but scope insufficient. Re-mint with 'api' if writes needed."; exit 1 ;;
  429) echo "WARN: rate-limited. Honor Retry-After; not a wiring failure." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from GitLab API. Check manually." ;;
esac
```

`200` with `[]` means the token works but the account has no projects — not a failure
of wiring.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove gitlab 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "docker rm -f gitlab-mcp 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset GITLAB_TOKEN 2>/dev/null || \
    sed -i '/^GITLAB_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset GITLAB_API_URL 2>/dev/null || \
    sed -i '/^GITLAB_API_URL=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. GitLab is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `$GITLAB_BASE/api/v4/mcp` with a `glpat-` token | First-party MCP is **OAuth-only**; static tokens are rejected | Use Path A (community sidecar) or Path B (REST) |
| 2 | Scope mismatch → silent 403 on writes | `read_api` lets the agent browse but every create/comment/trigger returns 403 | Mint with `api` if the agent acts; set `GITLAB_READ_ONLY_MODE=true` on the sidecar when token is read-only |
| 3 | Wrong API base | Base must end in `/api/v4`. Self-managed on a subpath (`https://host/gitlab`) needs `https://host/gitlab/api/v4` | A 404 on `/user` usually means missing/wrong `/api/v4` suffix |
| 4 | PAT = the owner's full blast radius | Inherits the creator's membership and permissions across every group/project | Mint from a dedicated bot/service account, not a human admin; set short expiry |
| 5 | GitLab.com rate limits | Chatty agent → `429` | Honor `Retry-After`; self-managed limits are admin-configured |
| 6 | Unpinned community MCP version | `npx -y @zereight/mcp-gitlab` (no tag) pulls latest; tool surface can change | Pin to verified `@2.1.28`; bump deliberately after re-checking the package page |
| 7 | OAuth tokens (Path C) expire/refresh | Hermes header-auth cannot refresh them | Path C is not set-and-forget; default to Path A |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline → invalid env | Always `hermes config set` (or the safe sed pattern in Step 4) |
| 10 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 11 | sed with `/` delimiter on tokens | Future GitLab token formats may contain `/+=` | Always use `\|` delimiter |
| 12 | Container vs host confusion | Adding keys / setting config in the wrong layer | Always `whoami; hostname` first; Step 1 detects automatically |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] PAT validated against `$GITLAB_API/user` (HTTP 200) before any wiring
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `GITLAB_TOKEN` + `GITLAB_API_URL` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Chosen path is honest: Path A (community static-token MCP) wired, Path B (REST) documented, or Path C (OAuth) acknowledged as hands-on
- [ ] Token scope matches intent (`read_api` for read-only, `api` for write); sidecar has `GITLAB_READ_ONLY_MODE=true` when read-only
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'gitlab'` within 30s (Path A only)
- [ ] Smoke test: `GET $GITLAB_API/projects?membership=true` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
