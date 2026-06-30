---
name: integration-github
description: Connect GitHub (repos, issues, PRs, Actions, code search) to a self-hosted Hermes Agent over SSH. Wires the official open-source `github-mcp-server` with a static personal access token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-github — connect GitHub to a remote Hermes (SSH-first)

You are the engineer connecting GitHub to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint a GitHub personal access token (PAT) in the GitHub UI.
2. (If org-restricted) approve the PAT for the target organization's SSO.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** GitHub ships a hosted remote MCP at
`https://api.githubcopilot.com/mcp/`, but the supported headless auth path is a Copilot
OAuth flow — bearer-only wiring works today but is changing under Copilot policy. For a
durable headless agent we use the official open-source server `github/github-mcp-server`
which takes a static `GITHUB_PERSONAL_ACCESS_TOKEN` — perfect for self-hosted Hermes.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GITHUB_TOKEN` | Personal access token (`github_pat_...` fine-grained, or `ghp_...` classic) | See "Token type" below |
| Org SSO authorized | If targeting an SSO-protected org | <https://github.com/settings/tokens> → Configure SSO → Authorize |

**Token type — pick fine-grained unless you have a reason not to:**

- **Fine-grained PAT (recommended):** <https://github.com/settings/personal-access-tokens/new>
  Select the owner (user or org), the specific repos, and per-resource permissions
  (Contents, Issues, Pull requests, Actions — read/write as needed). Metadata read is added
  automatically. Max lifetime ~1 year; expiry is enforced.
- **Classic PAT (fallback):** <https://github.com/settings/tokens/new> with `repo` (and
  `workflow` if the agent will touch Actions). Broad scope across every repo the user can
  see; non-expiring tokens are allowed but discouraged.

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

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci github" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "GitHub is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write GITHUB_TOKEN (length ${#GITHUB_TOKEN}, prefix ${GITHUB_TOKEN:0:7}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add github --command github-mcp-server --args stdio
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*github"
  6. Smoke test: GET https://api.github.com/user -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set GITHUB_TOKEN '$GITHUB_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GITHUB_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: GITHUB_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; PAT bodies are alnum/underscore but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^GITHUB_TOKEN=' ~/.hermes/.env || printf 'GITHUB_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$GITHUB_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the GitHub MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with static token

The `github-mcp-server` binary reads `GITHUB_PERSONAL_ACCESS_TOKEN` from its environment.
Hermes forwards `GITHUB_TOKEN` from `~/.hermes/.env` and renames it for the child process:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add github \
    --command github-mcp-server \
    --args 'stdio' \
    --env 'GITHUB_PERSONAL_ACCESS_TOKEN=\${GITHUB_TOKEN}'
"
```

To scope down the toolset (optional), append `--toolsets repos,issues,pull_requests` to
`--args`, or `--read-only` for a non-mutating agent. Leave defaults if unsure.

If `github-mcp-server` is not yet on the VPS, install it once:

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if ! command -v github-mcp-server >/dev/null 2>&1; then
    LATEST=$(curl -sSL https://api.github.com/repos/github/github-mcp-server/releases/latest \
      | grep -oE "\"tag_name\": *\"[^\"]+\"" | head -1 | cut -d\" -f4)
    ARCH=$(uname -m | sed "s/x86_64/amd64/;s/aarch64/arm64/")
    curl -sSL "https://github.com/github/github-mcp-server/releases/download/${LATEST}/github-mcp-server_Linux_${ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin github-mcp-server
    chmod +x /usr/local/bin/github-mcp-server
  fi
  github-mcp-server --version
'
```

### Path B (fallback) — generic HTTP tool against the GitHub REST API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command:

- **Base URL:** `https://api.github.com` (or `https://<host>/api/v3` for GitHub Enterprise Server)
- **Auth header:** `Authorization: Bearer ${GITHUB_TOKEN}`
- **Accept header:** `Accept: application/vnd.github+json`
- **API version header:** `X-GitHub-Api-Version: 2022-11-28`

Do NOT try to register `https://api.githubcopilot.com/mcp/` with a long-lived PAT as a
permanent path — GitHub gates that endpoint to Copilot OAuth and the bearer path may stop
working without notice.

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
       | grep -qiE "registered.*tool.*github|MCP server.*github.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: github registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: github not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.github.com/user' \
    -H \"Authorization: Bearer \$GITHUB_TOKEN\" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28'
")
case "$HTTP" in
  200) echo "OK: GitHub API reachable and token valid." ;;
  401) echo "FAIL: token invalid, expired, or revoked. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but blocked. Likely org SSO not authorized, PAT policy, or rate limit. See Pitfalls 2 and 6."; exit 1 ;;
  404) echo "FAIL: 404 from /user — wrong base URL (GHES vs api.github.com)?"; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from GitHub API. Check manually." ;;
esac
```

`200` returns a JSON body with `login`, plus an `X-OAuth-Scopes` response header for classic
PATs (fine-grained PATs return that header empty — scopes live on the token resource itself).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove github 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset GITHUB_TOKEN 2>/dev/null || \
    sed -i '/^GITHUB_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. GitHub is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the hosted `api.githubcopilot.com/mcp/` with a long-lived PAT | GitHub gates that endpoint to Copilot OAuth; bearer path is unsupported and may stop working | Use the stdio server (Path A) or REST (Path B) |
| 2 | Token works in `curl /user` but every org call returns 403 | Org PAT policy or SSO not authorized for that org | <https://github.com/settings/tokens> → Configure SSO → Authorize on the right org |
| 3 | Fine-grained PAT silently misses repos in another org | Fine-grained tokens are scoped to one owner | Mint one PAT per owner, or use a classic `repo` PAT |
| 4 | Calls fail with 401 after weeks of working | Fine-grained PATs expire (max ~1 year) | Set a calendar reminder; re-run skill with `FORCE=1` after rotating |
| 5 | Missing `X-GitHub-Api-Version` header | Some endpoints behave differently or warn under default versioning | Always send `X-GitHub-Api-Version: 2022-11-28` |
| 6 | Sudden 403 with `x-ratelimit-remaining: 0` or secondary-rate-limit message | Authenticated PAT = 5,000 req/hr primary; secondary limits trip on bursts/abuse heuristics | Honor `Retry-After`; back off exponentially; do not retry tight loops |
| 7 | GitHub Enterprise Server using `api.github.com` | GHES lives at `https://<host>/api/v3` | Detect host kind during gather; switch base URL in Path B |
| 8 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | sed with `/` delimiter on tokens | PAT bodies are alnum but the rule still matters for other secrets | Always use `\|` delimiter |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `GITHUB_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] If org-protected: PAT authorized for SSO on the target org
- [ ] MCP registered via Path A (stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'github'` within 30s
- [ ] Smoke test: `GET /user` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
