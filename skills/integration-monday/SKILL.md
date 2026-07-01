---
name: integration-monday
description: Connect Monday.com (boards, items, updates) to a self-hosted Hermes Agent over SSH via Monday's first-party hosted MCP server. Idempotent, dry-run-previewed, rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-monday — connect Monday.com to a remote Hermes (SSH-first)

You are the engineer connecting Monday.com to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the V2 personal API token in the Monday UI.
2. Have an account admin install the Monday MCP marketplace app (one-time, per account).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06 from `mondaycom/mcp` master + `developer.monday.com`):**
Monday ships a **first-party hosted remote MCP** at `https://mcp.monday.com/mcp` that accepts
a static personal API token over an `Authorization: Bearer` header — perfect for headless
agents. It also supports per-user OAuth, but that breaks the unattended-agent promise, so we
use the static token. There is **also** an official stdio package (`@mondaydotcomorg/monday-api-mcp`)
as a fallback when the hosted endpoint cannot be enabled (e.g. admin policy blocks the
marketplace app). Critical gotcha: the **hosted MCP requires `Bearer ` prefix; the raw REST
API at `api.monday.com/v2` requires the token with NO `Bearer ` prefix**. Mixing them = 401.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MONDAY_TOKEN` | V2 personal API token | Monday UI -> profile picture (top-right) -> **Developers** -> **API token** -> **Show** -> copy. Admins: profile -> **Administration** -> **Connections** -> **Personal API token**. Docs: <https://developer.monday.com/api-reference/docs/authentication> |
| Admin app install | Monday MCP marketplace app installed for the account (one-time) | <https://monday.com/marketplace/listing/10000806/monday-mcp> |
| API version (optional) | `Api-Version` header, e.g. `2025-07` | Only set if a specific version is required |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci monday" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Monday is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_MONDAY_API_KEY (length ${#MONDAY_TOKEN}, prefix ${MONDAY_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add monday --url https://mcp.monday.com/mcp --auth header (Bearer)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*monday"
  6. Smoke test: POST https://api.monday.com/v2 with { me { id name } } -> expect 200

The token is NEVER printed in plaintext. The hosted MCP needs 'Bearer <token>';
the REST smoke test uses the raw token with NO Bearer prefix.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

Hermes generates the env var name from the MCP name: `monday` -> `MCP_MONDAY_API_KEY`.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_MONDAY_API_KEY '$MONDAY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_MONDAY_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_MONDAY_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — Monday tokens are JWT-like and contain `/ + = .`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_MONDAY_API_KEY=' ~/.hermes/.env || printf 'MCP_MONDAY_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_MONDAY_API_KEY=.*|MCP_MONDAY_API_KEY=$MONDAY_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Monday MCP server

Pick the path that matches the account's posture. Path A is preferred.

### Path A (preferred) — hosted first-party MCP with bearer token

Register with a placeholder, then sed-inject the real token. The header value Hermes
writes to `config.yaml` must be `Bearer ${MCP_MONDAY_API_KEY}` (literal word `Bearer`
plus a space, then the env-var indirection). Monday's hosted server rejects a bare token.

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nBearer placeholder\n' | \
    hermes mcp add monday \
      --url 'https://mcp.monday.com/mcp' \
      --auth header
"
```

Confirm the header line was written correctly (must show `Bearer ${MCP_MONDAY_API_KEY}`):

```bash
ssh "$VPS_USER@$VPS_IP" "
  CFG=\$(hermes config path 2>/dev/null || echo ~/.hermes/config.yaml)
  grep -iA3 '^  monday:' \"\$CFG\"
"
```

If the registered header value is the raw `${MCP_MONDAY_API_KEY}` without the `Bearer `
prefix, fix it in place (pipe delimiter):

```bash
ssh "$VPS_USER@$VPS_IP" "
  CFG=\$(hermes config path 2>/dev/null || echo ~/.hermes/config.yaml)
  sed -i 's|Authorization: \\\${MCP_MONDAY_API_KEY}|Authorization: Bearer \\\${MCP_MONDAY_API_KEY}|' \"\$CFG\"
"
```

**Optional — pin the Monday API version.** Monday versions its GraphQL API by date.
The hosted MCP accepts an `Api-Version` header (e.g. `2025-07`). Add it only if needed:

```yaml
monday:
  url: https://mcp.monday.com/mcp
  headers:
    Authorization: Bearer ${MCP_MONDAY_API_KEY}
    Api-Version: "2025-07"
  enabled: true
```

Edit the non-secret version string in `config.yaml`; never hand-edit the secret there.

### Path B (fallback) — official stdio MCP or raw REST

Use this only if the account cannot enable the marketplace app (admin policy).

**B1 — official stdio MCP server (still first-party):** `@mondaydotcomorg/monday-api-mcp`
reads the token from env var `MONDAY_TOKEN` (no `MCP_` prefix, no `Bearer`):

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MONDAY_TOKEN '$MONDAY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add monday \
    --command npx \
    --args '-y,@mondaydotcomorg/monday-api-mcp' \
    --env 'MONDAY_TOKEN=\${MONDAY_TOKEN}'
"
```

Source: <https://github.com/mondaycom/mcp>

**B2 — raw REST/GraphQL via a generic HTTP tool:**

- **Base URL:** `https://api.monday.com/v2`
- **Method:** `POST` with body `{"query":"..."}`
- **Auth header:** `Authorization: <token>` — **NO `Bearer ` prefix** (this is the REST
  API's contract; differs from the hosted MCP)
- **Content type:** `Content-Type: application/json`

Docs: <https://developer.monday.com/api-reference/docs/authentication>

Do NOT claim Path B1 token storage alone wires Monday into the agent — it only
authenticates direct API calls.

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
       | grep -qiE "registered.*tool.*monday|MCP server.*monday.*(ok|ready|HTTP)"; then
    REGISTERED=1
    echo "OK: monday registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: monday not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success looks like `MCP server 'monday' (HTTP): registered N tool(s): ...`.

---

## Step 8 — live API smoke test

This calls the REST API directly to prove the token itself is live. Remember: REST uses
the **raw token, no Bearer**. The hosted MCP uses `Bearer <token>` (already wired in Step 5).

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://api.monday.com/v2' \
    -H \"Authorization: \$MCP_MONDAY_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"{ me { id name } }\"}'
")
case "$HTTP" in
  200) echo "OK: Monday API reachable and token valid." ;;
  401) echo "FAIL: token invalid, expired, or sent with stray Bearer prefix. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but user lacks board access. Use a service/ops user."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Monday API. Check manually." ;;
esac
```

A `200` with `error_code: "ComplexityException"` in the body means rate-limited, not
broken — Pitfall 7.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove monday 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_MONDAY_API_KEY 2>/dev/null || \
    sed -i '/^MCP_MONDAY_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MONDAY_TOKEN 2>/dev/null || \
    sed -i '/^MONDAY_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Monday is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Two different auth shapes (MCP vs REST) | Hosted MCP needs `Authorization: Bearer <token>`; REST `api.monday.com/v2` needs `Authorization: <token>` with NO `Bearer` | Bearer for MCP (Step 5/A), raw for REST (Step 5/B2, Step 8) |
| 2 | Marketplace app not installed | Hosted MCP won't authorize the account even with a valid token | Admin installs the Monday MCP app: <https://monday.com/marketplace/listing/10000806/monday-mcp> |
| 3 | Token permissions mirror minting user | V2 personal token only sees what that user sees in UI; agent gets 403/empty on private boards | Mint with a service/ops user that has the right board access |
| 4 | OAuth instead of static token | Per-user OAuth breaks unattended-agent operation | Use static personal token; only fall to OAuth if policy forbids personal tokens |
| 5 | Token regenerated in Monday UI | Old token invalidates instantly -> agent 401s | Re-run Step 4 (re-inject) and Step 6 (gateway reload) |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | GraphQL complexity budget exceeded | Heavy board reads return `ComplexityException` | Workflows page results; request only needed columns, not whole boards |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 9 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, env-var indirection in `config.yaml` |
| 10 | sed with `/` delimiter on tokens | Monday tokens are JWT-like with `/ + = .` | Always use `\|` delimiter |
| 11 | Container vs host confusion | Running `hermes` inside container vs on host hits different `.env` | Step 1 detects which layer and uses it consistently |
| 12 | Skipping the log verify | Silent success — config written, never picked up by gateway | Step 7 polls up to 30s; rollback on failure |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Admin installed the Monday MCP marketplace app for the account
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_MONDAY_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` shows `Authorization: Bearer ${MCP_MONDAY_API_KEY}` (Bearer prefix, env indirection)
- [ ] MCP registered via Path A (hosted) or Path B (stdio/REST) documented
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'monday'` within 30s
- [ ] Smoke test: `POST https://api.monday.com/v2 { me { id name } }` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
