---
name: integration-freshdesk
description: Connect Freshdesk (SMB support tickets, contacts, companies) to a self-hosted Hermes Agent over SSH using a static API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI when Hermes needs to triage, read, create, or update Freshdesk tickets.
---

# /integration-freshdesk — connect Freshdesk to a remote Hermes (SSH-first)

You are the engineer connecting Freshdesk to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not the local
machine. The user only does the two things a machine cannot:

1. Mint the Freshdesk API key in the UI (captcha required).
2. Confirm the Freshdesk plan / EAP enrollment for the first-party MCP.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Freshdesk ships a **first-party remote MCP
server** at `https://<domain>.freshdesk.com/mcp`. It is in **Early Access Program (EAP)**,
restricted to **Enterprise plan** accounts, with a 100 calls/min and 5,000 calls/month cap
during EAP. Auth is the raw Freshdesk **API key** in the `Authorization` header —
**no `Bearer ` prefix** (Freshworks docs are explicit on this). The v2 REST API stays
available on every plan and uses HTTP Basic auth (API key as username, literal `X` as
password); use it as the Path B fallback when the MCP EAP is not granted. Community
servers (`effytech/freshdesk_mcp`, `NeuraLegion/freshdesk_mcp`) exist but are local stdio
and not maintained by Freshworks — not recommended.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$FRESHDESK_DOMAIN` | Subdomain prefix (e.g. `acme` for `acme.freshdesk.com`) | Freshdesk admin URL |
| `$FRESHDESK_API_KEY` | Static API key for the integration agent | Log in as the owning agent → profile picture (top right) → **Profile Settings** → right pane **View API key** → complete the captcha → copy. Agent MUST be verified or the field is hidden. |
| Plan / EAP status | Enterprise + EAP grant for first-party MCP | Confirm with the Freshworks TAM or `support@freshdesk.com`. If not granted, skip to Path B. |

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

Expected: a version string like `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci freshdesk" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Freshdesk is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write FRESHDESK_API_KEY (length ${#FRESHDESK_API_KEY}, prefix ${FRESHDESK_API_KEY:0:4}...) via 'hermes config set'
  2. Write FRESHDESK_DOMAIN=${FRESHDESK_DOMAIN} via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Path A (Enterprise + EAP): register MCP at https://${FRESHDESK_DOMAIN}.freshdesk.com/mcp
     - Patch config.yaml to strip 'Bearer ' from Authorization header
     OR
     Path B (any plan): document REST base https://${FRESHDESK_DOMAIN}.freshdesk.com/api/v2
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*freshdesk"
  7. Smoke test: GET /api/v2/tickets?per_page=1 → expect 200

The API key is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set FRESHDESK_API_KEY '$FRESHDESK_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set FRESHDESK_DOMAIN '$FRESHDESK_DOMAIN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify both vars landed (returns `1` for each, NEVER the value):

```bash
WROTE_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^FRESHDESK_API_KEY=' ~/.hermes/.env" || echo 0)
WROTE_DOM=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^FRESHDESK_DOMAIN=' ~/.hermes/.env" || echo 0)
[ "$WROTE_KEY" = "1" ] && [ "$WROTE_DOM" = "1" ] \
  || { echo "FAIL: secret(s) not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — Freshdesk API keys are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^FRESHDESK_API_KEY=' ~/.hermes/.env || printf 'FRESHDESK_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^FRESHDESK_API_KEY=.*|FRESHDESK_API_KEY=$FRESHDESK_API_KEY|' ~/.hermes/.env
>   grep -q '^FRESHDESK_DOMAIN=' ~/.hermes/.env || printf 'FRESHDESK_DOMAIN=\n' >> ~/.hermes/.env
>   sed -i 's|^FRESHDESK_DOMAIN=.*|FRESHDESK_DOMAIN=$FRESHDESK_DOMAIN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server (or REST endpoint if EAP not granted)

Pick the path that matches the account. Path A is preferred when EAP is live.

### Path A (preferred, Enterprise + EAP) — first-party remote MCP

Endpoint: `https://${FRESHDESK_DOMAIN}.freshdesk.com/mcp`
Auth shape: header `Authorization: <api-key>` — **no `Bearer ` prefix**.

Before registering, sanity-check the MCP endpoint from the VPS with a `tools/list` probe.
`200` with a JSON-RPC `result` means EAP is live and the key is good. `401` / `403` means
EAP is not granted on this account — switch to Path B. `404` means the subdomain is wrong.

```bash
PROBE=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /tmp/fd_probe -w '%{http_code}' \
    -X POST 'https://${FRESHDESK_DOMAIN}.freshdesk.com/mcp' \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: \$FRESHDESK_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'
")
case "$PROBE" in
  200) echo "OK: EAP live; proceeding with Path A." ;;
  401|403) echo "EAP not granted; switching to Path B."; PATH_B=1 ;;
  404) echo "FAIL: subdomain wrong. Check FRESHDESK_DOMAIN."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $PROBE; check manually." ;;
esac
```

If `PATH_B` is unset, register the MCP server:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add freshdesk \
    --url 'https://${FRESHDESK_DOMAIN}.freshdesk.com/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme '' \
    --placeholder-token 'placeholder'
"
```

Hermes' default header template is `Bearer ${MCP_FRESHDESK_API_KEY}`. Freshdesk rejects
that — strip the `Bearer ` so only the raw key is sent (use `|` as the sed delimiter):

```bash
ssh "$VPS_USER@$VPS_IP" "
  sed -i 's|Authorization: Bearer \${MCP_FRESHDESK_API_KEY}|Authorization: \${MCP_FRESHDESK_API_KEY}|' \
    ~/.hermes/config.yaml
"
```

Inject the real key into the MCP indirection var (pipe delimiter; tokens may contain `/+=`):

```bash
ssh "$VPS_USER@$VPS_IP" "
  grep -q '^MCP_FRESHDESK_API_KEY=' ~/.hermes/.env || printf 'MCP_FRESHDESK_API_KEY=\n' >> ~/.hermes/.env
  sed -i 's|^MCP_FRESHDESK_API_KEY=.*|MCP_FRESHDESK_API_KEY=$FRESHDESK_API_KEY|' ~/.hermes/.env
  chmod 600 ~/.hermes/.env
"
```

### Path B (fallback, any plan) — Freshdesk v2 REST API as a generic HTTP tool

When EAP is not granted, use the REST API directly via the agent's generic HTTP tool
capability:

- **Base URL:** `https://${FRESHDESK_DOMAIN}.freshdesk.com/api/v2`
- **Auth:** HTTP Basic with API key as username, literal `X` as password
  → header `Authorization: Basic $(printf '%s:X' "$FRESHDESK_API_KEY" | base64)`
- **Content type:** `Content-Type: application/json`
- **Common endpoints:** `GET /tickets`, `GET /tickets/{id}`, `POST /tickets`,
  `PUT /tickets/{id}`, `GET /tickets/{id}/conversations`, `POST /tickets/{id}/reply`,
  `GET /contacts`, `GET /companies`, `GET /agents`, `GET /search/tickets?query="..."`.
- **Rate limits per plan:** Trial 50/min, Growth 200/min, Pro 400/min, Enterprise 700/min.
  Read `X-RateLimit-Remaining` and back off on `429`.

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

Skip this step entirely on Path B (no MCP registered; smoke test in Step 8 is the proof).

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*freshdesk|MCP server.*freshdesk.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: freshdesk registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: freshdesk not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the key stays on the VPS)

Hits the REST API regardless of which path was used — that's the universal proof the key
and domain are correct.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -u \"\$FRESHDESK_API_KEY:X\" \
    -H 'Content-Type: application/json' \
    'https://\$FRESHDESK_DOMAIN.freshdesk.com/api/v2/tickets?per_page=1'
")
case "$HTTP" in
  200) echo "OK: Freshdesk API reachable and key valid." ;;
  401) echo "FAIL: key invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: key valid but agent role cannot list tickets. Use an admin or scoped agent."; exit 1 ;;
  404) echo "FAIL: subdomain wrong. Check FRESHDESK_DOMAIN."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Freshdesk API. Check manually." ;;
esac
```

`200` with an empty `[]` is still a pass for wiring — it just means there are no tickets.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove freshdesk 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset FRESHDESK_API_KEY 2>/dev/null || \
    sed -i '/^FRESHDESK_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_FRESHDESK_API_KEY 2>/dev/null || \
    sed -i '/^MCP_FRESHDESK_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset FRESHDESK_DOMAIN 2>/dev/null || \
    sed -i '/^FRESHDESK_DOMAIN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Freshdesk is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer <key>` to the Freshdesk MCP | Freshworks docs require the raw key, no `Bearer ` prefix. Returns 401. | Patch `config.yaml` to drop `Bearer ` (Step 5 Path A). |
| 2 | Wiring MCP on a non-Enterprise plan or non-EAP account | EAP is gated; endpoint returns 403 or 404. | Probe `tools/list` first; on 401/403 switch to Path B. |
| 3 | Using a key from an unverified agent | UI hides the API key until the agent is verified. | Verify the agent email first, then mint the key. |
| 4 | API key inherits the agent's role | A restricted-scope agent silently 403s on tickets it cannot see. | Mint from an admin or a dedicated integration agent with the needed scope. |
| 5 | Subdomain typo in URL | `acme.freshdesk.com` vs `acme-help.freshdesk.com` returns 404 / wrong tenant. | Confirm the exact subdomain from the Freshdesk admin URL. |
| 6 | Hitting per-minute rate limits | Bulk syncs exceed plan cap (50-700/min) or EAP cap (100/min, 5000/month). | Honor `X-RateLimit-Remaining`; back off on `429`; batch via search. |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the safe `printf` + sed fallback) |
| 9 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 10 | sed with `/` delimiter on tokens | Tokens may contain `/+=` and break sed | Always use `\|` delimiter |
| 11 | Container vs host confusion | Skill assumed wrong layer; key invisible to sshd | Step 1's `docker exec` fallback handles it; always check `whoami; hostname` if debugging |
| 12 | Skipping the verify step | "Silent success" — config written, never picked up | Step 7 polls logs; Step 8 hits the API |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `FRESHDESK_API_KEY` and `FRESHDESK_DOMAIN` written to `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Freshdesk connected via Path A (MCP tools registered, EAP confirmed, no `Bearer ` prefix) or Path B (REST base documented and reachable)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'freshdesk'` within 30s (Path A only)
- [ ] Smoke test: `GET /api/v2/tickets?per_page=1` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
