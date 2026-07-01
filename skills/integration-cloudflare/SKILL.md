---
name: integration-cloudflare
description: Connect Cloudflare (DNS, Workers, KV, R2, D1, Pages, Access, Cloudflare One) to a self-hosted Hermes Agent over SSH. Wires Cloudflare's first-party remote MCP server with a static API token as bearer auth. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-cloudflare — connect Cloudflare to a remote Hermes (SSH-first)

You are the engineer connecting Cloudflare to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint a scoped API token in the Cloudflare dashboard.
2. Hand back the token once (it is shown a single time).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Cloudflare ships a **first-party remote MCP**
at `https://mcp.cloudflare.com/mcp` that exposes Workers, KV, R2, D1, Pages, DNS, Firewall,
Load Balancers, Stream, Images, AI Gateway, Vectorize, Access, and Gateway (Cloudflare One).
It supports **OAuth (interactive)** and a **static API token** as a bearer header. A
headless Hermes cannot complete the OAuth redirect, so we wire the bearer-token path. The
hosted endpoint is the only path — there is **no npm package** to self-host.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$CLOUDFLARE_TOKEN` | Scoped API token (often `cfut_...` for new scannable format) | <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → custom token; include `Account Resources: Read` (for account auto-detect) plus the scopes the agent needs (e.g. `Zone : DNS : Edit`, `Account : Workers Scripts : Edit`, `Access : Apps and Policies : Edit`). Shown **once** — copy immediately. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci cloudflare" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Cloudflare is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_CLOUDFLARE_API_KEY (length ${#CLOUDFLARE_TOKEN}, prefix ${CLOUDFLARE_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add cloudflare --url https://mcp.cloudflare.com/mcp --auth-header Authorization --auth-scheme Bearer
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*cloudflare"
  6. Smoke test: GET https://api.cloudflare.com/client/v4/user/tokens/verify → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

Hermes derives the env var name from the MCP server name (`cloudflare` →
`MCP_CLOUDFLARE_API_KEY`). Write it via `hermes config set`, never `echo >>`.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_CLOUDFLARE_API_KEY '$CLOUDFLARE_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_CLOUDFLARE_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_CLOUDFLARE_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter because tokens may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_CLOUDFLARE_API_KEY=' ~/.hermes/.env || printf 'MCP_CLOUDFLARE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_CLOUDFLARE_API_KEY=.*|MCP_CLOUDFLARE_API_KEY=$CLOUDFLARE_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Cloudflare MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred —
Cloudflare's first-party remote MCP is the supported automation path.

### Path A (preferred) — first-party remote MCP with bearer auth

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add cloudflare \
    --url 'https://mcp.cloudflare.com/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject the real token with pipe delimiter (Cloudflare tokens are alnum today but
# the pattern is safe for any future token format with /+=).
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$CLOUDFLARE_TOKEN\"'|g' ~/.hermes/config.yaml"
```

After registration `config.yaml` should reference the env var, never the raw token:

```yaml
cloudflare:
  url: https://mcp.cloudflare.com/mcp
  headers:
    Authorization: Bearer ${MCP_CLOUDFLARE_API_KEY}
  enabled: true
```

Use the streamable HTTP endpoint `/mcp`, **never** the deprecated `/sse`. The probe matrix
in `/hermes-mcp-add` will confirm bearer-header is the variant that returns `tools/list`;
path-token, query-token, and `X-API-Key` variants will fail.

### Path B (fallback) — generic HTTP tool against the Cloudflare REST API

If the Hermes build is stdio-only or cannot reach `mcp.cloudflare.com`:

- **Base URL:** `https://api.cloudflare.com/client/v4`
- **Auth header:** `Authorization: Bearer ${MCP_CLOUDFLARE_API_KEY}`
- **Content type:** `Content-Type: application/json`
- Cloudflare also ships product-specific remote MCPs for narrower tool surfaces:
  `https://dns-analytics.mcp.cloudflare.com/mcp`, `https://casb.mcp.cloudflare.com/mcp` —
  same bearer-token wiring, just swap the URL.

Do NOT try to connect a fresh client to `https://mcp.cloudflare.com/mcp` without the
bearer header — it triggers an interactive OAuth redirect that a headless agent cannot
complete and the agent will stall.

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

Cloudflare's server publishes many tools, so expect a large count.

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*cloudflare|MCP server.*cloudflare.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: cloudflare registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: cloudflare not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (token validity check)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.cloudflare.com/client/v4/user/tokens/verify' \
    -H \"Authorization: Bearer \$MCP_CLOUDFLARE_API_KEY\" \
    -H 'Content-Type: application/json'
")
case "$HTTP" in
  200) echo "OK: token is active. Cloudflare API reachable." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but scope missing. Re-mint with the needed permissions."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from /user/tokens/verify. Check manually." ;;
esac
```

`200` returns `{"result":{"status":"active"}, ... "success":true}`. A real chat call like
`@<agent> using cloudflare, list the DNS records for <zone>` confirms end-to-end wiring;
`Authentication error` means the token didn't land (re-check Step 4) or the token lacks
the needed scope.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove cloudflare 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_CLOUDFLARE_API_KEY 2>/dev/null || \
    sed -i '/^MCP_CLOUDFLARE_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Cloudflare is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Connecting `mcp.cloudflare.com/mcp` without a bearer header | Server falls back to OAuth redirect; headless agent stalls | Always send `Authorization: Bearer <token>`; never let it auto-OAuth |
| 2 | Token scope too narrow — tools register but calls return 403 | Server exposes only what the token permits | Mint with `Account Resources: Read` plus the specific edit scopes the agent needs |
| 3 | Account-scoped tools return 404 on account ID | Token is missing `Account Resources: Read` (used to auto-detect the account) | Re-mint with `Account Resources: Read` |
| 4 | Token shown once, then lost | Cloudflare never re-reveals API tokens | Roll a new token in the dashboard and re-inject via Step 4 |
| 5 | Using Global API Key or all-scopes token | Catastrophic blast radius if leaked | Least privilege: scope to specific zones/products; add IP filter or TTL in dashboard |
| 6 | Hitting deprecated `/sse` endpoint | Cloudflare moved to streamable HTTP at `/mcp` | Always use `https://mcp.cloudflare.com/mcp` |
| 7 | Trying to self-host the server | There is no npm package — Cloudflare ships hosted only | Use the hosted endpoint, or product-specific remote MCPs (`dns-analytics.mcp.cloudflare.com`, `casb.mcp.cloudflare.com`) for narrower surfaces |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline; SSH silently rejects merged keys / runtime ignores merged env | Always `hermes config set` |
| 10 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`; `config.yaml` references `${MCP_CLOUDFLARE_API_KEY}` |
| 11 | sed with `/` delimiter on tokens | Future token formats may contain `/+=` | Always use `\|` delimiter |
| 12 | Container vs host confusion | Adding keys / running config inside a container loses them | Always check `whoami; hostname` first — exit container if hex hostname |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_CLOUDFLARE_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `config.yaml` references `Bearer ${MCP_CLOUDFLARE_API_KEY}` only — no raw token anywhere
- [ ] MCP registered via Path A (remote MCP, bearer) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'cloudflare'` within 30s
- [ ] Smoke test: `GET /user/tokens/verify` returned `200` with `"status":"active"`
- [ ] Token is scoped to least privilege (specific zones/products), not a Global API Key
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
