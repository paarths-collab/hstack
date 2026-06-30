---
name: platform-teams
description: Wire a remote Hermes Agent to Microsoft Teams via Azure AD app registration and a public HTTPS webhook over SSH. Enforces a hard allowlist gate (AAD object IDs, GUID format) and a public-endpoint reachability check before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-teams — wire Microsoft Teams to a remote Hermes (SSH-first, AAD + public webhook)

You are the engineer connecting Microsoft Teams to a self-hosted Hermes agent on the user's
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user does four things a machine cannot:

1. Decide the **final** public HTTPS URL for the bot before creating the app registration
   (the endpoint is baked into the Azure AD app and changing it later requires updating
   the messaging endpoint manually).
2. Run the Teams CLI / portal flow to create the AAD app registration and copy the three
   values: `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`.
3. Find their AAD **object IDs** (GUIDs from Entra ID → Users → Object ID, NOT emails/UPNs).
4. Have a real domain + valid (non-self-signed) TLS cert in place — Teams refuses
   `localhost` and silently drops messages if the endpoint returns 5xx.

Everything else — secret storage, allowlist GUID validation, public-endpoint reachability
probe, gateway reload, smoke test — runs on the VPS via SSH, idempotently with a rollback.

**Honest picture (verified 2026-06 on Hermes v0.15.x/0.17.x):** Microsoft Teams is officially
supported by upstream Hermes (Teams adapter ships in v0.15.x). But unlike Telegram/Slack-
Socket-Mode/Discord, **Teams is not headless-friendly**:

- Teams delivers messages by **calling a public HTTPS webhook** (`POST /api/messages`).
- The Hermes instance needs a publicly reachable endpoint with a real TLS cert.
- Self-signed certs are rejected; `localhost` is rejected; 5xx responses are silently dropped.
- For local testing, use devtunnel / cloudflared / ngrok — but the endpoint URL gets baked
  into the AAD app, so dev/prod rotations mean re-registering or updating the app.

**Why the hard allowlist matters:** In an enterprise tenant, anyone who can find or install
the bot in Teams can drive it, executing skills and tools on their behalf, **unless**
`TEAMS_ALLOWED_USERS` holds at least one AAD object ID. This skill refuses to enable Teams
until the allowlist is set, validates every entry is a GUID, and aborts if
`TEAMS_ALLOW_ALL_USERS=true` is present (production footgun).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TEAMS_PUBLIC_URL` | The final public HTTPS URL the AAD app's messaging endpoint points to | E.g. `https://hermes.example.com/api/messages`. Pick BEFORE registering the app. |
| `$TEAMS_CLIENT_ID` | Azure AD application/client ID (GUID) | `teams app create --name Hermes --endpoint "$TEAMS_PUBLIC_URL"` output, OR Entra ID → App registrations → New |
| `$TEAMS_CLIENT_SECRET` | App secret (treat as password) | Same flow, shown once on creation |
| `$TEAMS_TENANT_ID` | Azure AD tenant ID (GUID) | Entra ID → Overview → Tenant ID |
| `$TEAMS_ALLOWED_USERS` | Comma-separated AAD object IDs (GUIDs, NOT emails/UPNs) | Entra ID → Users → <user> → Object ID, OR `teams status --verbose` |
| `$TEAMS_PORT` *(optional)* | Local port Hermes listens on for `/api/messages` (default `3978`) | Whatever your reverse proxy forwards to |
| `$TEAMS_HOME_CHANNEL` *(optional)* | Channel ID for cron pings | Right-click the channel → Get link to channel → ID in the URL |

If `$TEAMS_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TEAMS_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_CLIENT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^TEAMS_CLIENT_ID=[0-9a-fA-F]' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TENANT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^TEAMS_TENANT_ID=[0-9a-fA-F]' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^TEAMS_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'TEAMS_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_CLIENT" = "1" ] && [ "$HAS_TENANT" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Teams already wired (enabled, app registration, allowlist set). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + GUID format + no TEAMS_ALLOW_ALL_USERS)

```bash
if [ -z "${TEAMS_ALLOWED_USERS:-}" ]; then
  echo "ABORT: TEAMS_ALLOWED_USERS is empty. Teams would fail OPEN — anyone in the tenant could drive the bot."
  echo "Supply AAD object IDs (GUIDs), comma-separated. Find them in Entra ID → Users → Object ID."
  exit 1
fi

# AAD object IDs are GUIDs: 8-4-4-4-12 hex chars
INVALID=$(printf '%s' "$TEAMS_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid AAD object IDs (must be GUIDs, not emails/UPNs):"
  echo "$INVALID"
  echo "Find each user's object ID in Entra ID → Users → <user> → Object ID."
  exit 1
fi

# Validate the three Azure values are GUIDs (CLIENT_ID + TENANT_ID), SECRET is opaque ≥20 chars
for V in TEAMS_CLIENT_ID TEAMS_TENANT_ID; do
  eval "VAL=\$$V"
  printf '%s' "$VAL" | grep -qE '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' \
    || { echo "ABORT: $V is not a GUID."; exit 1; }
done
[ "${#TEAMS_CLIENT_SECRET}" -ge 20 ] \
  || { echo "ABORT: TEAMS_CLIENT_SECRET looks too short (<20 chars). Did you paste the right value?"; exit 1; }

# Public URL must be HTTPS and end in /api/messages
printf '%s' "$TEAMS_PUBLIC_URL" | grep -qE '^https://[^[:space:]]+/api/messages$' \
  || { echo "ABORT: TEAMS_PUBLIC_URL must be HTTPS and end in /api/messages."; exit 1; }

# Refuse TEAMS_ALLOW_ALL_USERS=true in env (production footgun)
EXISTING_ALL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TEAMS_ALLOW_ALL_USERS=true' ~/.hermes/.env 2>/dev/null" || echo 0)
[ "$EXISTING_ALL" = "0" ] \
  || { echo "ABORT: TEAMS_ALLOW_ALL_USERS=true is present in ~/.hermes/.env. Remove it before enabling for production."; exit 1; }

echo "Allowlist + GUIDs + URL OK. TEAMS_ALLOW_ALL_USERS=true is NOT present."
```

---

## Step 4 — public-endpoint reachability pre-flight (BEFORE writing env)

Teams will silently drop messages if the endpoint isn't reachable from the public internet
with a valid TLS cert. Check from outside the VPS:

```bash
PROBE=$(curl -sS -o /dev/null -w '%{http_code}\n%{ssl_verify_result}\n' --max-time 10 -I "$TEAMS_PUBLIC_URL" 2>&1) || true
HTTP=$(printf '%s' "$PROBE" | sed -n '1p')
TLS=$(printf '%s' "$PROBE" | sed -n '2p')
case "$HTTP" in
  401|405|200) echo "OK: $TEAMS_PUBLIC_URL is reachable (HTTP $HTTP — expected 401/405 from unsigned GET)." ;;
  000)         echo "FAIL: $TEAMS_PUBLIC_URL is not reachable from the public internet (timeout / DNS / cert)."; exit 1 ;;
  *)           echo "WARN: unexpected HTTP $HTTP from $TEAMS_PUBLIC_URL. Continuing anyway." ;;
esac
[ "${TLS:-0}" = "0" ] || echo "WARN: TLS verify result was $TLS (non-zero may mean self-signed). Teams requires a real cert."
```

---

## Step 5 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$TEAMS_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
PORT=${TEAMS_PORT:-3978}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write TEAMS_CLIENT_ID ($TEAMS_CLIENT_ID — public GUID) via 'hermes config set'
  2. Write TEAMS_CLIENT_SECRET (length ${#TEAMS_CLIENT_SECRET}) — NEVER printed in plaintext
  3. Write TEAMS_TENANT_ID ($TEAMS_TENANT_ID — public GUID)
  4. Write TEAMS_PORT ($PORT)
  5. Write TEAMS_ALLOWED_USERS ($USERS_N user(s))
  6. Write TEAMS_HOME_CHANNEL (${TEAMS_HOME_CHANNEL:-none}) if supplied
  7. chmod 600 ~/.hermes/.env
  8. Verify all landed (grep -c)
  9. ONLY NOW: TEAMS_ENABLED=true (gated on Step 3 + Step 4)
 10. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
 11. Verify Teams adapter loaded + smoke test from allowlisted AAD user
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 6 — write secrets first (NOT enable yet)

```bash
PORT=${TEAMS_PORT:-3978}
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_CLIENT_ID '$TEAMS_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_CLIENT_SECRET '$TEAMS_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_TENANT_ID '$TEAMS_TENANT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_PORT '$PORT'"
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_ALLOWED_USERS '$TEAMS_ALLOWED_USERS'"
if [ -n "${TEAMS_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_HOME_CHANNEL '$TEAMS_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns the count, NEVER the values):

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(TEAMS_CLIENT_ID=[0-9a-fA-F]|TEAMS_CLIENT_SECRET=.|TEAMS_TENANT_ID=[0-9a-fA-F]|TEAMS_PORT=[0-9]|TEAMS_ALLOWED_USERS=.|TEAMS_HOME_CHANNEL=.)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 5 ] || { echo "FAIL: Teams config did not land (got $COUNT, need ≥5). Rolling back."; rollback; exit 1; }
echo "Teams config confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use the safe sed pattern (pipe delimiter — the
> client secret may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'TEAMS_CLIENT_ID=$TEAMS_CLIENT_ID' 'TEAMS_CLIENT_SECRET=$TEAMS_CLIENT_SECRET' 'TEAMS_TENANT_ID=$TEAMS_TENANT_ID'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put `TEAMS_CLIENT_SECRET` in `config.yaml`.

---

## Step 7 — enable Teams (only after Step 6 verification passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 8 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 9 — verify Teams adapter + endpoint health

```bash
# (1) Hermes-side: Teams adapter loaded?
ADAPTER=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes gateway status 2>&1 | grep -i teams" \
       || ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1 | grep -qiE 'teams.*(loaded|listening|adapter ready)'"; then
    ADAPTER=1
    echo "OK: Teams adapter loaded in Hermes."
    break
  fi
  sleep 5
done
[ "$ADAPTER" = "1" ] || { echo "FAIL: Teams adapter did not load. Rolling back."; rollback; exit 1; }

# (2) Public endpoint health re-check after enable
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$TEAMS_PUBLIC_URL")
case "$HTTP" in
  401|405|200) echo "OK: public endpoint healthy (HTTP $HTTP)." ;;
  *) echo "WARN: public endpoint returned HTTP $HTTP. Teams may silently drop messages until this is fixed." ;;
esac
```

---

## Step 10 — live smoke test (AAD user DMs the bot)

```bash
FIRST_USER=$(printf '%s' "$TEAMS_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from an allowlisted AAD user (object ID $FIRST_USER):
  1. Open Microsoft Teams in that user's account.
  2. Search for the bot by app name (whatever you registered in Teams CLI / Entra).
  3. DM "hello".
  4. Expect a reply within 5s.

If silent:
  - 'hermes logs gateway -n 50 | grep -i teams' on the VPS for incoming POSTs
  - From outside the VPS: 'curl -I $TEAMS_PUBLIC_URL' — expect 401/405, NOT timeout/TLS error
  - Confirm the app is installed in the user's Teams tenant (App Studio or admin-uploaded)
  - Confirm the user's AAD Object ID is the GUID in TEAMS_ALLOWED_USERS (not their email)
EOF

ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -i teams" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set TEAMS_ENABLED false 2>/dev/null || \
    sed -i 's|^TEAMS_ENABLED=true|TEAMS_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Teams disabled. AAD app registration + secret preserved."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^TEAMS_CLIENT_ID=/d;
            /^TEAMS_CLIENT_SECRET=/d;
            /^TEAMS_TENANT_ID=/d;
            /^TEAMS_PORT=/d;
            /^TEAMS_ALLOWED_USERS=/d;
            /^TEAMS_HOME_CHANNEL=/d;
            /^TEAMS_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. All Teams env wiped. To fully decommission, also delete the Azure AD app registration."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `TEAMS_ENABLED=true` before allowlist | Anyone in the tenant can drive the bot — enterprise data exposure | Step 3 hard-abort; Step 7 only after Step 6 |
| 2 | `TEAMS_ALLOW_ALL_USERS=true` left in env | Bypasses allowlist entirely | Step 3 grep-fail if present |
| 3 | Allowlist using emails/UPNs instead of AAD object IDs | Allowlist matcher is exact-string on GUIDs | Step 3 validator requires GUID format |
| 4 | Endpoint hosted on `localhost` or self-signed TLS | Teams refuses both — messages never arrive | Step 4 reachability probe from outside the VPS |
| 5 | `TEAMS_PUBLIC_URL` changed after AAD registration | Old endpoint baked into the app; new endpoint receives traffic but Teams routes to old | Pick the final URL FIRST, register once |
| 6 | 5xx response from the endpoint | Teams silently drops — looks like the bot is ignoring you | Step 9 re-checks endpoint health post-enable |
| 7 | `TEAMS_CLIENT_SECRET` in `config.yaml` | Secret often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Reverse proxy not forwarding `/api/messages` | Endpoint exists but Hermes never sees POSTs | Test with `curl -X POST https://host/api/messages` (expect 401) |
| 9 | `gateway restart` instead of `stop`+`run` | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 8) |
| 10 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 6), or the documented sed pattern |
| 11 | App not installed in the user's tenant | User can't find the bot to DM | Operator must side-load the app (Teams App Studio or admin upload) |
| 12 | Client secret expired (Azure rotates) | Endpoint returns 401 from Teams; messages drop | Rotate secret in Entra ID, re-run with `FORCE=1` |
| 13 | Two `.env` files (compose + runtime) | Teams vars in the wrong one don't load | Always `~/.hermes/.env` (host) or `/opt/data/.env` (container) |
| 14 | sed with `/` delimiter on client secret | Secrets contain `/+=` | Always `\|` delimiter |
| 15 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both via `docker ps` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + app reg + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every entry is a GUID, `TEAMS_CLIENT_ID`/`TEAMS_TENANT_ID` are GUIDs, `TEAMS_CLIENT_SECRET` ≥20 chars, `TEAMS_PUBLIC_URL` is HTTPS ending in `/api/messages`, `TEAMS_ALLOW_ALL_USERS=true` NOT present
- [ ] Public-endpoint pre-flight: `curl -I $TEAMS_PUBLIC_URL` returned 401/405/200 (NOT timeout/TLS error)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 5-7 keys written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `TEAMS_ENABLED=true` set ONLY after Step 6 verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Teams adapter loaded in Hermes (confirmed in `gateway status` or logs)
- [ ] Public endpoint still healthy post-enable
- [ ] Live smoke: allowlisted AAD user DM'd the bot and got a reply
- [ ] Rollback function defined (`rollback`: disable in Hermes, keep app reg; `hard_rollback`: full env wipe)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, AAD,
and public-endpoint failure modes.
