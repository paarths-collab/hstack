---
name: integration-netlify
description: Connect Netlify (static/frontend deploys, site + deploy management) to a self-hosted Hermes agent over SSH. Wires the official @netlify/mcp stdio server with a Personal Access Token, falling back to direct REST. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-netlify — connect Netlify to a remote Hermes (SSH-first)

You are the engineer connecting Netlify to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the one thing a machine cannot: mint the
Netlify Personal Access Token (PAT) in the dashboard.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Netlify ships an official MCP server
(`@netlify/mcp`, repo `netlify/netlify-mcp`). There are two ways to reach it and the
choice matters for a headless server:

- The **remote MCP** at `https://netlify-mcp.netlify.app/mcp` authenticates via **OAuth
  (browser sign-in) by default.** A headless Hermes container has no browser, so the
  OAuth handshake cannot complete there. Do not wire the remote URL expecting a Bearer
  header to "just work" — Netlify documents the PAT only as a fallback env var on the
  local server, not as a remote header.
- The **local stdio MCP** (`npx -y @netlify/mcp`) takes a `NETLIFY_PERSONAL_ACCESS_TOKEN`
  env var. This is the token-based, headless-friendly path. We use it (Path A), with
  the direct REST API as the fallback (Path B).

Netlify PATs are **account-scoped** (no per-token scopes — they inherit your full account
access). Treat them like a password.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$NETLIFY_TOKEN` | Personal Access Token | <https://app.netlify.com/user/applications#personal-access-tokens> → **New access token** → name + expiration → **Generate** → copy immediately (shown once) |

Docs: <https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/>

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
    # @netlify/mcp requires Node 22+ — confirm before relying on the stdio server
    docker exec "$AGENT" node --version || echo "WARN: node not found in container"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`, and Node `v22.x` or newer (the stdio server exits
immediately on older Node).

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci netlify" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Netlify is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Sanity-check PAT against https://api.netlify.com/api/v1/sites (expect 200)
  2. Write NETLIFY_PERSONAL_ACCESS_TOKEN (length ${#NETLIFY_TOKEN}, prefix ${NETLIFY_TOKEN:0:4}...) via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add netlify --command npx --args -y,@netlify/mcp
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*netlify"
  7. Smoke test: GET https://api.netlify.com/api/v1/sites → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

Quick pre-flight against the REST API (proves the PAT is valid before any Hermes work):

```bash
PRECHECK=$(curl -sS -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${NETLIFY_TOKEN}" \
  -H "User-Agent: hermes-agent (ops)" \
  https://api.netlify.com/api/v1/sites)
case "$PRECHECK" in
  200) echo "OK: PAT validates against Netlify REST." ;;
  401) echo "ABORT: PAT invalid/expired (a password reset invalidates all PATs)."; exit 1 ;;
  *)   echo "WARN: pre-flight returned $PRECHECK; proceeding anyway." ;;
esac
```

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set NETLIFY_PERSONAL_ACCESS_TOKEN '$NETLIFY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^NETLIFY_PERSONAL_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: NETLIFY_PERSONAL_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If this Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Netlify PATs are alnum but the pattern is safe for tokens with `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^NETLIFY_PERSONAL_ACCESS_TOKEN=' ~/.hermes/.env \
>     || printf 'NETLIFY_PERSONAL_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^NETLIFY_PERSONAL_ACCESS_TOKEN=.*|NETLIFY_PERSONAL_ACCESS_TOKEN=$NETLIFY_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```
> Never use a bare `echo >>` that can glue onto a previous line missing a trailing newline.

---

## Step 5 — register the Netlify MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official @netlify/mcp stdio server with PAT env var

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add netlify \
    --command npx \
    --args '-y,@netlify/mcp' \
    --env 'NETLIFY_PERSONAL_ACCESS_TOKEN=\${NETLIFY_PERSONAL_ACCESS_TOKEN}'
"
```

The resulting `config.yaml` block should reference the env var, not the literal token:

```yaml
netlify:
  command: npx
  args: ["-y", "@netlify/mcp"]
  env:
    NETLIFY_PERSONAL_ACCESS_TOKEN: ${NETLIFY_PERSONAL_ACCESS_TOKEN}
  enabled: true
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax. The token stays in `~/.hermes/.env` and is referenced via
`${NETLIFY_PERSONAL_ACCESS_TOKEN}` indirection — never inlined.

### Path B (fallback) — direct REST against the Netlify API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command, do NOT fall back
to the OAuth-gated remote URL on a headless box. Drive REST directly:

- **Base URL:** `https://api.netlify.com/api/v1/`
- **Auth header:** `Authorization: Bearer ${NETLIFY_PERSONAL_ACCESS_TOKEN}`
- **List sites:** `GET /sites`
- **Trigger deploy:** `POST /sites/{site_id}/builds`
- **User-Agent:** include a recognizable UA, e.g. `hermes-agent (ops)`

State plainly to the user that the agent is calling REST, not MCP, in this case.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 10   # first npx run downloads @netlify/mcp; allow extra time
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*netlify|MCP server.*netlify.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: netlify registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: netlify not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success looks like a line such as:
`INFO tools.mcp_tool: MCP server 'netlify' (stdio): registered N tool(s): mcp_netlify_...`

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.netlify.com/api/v1/sites' \
    -H \"Authorization: Bearer \$NETLIFY_PERSONAL_ACCESS_TOKEN\" \
    -H 'User-Agent: hermes-agent (ops)'
")
case "$HTTP" in
  200) echo "OK: Netlify API reachable and token valid." ;;
  401) echo "FAIL: token invalid/expired (password reset invalidates all PATs). Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but forbidden. Confirm account permissions."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Netlify API. Check manually." ;;
esac
```

`200` with an empty JSON array means the token works but no sites exist on the account —
not a failure of wiring.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove netlify 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset NETLIFY_PERSONAL_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^NETLIFY_PERSONAL_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Netlify is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the remote `netlify-mcp.netlify.app/mcp` with a Bearer header | The remote MCP is **OAuth-only**; Bearer tokens are rejected on a headless box | Use the stdio server (Path A) or REST (Path B) |
| 2 | Assuming PATs have scopes | Netlify PATs are account-scoped — no per-token narrowing, no read-only | Mint a dedicated token with an expiration; rotate it; treat as password |
| 3 | Password reset invalidates all tokens | Resetting the Netlify password nukes every PAT and OAuth token | After any reset, re-mint and re-run Step 4 |
| 4 | Node < 22 in the container | `@netlify/mcp` requires Node 22+; older Node makes the stdio server exit immediately with zero registered tools | Step 1 checks `node --version`; upgrade base image if needed |
| 5 | First-run timeout | `npx -y @netlify/mcp` downloads the package on first launch | Step 6 sleeps 10s; bump to 30s on a slow VPS |
| 6 | Using a PAT for public/multi-user integrations | Netlify mandates OAuth2 for multi-tenant use; PATs are personal-only | Use OAuth2 for shared apps; PAT only for your own automation |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline; SSH ignores the merged key | Always `hermes config set` |
| 9 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 10 | sed with `/` delimiter on tokens | Tokens may contain `/+=` | Always use `\|` delimiter |
| 11 | Container vs host confusion | Skill assumed wrong layer; SSH keys added in container are invisible to host sshd | Always check `whoami; hostname` first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x); Node 22+ confirmed in container
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] PAT pre-flight (`GET /api/v1/sites`) returned `200`
- [ ] `NETLIFY_PERSONAL_ACCESS_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (stdio @netlify/mcp) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'netlify'` within 30s
- [ ] Smoke test: `GET /api/v1/sites` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)
- [ ] User told that the remote MCP is OAuth-only and this setup uses the token-based stdio/REST path

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
