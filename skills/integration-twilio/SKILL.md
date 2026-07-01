---
name: integration-twilio
description: Connect Twilio (SMS, voice, WhatsApp infra) to a self-hosted Hermes Agent over SSH using Account SID + API Key Secret against REST API (Basic auth, form-encoded). Refuses the docs-only hosted MCP. Warns on trial account limits and EU-residency URL. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-twilio — connect Twilio to a remote Hermes (SSH-first)

You are the engineer connecting Twilio to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does two things a machine cannot:

1. Mint API Key SID + Secret (preferred) at https://console.twilio.com/us1/account/keys-credentials/api-keys.
2. Approve WhatsApp Sender (if WhatsApp is in scope) or use sandbox `+14155238886`.

Everything else — credential storage, live REST verify, gateway reload, smoke test — runs on
the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Twilio's hosted MCP at `https://mcp.twilio.com/docs`
is **documentation-only and read-only** — per Twilio's own docs, "the server provides API
search and documentation retrieval. It does not execute API calls on your behalf." **So it
CANNOT send an SMS.** Wiring it as an executor is a common mistake this skill refuses.

The reliable headless path is the **REST API** at `https://api.twilio.com/2010-04-01` (or
`https://api.dublin.ie1.twilio.com/2010-04-01` for EU residency) with **HTTP Basic auth**
and **form-encoded bodies** (Twilio uses `x-www-form-urlencoded`, NOT JSON — the #2 mistake).

**API Key SID vs Auth Token:** Prefer **API Key SID (`SK...`) + Secret** for production —
revocable per-environment without rotating the account-wide Auth Token. Both use the same
Basic auth shape.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TWILIO_ACCOUNT_SID` | Account SID (starts `AC`, 34 chars) | Twilio Console dashboard |
| `$TWILIO_API_KEY` | API Key SID (starts `SK...`) — Basic auth username | https://console.twilio.com/us1/account/keys-credentials/api-keys → Create API Key |
| `$TWILIO_API_SECRET` | API Key Secret — Basic auth password | Same flow (shown ONCE) |
| `$TWILIO_FROM` | Sender: E.164 `+15551234567` OR Messaging Service SID `MG...` OR `whatsapp:+...` | Console → Phone Numbers OR Messaging → Services |
| `$TWILIO_REGION` *(optional)* | `us1` (default) or `ie1` (EU residency) | For EU data residency use `ie1` |

**Alternative:** if the user only has Auth Token (not API Key), use SID as username, Auth
Token as password. Set `$TWILIO_API_KEY=$TWILIO_ACCOUNT_SID` and `$TWILIO_API_SECRET=<auth-token>`.

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
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(TWILIO_ACCOUNT_SID|TWILIO_API_KEY|TWILIO_API_SECRET|TWILIO_FROM)=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$COUNT" = "4" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Twilio already wired (all 4 vars present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (SID format + live REST verify + sender format)

```bash
# SID format
printf '%s' "$TWILIO_ACCOUNT_SID" | grep -qE '^AC[0-9a-f]{32}$' \
  || { echo "ABORT: TWILIO_ACCOUNT_SID must be AC + 32 hex chars."; exit 1; }

# API Key format (either SK... or ACCOUNT_SID as fallback)
if printf '%s' "$TWILIO_API_KEY" | grep -qE '^SK[0-9a-f]{32}$'; then
  echo "Using API Key SID (SK...) — recommended."
elif [ "$TWILIO_API_KEY" = "$TWILIO_ACCOUNT_SID" ]; then
  echo "Using Account SID as Basic auth username (legacy Auth Token mode)."
else
  echo "ABORT: TWILIO_API_KEY must be either SK... or equal to \$TWILIO_ACCOUNT_SID."
  exit 1
fi

# Secret sanity
[ "${#TWILIO_API_SECRET}" -ge 20 ] \
  || { echo "ABORT: TWILIO_API_SECRET looks too short."; exit 1; }

# Sender format
case "$TWILIO_FROM" in
  \+[0-9]*|MG[0-9a-f]*|whatsapp:\+*) : ;;
  *) echo "ABORT: TWILIO_FROM must be E.164 (+15551234567), Messaging Service SID (MG...), or whatsapp:+..."; exit 1 ;;
esac

# Base URL by region
case "${TWILIO_REGION:-us1}" in
  us1) BASE='https://api.twilio.com/2010-04-01' ;;
  ie1) BASE='https://api.dublin.ie1.twilio.com/2010-04-01' ;;
  *) echo "ABORT: TWILIO_REGION must be 'us1' or 'ie1'."; exit 1 ;;
esac

# Live REST verify
HTTP=$(curl -sS -o /tmp/t.json -w '%{http_code}' --max-time 10 \
  -u "$TWILIO_API_KEY:$TWILIO_API_SECRET" \
  "$BASE/Accounts/$TWILIO_ACCOUNT_SID/Messages.json?PageSize=1" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    echo "Twilio REST OK. Region: ${TWILIO_REGION:-us1}"
    # Trial-account detection
    if grep -q '"status": "trial"' /tmp/t.json 2>/dev/null; then
      echo "WARN: trial account detected. Can only send to VERIFIED numbers. Upgrade or verify destinations."
    fi ;;
  401) echo "ABORT: 401 — Basic auth rejected. Check API Key + Secret pair."; exit 1 ;;
  404) echo "ABORT: 404 — Account SID '$TWILIO_ACCOUNT_SID' not found."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/t.json | head -3; exit 1 ;;
esac
rm -f /tmp/t.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write TWILIO_ACCOUNT_SID ($TWILIO_ACCOUNT_SID)
  2. Write TWILIO_API_KEY (${TWILIO_API_KEY:0:4}...)
  3. Write TWILIO_API_SECRET (length ${#TWILIO_API_SECRET}) — NEVER plaintext-logged
  4. Write TWILIO_FROM ($TWILIO_FROM)
  5. Write TWILIO_BASE ($BASE)
  6. chmod 600 ~/.hermes/.env
  7. Verify all 5 landed (grep -c)
  8. No MCP registered (mcp.twilio.com is docs-only; refused for executor)
  9. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
 10. Smoke test: GET Messages.json?PageSize=1 from VPS — expect 200
 11. Optional real SMS if TEST_TO env var set

Twilio uses form-encoded bodies (NOT JSON).
Base URL varies by region: us1 vs ie1.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TWILIO_ACCOUNT_SID '$TWILIO_ACCOUNT_SID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TWILIO_API_KEY '$TWILIO_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TWILIO_API_SECRET '$TWILIO_API_SECRET'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TWILIO_FROM '$TWILIO_FROM'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TWILIO_BASE '$BASE'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^TWILIO_(ACCOUNT_SID|API_KEY|API_SECRET|FROM|BASE)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "5" ] || { echo "FAIL: env vars did not all land (got $COUNT, need 5). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put secrets in `config.yaml`.

---

## Step 6 — wire the REST surface (no executor MCP to register)

Twilio hosted MCP is docs-only. Generic HTTP tool reads env and calls:

- **Base URL:** `${TWILIO_BASE}` (region-specific)
- **Auth:** HTTP Basic — `username=${TWILIO_API_KEY}`, `password=${TWILIO_API_SECRET}`
- **Content-Type:** `application/x-www-form-urlencoded` (NOT JSON)

Common endpoints:

| Action | Method + path |
|---|---|
| Send SMS | `POST /Accounts/{AccountSid}/Messages.json` — `To=&From=&Body=` |
| Send WhatsApp | same, but `From=whatsapp:+...` and `To=whatsapp:+...` |
| Place call | `POST /Accounts/{AccountSid}/Calls.json` — `To=&From=&Url=<TwiML URL>` |
| Lookup number | `GET https://lookups.twilio.com/v2/PhoneNumbers/{E.164}` (separate host) |
| List messages | `GET /Accounts/{AccountSid}/Messages.json?PageSize=20` |

For twilio-labs/mcp stdio (Path B, opt-in): `@twilio-alpha/mcp` npm package as stdio MCP —
document only, do not auto-wire (still alpha/unstable per Twilio labs).

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify + optional real-send smoke test

```bash
# Read-only ping from VPS
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -u \"\$TWILIO_API_KEY:\$TWILIO_API_SECRET\" \
    \"\$TWILIO_BASE/Accounts/\$TWILIO_ACCOUNT_SID/Messages.json?PageSize=1\"
")
[ "$HTTP" = "200" ] \
  && echo "OK: Twilio REST reachable from VPS." \
  || { echo "FAIL: HTTP $HTTP. Rolling back."; rollback; exit 1; }

# Optional real SMS send (only if TEST_TO set — user opts in)
if [ -n "${TEST_TO:-}" ]; then
  SEND_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
      -u \"\$TWILIO_API_KEY:\$TWILIO_API_SECRET\" \
      -X POST \
      --data-urlencode 'To=$TEST_TO' \
      --data-urlencode \"From=\$TWILIO_FROM\" \
      --data-urlencode 'Body=hstack twilio wiring check' \
      \"\$TWILIO_BASE/Accounts/\$TWILIO_ACCOUNT_SID/Messages.json\"
  ")
  case "$SEND_HTTP" in
    201) echo "OK: real SMS to $TEST_TO returned 201 (queued). Check the phone." ;;
    400) echo "WARN: 400 — check E.164 format on To/From." ;;
    *) echo "WARN: unexpected HTTP $SEND_HTTP." ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^TWILIO_ACCOUNT_SID=/d;
            /^TWILIO_API_KEY=/d;
            /^TWILIO_API_SECRET=/d;
            /^TWILIO_FROM=/d;
            /^TWILIO_BASE=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the API Key at https://console.twilio.com/us1/account/keys-credentials/api-keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `mcp.twilio.com/docs` and expecting SMS to send | It is docs-only; cannot execute API calls | This skill refuses; uses REST only |
| 2 | Sending JSON body to `/Messages.json` | Twilio expects `application/x-www-form-urlencoded`; JSON returns 400 | Always form-encoded bodies |
| 3 | `To`/`From` not in E.164 | Twilio rejects with 21211/21212 | Always `+<country><number>`; WhatsApp prefix `whatsapp:` |
| 4 | Auth Token used and never rotated | Account-wide compromise on leak | Use API Key SID (`SK...`) + Secret per env; revocable |
| 5 | WhatsApp from non-approved sender | 63007/63016 outside sandbox | Use sandbox `+14155238886` for tests; approved Sender for prod |
| 6 | EU customer using `api.twilio.com` (US1) | Data residency violation | Set `TWILIO_REGION=ie1` for IE1 endpoint |
| 7 | Trial account sending to unverified numbers | 21608 or silent drop | Verify destinations in Console, or upgrade |
| 8 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule (Twilio secrets are alnum but future-proof) | Always `\|` delimiter |
| 12 | `lookups.twilio.com` mixed up with `api.twilio.com` | Different host (v2 API) | Use `https://lookups.twilio.com/v2/PhoneNumbers/{E.164}` for lookups |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Confusing Account SID and API Key SID | Both start with `AC` or `SK` — different roles | Step 3 validator distinguishes; API Key preferred for auth |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if all 4 vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: Account SID is `AC+32hex`; API Key is `SK+32hex` (or fallback to Account SID); secret ≥20 chars; sender is E.164/MG/`whatsapp:+`; region valid; live `Messages.json` returned 200
- [ ] Trial account status detected + warned if applicable
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 5 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] No MCP server registered (correctly — hosted MCP is docs-only)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `Messages.json` from VPS returned 200
- [ ] Optional real SMS (if `TEST_TO` set): returned 201
- [ ] Rollback function defined; key revocation URL included
- [ ] User informed of form-encoded body requirement + region variant + trial-account limits

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Twilio
region, and E.164 formatting failure modes.
