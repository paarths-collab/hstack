---
name: integration-jira
description: Connect Jira (Atlassian Cloud) to a self-hosted Hermes Agent over SSH so the agent can search, create, and update issues. Wires Atlassian's official remote MCP server (Rovo) with a static API token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-jira — connect Jira to a remote Hermes (SSH-first)

You are the engineer connecting Jira (Atlassian Cloud) to a self-hosted Hermes agent on
the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of
them) work over SSH as root against the VPS. The user only does the things a machine
cannot: minting the Atlassian API token, and (one time, org-wide) flipping the
admin-console toggle that enables API-token auth for the Rovo MCP Server.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Atlassian ships a hosted remote MCP at
`https://mcp.atlassian.com/v1/mcp`. It accepts two header shapes for headless use:

| Credential | Header | Access |
|------------|--------|--------|
| **Personal API token** (recommended) | `Authorization: Basic <base64(email:token)>` | Full — read **and** write (create/update issues) |
| Service-account API key | `Authorization: Bearer <api_key>` | Read-only tools |

Default to **Basic** unless the user explicitly wants read-only. A common silent failure
is sending a personal token as `Bearer` — it authenticates but exposes only read tools,
so writes appear "missing." This is **Atlassian Cloud only**; Jira Data Center / Server
is not served by the remote MCP endpoint (see Pitfalls). The legacy SSE transport
`https://mcp.atlassian.com/v1/sse` is deprecated after 2026-06-30 — use `/v1/mcp`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ATLASSIAN_EMAIL` | Email of the Atlassian account the agent acts as | The user's Atlassian account |
| `$JIRA_TOKEN` | Atlassian API token (opaque string) | <https://id.atlassian.com/manage-profile/security/api-tokens> → Create API token |
| Org-admin toggle | API-token auth enabled for Rovo MCP | Atlassian Administration → Settings → Rovo MCP Server |

The MCP server runs **within that user's Jira permissions** — pick the right account.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci jira" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Jira is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

Compute the `Basic` header value locally (no logging). The header *value* must include
the literal `Basic ` scheme prefix because Hermes passes it through as one opaque header
value — `email:token` is not a bearer token, so Hermes cannot synthesize the scheme:

```bash
# GNU base64 (Linux): -w0 = no line wrap. macOS base64: drop -w0 (it does not wrap).
B64=$(printf '%s' "$ATLASSIAN_EMAIL:$JIRA_TOKEN" | base64 -w0)
HEADER_VALUE="Basic $B64"
```

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_JIRA_API_KEY (length ${#HEADER_VALUE}, prefix Basic ${B64:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add jira --url https://mcp.atlassian.com/v1/mcp --auth-header Authorization
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*jira"
  6. Smoke test: GET https://mcp.atlassian.com/v1/mcp -> expect 200/401/403

The token and header value are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

The secret stored is the **whole** `Basic <b64>` string, not just the token. The base64
blob can contain `+`, `/`, and `=` — this is exactly why all sed below uses the `|`
delimiter.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_JIRA_API_KEY '$HEADER_VALUE'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_JIRA_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_JIRA_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter is required — the value contains `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_JIRA_API_KEY=' ~/.hermes/.env || printf 'MCP_JIRA_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_JIRA_API_KEY=.*|MCP_JIRA_API_KEY=$HEADER_VALUE|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Jira MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official Atlassian remote MCP (HTTP, header auth)

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add jira \
    --url 'https://mcp.atlassian.com/v1/mcp' \
    --auth-header 'Authorization' \
    --header-value '\${MCP_JIRA_API_KEY}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its HTTP-header syntax. The header value uses `${MCP_JIRA_API_KEY}` indirection so
the secret stays in `~/.hermes/.env` and never appears in `config.yaml`.

The resulting `config.yaml` block should read (token stays out of it):

```yaml
jira:
  url: https://mcp.atlassian.com/v1/mcp
  headers:
    Authorization: ${MCP_JIRA_API_KEY}
  enabled: true
```

### Path B (fallback) — generic HTTP tool against the Jira REST API

If the Hermes build is stdio-MCP-only and cannot register an HTTP MCP, or if this is
**Jira Data Center / Server** (no remote MCP):

- **Base URL:** `https://<your-domain>.atlassian.net/rest/api/3` (Cloud) or
  `https://<your-domain>/rest/api/3` (self-hosted)
- **Auth header:** `Authorization: Basic ${MCP_JIRA_API_KEY_RAW}` where
  `MCP_JIRA_API_KEY_RAW = base64(email:token)` (no `Basic ` prefix when Hermes adds the
  scheme itself; otherwise pass the full `Basic <b64>` as above)
- **Content type:** `Content-Type: application/json`

Do NOT try to register `https://mcp.atlassian.com/v1/mcp` against a Data Center
instance — the hosted endpoint serves Cloud tenants only.

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
       | grep -qiE "registered.*tool.*jira|MCP server.*jira.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: jira registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: jira not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Expect a line like `MCP server 'jira' (HTTP): registered N tool(s): ...`.

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://mcp.atlassian.com/v1/mcp' \
    -H \"Authorization: \$MCP_JIRA_API_KEY\" \
    -H 'Accept: application/json'
")
case "$HTTP" in
  200) echo "OK: Jira MCP endpoint reachable and credential valid." ;;
  401) echo "FAIL: 401 — invalid header, wrong scheme, or org-admin toggle not enabled. Rolling back."; rollback; exit 1 ;;
  403) echo "FAIL: 403 — credential valid but missing scope/permission."; exit 1 ;;
  404) echo "WARN: 404 — probe path differs by tenant; check tools/list via the gateway." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Jira MCP. Check manually." ;;
esac
```

End-to-end smoke from chat:

```
@<agent> using jira, search for issues assigned to me
```

A real issue list — or an empty-but-valid result for an account with no issues — is a
pass. "Tool not found" for create/update means the credential authenticated as `Bearer`
read-only; switch to `Basic` (Step 3).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove jira 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_JIRA_API_KEY 2>/dev/null || \
    sed -i '/^MCP_JIRA_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Jira is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Org-admin API-token toggle not enabled | #1 cause of "valid token, still 401" | Org admin must enable API-token auth for Rovo MCP in Atlassian Administration before headless auth works |
| 2 | Sending personal token as `Bearer` instead of `Basic` | Authenticates but exposes only read-only tools — writes appear "missing" | Use `Basic base64(email:token)` for create/update access |
| 3 | Forgetting the `Basic ` scheme prefix in the stored value | Hermes passes the header value through opaquely — there is no synthesis | Store the full `Basic <b64>` string in `MCP_JIRA_API_KEY` |
| 4 | Wiring `mcp.atlassian.com` for Jira Data Center / Server | Hosted endpoint serves Cloud only | Use Path B (REST) against `https://<your-domain>/rest/api/3/` for self-hosted Jira |
| 5 | Scoped vs classic token confusion | A "Create API token with scopes" token only exposes data its scopes allow; classic inherits full user perms | If tools register but return "permission denied," widen scopes or use a classic token |
| 6 | Hitting Atlassian Cloud rate limits | Per-account REST limits (HTTP 429 + `Retry-After`); MCP proxies these | Keep agent polling/automation modest; backoff on 429 |
| 7 | Using the legacy `/v1/sse` endpoint | Deprecated after 2026-06-30 | Always use `/v1/mcp` (streamable HTTP) |
| 8 | Permission boundary surprises | MCP acts strictly within the signed-in account's Jira permissions | Pick the right Atlassian account up front; cannot widen at runtime |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline; silent corruption | Always `hermes config set` (or the sed-fallback in Step 4) |
| 11 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 12 | sed with `/` delimiter on the header value | Base64 contains `/+=` — sed breaks mid-line | Always use `\|` delimiter |
| 13 | Container vs host confusion when running commands | Skill assumed wrong layer | Always `whoami; hostname` check; exit any container first |
| 14 | base64 line-wrap on macOS vs GNU | macOS `base64` has no `-w0` (but does not wrap short input) | Drop `-w0` on macOS; keep it on Linux |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_JIRA_API_KEY` written to `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Auth shape is `Basic base64(email:token)` if writes are needed (not `Bearer`)
- [ ] Org-admin API-token enablement confirmed for the Rovo MCP Server
- [ ] MCP registered via Path A (HTTP, header auth) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'jira'` within 30s
- [ ] Smoke test: GET against the MCP endpoint returned `200` (or chat search returned a valid result set)
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
