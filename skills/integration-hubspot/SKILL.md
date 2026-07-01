---
name: integration-hubspot
description: Connect HubSpot CRM (contacts, companies, deals, tasks) to a self-hosted Hermes agent over SSH using a Private App access token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-hubspot — connect HubSpot to a remote Hermes (SSH-first)

You are the engineer connecting HubSpot to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the thing a machine cannot: mint the
Private App token in the HubSpot UI and pick the right scopes.

Everything else — token storage, MCP/REST wiring, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** HubSpot ships a first-party remote MCP at
`https://mcp.hubspot.com` (GA 2026-04-13) but it is **OAuth-only** — OAuth 2.0 / 2.1
authorization-code with PKCE against a registered MCP auth app. There is no static-bearer
or API-key mode. A headless Hermes container cannot complete that browser handshake. So we
do NOT wire the hosted MCP. We use HubSpot's **REST API with a Private App access token** —
a static, non-expiring, scope-limited credential perfect for headless agents. Legacy
account-level API keys (`hapikey`) are deprecated and no longer accepted.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$HUBSPOT_ACCESS_TOKEN` | Private App access token (`pat-na1-...` or `pat-eu1-...`) | HubSpot UI: **Settings (gear)** -> **Integrations** -> **Private Apps** -> **Create a private app** -> **Scopes** tab (pick `crm.objects.contacts.read`/`.write`, `crm.objects.companies.read`/`.write`, `crm.objects.deals.read`/`.write`, plus `crm.objects.tasks.*` if the agent should manage tasks) -> **Create app** -> **Auth** tab -> **Show token** -> **Copy** |

Docs: <https://developers.hubspot.com/docs/guides/apps/private-apps/overview>

The token embeds the data center; the same REST host (`https://api.hubapi.com`) works
for both `pat-na1-` and `pat-eu1-` tokens.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci hubspot" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "HubSpot is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

If no MCP entry exists but `HUBSPOT_ACCESS_TOKEN` is already in `~/.hermes/.env`, you are
on Path B (REST-only). Check with:

```bash
HAVE_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^HUBSPOT_ACCESS_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAVE_TOKEN" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "HubSpot token already present (REST mode). Set FORCE=1 to overwrite."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Validate the Private App token against https://api.hubapi.com/crm/v3/objects/contacts -> expect 200
  2. Write HUBSPOT_ACCESS_TOKEN (length ${#HUBSPOT_ACCESS_TOKEN}, prefix ${HUBSPOT_ACCESS_TOKEN:0:8}...) via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register MCP if available (Path A) OR document the REST tool (Path B):
       Base URL: https://api.hubapi.com
       Auth:     Authorization: Bearer \${HUBSPOT_ACCESS_TOKEN}
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*hubspot" (Path A) OR skip (Path B)
  7. Smoke test: GET /crm/v3/objects/contacts?limit=1 -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

First validate the token against the live API so we never store a bad credential:

```bash
PRECHECK=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Authorization: Bearer $HUBSPOT_ACCESS_TOKEN' \
    'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false'
")
case "$PRECHECK" in
  200) echo "OK: token valid, contacts-read scope present." ;;
  401) echo "FAIL: token invalid or has stray whitespace. Re-copy from HubSpot UI."; exit 1 ;;
  403) echo "FAIL: token valid but missing required scope. Add scopes in Private App UI."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $PRECHECK from HubSpot. Inspect manually before proceeding."; exit 1 ;;
esac
```

Now store the secret:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set HUBSPOT_ACCESS_TOKEN '$HUBSPOT_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^HUBSPOT_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: HUBSPOT_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern.
> Use `|` as the sed delimiter — Private App tokens contain `-` and may carry other
> punctuation in future formats. **Never `echo >>`** (it merges onto the previous line
> if that line lacks a trailing newline):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^HUBSPOT_ACCESS_TOKEN=' ~/.hermes/.env || printf 'HUBSPOT_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^HUBSPOT_ACCESS_TOKEN=.*|HUBSPOT_ACCESS_TOKEN=$HUBSPOT_ACCESS_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — wire the agent's HubSpot tool

No first-party static-token MCP exists. Pick the path that matches the Hermes build on
the VPS. Path B is the recommended default.

### Path A (optional) — self-hosted community MCP server

Community HubSpot MCP servers that accept a Private App token via env exist (see
<https://www.pulsemcp.com/servers/hubspot> and similar Glama/npm-indexed servers). Most
are stdio/Node, not hosted HTTP. Use one only if you self-host it behind an HTTP transport
and have vetted the code. Treat it as third-party.

If you have a vetted stdio server:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add hubspot \
    --command npx \
    --args '-y,<verified-hubspot-mcp-package>' \
    --env 'HUBSPOT_ACCESS_TOKEN=\${HUBSPOT_ACCESS_TOKEN}'
"
```

Do NOT try to register `https://mcp.hubspot.com` with a bearer token — that endpoint is
OAuth-only and will return an auth error.

### Path B (recommended) — generic REST tool against the HubSpot CRM API

Point a generic HTTP/tool action at the documented REST API. The agent reads
`HUBSPOT_ACCESS_TOKEN` from `~/.hermes/.env`.

- **Base URL:** `https://api.hubapi.com`
- **Auth header:** `Authorization: Bearer ${HUBSPOT_ACCESS_TOKEN}`
- **Content type:** `Content-Type: application/json`

Common endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/crm/v3/objects/contacts?limit=10` | List contacts |
| `GET`  | `/crm/v3/objects/companies?limit=10` | List companies |
| `GET`  | `/crm/v3/objects/deals?limit=10` | List deals |
| `POST` | `/crm/v3/objects/contacts` | Create contact `{"properties":{"email":"...","firstname":"..."}}` |
| `POST` | `/crm/v3/objects/deals` | Create deal `{"properties":{"dealname":"...","pipeline":"...","dealstage":"..."}}` |
| `POST` | `/crm/v3/objects/contacts/search` | Search contacts by `filterGroups` |

Optional — inspect the token's actual granted scopes:

```bash
ssh "$VPS_USER@$VPS_IP" "
  . ~/.hermes/.env
  curl -sS -H \"Authorization: Bearer \$HUBSPOT_ACCESS_TOKEN\" \
    \"https://api.hubapi.com/oauth/v1/access-tokens/\$HUBSPOT_ACCESS_TOKEN\" | head -c 800
"
```

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

Path A only — Path B has no MCP entry so this step is informational.

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*hubspot|MCP server.*hubspot.*(ok|ready)|env.*HUBSPOT_ACCESS_TOKEN.*loaded"; then
    REGISTERED=1
    echo "OK: hubspot wiring visible in gateway logs."
    break
  fi
  sleep 5
done
if [ "$REGISTERED" = "0" ] && [ "${PATH_B:-0}" != "1" ]; then
  echo "FAIL: hubspot not in logs after 30s. Rolling back."; rollback; exit 1
fi
```

---

## Step 8 — live API smoke test (inside the VPS so the token stays put)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  . ~/.hermes/.env
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: Bearer \$HUBSPOT_ACCESS_TOKEN\" \
    'https://api.hubapi.com/crm/v3/objects/contacts?limit=1&archived=false'
")
case "$HTTP" in
  200) echo "OK: HubSpot REST API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing scope for contacts. Add scope in Private App UI."; exit 1 ;;
  429) echo "WARN: rate-limited (Retry-After header). Back off and retry." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from HubSpot API. Check manually." ;;
esac
```

`200` with an empty `results` array means the token works but the portal has no contacts
yet — not a wiring failure. Then prove end-to-end from chat:

```
@<agent> list my 5 most recent HubSpot contacts
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove hubspot 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset HUBSPOT_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^HUBSPOT_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. HubSpot is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `https://mcp.hubspot.com` with a bearer token | It is **OAuth-only** (PKCE); static tokens are rejected | Use Private App + REST (Path B) or vetted stdio MCP (Path A) |
| 2 | Trying legacy `hapikey` query param | Account-level API keys are deprecated and no longer accepted | Only OAuth or Private App tokens work |
| 3 | Scope errors look like `403`, not `401` | `401` = bad/revoked token; `403` = token valid but missing scope for that object | Add the scope in Private App **Scopes** tab; re-copy token from **Auth** tab |
| 4 | Token grants account-wide scope | A Private App token acts with exactly the selected scopes for the whole account | Pick least privilege; create the app from an admin who should own that access |
| 5 | Token has no expiry but is revocable | Private App tokens never expire, but an admin can delete the app at any time -> sudden `401` | Treat `401` after working as "admin revoked"; re-mint |
| 6 | Rate limits (`429 Too Many Requests`) | Private apps allow ~190 req/10s burst; daily caps vary by tier | Respect `Retry-After` header; back off; do not hammer |
| 7 | Token format assumed `pat-na1-` only | EU portals issue `pat-eu1-` tokens; both work against `api.hubapi.com` | Treat token as opaque past the `pat-na1-` / `pat-eu1-` prefix |
| 8 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `hermes config set` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | `echo "$TOKEN" >> .env` | Merges onto a prior line that lacks trailing newline -> silently invalid | Always `hermes config set`; fallback uses `printf` + `sed` |
| 11 | sed with `/` delimiter on tokens | Future tokens may contain `/+=` and break the expression | Always use `\|` delimiter |
| 12 | Container vs host confusion | Skill executed on the wrong layer -> changes invisible to Hermes | Always `whoami; hostname` on the VPS first; secrets go in `~/.hermes/.env` (or `/opt/data/.env` inside the container) |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Private App token validated against `/crm/v3/objects/contacts` -> `200`
- [ ] `HUBSPOT_ACCESS_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (vetted stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs checked within 30s (Path A) or skipped with note (Path B)
- [ ] Smoke test: `GET /crm/v3/objects/contacts?limit=1` from the VPS returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)
- [ ] OAuth-only MCP caveat communicated to the user (no static-token first-party MCP as of 2026-06)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
