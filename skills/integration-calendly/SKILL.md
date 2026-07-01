---
name: integration-calendly
description: Connect Calendly (event types, scheduled events, invitees, availability) to a self-hosted Hermes Agent over SSH using a static personal access token against the REST API. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-calendly — connect Calendly to a remote Hermes (SSH-first)

You are the engineer connecting Calendly to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Calendly is the agent's scheduling surface: event types,
booked events, invitee details, one-off links, availability windows. The user only does
the one thing a machine cannot: mint the personal access token in the Calendly UI.

Everything else — token storage, REST wiring (or community MCP if available), gateway
reload, verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Calendly ships an official hosted remote MCP
at `https://mcp.calendly.com`, but it is **OAuth-only** — Calendly's docs state the server
uses Dynamic Client Registration (RFC 7591) with OAuth 2.1 Authorization Code + PKCE, and
explicitly list "Non-OAuth bearer tokens (e.g. personal access tokens)" under **Not
Supported Today**. Self-hosting is also "not supported." That kills the one-click headless
path for a server-side agent, so we do **not** wire the hosted MCP. **No first-party
static-token MCP server verified as of 2026-06.** We use the REST API with a personal
access token (PAT) — the supported headless mode.

See <https://developer.calendly.com/calendly-mcp-server> (MCP auth model) and
<https://developer.calendly.com/how-to-authenticate-with-personal-access-tokens> (PAT flow).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$CALENDLY_TOKEN` | Personal access token (opaque bearer) | <https://calendly.com/integrations/api_webhooks> -> **Personal access tokens** -> **Generate new token** -> name it `hermes-agent` -> **Copy token**. Calendly does **not** redisplay PATs; if lost, revoke and remint. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci calendly" || echo 0)
HAS_SECRET=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CALENDLY_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY" -gt 0 ] || [ "$HAS_SECRET" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Calendly is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN -- the following will happen on $VPS_USER@$VPS_IP:
  1. Write CALENDLY_TOKEN (length ${#CALENDLY_TOKEN}, prefix ${CALENDLY_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Wire Calendly via REST (https://api.calendly.com) -- hosted MCP is OAuth-only and skipped
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "calendly" (env reload signal)
  6. Smoke test: GET https://api.calendly.com/users/me -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set CALENDLY_TOKEN '$CALENDLY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^CALENDLY_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: CALENDLY_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Calendly PATs are opaque and may contain `.`, `_`, `-`, `=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^CALENDLY_TOKEN=' ~/.hermes/.env || printf 'CALENDLY_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^CALENDLY_TOKEN=.*|CALENDLY_TOKEN=$CALENDLY_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — wire Calendly (REST is the supported headless path)

Pick the path that matches what is currently shipping. Path B is the verified default.

### Path A (only if a community static-token MCP server is verified)

If/when a community MCP server for Calendly with PAT/bearer auth is verified, register it:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add calendly \
    --url '<community-mcp-url>' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject real token with pipe delimiter (Calendly PATs may contain /+=)
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$CALENDLY_TOKEN\"'|g' ~/.hermes/config.yaml"
```

Do **not** point this at `https://mcp.calendly.com` -- that endpoint is OAuth-only (DCR +
PKCE) and rejects bearer tokens.

### Path B (verified default) — generic HTTP tool against the Calendly v2 REST API

- **Base URL:** `https://api.calendly.com`
- **Auth header:** `Authorization: Bearer ${CALENDLY_TOKEN}`
- **Content type:** `Content-Type: application/json`

Endpoints the agent will need:

| Verb | Path | Purpose |
|------|------|---------|
| GET  | `/users/me` | resolve the current user URI (cache it) |
| GET  | `/event_types?user=<user_uri>` | list bookable event types |
| GET  | `/scheduled_events?user=<user_uri>&min_start_time=<ISO>&status=active` | upcoming meetings |
| GET  | `/scheduled_events/{uuid}/invitees` | invitee email, name, answers |
| POST | `/scheduling_links` | mint a one-off booking link for an event type |
| GET  | `/user_availability_schedules?user=<user_uri>` | working hours |
| GET  | `/event_type_available_times?event_type=<uri>&start_time=<ISO>&end_time=<ISO>` | open slots (max 7-day window) |

The token reference stays in `~/.hermes/.env`; HTTP tool definitions read it as
`${CALENDLY_TOKEN}` -- never inline the value.

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

## Step 7 — verify the gateway picked up the new env (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*calendly|gateway.*ready|env.*reloaded"; then
    REGISTERED=1
    echo "OK: gateway is up and env is reloaded."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gateway did not signal ready in 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the VPS so the token stays on the box)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  set -a; . ~/.hermes/.env; set +a
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.calendly.com/users/me' \
    -H \"Authorization: Bearer \$CALENDLY_TOKEN\" \
    -H 'Content-Type: application/json'
")
case "$HTTP" in
  200) echo "OK: Calendly API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but scope/plan blocks /users/me. Confirm plan tier."; exit 1 ;;
  429) echo "WARN: rate limited. Honor Retry-After and rerun smoke test." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Calendly API. Check manually." ;;
esac
```

Optional second probe (listing scheduled events end-to-end):

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -a; . ~/.hermes/.env; set +a
  USER_URI=\$(curl -sS \
    -H \"Authorization: Bearer \$CALENDLY_TOKEN\" \
    'https://api.calendly.com/users/me' \
    | sed -n 's/.*\"uri\":\"\\([^\"]*\\)\".*/\\1/p' | head -1)
  curl -sS -o /dev/null -w 'scheduled_events=%{http_code}\n' \
    -H \"Authorization: Bearer \$CALENDLY_TOKEN\" \
    \"https://api.calendly.com/scheduled_events?user=\$USER_URI&status=active&count=1\"
"
```

`200` with a `collection` array (empty is fine) = the agent can read Calendly.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove calendly 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset CALENDLY_TOKEN 2>/dev/null || \
    sed -i '/^CALENDLY_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Calendly is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `mcp.calendly.com` with a PAT | The hosted MCP is **OAuth-only** (DCR + PKCE); bearer tokens are rejected | Use REST (Path B) or a verified community MCP (Path A) |
| 2 | Lost the token | Calendly does not redisplay PATs after generation | Save to `~/.hermes/.env` immediately; if lost, revoke and remint |
| 3 | Calls return `403` on listing endpoints | Many list endpoints require a `user` (or `organization`) URI query param | Always pass `?user=<uri>` resolved from `/users/me` |
| 4 | `event_type_available_times` returns `400` | Window is capped at 7 days and times must be ISO 8601 UTC | Send `start_time`/`end_time` as `YYYY-MM-DDTHH:MM:SS.000000Z`, <=7 days apart |
| 5 | Token has narrower scope than expected | PATs inherit the minting user's plan; Teams/Enterprise endpoints fail on Free | Confirm plan tier matches the endpoint (org scope needs Teams+) |
| 6 | Rate limits | Calendly throttles per-token; bursts get `429` with `Retry-After` | Backoff on `429`; honor `Retry-After` |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 9 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 10 | sed with `/` delimiter on tokens | PATs may contain `/+=` | Always use `\|` delimiter |
| 11 | Container vs host confusion | Keys/config added inside a container are invisible to host sshd; commands aimed at the host miss the container runtime | Check `whoami; hostname` before assuming layer |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `CALENDLY_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Calendly wired via REST `https://api.calendly.com` with `Authorization: Bearer ${CALENDLY_TOKEN}` (or community MCP if verified)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show gateway ready / env reloaded within 30s
- [ ] Smoke test: `GET /users/me` returned `200`; optional `/scheduled_events` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
