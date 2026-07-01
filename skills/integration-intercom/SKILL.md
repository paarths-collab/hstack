---
name: integration-intercom
description: Connect Intercom (support inbox, conversations, contacts) to a self-hosted Hermes Agent over SSH using the official remote MCP server with a static Access Token. Use when the user wants Hermes to search, read, or triage Intercom conversations and contact data. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-intercom — connect Intercom to a remote Hermes (SSH-first)

You are the engineer connecting Intercom to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not locally.

The user only does the two things a machine cannot: minting the Access Token in the
Intercom Developer Hub and confirming which region (US / EU / AU) their workspace lives in.

**Honest auth picture (verified 2026-06):** Intercom ships an official **remote MCP server**
at `https://mcp.intercom.com/mcp` that accepts both OAuth and Bearer-token auth (see
<https://developers.intercom.com/docs/guides/mcp>). Static Bearer is the headless-friendly
path, so we wire it through the standard SSH-first pattern. Two real constraints from
Intercom's docs:

1. The MCP is **read-focused** (search and retrieval of conversations/contacts, not writes).
2. The MCP currently supports **US-hosted Intercom workspaces only**. EU and AU workspaces
   must fall back to the REST API path (Path B in Step 5).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$INTERCOM_TOKEN` | Workspace Access Token | <https://app.intercom.com/a/developer-signup> → Developer Hub → **Your Apps** → click the app → **Configure → Authentication** → copy the Access Token. Internal/private app shape. |
| `$INTERCOM_REGION` | `us`, `eu`, or `au` | Intercom Settings → Workspace → **Data hosting**. US unlocks the MCP path; EU/AU forces the REST path. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci intercom" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Intercom is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP (region: $INTERCOM_REGION):
  1. Write INTERCOM_ACCESS_TOKEN (length ${#INTERCOM_TOKEN}, prefix ${INTERCOM_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. If region=us  → Register MCP: hermes mcp add intercom --url https://mcp.intercom.com/mcp
     If region=eu|au → Document REST surface (Path B); no MCP registration.
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*intercom" (US only)
  6. Smoke test: GET https://api.intercom.io/me → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set INTERCOM_ACCESS_TOKEN '$INTERCOM_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^INTERCOM_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: INTERCOM_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern. Intercom
> Access Tokens can contain `/`, `+`, `=` — always use the `|` delimiter, never `/`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^INTERCOM_ACCESS_TOKEN=' ~/.hermes/.env || printf 'INTERCOM_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^INTERCOM_ACCESS_TOKEN=.*|INTERCOM_ACCESS_TOKEN=$INTERCOM_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server (or REST endpoint if no MCP exists)

Pick the path that matches the workspace region.

### Path A (preferred) — official remote MCP for US workspaces

First probe the MCP endpoint to confirm the token is accepted and the workspace is US-hosted.
A `result.tools` array (search_conversations, list_conversations, get_contact, etc.) means
the token works. A 4xx or "unsupported region" error means the workspace is not US — fall
back to Path B.

```bash
ssh "$VPS_USER@$VPS_IP" "
  URL=https://mcp.intercom.com/mcp
  H='Accept: application/json, text/event-stream'
  C='Content-Type: application/json'
  INIT='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'
  curl -sS -D /tmp/intercom_headers -o /tmp/intercom_init \
    -X POST -H \"\$H\" -H \"\$C\" -H \"Authorization: Bearer \$INTERCOM_ACCESS_TOKEN\" -d \"\$INIT\" \"\$URL\"
  SID=\$(grep -i mcp-session-id /tmp/intercom_headers | tr -d '\r' | awk '{print \$2}')
  curl -sS \
    -X POST -H \"\$H\" -H \"\$C\" -H \"Mcp-Session-Id: \$SID\" \
    -H \"Authorization: Bearer \$INTERCOM_ACCESS_TOKEN\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}' \"\$URL\"
"
```

Register with the placeholder pattern, then inject the real token via `sed` with `|`
delimiter (Intercom tokens can contain `/`, `+`, `=`):

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    hermes mcp add intercom \
      --url 'https://mcp.intercom.com/mcp' \
      --auth header
  sed -i 's|placeholder|'\"\$INTERCOM_ACCESS_TOKEN\"'|g' ~/.hermes/config.yaml
"
```

The resulting `config.yaml` block should read:

```yaml
intercom:
  url: https://mcp.intercom.com/mcp
  headers:
    Authorization: Bearer ${INTERCOM_ACCESS_TOKEN}
  enabled: true
```

### Path B (fallback) — REST API for EU/AU workspaces (or if MCP refuses)

Intercom's MCP does not yet serve EU/AU workspaces. The token written in Step 4 is enough;
document the REST surface for a generic HTTP tool. Do NOT try to register
`https://mcp.intercom.com/mcp` with an EU/AU token — that endpoint rejects non-US tokens.

REST surface:

- **Base URL:** `https://api.intercom.io` (US), `https://api.eu.intercom.io` (EU), `https://api.au.intercom.io` (AU)
- **Auth header:** `Authorization: Bearer ${INTERCOM_ACCESS_TOKEN}`
- **Version header:** `Intercom-Version: 2.11` (pin explicitly — unversioned calls drift)
- **Content type:** `Content-Type: application/json`
- **Accept:** `Accept: application/json`

Common endpoints:

- `GET /me` — token sanity check, returns the app/workspace
- `POST /conversations/search` — search conversations by state, assignee, tags, custom attrs
- `GET /conversations/{id}` — fetch a single conversation with parts
- `POST /contacts/search` — search contacts
- `GET /contacts/{id}` — fetch a contact
- `POST /conversations/{id}/reply` — only if your Access Token has write scope

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

US / Path A only. Skip this step for EU/AU REST-only deployments and rely on Step 8.

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*intercom|MCP server.*intercom.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: intercom registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: intercom not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test

Choose the right base URL for the region. Runs against `GET /me` — the cheapest valid
authenticated call.

```bash
case "$INTERCOM_REGION" in
  us) BASE=https://api.intercom.io ;;
  eu) BASE=https://api.eu.intercom.io ;;
  au) BASE=https://api.au.intercom.io ;;
  *)  BASE=https://api.intercom.io ;;
esac

HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: Bearer \$INTERCOM_ACCESS_TOKEN\" \
    -H 'Intercom-Version: 2.11' \
    -H 'Accept: application/json' \
    '$BASE/me'
")
case "$HTTP" in
  200) echo "OK: Intercom API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing scope. Check the app's Authentication tab."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Intercom API. Check manually." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove intercom 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset INTERCOM_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^INTERCOM_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Intercom is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trying the MCP from an EU or AU workspace | Intercom MCP is US-only as of 2026-06; endpoint rejects non-US tokens | Check region in Settings, fall back to REST (Path B) |
| 2 | Expecting write tools from the MCP | The MCP is read-focused (search/retrieve). Replying/closing requires REST | Use REST `POST /conversations/{id}/reply` for writes |
| 3 | Missing `Intercom-Version` header on REST | Intercom rolls API versions; unversioned calls drift silently | Always send `Intercom-Version: 2.11` (or current) |
| 4 | Sharing the Access Token with a third-party app | Intercom explicitly forbids this — third-party apps must use OAuth | Use the token only for your own Hermes agent; rotate if leaked |
| 5 | Hitting Intercom rate limits | Default is 83 req/10s per workspace; bursts return `429` | Backoff on `429`, prefer search over per-record loops |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 8 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 9 | sed with `/` delimiter on tokens | Intercom tokens contain `/+=`; sed breaks | Use `\|` delimiter |
| 10 | Container vs host confusion | Skill assumed wrong layer; key/secret invisible | Always check `whoami; hostname` first |
| 11 | Wrong regional base URL on REST | `api.intercom.io` returns auth errors for EU/AU tokens | Use `api.eu.intercom.io` / `api.au.intercom.io` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `INTERCOM_ACCESS_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] US workspaces: MCP registered at `https://mcp.intercom.com/mcp` via Path A
- [ ] EU/AU workspaces: REST base URL, `Intercom-Version`, and Bearer header documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] US only: logs show `registered N tool(s) for 'intercom'` within 30s
- [ ] Smoke test: `GET /me` against the regional base URL returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
