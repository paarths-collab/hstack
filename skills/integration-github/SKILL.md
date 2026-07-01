---
name: integration-github
description: Connect GitHub (code, issues, PRs, CI) to a self-hosted Hermes Agent over SSH via GitHub's first-party remote MCP server. Idempotent, dry-run, and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-github — connect GitHub to a remote Hermes (SSH-first)

You are the engineer connecting GitHub to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not locally.

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
| `$GITHUB_MCP_URL` | MCP base URL | Default `https://api.githubcopilot.com/mcp/`; for `ghe.com` data-residency users, `https://copilot-api.<subdomain>.ghe.com/mcp` |

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
  1. Write GITHUB_TOKEN (length ${#GITHUB_TOKEN}, prefix ${GITHUB_TOKEN:0:11}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add github --url ${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/} --auth header
     Header: Authorization: Bearer \${GITHUB_TOKEN}
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*github"
  6. Smoke test: GET https://api.github.com/user → expect 200

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
> (pipe delimiter; PATs are alnum + `_` but always use `|` for safety):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^GITHUB_TOKEN=' ~/.hermes/.env || printf 'GITHUB_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^GITHUB_TOKEN=.*|GITHUB_TOKEN=$GITHUB_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the GitHub MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred — GitHub
ships a real remote MCP server, so there's no need for stdio shims or REST fallbacks.

### Path A (preferred) — first-party remote HTTP MCP with bearer auth

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add github \
    --url '${GITHUB_MCP_URL:-https://api.githubcopilot.com/mcp/}' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --env 'GITHUB_TOKEN=\${GITHUB_TOKEN}'
"
```

The exact flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first
and match its HTTP/header syntax. The token stays in `~/.hermes/.env` and is referenced
via `${GITHUB_TOKEN}` indirection — never inlined into `config.yaml`.

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

Edit `config.yaml`'s `headers:` block and reload the gateway (Step 6).

### Path B (fallback) — generic HTTP tool against the GitHub REST API

If the Hermes build is stdio-MCP-only and cannot reach a remote HTTP MCP:

- **Base URL:** `https://api.github.com`
- **Auth header:** `Authorization: Bearer ${GITHUB_TOKEN}`
- **Recommended version header:** `X-GitHub-Api-Version: 2022-11-28`
- **Accept:** `Accept: application/vnd.github+json`

Do NOT inline the token into any registered URL or YAML field. Reference it via env.

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

## Step 8 — live API smoke test (token validity, end-to-end)

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
  401) echo "FAIL: token invalid, expired, or empty. Re-check Step 4 and PAT validity."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but blocked — likely org PAT policy or missing scope."; exit 1 ;;
  404) echo "FAIL: unexpected 404 from /user. Check network / Enterprise host."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from GitHub API. Check manually." ;;
esac
```

A `200` proves the PAT lands and authenticates. From chat you can then run something like
`@<agent> using github, list the open issues on <owner>/<repo>` — a real list (or a valid
empty result) confirms the MCP path itself is wired, not just the REST credential.

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
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the documented sed-fallback with `printf` for the seed line) |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, referenced via `${GITHUB_TOKEN}` |
| 4 | sed with `/` delimiter on tokens | Future tokens may contain `/+=` | Always use `\|` delimiter |
| 5 | Container vs host confusion | Skill assumed wrong layer | Step 1's host/container detection picks the right one |
| 6 | PAT scopes are the ceiling | MCP can only do what the token allows; a fine-grained PAT without Issues/Pull requests perms returns 200 on `/user` but 403/404 on tool calls | Match permissions to the use case BEFORE blaming the wiring |
| 7 | Org PAT policy silently blocks | If the target org restricts/forbids PATs (or requires approval for fine-grained), token returns 401/403 until an org owner approves | Check org SSO/PAT policy; have an org owner approve the token |
| 8 | Fine-grained PATs are org/owner-scoped | A fine-grained token only reaches repos under the owner picked at creation | Use multiple tokens, or fall back to a classic PAT for cross-org reach |
| 9 | Token expiry | Fine-grained PATs expire (max ~1 year, often less); after expiry, calls 401 | When 401s start, mint a fresh PAT and rerun Steps 3-8 |
| 10 | Trying OAuth path on headless agent | GitHub's MCP also supports one-click OAuth, but it needs an interactive browser | Stay on the PAT path for Hermes |
| 11 | Wrong host for GitHub Enterprise | Public URL fails for `ghe.com` data-residency tenants | Use `https://copilot-api.<subdomain>.ghe.com/mcp` for those users |
| 12 | Rate limits | Authenticated REST/GraphQL is 5,000 req/hr (lower for some resources); bursts get `403` with `X-RateLimit-Remaining: 0` | Backoff on `403` with rate-limit headers; do not tight-loop retry |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `GITHUB_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (remote HTTP MCP) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'github'` within 30s
- [ ] Smoke test: `GET https://api.github.com/user` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
