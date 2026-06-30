---
name: integration-hubspot
description: Connect HubSpot CRM (contacts, companies, deals, tickets, tasks) to a self-hosted Hermes Agent over SSH. Wires HubSpot's official open-source MCP server (@hubspot/mcp-server) with a Private App access token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-hubspot — connect HubSpot to a remote Hermes (SSH-first)

You are the engineer connecting HubSpot to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Create the Private App in the HubSpot UI and mint the access token (requires a
   super-admin and HubSpot 2FA).
2. Pick the scopes (read-only first; widen later).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** HubSpot ships two MCP options:

- **Hosted remote MCP** at `https://mcp.hubspot.com` (GA 2026-04-13) — **OAuth 2.1 +
  PKCE only**. Static bearer tokens are rejected; a headless container cannot complete
  the browser handshake unattended.
- **Official open-source server** `@hubspot/mcp-server` (npm, v0.4.x, bin
  `mcp-hubspot`) — stdio server that reads `PRIVATE_APP_ACCESS_TOKEN` from env. This is
  the only headless-friendly path and it is what we wire.

Legacy account-level API keys (`hapikey=...`) are **dead**; HubSpot removed them.
OAuth apps exist but are for multi-tenant distribution — skip for self-hosted single
account use.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$HUBSPOT_ACCESS_TOKEN` | Private App access token (`pat-na1-...` or `pat-eu1-...`) | HubSpot: **Settings (gear)** -> **Integrations** -> **Private Apps** -> **Create a private app** -> **Scopes** tab (pick scopes — see below) -> **Create app** -> **Auth** tab -> **Show token** -> **Copy** (shown once). Must be done by a super-admin |
| Scopes | Which CRM objects the agent can touch | Start read-only: `crm.objects.contacts.read`, `crm.objects.companies.read`, `crm.objects.deals.read`. Add `.write` variants and `tickets`, `crm.objects.quotes.*`, `crm.schemas.*` only after auditing tool calls |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

Sanity-check the token prefix (catches paste errors and rejects legacy keys before they
hit the VPS):

```bash
case "$HUBSPOT_ACCESS_TOKEN" in
  pat-na1-*|pat-eu1-*) echo "OK: Private App token (data center: ${HUBSPOT_ACCESS_TOKEN:4:3})." ;;
  hapikey=*|*-*-*-*-*) echo "ABORT: this looks like a legacy account API key. HubSpot removed those; mint a Private App token instead."; exit 1 ;;
  *) echo "ABORT: token does not look like a HubSpot Private App token (expected pat-na1- or pat-eu1- prefix)."; exit 1 ;;
esac
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

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write HUBSPOT_ACCESS_TOKEN (length ${#HUBSPOT_ACCESS_TOKEN}, prefix ${HUBSPOT_ACCESS_TOKEN:0:8}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add hubspot --command npx --args -y,@hubspot/mcp-server
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*hubspot"
  6. Smoke test: GET https://api.hubapi.com/crm/v3/objects/contacts?limit=1 -> expect 200

Data center: ${HUBSPOT_ACCESS_TOKEN:4:3} (na1 = US portal; eu1 = EU portal — REST base host is the same)
The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set HUBSPOT_ACCESS_TOKEN '$HUBSPOT_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^HUBSPOT_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: HUBSPOT_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, fall back to the safe sed pattern.
> HubSpot tokens contain `-` (and may contain other punctuation across rotations); use
> the pipe delimiter regardless:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^HUBSPOT_ACCESS_TOKEN=' ~/.hermes/.env || printf 'HUBSPOT_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^HUBSPOT_ACCESS_TOKEN=.*|HUBSPOT_ACCESS_TOKEN=$HUBSPOT_ACCESS_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the HubSpot MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with Private App token

`@hubspot/mcp-server` (v0.4.x, bin `mcp-hubspot`) reads the token from
`PRIVATE_APP_ACCESS_TOKEN` in its environment. The token stays in `~/.hermes/.env` and
is referenced via `${HUBSPOT_ACCESS_TOKEN}` indirection — never inlined into
`config.yaml`. We re-export it under the name the server expects.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add hubspot \
    --command npx \
    --args '-y,@hubspot/mcp-server' \
    --env 'PRIVATE_APP_ACCESS_TOKEN=\${HUBSPOT_ACCESS_TOKEN}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax. The tool surface the MCP server exposes is constrained by the
token's scopes — that is the security boundary; the server itself has no `--tools`
allow-list flag.

### Path B (fallback) — generic HTTP tool against the HubSpot REST API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command:

- **Base URL:** `https://api.hubapi.com` (the same host for `pat-na1-` and `pat-eu1-`
  tokens — the token itself encodes the data center)
- **Auth header:** `Authorization: Bearer ${HUBSPOT_ACCESS_TOKEN}`
- **Content type:** `Content-Type: application/json`
- **No version header.** HubSpot versions in the path (`/crm/v3/...`, `/crm/v4/...`);
  pin the path version you tested against
- **Common endpoints:**
  - `GET /crm/v3/objects/contacts?limit=10`
  - `GET /crm/v3/objects/companies?limit=10`
  - `GET /crm/v3/objects/deals?limit=10`
  - `POST /crm/v3/objects/contacts` with `{"properties":{"email":"...","firstname":"..."}}`
  - `POST /crm/v3/objects/contacts/search` for property-filtered lookups

Do NOT try to register `https://mcp.hubspot.com` with a bearer token — that endpoint is
**OAuth-only (2.1 + PKCE)** and rejects static tokens.

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
       | grep -qiE "registered.*tool.*hubspot|MCP server.*hubspot.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: hubspot registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: hubspot not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

A bare `GET /crm/v3/objects/contacts?limit=1` is side-effect-free, works on a brand-new
portal (returns `{"results":[]}`), and exercises every layer: env var, token validity,
scope, and network egress.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -G 'https://api.hubapi.com/crm/v3/objects/contacts' \
    --data-urlencode 'limit=1' \
    --data-urlencode 'archived=false' \
    -H \"Authorization: Bearer \$HUBSPOT_ACCESS_TOKEN\"
")
case "$HTTP" in
  200) echo "OK: HubSpot API reachable, token valid, contacts.read scope present." ;;
  401) echo "FAIL: token invalid, empty, revoked, or pasted with whitespace. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing crm.objects.contacts.read scope. Add it in the Private App Scopes tab."; exit 1 ;;
  429) echo "WARN: rate-limited at smoke test — back off and retry."; ;;
  *)   echo "WARN: unexpected HTTP $HTTP from HubSpot API. Check manually." ;;
esac
```

`200` with an empty `results` array means the token works but the portal has no
contacts yet — that is a **pass** of the wiring. A read-only token will 200 here but
403 on a `POST /crm/v3/objects/contacts`; widen scopes only after auditing actual tool
calls in `hermes logs`.

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
| 1 | Wiring the hosted `mcp.hubspot.com` MCP with a bearer token | It is **OAuth 2.1 + PKCE only**; static Private App tokens are rejected, and a headless container cannot complete the browser handshake | Use stdio `@hubspot/mcp-server` (Path A) or REST (Path B) |
| 2 | Reaching for a legacy account API key (`hapikey=...`) | HubSpot removed account-level API keys; only OAuth and Private App tokens work now | Mint a Private App access token; reject `hapikey` in Step 0 sanity check |
| 3 | Read-only token but agent tries to write | A `403` (not `401`) — token is valid but the requested object/verb is outside the granted scopes | Start read-only on purpose; widen one object at a time after auditing `hermes logs` |
| 4 | Only super-admins can create Private Apps | A non-admin user hits a UI dead-end at "Create private app" and burns time guessing | Confirm before Step 0 that the user is a HubSpot super-admin, or get one to mint the token |
| 5 | Wrong data center confusion (`pat-na1-` vs `pat-eu1-`) | Users assume they need different base URLs per region | `api.hubapi.com` works for both — the token encodes the data center. Do NOT hardcode `api-eu1.hubapi.com` |
| 6 | Sandbox token used against production portal (or vice versa) | Token is portal-scoped; data appears empty or 401 because it is the wrong portal | Confirm portal in dry-run; HubSpot sandbox portals have separate `hub IDs` and separate Private Apps |
| 7 | Archived records hidden by default | `GET /crm/v3/objects/contacts` excludes archived rows; agent reports "no contacts" when there are archived ones | Pass `archived=true` (or `false` explicitly) to make the filter intentional |
| 8 | Rate limits (free portal: 100 req / 10s per app; ~190 req / 10s for paid) | Bursty agent loops 429 the whole portal; daily caps also vary by subscription tier | Backoff on `429` honoring `Retry-After`; batch via `/batch/read` and search endpoints |
| 9 | Private App token leaked = full granted scope, account-wide, non-expiring | Token has no expiry and no per-resource auth boundary inside the granted scope; deletion is the only revocation | Least-privilege scopes; rotate by deleting+recreating the app on a schedule; `chmod 600 ~/.hermes/.env` |
| 10 | Webhook signing secret confused with access token | `whsec_` style HubSpot signing secrets are for verifying inbound payloads, not API calls | Webhook secrets stay in the webhook receiver, not the MCP token slot |
| 11 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 12 | sed with `/` delimiter on tokens | House style is `\|` — safer across token formats | Always use `\|` delimiter |
| 13 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Token prefix is `pat-na1-` or `pat-eu1-` (legacy `hapikey` rejected)
- [ ] `HUBSPOT_ACCESS_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Scopes documented; started read-only unless the user explicitly asked for writes
- [ ] MCP registered via Path A (stdio `@hubspot/mcp-server`, env `PRIVATE_APP_ACCESS_TOKEN`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'hubspot'` within 30s
- [ ] Smoke test: `GET /crm/v3/objects/contacts?limit=1` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
