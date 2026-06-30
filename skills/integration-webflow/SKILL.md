---
name: integration-webflow
description: Connect Webflow (marketing-site CMS, pages, collections, publishing) to a self-hosted Hermes Agent over SSH using a static v2 Data API site token. Path A — official stdio MCP (webflow-mcp-server). Path B — generic REST. Refuses the hosted OAuth-only MCP. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-webflow — connect Webflow to a remote Hermes (SSH-first)

You are the engineer connecting Webflow to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint a v2 Data API site token (workspace → site → gear → Apps & integrations → API
   access → Generate API token → select scopes → copy ONCE).
2. (Path A) Publish the **MCP Bridge App** in the Webflow workspace one-time.

Everything else — credential storage, live API verification, MCP registration, gateway
reload, smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Webflow ships an official **hosted** remote MCP
at `https://mcp.webflow.com/sse` (and `/mcp`), but it is **OAuth-only** — each authorization
grants per-workspace browser-consented access. That breaks headless. So we do NOT wire the
hosted MCP. Two practical paths:

- **Path A (preferred — official open-source stdio MCP):** `webflow-mcp-server` reads
  `WEBFLOW_TOKEN` from env, exposes Webflow Data API (sites/pages/collections/items/publish)
  as MCP tools. Requires the Bridge App published once per workspace.
- **Path B (fallback — generic REST):** generic HTTP tool hits `https://api.webflow.com/v2`
  with `Authorization: Bearer ${WEBFLOW_TOKEN}`.

Sources:
- https://github.com/webflow/mcp-server
- https://developers.webflow.com/data/reference/authentication/site-token

**Site tokens:** up to 5 per site; expire after 365 days of inactivity. Rotate via Site
settings → API access.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WEBFLOW_TOKEN` | v2 Data API site token | Workspace → site → gear → Apps & integrations → API access → Generate API token (scopes: `cms:read`, `cms:write`, `pages:read`, `pages:write`, `sites:read`, `sites:write` for typical marketing-site work) |
| `$WEBFLOW_SITE_ID` | Site ID to manage | `GET /v2/sites` with the token, or URL of site settings |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (REST) | A requires `npx` on the VPS + Bridge App published |

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
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^WEBFLOW_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_SITE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^WEBFLOW_SITE_ID=' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci webflow" || echo 0)
if [ "$HAS_TOKEN" = "1" ] && [ "$HAS_SITE" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY_MCP" -gt 0 ]; then
    echo "Webflow already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "Webflow token present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (live API verify + site-binding + Path A prereqs)

```bash
# Token sanity (Webflow tokens vary in format; just check non-empty + length)
[ "${#WEBFLOW_TOKEN}" -ge 30 ] \
  || { echo "ABORT: WEBFLOW_TOKEN looks too short (<30 chars)."; exit 1; }

# Live /v2/sites verify
HTTP=$(curl -sS -o /tmp/wf.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $WEBFLOW_TOKEN" \
  -H 'accept-version: 2.0.0' \
  'https://api.webflow.com/v2/sites' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200) echo "Webflow API OK." ;;
  401) echo "ABORT: 401 — token rejected."; exit 1 ;;
  403) echo "ABORT: 403 — token scopes too narrow."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/wf.json | head -3; exit 1 ;;
esac

# Verify the supplied site ID is in the list (token actually has access to it)
if ! grep -q "\"id\":\"$WEBFLOW_SITE_ID\"" /tmp/wf.json; then
  echo "WARN: WEBFLOW_SITE_ID=$WEBFLOW_SITE_ID not found in /v2/sites response. Token may not cover that site."
fi
rm -f /tmp/wf.json

# Path A: require npx
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires npx on the VPS. Install Node.js or pick Path B (WIRE_PATH=B)."; exit 1; }
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write WEBFLOW_TOKEN (length ${#WEBFLOW_TOKEN}) via 'hermes config set'
    2. Write WEBFLOW_SITE_ID ($WEBFLOW_SITE_ID)
    3. chmod 600 ~/.hermes/.env

  Path A (stdio MCP):
    4. Register MCP: hermes mcp add webflow --command npx --args -y,webflow-mcp-server@latest
    5. Reload gateway: stop + run
    6. Verify in logs: grep "registered.*webflow"
    7. NOTE: MCP Bridge App must be published in the Webflow workspace (one-time, in UI)

  Path B (REST):
    4. No MCP registration; generic HTTP tool reads env vars
    5. Reload gateway: stop + run
    6. Smoke test: GET /v2/sites/{site_id}/collections — expect 200

Token is NEVER printed in plaintext beyond a length.
Hosted https://mcp.webflow.com/{sse,mcp} is OAuth-only and is NOT wired by this skill.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set WEBFLOW_TOKEN '$WEBFLOW_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set WEBFLOW_SITE_ID '$WEBFLOW_SITE_ID'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(WEBFLOW_TOKEN|WEBFLOW_SITE_ID)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "2" ] || { echo "FAIL: env vars did not all land. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'WEBFLOW_TOKEN=$WEBFLOW_TOKEN' 'WEBFLOW_SITE_ID=$WEBFLOW_SITE_ID'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A (stdio MCP — default)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add webflow \
      --command 'npx' \
      --args '-y,webflow-mcp-server@latest' \
      --env 'WEBFLOW_TOKEN=\${WEBFLOW_TOKEN}'
  "
  echo "Path A registered. REMINDER: MCP Bridge App must be published in the Webflow workspace (one-time, in UI) before tool calls work."
fi
```

### Path B (REST)

Generic HTTP tool layer reads env and calls:

- **Base URL:** `https://api.webflow.com/v2`
- **Auth:** `Authorization: Bearer ${WEBFLOW_TOKEN}`
- **accept-version:** `2.0.0` (optional but explicit is safer)

Common endpoints:
- `GET /v2/sites` — list sites
- `GET /v2/sites/{site_id}/pages` — list pages
- `GET /v2/sites/{site_id}/collections` — list collections
- `GET /v2/collections/{collection_id}/items` — list items
- `POST /v2/collections/{collection_id}/items` — create item
- `PATCH /v2/collections/{collection_id}/items/{item_id}` — update item
- `POST /v2/sites/{site_id}/publish` — publish (ships LIVE immediately — use `publishTargets: ["staging"]` for review first)

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
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*webflow|MCP server.*webflow"; then
      REGISTERED=1; echo "OK: webflow MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: webflow not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test for both paths
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$WEBFLOW_TOKEN\" \
    -H 'accept-version: 2.0.0' \
    \"https://api.webflow.com/v2/sites/\$WEBFLOW_SITE_ID/collections\"
")
case "$HTTP" in
  200) echo "OK: /v2/sites/{site}/collections reachable from VPS." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  403) echo "FAIL: 403 — token scopes too narrow for collections. Re-mint."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove webflow 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^WEBFLOW_TOKEN=/d;
            /^WEBFLOW_SITE_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at site settings → API access if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `mcp.webflow.com` with a site token | Hosted MCP is OAuth-only; bearer rejected | This skill refuses; uses stdio (A) or REST (B) |
| 2 | Path A without publishing the MCP Bridge App | Tools register but every site call errors "app not installed" | Operator must publish the Bridge App once per workspace in Webflow UI |
| 3 | Token scope too narrow | Writes/publish return 403 | Re-mint with `cms:write`, `pages:write`, `sites:write` as needed |
| 4 | Using v1 endpoints | Deprecated; return 410/404 or wrong shapes | Use `/v2` exclusively |
| 5 | Site already has 5 tokens | New mint silently fails or overwrites | List/rotate at site settings; cap is 5/site |
| 6 | `POST /v2/sites/{id}/publish` without staging first | Ships live immediately | Default `publishTargets: ["staging"]`; explicit opt-in for live |
| 7 | Rate limits (~60 req/min per token) | Bursty CMS work hits 429 | Back off; paginate reads |
| 8 | Token expires after 365 days of inactivity | Surprise 401 a year later | Re-mint via `/hermes-cron` annually |
| 9 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: token ≥30 chars; live `/v2/sites` returned 200; site ID found in response (or warning printed); Path A → npx present
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP `webflow` registered with env-var indirection; user reminded to publish Bridge App in Webflow UI
- [ ] Path B: generic HTTP tool documented (base URL + auth + version header)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v2/sites/{site_id}/collections` from inside container returned 200
- [ ] Path A: logs show `registered N tool(s)` within 30s
- [ ] Rollback function defined; token revocation instructions included
- [ ] User told that hosted `mcp.webflow.com` is OAuth-only and NOT wired

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, scope,
and Webflow v2-API failure modes.
