---
name: integration-bitbucket
description: Connect Bitbucket Cloud (repos, branches, pull-request lifecycle) to a self-hosted Hermes Agent over SSH via the official Atlassian Rovo remote MCP server. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-bitbucket — connect Bitbucket Cloud to a remote Hermes (SSH-first)

You are the engineer connecting Bitbucket Cloud to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the API token (or have an org admin mint a service-account key) in the Atlassian UI.
2. Have an org admin enable API-token auth for the Rovo MCP server in Atlassian Administration.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Atlassian ships a first-party remote MCP server
(`atlassian/atlassian-mcp-server`) at `https://mcp.atlassian.com/v1/mcp` that DOES cover
Bitbucket Cloud. But unlike Jira/Confluence, **Bitbucket Cloud tools are available only via
API-token auth — OAuth 2.1 does not cover Bitbucket yet.** Static-token auth keeps the
one-click promise. The legacy `/v1/sse` endpoint is unsupported after 2026-06-30 — do not use it.

There are two credential shapes, and picking the wrong header is the #1 footgun:

- **Personal API token** → HTTP Basic of `email:token` (NOT Bearer).
- **Service-account API key** → Bearer directly (recommended for always-on agents).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$BITBUCKET_AUTH` | Complete `Authorization` value: either `Basic <b64(email:token)>` or `Bearer <service-key>` | <https://id.atlassian.com/manage-profile/security/api-tokens> → *Create API token with scopes*, OR Atlassian Administration → Rovo / MCP settings → service-account key |
| Scopes on the token | At least `read:repository:bitbucket`, `read:pullrequest:bitbucket`; add `write:pullrequest:bitbucket` to create/comment/merge PRs | Set when minting the token; scope to narrowest workspace/repos needed |
| Org-admin toggle | API-token auth for Rovo MCP must be enabled in Atlassian Administration | Org admin task; if `401`/`403` on a correctly-formed request, this is usually the cause |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

If you are minting `$BITBUCKET_AUTH` locally, build it correctly **before** sending it to the VPS:

- Personal token (Linux): `BITBUCKET_AUTH="Basic $(printf '%s' 'you@example.com:<token>' | base64 -w0)"`
- Personal token (BSD/macOS): `BITBUCKET_AUTH="Basic $(printf '%s' 'you@example.com:<token>' | base64 | tr -d '\n')"`
- Service-account key: `BITBUCKET_AUTH="Bearer <service-account-api-key>"`

`-w0` (or `tr -d '\n'`) is mandatory — a wrapped base64 value is an invalid header and silently 401s.

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

Expected: `0.15.x` or `0.17.x`. If you land in a container shell with `root@<hex-string>`, exit
to the host first — keys/configs added inside a container are invisible to the host.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci bitbucket" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Bitbucket is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_BITBUCKET_API_KEY (length ${#BITBUCKET_AUTH}, prefix ${BITBUCKET_AUTH:0:6}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add bitbucket --url https://mcp.atlassian.com/v1/mcp --auth header (Authorization)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*bitbucket"
  6. Smoke test: GET https://api.bitbucket.org/2.0/user → expect 200 (Bearer key) or use /workspaces for Basic
EOF
echo "The Authorization value is NEVER printed in plaintext."
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

The whole `Authorization` value (including the literal word `Basic ` or `Bearer ` and the space)
lives in `MCP_BITBUCKET_API_KEY`. `config.yaml` will reference it with no literal prefix.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_BITBUCKET_API_KEY '$BITBUCKET_AUTH'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_BITBUCKET_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_BITBUCKET_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with `|` as
> delimiter (the base64/key contains `/`, `+`, `=` — a `/`-delimited sed will break):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_BITBUCKET_API_KEY=' ~/.hermes/.env || printf 'MCP_BITBUCKET_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_BITBUCKET_API_KEY=.*|MCP_BITBUCKET_API_KEY=$BITBUCKET_AUTH|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```
> Never `echo >>` the value: a missing trailing newline on the prior line merges values and
> the runtime silently picks up garbage.

---

## Step 5 — register the Bitbucket MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official Atlassian Rovo remote MCP server

The full `Authorization` value (including `Basic ` / `Bearer `) is already in
`MCP_BITBUCKET_API_KEY`, so `config.yaml` references it with **no literal prefix**:

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    hermes mcp add bitbucket \
      --url 'https://mcp.atlassian.com/v1/mcp' \
      --auth header
"
```

Then swap the placeholder for the env-var reference (pipe delimiter — never `/`):

```bash
ssh "$VPS_USER@$VPS_IP" \
  "sed -i 's|Authorization: placeholder|Authorization: \${MCP_BITBUCKET_API_KEY}|' ~/.hermes/config.yaml"
```

The result in `config.yaml` should look like:

```yaml
bitbucket:
  url: https://mcp.atlassian.com/v1/mcp
  headers:
    Authorization: ${MCP_BITBUCKET_API_KEY}
  enabled: true
```

If `mcp add` generated a literal `Bearer ${MCP_BITBUCKET_API_KEY}` line, edit `config.yaml` to
drop the literal `Bearer ` — otherwise the prefix is duplicated and the server 401s every call.

### Path B (fallback) — generic HTTP tool against the Bitbucket Cloud REST API

If the Hermes build cannot register a remote MCP, or the org-admin Rovo toggle is not yet on:

- **Base URL:** `https://api.bitbucket.org/2.0`
- **Auth header:** `Authorization: ${MCP_BITBUCKET_API_KEY}` (the env var already contains `Basic ...` or `Bearer ...`)
- **Common endpoints:** `/user`, `/workspaces`, `/repositories/{workspace}`, `/repositories/{workspace}/{repo_slug}/pullrequests`

Do NOT use the legacy `https://mcp.atlassian.com/v1/sse` endpoint — it is unsupported after 2026-06-30.

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
       | grep -qiE "registered.*tool.*bitbucket|MCP server.*bitbucket.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: bitbucket registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: bitbucket not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test

Use a side-effect-free call. For a Bearer service-account key, `/user` works. For a Basic
personal token, prefer `/workspaces` (which always succeeds with any read-scope token):

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.bitbucket.org/2.0/workspaces?pagelen=1' \
    -H \"Authorization: \$MCP_BITBUCKET_API_KEY\"
")
case "$HTTP" in
  200) echo "OK: Bitbucket API reachable and Authorization valid." ;;
  401) echo "FAIL: Authorization invalid. Common causes: wrong shape (Bearer vs Basic), wrapped base64, missing email in Basic, org-admin API-token toggle off."; rollback; exit 1 ;;
  403) echo "FAIL: Authorization valid but scope missing. Re-mint with read:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket."; exit 1 ;;
  429) echo "WARN: rate-limited by Atlassian. Back off and retry; do not tight-loop." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Bitbucket API. Check manually." ;;
esac
```

A `200` with an empty list is still a pass — it proves auth/routing; the account simply has no
workspaces shared with the token yet.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove bitbucket 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_BITBUCKET_API_KEY 2>/dev/null || \
    sed -i '/^MCP_BITBUCKET_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Bitbucket is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using `Bearer` with a **personal** API token | Personal tokens need `Basic base64(email:token)`; Bearer is only for service-account keys | Match header shape to credential type (see Before you start) |
| 2 | Forgetting the email in the Basic value | The credential is `email:token`, not the token alone | Always base64 `email:token` |
| 3 | Wrapped base64 | `base64` without `-w0` inserts newlines → malformed header → silent 401 | `base64 -w0` (Linux) or `base64 \| tr -d '\n'` (BSD/macOS) |
| 4 | Expecting OAuth | OAuth 2.1 works for Jira/Confluence but **not** Bitbucket Cloud yet | Use an API token / service-account key; do not wait for OAuth |
| 5 | API-token auth not enabled org-wide | Org admin must enable API-token auth for the Rovo MCP server; otherwise every token 401s | Confirm the Atlassian Admin toggle before debugging headers |
| 6 | Over-broad token scope | A workspace/account-wide token gives the agent more than the task needs | Scope to specific repos/PR permissions; prefer a service account |
| 7 | Legacy `/v1/sse` endpoint | Unsupported after 2026-06-30 | Use `https://mcp.atlassian.com/v1/mcp` |
| 8 | Literal `Bearer ` in `config.yaml` AND in the env var | Prefix gets duplicated → 401 every call | Either keep the full prefix in the env var (recommended) OR keep it literal in `config.yaml` — never both |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | `echo >> .env` instead of `hermes config set` | Missing trailing newline merges values onto one line — runtime picks up garbage | Always `hermes config set` (or the sed fallback in Step 4) |
| 11 | Secret in `config.yaml` instead of `.env` | World-readable; defeats `chmod 600`; may not be loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, env-var reference in `config.yaml` |
| 12 | sed with `/` delimiter on tokens | Tokens / base64 contain `/`, `+`, `=` | Always use `\|` as the sed delimiter |
| 13 | Container vs host confusion | `root@<hex>` is inside a container; keys/configs added there are invisible to host sshd | `whoami; hostname` first; `exit` until you are on the host |
| 14 | Skipping the verify step | "Silent success" — config written, never picked up | Always poll logs + smoke-test the API |
| 15 | Rate limits | Atlassian throttles MCP/API calls per token; bursty PR automation can 429 | Back off on `429`; avoid tight polling loops |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded (Step 1 host/container check passed)
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_BITBUCKET_API_KEY` holds the full `Basic <b64>` or `Bearer <key>` value in `~/.hermes/.env`, `chmod 600`
- [ ] Secret NOT in `config.yaml` and NOT echoed in chat; literal `Bearer `/`Basic ` not duplicated between env and config
- [ ] MCP registered via Path A (Rovo remote MCP) with `Authorization: ${MCP_BITBUCKET_API_KEY}`, OR Path B (REST) documented
- [ ] Org admin has enabled API-token auth for the Rovo MCP server
- [ ] Token scoped to the minimum repos / PR permissions the agent actually needs
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'bitbucket'` within 30s
- [ ] Smoke test: `GET /2.0/workspaces` (or `/2.0/user` for Bearer) returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
