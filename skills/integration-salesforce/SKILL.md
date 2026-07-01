---
name: integration-salesforce
description: Connect Salesforce (enterprise CRM) to a self-hosted Hermes Agent over SSH. Path A — first-party hosted MCP (OAuth + PKCE, requires browser consent). Path B — headless REST via Client Credentials Flow (fully unattended, no MCP). Refuses to pretend a static token "connects" the hosted MCP. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-salesforce — connect Salesforce CRM to a remote Hermes (SSH-first)

You are the engineer connecting Salesforce to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does up to three things a machine cannot:

1. Create the External Client App (ECA) in Setup → App Manager with the right OAuth scopes
   (Path A) OR Client Credentials Flow + integration user (Path B).
2. For Path A only: complete the browser OAuth consent ONCE (refresh token then persists).
3. Confirm the org type (production vs sandbox/scratch) — changes the MCP URL prefix.

Everything else — secret storage, live token-exchange verify, gateway reload, smoke test —
runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Salesforce has a **first-party hosted MCP**
(GA April 2026), but it is **OAuth + PKCE ONLY** — Client Credentials Flow is explicitly
disabled for it; there is no static bearer token. So the choices are real:

- **Path A — official hosted MCP (OAuth + PKCE):** Salesforce-managed endpoint, full
  permission enforcement. Requires browser consent ONCE per user. After consent, refresh
  token persists; subsequent calls are headless.
- **Path B — headless REST via Client Credentials Flow:** zero browser interaction. Store
  the ECA client ID + secret; agent's HTTP tool layer exchanges them for short-lived access
  tokens at the org's `/services/oauth2/token` endpoint per call (no refresh token, so
  re-exchange is required). **No first-party MCP is wired here** — the secret alone does
  NOT connect anything; you also need an HTTP/REST tool that calls the Salesforce API.

Refusing pretense: this skill will NOT pretend a static-secret stored in env "connects"
Salesforce. Path A requires the OAuth dance. Path B documents the REST surface but is honest
that tool implementation lives elsewhere.

**Required edition:** Hosted MCP requires Enterprise Edition or above. Confirm before Path A.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WIRE_PATH` | `A` (hosted MCP, OAuth+PKCE — recommended) or `B` (REST, headless) | A needs browser consent ONCE; B is fully unattended |
| `$SF_INSTANCE_URL` | My Domain URL `https://<mydomain>.my.salesforce.com` | Setup → My Domain |
| `$SF_ORG_TYPE` | `production` or `sandbox` (used for Path A URL prefix) | Salesforce org type |
| `$SF_SERVER` *(Path A — optional, default `sobject-reads`)* | `sobject-reads` / `sobject-all` / `sobject-mutations` / `flows` / `invocable-actions` / `data-cloud-sql` / `tableau-next` / `prompt-builder` | https://developer.salesforce.com/docs/platform/hosted-mcp-servers/references/reference/servers-reference.html |
| `$SF_CLIENT_ID` | ECA consumer key (both paths) | Setup → App Manager → New External Client App → API (Enable OAuth Settings) → Consumer Key |
| `$SF_CLIENT_SECRET` | ECA consumer secret (both paths) | Same place — Consumer Secret |

Path A scopes on the ECA: **`mcp_api` AND `refresh_token`**. Supported Auth Flow:
**Authorization Code with PKCE**. Client Credentials Flow OFF.

Path B: ECA with **Client Credentials Flow ON** and an **integration (run-as) user**
assigned with the object permissions the agent needs.

Confirm SSH access:

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
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    HERMES="docker exec $AGENT hermes"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
  echo "Using: $HERMES"
  $HERMES --version
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
HAS_INSTANCE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SF_INSTANCE_URL=' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_CLIENT=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SF_CLIENT_ID=' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci salesforce" || echo 0)
if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY_MCP" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Salesforce MCP already wired (Path A). Set FORCE=1 to rewire."; exit 0
fi
if [ "${WIRE_PATH:-A}" = "B" ] && [ "$HAS_INSTANCE" = "1" ] && [ "$HAS_CLIENT" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Salesforce Client Credentials already wired (Path B). Set FORCE=1 to rewire."; exit 0
fi
```

---

## Step 3 — HARD GATE (per-path validation + live verification where possible)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

# Common: My Domain URL format
printf '%s' "$SF_INSTANCE_URL" | grep -qE '^https://[A-Za-z0-9-]+\.my\.salesforce\.com$' \
  || { echo "ABORT: SF_INSTANCE_URL must be 'https://<mydomain>.my.salesforce.com' (no trailing slash)."; exit 1; }

# Common: ECA secrets present
[ -n "$SF_CLIENT_ID" ] && [ -n "$SF_CLIENT_SECRET" ] \
  || { echo "ABORT: SF_CLIENT_ID and SF_CLIENT_SECRET are required for both paths."; exit 1; }
[ "${#SF_CLIENT_SECRET}" -ge 20 ] \
  || { echo "ABORT: SF_CLIENT_SECRET looks too short."; exit 1; }

if [ "$PATH_CHOSEN" = "A" ]; then
  SERVER=${SF_SERVER:-sobject-reads}
  case "${SF_ORG_TYPE:-production}" in
    production) MCP_URL="https://api.salesforce.com/platform/mcp/v1/$SERVER" ;;
    sandbox|scratch) MCP_URL="https://api.salesforce.com/platform/mcp/v1/sandbox/$SERVER" ;;
    *) echo "ABORT: SF_ORG_TYPE must be 'production' or 'sandbox'."; exit 1 ;;
  esac
  echo "Path A MCP URL: $MCP_URL (server: $SERVER)"

  # Note: cannot live-probe a PKCE OAuth MCP without browser consent.
  # The user must complete the consent in Step 6 (the one human step).
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  # Live Client Credentials exchange
  RESP=$(curl -sS --max-time 10 \
    -X POST "$SF_INSTANCE_URL/services/oauth2/token" \
    -d grant_type=client_credentials \
    -d "client_id=$SF_CLIENT_ID" \
    -d "client_secret=$SF_CLIENT_SECRET" 2>/dev/null) || true
  if printf '%s' "$RESP" | grep -q '"access_token"'; then
    echo "Salesforce Client Credentials Flow OK."
  elif printf '%s' "$RESP" | grep -q 'invalid_client\|inactive'; then
    echo "ABORT: Client Credentials Flow rejected. Ensure ECA has it enabled AND an integration user is assigned."
    echo "$RESP" | head -c 200
    exit 1
  else
    echo "ABORT: unexpected token response."
    echo "$RESP" | head -c 200
    exit 1
  fi
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write SF_INSTANCE_URL ($SF_INSTANCE_URL)
    2. Write SF_CLIENT_ID (length ${#SF_CLIENT_ID})
    3. Write SF_CLIENT_SECRET (length ${#SF_CLIENT_SECRET}) — NEVER plaintext-logged
    4. chmod 600 ~/.hermes/.env

  Path A (hosted MCP, OAuth+PKCE):
    5. Register MCP via /hermes-mcp-add at $MCP_URL with --auth oauth
    6. ONE-TIME: user follows browser consent URL (Salesforce prompts to authorize the ECA)
    7. Reload gateway: stop + run
    8. Verify in logs: grep "registered.*salesforce"

  Path B (REST via Client Credentials):
    5. No MCP server registered; generic HTTP tool re-mints access_token per call
    6. Reload gateway: stop + run
    7. Smoke test: token mint + SOQL "SELECT Id,Name FROM Account LIMIT 1"

ECA secret is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SF_INSTANCE_URL '$SF_INSTANCE_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SF_CLIENT_ID '$SF_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SF_CLIENT_SECRET '$SF_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(SF_INSTANCE_URL|SF_CLIENT_ID|SF_CLIENT_SECRET)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "3" ] || { echo "FAIL: secrets did not all land (got $COUNT, need 3). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put secrets in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A — hosted MCP with OAuth + PKCE

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add salesforce \
      --url '$MCP_URL' \
      --auth oauth \
      --oauth-client-id '\${SF_CLIENT_ID}' \
      --oauth-client-secret '\${SF_CLIENT_SECRET}' \
      --oauth-pkce
  "
  echo ""
  echo "ACTION REQUIRED: Hermes will print an authorization URL for the user."
  echo "Open it in a browser logged in as the desired Salesforce user."
  echo "Approve the External Client App. After approval, the refresh token persists."
  echo "Watch 'hermes logs gateway -f' for the consent URL and confirmation."
fi
```

### Path B — headless REST via Client Credentials Flow

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  echo "Path B: no MCP server registered. Generic HTTP/REST tool layer reads env vars."
  echo ""
  echo "Tool implementation contract (the generic HTTP tool layer must do, per call):"
  echo "  1. POST \$SF_INSTANCE_URL/services/oauth2/token"
  echo "     -d grant_type=client_credentials -d client_id=\$SF_CLIENT_ID -d client_secret=\$SF_CLIENT_SECRET"
  echo "  2. Parse access_token + instance_url from JSON response"
  echo "  3. Call REST: Authorization: Bearer <access_token>"
  echo "     e.g. GET \$instance_url/services/data/v60.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+5"
  echo "  4. Client Credentials returns NO refresh_token; re-mint on every expiry"
fi
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 12); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*salesforce|MCP server.*salesforce.*(ok|ready)"; then
      REGISTERED=1; echo "OK: salesforce MCP registered (consent completed)."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: salesforce not in logs after 60s. Did the user complete browser consent? Rolling back."; rollback; exit 1; }
fi

if [ "${WIRE_PATH:-A}" = "B" ]; then
  # Live REST smoke test from inside the container
  RECORDS=$(ssh "$VPS_USER@$VPS_IP" "
    . ~/.hermes/.env 2>/dev/null
    TOK=\$(curl -sS --max-time 10 -X POST \"\$SF_INSTANCE_URL/services/oauth2/token\" \
      -d grant_type=client_credentials \
      -d client_id=\"\$SF_CLIENT_ID\" \
      -d client_secret=\"\$SF_CLIENT_SECRET\" \
      | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')
    [ -z \"\$TOK\" ] && { echo NO_TOKEN; exit 0; }
    INST=\$(curl -sS --max-time 10 -X POST \"\$SF_INSTANCE_URL/services/oauth2/token\" \
      -d grant_type=client_credentials \
      -d client_id=\"\$SF_CLIENT_ID\" \
      -d client_secret=\"\$SF_CLIENT_SECRET\" \
      | sed -n 's/.*\"instance_url\":\"\\([^\"]*\\)\".*/\\1/p')
    curl -sS --max-time 10 -H \"Authorization: Bearer \$TOK\" \
      \"\$INST/services/data/v60.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+1\" \
      | head -c 200
  ")
  case "$RECORDS" in
    NO_TOKEN) echo "FAIL: no access_token. Rolling back."; rollback; exit 1 ;;
    *records*|*\"totalSize\"*) echo "OK: REST query returned data shape." ;;
    *) echo "WARN: unexpected query response: $RECORDS" ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove salesforce 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SF_INSTANCE_URL=/d;
            /^SF_CLIENT_ID=/d;
            /^SF_CLIENT_SECRET=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the ECA in Salesforce Setup → App Manager if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Pretending static secret "connects" the hosted MCP | Hosted MCP refuses Client Credentials; only OAuth+PKCE works | This skill makes Path A require browser consent; Path B is REST-only |
| 2 | MCP URL pointing at `<mydomain>.my.salesforce.com` | MCP host is `api.salesforce.com`, not your org domain — 404/405 | Step 3 derives correct URL from `$SF_ORG_TYPE` |
| 3 | Classic Connected App instead of External Client App (ECA) | Hosted MCP requires ECA; classic apps authenticate but MCP rejects | Tell user: create ECA, not classic Connected App |
| 4 | Missing OAuth scopes (`mcp_api` AND `refresh_token`) | OAuth completes but tool calls 401/403 | Pre-flight checklist before Path A |
| 5 | Client Credentials without integration user | `inactive` / `invalid_client` error | Step 3 catches this; Setup → ECA → assign run-as user |
| 6 | Client Credentials caches token as if static | Issues short-lived access token, NO refresh token | Tool must re-POST `/oauth2/token` on every expiry |
| 7 | API limits (per-org daily request quota) | Chatty agent exhausts limit; all calls 429 | Prefer selective SOQL over broad scans; monitor limit |
| 8 | Pointing at production when targeting sandbox | Wrong URL prefix → 404 | Step 3 enforces `production` vs `sandbox` |
| 9 | Sandbox API URL has different MCP path | `/platform/mcp/v1/sandbox/<server>` not just `/platform/mcp/v1/<server>` | Step 3 derives correctly |
| 10 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 11 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 12 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 13 | Granting `sobject-all` when `sobject-reads` suffices | Over-broad permissions | Default Path A to `sobject-reads`; upgrade only when writes needed |
| 14 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: instance URL is `*.my.salesforce.com`; client ID + secret present + ≥20 chars; Path A → MCP URL derived from org type; Path B → Client Credentials live exchange returned access_token
- [ ] Dry-run shown to user; OAuth-vs-static tradeoff stated plainly; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: MCP registered with OAuth+PKCE; user completed browser consent ONCE
- [ ] Path B: REST surface documented with token-mint-per-call contract
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s)` post-consent
- [ ] Path B: live REST query (`SELECT Id,Name FROM Account LIMIT 1`) returned a records-shaped response
- [ ] Least-privilege server chosen (default `sobject-reads`; widen only with explicit need)
- [ ] Rollback function defined; ECA revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, OAuth
consent, and Salesforce ECA failure modes.
