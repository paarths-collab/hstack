---
name: integration-sendgrid
description: Connect SendGrid (transactional email) to a self-hosted Hermes Agent over SSH using a static v3 API key (SG.-prefixed). No first-party MCP — REST API (Path A, default) or community stdio MCP (Path B, opt-in). Enforces Restricted Access key + verified sender identity. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-sendgrid — connect SendGrid to a remote Hermes (SSH-first)

You are the engineer connecting SendGrid to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Mint the API key at https://app.sendgrid.com/settings/api_keys → **Restricted Access** →
   grant at minimum **Mail Send: Full Access** → copy ONCE.
2. Verify the sender identity (Domain Authentication OR Single Sender Verification) —
   without it, every `mail/send` returns `403 The from address does not match a verified
   Sender Identity`. This is a DNS or inbox-click step.

Everything else — credential storage, live scope + send verification, gateway reload,
smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** **No first-party SendGrid remote MCP server is
verified.** Twilio publishes a build-your-own tutorial and community stdio MCPs exist
(`Garoth/sendgrid-mcp`, `deyikong/sendgrid-mcp`) but nothing first-party hosted with bearer
auth. The clean headless path is the SendGrid v3 REST API with a static `SG.`-prefixed API
key at `https://api.sendgrid.com/v3`.

- **Path A (preferred — REST):** zero third-party code in trust path.
- **Path B (opt-in — community stdio MCP):** review source before granting Mail Send scope.

**202 is success:** `POST /v3/mail/send` returns HTTP 202 with an EMPTY BODY and an
`X-Message-Id` response header. Treating empty body as failure is the #2 SendGrid mistake.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SENDGRID_API_KEY` | API key starting with `SG.` | https://app.sendgrid.com/settings/api_keys → Create → Restricted Access → Mail Send: Full Access |
| `$SENDGRID_FROM` | Verified from-address (e.g. `noreply@yourdomain.com`) | Must be a verified sender (Domain Auth or Single Sender) |
| `$WIRE_PATH` *(optional)* | `A` (REST, default) or `B` (community stdio MCP) | B needs npx + source review |

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
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SENDGRID_API_KEY=SG\\.' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_FROM=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SENDGRID_FROM=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "$HAS_FROM" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "SendGrid already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key format + email shape + live scope check)

```bash
# Key format
printf '%s' "$SENDGRID_API_KEY" | grep -qE '^SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' \
  || { echo "ABORT: SENDGRID_API_KEY must start with 'SG.' and have two dot-separated segments."; exit 1; }

# From-address email shape
printf '%s' "$SENDGRID_FROM" | grep -qE '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' \
  || { echo "ABORT: SENDGRID_FROM must be a valid email address."; exit 1; }

# Live scope check: /v3/scopes must return 200 AND include mail.send
RESP=$(curl -sS -o /tmp/sg.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $SENDGRID_API_KEY" \
  'https://api.sendgrid.com/v3/scopes' 2>/dev/null) || RESP=000
case "$RESP" in
  200) ;;
  401) echo "ABORT: 401 — key rejected."; exit 1 ;;
  403) echo "ABORT: 403 — key valid but blocked (paused account? compliance review?)."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $RESP."; cat /tmp/sg.json | head -3; exit 1 ;;
esac

grep -q '"mail.send"' /tmp/sg.json \
  || { echo "ABORT: API key lacks 'mail.send' scope. Re-mint with Mail Send: Full Access."; exit 1; }
rm -f /tmp/sg.json
echo "SendGrid key OK, mail.send scope present."

# Path B: require npx
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path B requires npx on the VPS."; exit 1; }
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
    1. Write SENDGRID_API_KEY (length ${#SENDGRID_API_KEY}, prefix SG.) via 'hermes config set'
    2. Write SENDGRID_FROM ($SENDGRID_FROM)
    3. chmod 600 ~/.hermes/.env
    4. Verify both landed (grep -c)

  Path A (REST — default): no MCP register; generic HTTP tool reads env
  Path B (community stdio MCP): register 'sendgrid' with npx @garoth/sendgrid-mcp

  Always:
    5. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
    6. Smoke test: GET /v3/scopes (expect 200)
    7. Optional: send a real test email if TEST_TO env var set

Sender identity must be verified (Domain Auth or Single Sender). Unverified from = 403.
Key is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write env (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set SENDGRID_API_KEY '$SENDGRID_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set SENDGRID_FROM '$SENDGRID_FROM'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^(SENDGRID_API_KEY|SENDGRID_FROM)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "2" ] || { echo "FAIL: env vars did not land. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'SENDGRID_API_KEY=$SENDGRID_API_KEY' 'SENDGRID_FROM=$SENDGRID_FROM'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A (REST — default)

Generic HTTP tool layer reads env and calls:
- **Base URL:** `https://api.sendgrid.com/v3`
- **Auth:** `Authorization: Bearer ${SENDGRID_API_KEY}`
- **Content-Type:** `application/json`

Common endpoints:
- `POST /v3/mail/send` — send email (returns 202 + empty body + `X-Message-Id` header)
- `GET /v3/scopes` — key-validity check
- `GET /v3/stats` — volume/opens/clicks
- `GET /v3/templates` — dynamic templates
- `GET /v3/suppression/bounces` — deliverability

Minimal send body:
```json
{
  "personalizations": [{"to": [{"email": "user@example.com"}]}],
  "from": {"email": "noreply@yourdomain.com"},
  "subject": "Hello from Hermes",
  "content": [{"type": "text/plain", "value": "Test send."}]
}
```

### Path B (community stdio MCP, opt-in)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add sendgrid \
      --command 'npx' \
      --args '-y,@garoth/sendgrid-mcp' \
      --env 'SENDGRID_API_KEY=\${SENDGRID_API_KEY}'
  "
  echo "WARN: @garoth/sendgrid-mcp is unofficial. Review source before granting Mail Send scope in production."
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

## Step 8 — verify + optional real-send smoke test

```bash
# Scope check from VPS
SCOPE_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$SENDGRID_API_KEY\" \
    'https://api.sendgrid.com/v3/scopes'
")
[ "$SCOPE_HTTP" = "200" ] \
  && echo "OK: /v3/scopes reachable from VPS with key in env." \
  || { echo "FAIL: /v3/scopes $SCOPE_HTTP. Rolling back."; rollback; exit 1; }

# Optional real send (only if TEST_TO is set — user opts in)
if [ -n "${TEST_TO:-}" ]; then
  SEND_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
      -X POST 'https://api.sendgrid.com/v3/mail/send' \
      -H \"Authorization: Bearer \$SENDGRID_API_KEY\" \
      -H 'Content-Type: application/json' \
      -d '{\"personalizations\":[{\"to\":[{\"email\":\"$TEST_TO\"}]}],\"from\":{\"email\":\"'\$SENDGRID_FROM'\"},\"subject\":\"hstack sendgrid test\",\"content\":[{\"type\":\"text/plain\",\"value\":\"hello from hstack\"}]}'
  ")
  case "$SEND_HTTP" in
    202) echo "OK: real send returned 202 (accepted). Check $TEST_TO inbox + SendGrid Activity Feed." ;;
    403) echo "WARN: 403 — likely 'from address not verified'. Complete Domain Auth or Single Sender Verification." ;;
    *) echo "WARN: send returned $SEND_HTTP." ;;
  esac
fi

# Path B: also check MCP registered
if [ "${WIRE_PATH:-A}" = "B" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*sendgrid|MCP server.*sendgrid"; then
      REGISTERED=1; echo "OK: sendgrid MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: sendgrid MCP not in logs. Rolling back."; rollback; exit 1; }
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove sendgrid 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^SENDGRID_API_KEY=/d;
            /^SENDGRID_FROM=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the API key at https://app.sendgrid.com/settings/api_keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring a "SendGrid remote MCP" with bearer | No first-party hosted MCP verified | This skill uses REST (Path A) or community stdio (Path B, opt-in) |
| 2 | `403 from address does not match a verified Sender Identity` | Sender identity not verified | Complete Domain Auth or Single Sender Verification before testing |
| 3 | Treating empty 202 body as failure | `POST /v3/mail/send` returns 202 + empty body + `X-Message-Id` header | Check HTTP status only; capture `X-Message-Id` for tracing |
| 4 | Full Access key when only Mail Send needed | Lost key = full account compromise | Mint Restricted Access key with only `Mail Send: Full Access` |
| 5 | Sandbox / paused account (compliance review) | 403 with compliance message | Check https://app.sendgrid.com/ banner; complete account review |
| 6 | Missing `Content-Type: application/json` | Opaque 400 instead of parse error | Always set header on POST |
| 7 | Rate limits per plan | Bursts 429 | Honor `X-RateLimit-Reset`; back off |
| 8 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule (SG. keys contain `.` and `-` — safe with `\|`) | Always `\|` delimiter |
| 12 | Confusing Marketing Send with Mail Send (transactional) | Different endpoints (`/marketing/singlesends` vs `/mail/send`), different scopes | This skill wires transactional Mail Send only |
| 13 | Community stdio MCP unaudited | Third-party code with a Mail-Send key | Path B is opt-in via `WIRE_PATH=B`; user acknowledges risk |
| 14 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if both env vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: key starts `SG.` with 2 dot-segments; from-address is email-shaped; live `/v3/scopes` returned 200 and includes `mail.send`
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Both env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: no MCP registered; generic HTTP tool documented
- [ ] Path B: community stdio MCP registered with env-var indirection (user acknowledged unaudited)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v3/scopes` from VPS returned 200
- [ ] Optional real send (if `TEST_TO` set): `POST /v3/mail/send` returned 202
- [ ] Rollback function defined; key revocation URL included
- [ ] User informed of Sender Identity verification requirement + 202-is-success behavior

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, sender-
verification, and SendGrid rate-limit failure modes.
