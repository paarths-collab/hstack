---
name: integration-linear
description: Connect Linear (product/engineering issues, projects, cycles) to a self-hosted Hermes Agent over SSH. Wires Linear's first-party remote MCP server via static API-key-in-bearer-header. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-linear — connect Linear to a remote Hermes (SSH-first)

You are the engineer connecting Linear to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Linear personal API key in the Linear UI.
2. Confirm the key's scope (Read / Write / Admin, optionally team-restricted).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Linear ships a hosted remote MCP at
`https://mcp.linear.app/mcp`. Its **documented default** is OAuth 2.1 with dynamic
client registration (browser flow — not headless-friendly). Linear's own MCP FAQ
documents a supported alternative: pass an OAuth token *or a personal API key* in the
`Authorization: Bearer <token>` header instead of the interactive flow
(<https://linear.app/docs/mcp>). That static-bearer path is what we use here so the
whole flow stays headless. If Linear ever removes header-based auth, fall back to an
OAuth bridge (`mcp-remote`) which requires a one-time browser login.

**Bearer asymmetry — the #1 Linear gotcha.** Linear's raw GraphQL API takes the
personal API key with **no** prefix (`Authorization: <key>`). The MCP server takes the
**same** key **with** `Bearer` (`Authorization: Bearer <key>`). Step 1 uses the
no-Bearer form to validate the key; the MCP wiring uses the Bearer form. Mixing them
returns 401.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$LINEAR_API_KEY` | Personal API key (`lin_api_...`) | <https://linear.app/settings/account/security> -> **Personal API keys** -> **New API key**. Pick the narrowest scope (Read / Write / Admin; optionally team-restricted) that covers what the agent should do. |

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

While we're here, validate the key against Linear's GraphQL API — the **no-Bearer**
form. This catches a bad key before we touch any config:

```bash
VIEWER=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -X POST https://api.linear.app/graphql \
    -H 'Authorization: $LINEAR_API_KEY' \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"{ viewer { id name email } }\"}'
")
echo "$VIEWER" | grep -q '"viewer"' \
  || { echo "FAIL: GraphQL key check failed. Did you send Bearer to the raw API? Personal keys go raw, no prefix."; exit 1; }
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci linear" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Linear is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_LINEAR_API_KEY (length ${#LINEAR_API_KEY}, prefix ${LINEAR_API_KEY:0:8}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add linear --url https://mcp.linear.app/mcp --auth-header Authorization --auth-scheme Bearer
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*linear"
  6. Smoke test: POST https://mcp.linear.app/mcp tools/list -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_LINEAR_API_KEY '$LINEAR_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_LINEAR_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_LINEAR_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; `lin_api_` keys are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_LINEAR_API_KEY=' ~/.hermes/.env || printf 'MCP_LINEAR_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_LINEAR_API_KEY=.*|MCP_LINEAR_API_KEY=$LINEAR_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Linear MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred — Linear's
first-party hosted MCP accepts the static API key in the bearer header, so no OAuth
bootstrap is needed.

### Path A (preferred) — official remote MCP with Bearer header

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add linear \
    --url 'https://mcp.linear.app/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject the real key with pipe delimiter (lin_api_ is alnum, but always use | for safety).
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$LINEAR_API_KEY\"'|g' ~/.hermes/config.yaml"
```

The resulting `config.yaml` block must reference the env var indirectly — never inline
the literal key:

```yaml
linear:
  url: https://mcp.linear.app/mcp
  headers:
    Authorization: Bearer ${MCP_LINEAR_API_KEY}
  enabled: true
```

Use the streamable HTTP endpoint `https://mcp.linear.app/mcp`. The legacy
`https://mcp.linear.app/sse` endpoint is being retired — do **not** wire it.

### Path B (fallback) — generic HTTP tool against the Linear GraphQL API

If the Hermes build is stdio-MCP-only or cannot reach the remote MCP, expose the raw
GraphQL endpoint as a generic HTTP tool:

- **Endpoint:** `POST https://api.linear.app/graphql`
- **Auth header:** `Authorization: ${MCP_LINEAR_API_KEY}` (**no** `Bearer` — the raw GraphQL API rejects Bearer for personal keys)
- **Content type:** `Content-Type: application/json`
- **Body shape:** `{ "query": "...", "variables": { ... } }`

Path B loses the bundled Linear tool catalogue (the MCP server pre-registers
`list_issues`, `create_issue`, etc.); the agent has to write GraphQL by hand.

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
       | grep -qiE "registered.*tool.*linear|MCP server.*linear.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: linear registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: linear not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success looks like `MCP server 'linear' (HTTP): registered N tool(s): mcp_linear_list_issues, ...`.

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

Hit the MCP server's `tools/list` directly with the Bearer header — this is the same
call Hermes makes internally, so it proves both the key and the wiring.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://mcp.linear.app/mcp' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: Bearer \$MCP_LINEAR_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'
")
case "$HTTP" in
  200) echo "OK: Linear MCP reachable and bearer key valid." ;;
  401) echo "FAIL: bearer key rejected. Did the sed inject drop the Bearer prefix? Re-check Step 5."; rollback; exit 1 ;;
  403) echo "FAIL: key valid but scope insufficient (e.g. read-only key on a write op). Re-mint with broader scope."; exit 1 ;;
  429) echo "WARN: rate limited. Linear caps personal-key requests per user; back off and retry." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Linear MCP. Check manually." ;;
esac
```

Optional second check from the chat interface to prove end-to-end tool use:

```
@<agent> using linear, list my assigned issues
```

A valid result — even an empty list if nothing is assigned — is a pass.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove linear 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_LINEAR_API_KEY 2>/dev/null || \
    sed -i '/^MCP_LINEAR_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Linear is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Bearer asymmetry: raw GraphQL vs MCP | GraphQL takes the key **raw**; MCP takes it with **Bearer**. Mixing returns 401. | Step 1 uses no-Bearer; Step 5/8 use Bearer. Don't cross-paste. |
| 2 | Wiring the legacy `/sse` endpoint | Linear is retiring SSE; only streamable HTTP `/mcp` is supported | Always use `https://mcp.linear.app/mcp` |
| 3 | OAuth is the documented default | Hosted MCP defaults to OAuth 2.1 + dynamic client registration (browser flow) | Use the API-key-in-header path; fall back to `mcp-remote` only if Linear removes header auth |
| 4 | Read-only key on write tools | Create/comment/update tools return 403 | Match key scope to intended actions; prefer narrowest scope |
| 5 | Key is user-scoped, not workspace-scoped | Agent sees only what that user can see (and only allowed teams) | Document this; mint a service-account user key if broader reach is needed |
| 6 | Linear API rate limits | Personal-key requests are per-user (~few thousand/hour); complex GraphQL costs more; bursts get 429 | Back off on 429; batch queries; avoid tight loops |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 9 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, referenced as `${MCP_LINEAR_API_KEY}` |
| 10 | sed with `/` delimiter on tokens | `lin_api_` is safe today, but defensive habit matters across integrations | Always use `|` delimiter |
| 11 | Container vs host confusion | Adding the key inside a container won't survive a rebuild | Always check `whoami; hostname`; key writes happen on host via `hermes config set` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `{ viewer { id name } }` against `https://api.linear.app/graphql` returned the user (raw, no Bearer)
- [ ] `MCP_LINEAR_API_KEY` written to `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` and **not** echoed in chat
- [ ] MCP registered via Path A (`https://mcp.linear.app/mcp` with `Authorization: Bearer ${MCP_LINEAR_API_KEY}`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'linear'` within 30s
- [ ] Smoke test: `POST https://mcp.linear.app/mcp tools/list` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
