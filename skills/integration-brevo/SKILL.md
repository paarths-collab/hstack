---
name: integration-brevo
description: Connect Brevo (formerly Sendinblue) email, SMS, and CRM marketing to a self-hosted Hermes agent over SSH using Brevo's first-party remote MCP server. Use when the user wants any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI) to send campaigns, manage contacts, run automations, or read marketing analytics. Idempotent and rollback-safe.
---

# /integration-brevo — connect Brevo to a remote Hermes (SSH-first)

You are the engineer connecting Brevo to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the MCP-enabled API key in the Brevo UI.
2. Validate the sender address or sending domain that campaigns will originate from.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Brevo ships an official first-party **remote
HTTP MCP server** at `https://mcp.brevo.com/v1/brevo/mcp` that accepts a static **bearer
MCP token** (no OAuth required). That is the headless-friendly path and the one this skill
uses. A plain REST API key created without the MCP option will return `401` against the
MCP endpoint — the key must be minted with the **MCP** checkbox enabled. See
<https://developers.brevo.com/docs/mcp-protocol>.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$BREVO_TOKEN` | MCP-enabled API key | Brevo dashboard: **Account → SMTP & API → API Keys → Generate a new API key**, then **check the MCP option** before saving. Copy immediately; Brevo will not show it again. |
| Validated sender | At least one verified sender address or authenticated domain | Brevo: **Senders, Domains & Dedicated IPs → Senders** |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci brevo" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Brevo is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_BREVO_API_KEY (length ${#BREVO_TOKEN}, prefix ${BREVO_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add brevo --url https://mcp.brevo.com/v1/brevo/mcp --auth header
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*brevo"
  6. Smoke test: POST https://mcp.brevo.com/v1/brevo/mcp initialize → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_BREVO_API_KEY '$BREVO_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_BREVO_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_BREVO_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Brevo MCP tokens are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_BREVO_API_KEY=' ~/.hermes/.env || printf 'MCP_BREVO_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_BREVO_API_KEY=.*|MCP_BREVO_API_KEY=$BREVO_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Brevo MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — Brevo's first-party remote HTTP MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add brevo \
    --url 'https://mcp.brevo.com/v1/brevo/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --auth-value '\${MCP_BREVO_API_KEY}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first
and match its HTTP-MCP syntax. The token stays in `~/.hermes/.env` and is referenced via
`${MCP_BREVO_API_KEY}` indirection — never inlined into `config.yaml`.

If your Hermes build only supports placeholder-then-inject (older builds), use:

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    hermes mcp add brevo --url 'https://mcp.brevo.com/v1/brevo/mcp' --auth header
"
# No sed-into-config.yaml — the token already lives in ~/.hermes/.env from Step 4.
# The placeholder will resolve from MCP_BREVO_API_KEY at gateway runtime.
```

### Path B (fallback) — generic HTTP tool against the Brevo REST API

If the Hermes build is stdio-MCP-only or cannot reach `mcp.brevo.com`:

- **Base URL:** `https://api.brevo.com/v3`
- **Auth header:** `api-key: ${MCP_BREVO_API_KEY}` (NOT `Authorization: Bearer` — REST uses a different scheme than MCP)
- **Content type:** `Content-Type: application/json`
- **Common endpoints:** `/account`, `/contacts`, `/emailCampaigns`, `/smtp/email`

Do NOT mix the headers — `Authorization: Bearer` belongs on `mcp.brevo.com`,
`api-key:` belongs on `api.brevo.com`. The same secret value works on both endpoints
when the key was minted with the MCP option, but the header name differs.

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
       | grep -qiE "registered.*tool.*brevo|MCP server.*brevo.*(ok|ready|registered)"; then
    REGISTERED=1
    echo "OK: brevo registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: brevo not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://mcp.brevo.com/v1/brevo/mcp' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: Bearer \$MCP_BREVO_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"verify\",\"version\":\"0\"}}}'
")
case "$HTTP" in
  200) echo "OK: Brevo MCP reachable and token valid." ;;
  401) echo "FAIL: token invalid or missing MCP option. Re-mint with MCP checkbox enabled."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but scope/plan does not permit MCP."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Brevo MCP. Check manually." ;;
esac
```

A `200` from `initialize` proves the handshake works, but Brevo (like most servers)
enforces auth on `tools/call`, not just `initialize`. For a stronger check, follow the
session-id flow and call `tools/list` — a populated `tools` array is the real proof.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove brevo 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_BREVO_API_KEY 2>/dev/null || \
    sed -i '/^MCP_BREVO_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Brevo is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using a plain REST API key against `mcp.brevo.com` | Brevo keys must have the **MCP** option checked at creation; plain v3 keys return `401` on the MCP endpoint | Re-mint with the MCP checkbox enabled |
| 2 | Confusing the REST API header with the MCP header | REST uses `api-key: <key>` against `https://api.brevo.com/v3`; MCP uses `Authorization: Bearer <token>` against `https://mcp.brevo.com/v1/brevo/mcp` | Use bearer header only for the MCP path; `api-key` only for `api.brevo.com` |
| 3 | Sending campaigns from an unverified sender | Brevo rejects sends from non-validated senders, even with a valid token | Validate the sender / authenticate the domain in Brevo before first send |
| 4 | Treating `initialize` success as proof | Handshake is often open; auth is enforced on `tools/call` | Run a `tools/list` probe with `Mcp-Session-Id` to confirm |
| 5 | Rate limits | Brevo throttles per-account; bursts get `429` | Backoff on `429`; chunk contact imports |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline → key is silently invalid | Always `hermes config set` (or the safe sed pattern with pipe delimiter) |
| 8 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600` |
| 9 | sed with `/` delimiter on tokens | Brevo MCP tokens are alnum today, but future tokens may include `/+=` | Always use `\|` delimiter |
| 10 | Container vs host confusion when running on the VPS | SSH-as-root lands on the host; `hermes` may live inside a docker container | Step 1 detects host vs container and dispatches `docker exec` automatically |
| 11 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_BREVO_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Sender address or sending domain validated in the Brevo UI
- [ ] MCP registered via Path A (`mcp.brevo.com`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'brevo'` within 30s
- [ ] Smoke test: `initialize` POST to `https://mcp.brevo.com/v1/brevo/mcp` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
