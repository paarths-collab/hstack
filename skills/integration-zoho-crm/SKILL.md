---
name: integration-zoho-crm
description: Connect Zoho CRM (leads, contacts, deals, accounts across standard and custom modules) to a self-hosted Hermes Agent over SSH. Uses Zoho's first-party hosted MCP (URL-embedded secret) as Path A; OAuth 2.0 refresh-token bridge as Path B. Enforces the Authorization-via-Connections mode for unattended agents and validates region/DC. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-zoho-crm — connect Zoho CRM to a remote Hermes (SSH-first)

You are the engineer connecting Zoho CRM to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does several things a machine cannot:

1. Create a server at https://mcp.zoho.com → add CRM tools → choose **Authorization via
   Connections** (NOT on-demand) → copy the MCP Server URL from the **Connect** tab.
2. If on-demand was chosen by accident: complete the one-time browser OAuth flow.
3. (Path B only) Register an OAuth client in https://api-console.zoho.com and capture
   client ID + secret + refresh token with the right scopes.

Everything else — URL storage, region validation, MCP registration, gateway reload, live
verification — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Two paths, both real.

- **Path A (preferred — first-party hosted MCP):** Zoho ships a hosted MCP at
  `https://mcp.zoho.com` whose per-server URL **contains the secure key embedded in the URL
  itself**. Zoho's own docs: *"Treat your MCP Server URL as you would your password."*
  Regeneratable from the same Connect tab if leaked. No separate bearer header — the URL
  IS the credential.
- **Path B (fallback — OAuth 2.0 refresh-token bridge):** Zoho's raw REST API has NO static
  API key. It's OAuth 2.0 only: 1-hour access token + long-lived refresh token. The auth
  header is `Authorization: Zoho-oauthtoken <access_token>` — **NOT `Bearer`**. This is the
  single most common Zoho integration mistake.

**Multi-DC (region) matters:** Zoho is `.com`, `.eu`, `.in`, `.com.au`, `.jp`. A `.com`
token/URL will NOT work against `.eu` data and vice-versa. The MCP console hands you a
region-correct URL automatically; this skill detects the region from the URL.

**"Authorization on demand" blocks unattended agents:** First tool call opens a browser
login — a person must click. Always choose **Authorization via Connections** in the console.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ZOHO_MCP_URL` *(Path A)* | Full MCP Server URL from Zoho console (URL = secret) | https://mcp.zoho.com → server → Connect → MCP Server URL |
| `$ZOHO_AUTH_MODE` *(Path A — required)* | `connections` (preferred) or `ondemand` | Set in the server's Authorization tab |
| `$ZOHO_CRM_CLIENT_ID` *(Path B only)* | OAuth client ID | https://api-console.zoho.com → Self Client or Server-based |
| `$ZOHO_CRM_CLIENT_SECRET` *(Path B only)* | OAuth client secret | Same place |
| `$ZOHO_CRM_REFRESH_TOKEN` *(Path B only)* | Long-lived refresh token | Generated via the Self Client flow |
| `$ZOHO_DC` *(optional)* | Zoho data center: `com`, `eu`, `in`, `com.au`, `jp` (autodetected from URL for Path A) | The DC that owns the CRM org |
| `$WIRE_PATH` *(optional)* | `A` (default) or `B` | Pick B only if user cannot/will not use MCP |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci zoho" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_ZOHO_CRM_URL=https://mcp.zoho' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_OAUTH=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^ZOHO_CRM_REFRESH_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && { [ "$HAS_URL" = "1" ] || [ "$HAS_OAUTH" = "1" ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Zoho CRM already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (path-specific validation + region detection + auth-mode refusal)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

if [ "$PATH_CHOSEN" = "A" ]; then
  # MCP URL must point to mcp.zoho.<dc>
  printf '%s' "$ZOHO_MCP_URL" | grep -qE '^https://mcp\.zoho\.(com|eu|in|com\.au|jp)/' \
    || { echo "ABORT: ZOHO_MCP_URL must be a https://mcp.zoho.<dc>/... URL."; exit 1; }

  # Auto-detect DC from URL
  DETECTED_DC=$(printf '%s' "$ZOHO_MCP_URL" | sed -E 's|^https://mcp\.zoho\.([a-z.]+)/.*|\1|')
  echo "Detected Zoho DC: $DETECTED_DC"
  if [ -n "${ZOHO_DC:-}" ] && [ "$ZOHO_DC" != "$DETECTED_DC" ]; then
    echo "ABORT: ZOHO_DC=$ZOHO_DC but URL is for $DETECTED_DC. Region mismatch — calls will fail."
    exit 1
  fi
  ZOHO_DC="$DETECTED_DC"

  # Refuse the production footgun: on-demand auth means an unattended agent will hang
  if [ "${ZOHO_AUTH_MODE:-}" = "ondemand" ]; then
    echo "ABORT: ZOHO_AUTH_MODE=ondemand blocks unattended Hermes agents — first tool call opens a browser login."
    echo "Go to https://mcp.zoho.$ZOHO_DC, open your server, switch to 'Authorization via Connections', re-export the URL."
    exit 1
  fi
  if [ "${ZOHO_AUTH_MODE:-connections}" != "connections" ]; then
    echo "WARN: ZOHO_AUTH_MODE is '$ZOHO_AUTH_MODE' (expected 'connections'). Confirm in the Zoho MCP console."
  fi

  # Live MCP probe: tools/list should return a JSON-RPC result (proves URL credential works)
  RESP=$(curl -sS -X POST --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    "$ZOHO_MCP_URL" 2>/dev/null) || true
  if printf '%s' "$RESP" | grep -q '"result"'; then
    TOOL_COUNT=$(printf '%s' "$RESP" | grep -oE '"name":"[^"]+"' | wc -l | tr -d ' ')
    echo "Zoho MCP OK: $TOOL_COUNT tools available."
  elif printf '%s' "$RESP" | grep -qi 'authorize\|login'; then
    echo "ABORT: Zoho MCP wants browser OAuth (on-demand mode). Switch to Connections."
    exit 1
  else
    echo "ABORT: Zoho MCP did not return a tools/list result. Response:"
    echo "$RESP" | head -3
    exit 1
  fi
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  for V in ZOHO_CRM_CLIENT_ID ZOHO_CRM_CLIENT_SECRET ZOHO_CRM_REFRESH_TOKEN; do
    eval "VAL=\$$V"
    [ -n "$VAL" ] || { echo "ABORT: Path B requires $V."; exit 1; }
  done
  ZOHO_DC=${ZOHO_DC:-com}
  ACCOUNTS_BASE="https://accounts.zoho.$ZOHO_DC"

  # Exchange refresh for access token to prove credentials work
  TOK_RESP=$(curl -sS --max-time 10 \
    -d "refresh_token=$ZOHO_CRM_REFRESH_TOKEN" \
    -d "client_id=$ZOHO_CRM_CLIENT_ID" \
    -d "client_secret=$ZOHO_CRM_CLIENT_SECRET" \
    -d "grant_type=refresh_token" \
    "$ACCOUNTS_BASE/oauth/v2/token" 2>/dev/null) || true
  ACCESS=$(printf '%s' "$TOK_RESP" | grep -oE '"access_token":"[^"]+"' | head -1 | cut -d'"' -f4)
  API_DOMAIN=$(printf '%s' "$TOK_RESP" | grep -oE '"api_domain":"[^"]+"' | head -1 | cut -d'"' -f4)
  [ -n "$ACCESS" ] || { echo "ABORT: Zoho OAuth refresh failed. Response: $(printf '%s' "$TOK_RESP" | head -c 200)"; exit 1; }
  echo "Zoho OAuth OK. api_domain=$API_DOMAIN, access token (expires 1h)."
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path chosen: $PATH_CHOSEN   (A = Zoho MCP, B = OAuth REST bridge)
  DC: $ZOHO_DC

  Path A:
    1. Write MCP_ZOHO_CRM_URL (length ${#ZOHO_MCP_URL}, host mcp.zoho.$ZOHO_DC) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. Register MCP: hermes mcp add zoho-crm --url '\${MCP_ZOHO_CRM_URL}' --auth none
    4. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
    5. Verify in logs: grep "registered.*zoho-crm"
    6. Smoke test: tools/list returns N tools

  Path B:
    1. Write ZOHO_CRM_CLIENT_ID, ZOHO_CRM_CLIENT_SECRET, ZOHO_CRM_REFRESH_TOKEN via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. Document REST base: $API_DOMAIN/crm/v8  (Authorization: Zoho-oauthtoken <access>, NOT Bearer)
    4. Reload gateway: hermes gateway stop && hermes gateway run
    5. Bridge code must refresh access tokens hourly

The MCP URL / refresh token are NEVER printed in plaintext beyond length + host/domain.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600, no echo, no logging)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_ZOHO_CRM_URL '$ZOHO_MCP_URL'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_ZOHO_CRM_URL=https://mcp.zoho' ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: MCP_ZOHO_CRM_URL not written. Rolling back."; rollback; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set ZOHO_CRM_CLIENT_ID '$ZOHO_CRM_CLIENT_ID'"
  ssh "$VPS_USER@$VPS_IP" "hermes config set ZOHO_CRM_CLIENT_SECRET '$ZOHO_CRM_CLIENT_SECRET'"
  ssh "$VPS_USER@$VPS_IP" "hermes config set ZOHO_CRM_REFRESH_TOKEN '$ZOHO_CRM_REFRESH_TOKEN'"
  ssh "$VPS_USER@$VPS_IP" "hermes config set ZOHO_CRM_DC '$ZOHO_DC'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
  COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(ZOHO_CRM_CLIENT_ID=|ZOHO_CRM_CLIENT_SECRET=|ZOHO_CRM_REFRESH_TOKEN=|ZOHO_CRM_DC=)' ~/.hermes/.env" || echo 0)
  [ "$COUNT" = "4" ] || { echo "FAIL: Zoho OAuth vars did not land (got $COUNT, need 4). Rolling back."; rollback; exit 1; }
fi
echo "Zoho secrets confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter — URL contains `/?=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_ZOHO_CRM_URL=' ~/.hermes/.env || printf 'MCP_ZOHO_CRM_URL=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_ZOHO_CRM_URL=.*|MCP_ZOHO_CRM_URL=$ZOHO_MCP_URL|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the URL or refresh token in `config.yaml`.

---

## Step 6 — register the MCP (Path A only)

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add zoho-crm \
      --url '\${MCP_ZOHO_CRM_URL}' \
      --auth none
  "
fi
```

Path B has no MCP server to register — the agent's REST tool layer reads the OAuth env vars
and performs the refresh-token exchange per call. The bridge MUST send:
`Authorization: Zoho-oauthtoken <access_token>` (NOT `Bearer`).

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 8 — verify

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*zoho|MCP server.*zoho-crm.*(ok|ready)"; then
      REGISTERED=1
      echo "OK: zoho-crm MCP registered."
      break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: zoho-crm not in logs after 30s. Rolling back."; rollback; exit 1; }
fi
```

---

## Step 9 — live smoke test

```bash
if [ "$PATH_CHOSEN" = "A" ]; then
  RESP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -X POST --max-time 15 \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}' \
      \"\$MCP_ZOHO_CRM_URL\"
  ")
  printf '%s' "$RESP" | grep -q '"result"' \
    && echo "OK: Zoho MCP tools/list returned a result from the VPS." \
    || { echo "FAIL: tools/list did not return result from VPS. Rolling back."; rollback; exit 1; }
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    set -e
    . ~/.hermes/.env 2>/dev/null
    TOK=\$(curl -sS --max-time 10 \
      -d \"refresh_token=\$ZOHO_CRM_REFRESH_TOKEN\" \
      -d \"client_id=\$ZOHO_CRM_CLIENT_ID\" \
      -d \"client_secret=\$ZOHO_CRM_CLIENT_SECRET\" \
      -d 'grant_type=refresh_token' \
      \"https://accounts.zoho.\$ZOHO_CRM_DC/oauth/v2/token\" \
      | grep -oE '\"access_token\":\"[^\"]+\"' | head -1 | cut -d'\"' -f4)
    [ -n \"\$TOK\" ] || { echo 000; exit 0; }
    DOMAIN=\$(curl -sS --max-time 10 \
      -d \"refresh_token=\$ZOHO_CRM_REFRESH_TOKEN\" \
      -d \"client_id=\$ZOHO_CRM_CLIENT_ID\" \
      -d \"client_secret=\$ZOHO_CRM_CLIENT_SECRET\" \
      -d 'grant_type=refresh_token' \
      \"https://accounts.zoho.\$ZOHO_CRM_DC/oauth/v2/token\" \
      | grep -oE '\"api_domain\":\"[^\"]+\"' | head -1 | cut -d'\"' -f4)
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -H \"Authorization: Zoho-oauthtoken \$TOK\" \
      \"\$DOMAIN/crm/v8/Leads?per_page=1\"
  ")
  case "$HTTP" in
    200|204) echo "OK: Zoho CRM REST reachable with Zoho-oauthtoken header." ;;
    401) echo "FAIL: token rejected (401). Check refresh-token scope."; rollback; exit 1 ;;
    *) echo "WARN: HTTP $HTTP from Zoho. Investigate." ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${PATH_CHOSEN:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove zoho-crm 2>/dev/null || true"
    ssh "$VPS_USER@$VPS_IP" "sed -i '/^MCP_ZOHO_CRM_URL=/d' ~/.hermes/.env"
  else
    ssh "$VPS_USER@$VPS_IP" "
      sed -i '/^ZOHO_CRM_CLIENT_ID=/d;
              /^ZOHO_CRM_CLIENT_SECRET=/d;
              /^ZOHO_CRM_REFRESH_TOKEN=/d;
              /^ZOHO_CRM_DC=/d' ~/.hermes/.env
    "
  fi
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env && hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Regenerate the Zoho MCP URL in the console if it was leaked."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `Authorization: Bearer ...` for REST | Zoho rejects; valid header is `Authorization: Zoho-oauthtoken <token>` | Path B verify uses Zoho-oauthtoken; Pitfalls explicit |
| 2 | The MCP URL leaked because it was in `config.yaml` | URL IS the credential | Only `~/.hermes/.env`, `chmod 600`; only `${MCP_ZOHO_CRM_URL}` indirection in yaml; regenerate URL if leaked |
| 3 | "Authorization on demand" mode chosen | First tool call opens a browser login — agent hangs | Step 3 hard-aborts if `ZOHO_AUTH_MODE=ondemand` |
| 4 | Region mismatch (`.com` URL against `.eu` data) | INVALID_TOKEN or empty results despite valid auth | Step 3 auto-detects DC from URL; aborts on explicit mismatch |
| 5 | Caching the 1-hour access token | Token dies in 60 minutes | Always drive from refresh token; let MCP server (Path A) manage lifecycle |
| 6 | Scope mismatch on the refresh token | Reads work, writes fail with permission error | Re-mint refresh token with `ZohoCRM.modules.ALL` |
| 7 | Connected user has low CRM permissions | Reads come back empty, not errors | Confirm the connected Zoho user can see the expected records |
| 8 | Bursty MCP tool calls hit API credits | 429 / credit-exhausted | Throttle; consume credits sparingly |
| 9 | Community MCP server (`junnaisystems/zoho-crm-mcp`) used without review | Third-party code in the trust path | This skill does NOT wire community servers; document only |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter on URL | URL contains `/?=` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: Path A → URL is `https://mcp.zoho.<dc>/...`, DC matches if `$ZOHO_DC` set, AUTH_MODE is `connections` (not `ondemand`), live `tools/list` returned a result. Path B → all 3 OAuth vars present, refresh-token exchange returned an access token + api_domain.
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Secrets written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: MCP registered with `--url '${MCP_ZOHO_CRM_URL}'` (env-var indirection, NOT plaintext URL in yaml)
- [ ] Path B: bridge code uses `Authorization: Zoho-oauthtoken <token>` (NEVER `Bearer`)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'zoho-crm'` within 30s
- [ ] Smoke test: Path A `tools/list` from VPS OR Path B `/crm/v8/Leads` returned `200`
- [ ] Rollback function defined; if URL leaked, the operator was told to regenerate it in the console
- [ ] User informed of the 1-hour access token lifecycle (Path B) or `Connections` mode requirement (Path A)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, region,
and OAuth failure modes.
