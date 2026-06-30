---
name: platform-mattermost
description: Wire a remote Hermes Agent to a self-hosted Mattermost server (bot access token + server URL, with correct Docker networking on a shared VPS) over SSH. Enforces a hard allowlist gate before enabling. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-mattermost — wire Mattermost to a remote Hermes (SSH-first)

You are the engineer connecting Mattermost to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does two things a machine cannot:

1. Create a Bot Account in Mattermost (System Console → Integrations → Bot Accounts).
2. Copy the bot's access token (shown ONCE on creation) and supply it.

Everything else — token storage, allowlist gate, Docker network linkage, gateway reload,
verification — runs on the VPS via SSH, idempotently with a rollback path.

**Honest picture (verified 2026-06):** Mattermost is typically self-hosted, often on the
same VPS as Hermes but in a separate Docker container. The common failure isn't auth — it's
**networking**: Hermes container cannot resolve the Mattermost container's public DNS (often
behind a CDN or a different IP on the host) so the bot can't reach the server. The fix is
to put both containers on the same Docker network and use the internal hostname.

**Pairing flow:** Some Hermes versions require an interactive `hermes pairing approve` step
the first time a new bot connects (a brief PIN/CODE printed on the Mattermost side that you
echo back). This skill handles both cases.

**Why the hard allowlist matters:** Without `MATTERMOST_ALLOWED_USERS`, anyone on the
Mattermost server can DM the bot. This skill refuses to enable until at least one
26-character Mattermost user ID is set.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MATTERMOST_URL` | Mattermost server URL — **internal Docker URL** if same host, else `https://...` (NO trailing slash) | E.g. `http://mattermost:8065` or `https://chat.example.com` |
| `$MATTERMOST_TOKEN` | Bot access token, shown ONCE on creation | Mattermost: System Console → Integrations → Bot Accounts → Add Bot → copy token |
| `$MATTERMOST_ALLOWED_USERS` | Comma-separated Mattermost user IDs (26-char alphanumeric) | In Mattermost: profile → Account Settings → URL has `/admin_console/user_management/users/<ID>` |
| `$MATTERMOST_HOME_CHANNEL` *(optional)* | Channel ID (26-char) for cron pings | Right-click channel → Copy Link → ID in the URL |
| `$MATTERMOST_NETWORK` *(optional)* | Docker network name if Mattermost is in another container on the same host | `docker network ls` on the VPS |

If `$MATTERMOST_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

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
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MATTERMOST_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MATTERMOST_URL=http' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MATTERMOST_TOKEN=.' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^MATTERMOST_ALLOWED_USERS=.+' ~/.hermes/.env 2>/dev/null | grep -cv 'MATTERMOST_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_URL" = "1" ] && [ "$HAS_TOKEN" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Mattermost already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + URL + token format)

```bash
if [ -z "${MATTERMOST_ALLOWED_USERS:-}" ]; then
  echo "ABORT: MATTERMOST_ALLOWED_USERS is empty. Mattermost would fail OPEN."
  echo "Supply 26-char user IDs, comma-separated. Find each via the Mattermost admin URL."
  exit 1
fi

# Mattermost IDs are 26 lowercase alphanumeric.
INVALID=$(printf '%s' "$MATTERMOST_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^[a-z0-9]{26}$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid Mattermost user IDs (must be 26 lowercase alphanumeric chars):"
  echo "$INVALID"
  exit 1
fi

# URL: must start with http(s)://, no trailing slash.
printf '%s' "$MATTERMOST_URL" | grep -qE '^https?://[^[:space:]]+[^/]$' \
  || { echo "ABORT: MATTERMOST_URL must be http(s)://host[:port] with NO trailing slash."; exit 1; }

# Token must be non-empty alphanumeric (Mattermost tokens are typically 26 chars).
[ "${#MATTERMOST_TOKEN}" -ge 20 ] \
  || { echo "ABORT: MATTERMOST_TOKEN looks too short (<20 chars). Did you paste the right token?"; exit 1; }
echo "Allowlist + URL + token-format OK."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$MATTERMOST_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. (If MATTERMOST_NETWORK supplied) docker network connect $MATTERMOST_NETWORK <hermes-container>
  2. Write MATTERMOST_URL ($MATTERMOST_URL)
  3. Write MATTERMOST_TOKEN (length ${#MATTERMOST_TOKEN}) — never printed in plaintext
  4. Write MATTERMOST_ALLOWED_USERS ($USERS_N user(s))
  5. Write MATTERMOST_HOME_CHANNEL (${MATTERMOST_HOME_CHANNEL:-none}) if supplied
  6. chmod 600 ~/.hermes/.env
  7. Verify all landed (grep -c)
  8. Pre-flight: curl --noproxy --max-time 5 \$MATTERMOST_URL/api/v4/system/ping
  9. ONLY NOW: MATTERMOST_ENABLED=true
 10. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
 11. Verify connection in logs; approve pairing if a PIN appears
 12. Smoke test: live DM from an allowlisted user; expect reply
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — link Docker networks if Hermes and Mattermost share the host

If both run as containers on the same VPS, the Hermes container must be on the same Docker
network as the Mattermost container — public DNS often points to a different IP (CDN, host
firewall) that the container cannot reach.

```bash
if [ -n "${MATTERMOST_NETWORK:-}" ]; then
  HERMES_CONTAINER=$(ssh "$VPS_USER@$VPS_IP" "docker ps --filter name=hermes --format '{{.Names}}' | head -1")
  [ -n "$HERMES_CONTAINER" ] || { echo "ABORT: no running hermes container found."; exit 1; }
  ssh "$VPS_USER@$VPS_IP" "
    docker network inspect '$MATTERMOST_NETWORK' >/dev/null 2>&1 \
      || { echo 'ABORT: docker network $MATTERMOST_NETWORK not found.'; exit 1; }
    docker network connect '$MATTERMOST_NETWORK' '$HERMES_CONTAINER' 2>&1 \
      | grep -v 'already exists' || true
  "
  echo "Hermes container '$HERMES_CONTAINER' is on network '$MATTERMOST_NETWORK'."
fi
```

---

## Step 6 — write secrets first (NOT enable yet)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_URL '$MATTERMOST_URL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_TOKEN '$MATTERMOST_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_ALLOWED_USERS '$MATTERMOST_ALLOWED_USERS'"
if [ -n "${MATTERMOST_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_HOME_CHANNEL '$MATTERMOST_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify all landed (returns the count, NEVER the values):

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(MATTERMOST_URL=http|MATTERMOST_TOKEN=.|MATTERMOST_ALLOWED_USERS=.|MATTERMOST_HOME_CHANNEL=.)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 3 ] || { echo "FAIL: secrets did not land (got $COUNT, need ≥3). Rolling back."; rollback; exit 1; }
echo "Mattermost secrets confirmed in ~/.hermes/.env."
```

> If your Hermes build lacks `config set`, use the safe sed pattern (pipe delimiter — tokens
> may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'MATTERMOST_URL=$MATTERMOST_URL' 'MATTERMOST_TOKEN=$MATTERMOST_TOKEN' 'MATTERMOST_ALLOWED_USERS=$MATTERMOST_ALLOWED_USERS'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put tokens in `config.yaml`.

---

## Step 7 — pre-flight: can the Hermes container reach Mattermost?

Before enabling, prove the network is connectable. This catches the #1 failure mode (DNS /
network mismatch) before the gateway reload, so logs are clean.

```bash
PING=$(ssh "$VPS_USER@$VPS_IP" "
  HERMES_CONTAINER=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  if [ -n \"\$HERMES_CONTAINER\" ]; then
    docker exec \"\$HERMES_CONTAINER\" curl -sS --max-time 5 -o /dev/null -w '%{http_code}' '$MATTERMOST_URL/api/v4/system/ping' || echo 000
  else
    curl -sS --max-time 5 -o /dev/null -w '%{http_code}' '$MATTERMOST_URL/api/v4/system/ping' || echo 000
  fi
")
case "$PING" in
  200) echo "OK: Mattermost reachable from Hermes." ;;
  000) echo "FAIL: cannot reach $MATTERMOST_URL from Hermes container. Did you link the Docker network (Step 5)?"; rollback; exit 1 ;;
  *)   echo "WARN: Mattermost ping returned HTTP $PING (expected 200). Continuing anyway." ;;
esac
```

---

## Step 8 — enable Mattermost (only after Step 7 passed)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 9 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 10 — verify connection + handle pairing if needed

```bash
CONNECTED=0
PAIRING_CODE=""
for i in $(seq 1 6); do
  LOG=$(ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1")
  if printf '%s' "$LOG" | grep -qiE 'mattermost.*(connected|ready|websocket established)'; then
    CONNECTED=1
    echo "OK: Mattermost connected."
    break
  fi
  PAIRING_CODE=$(printf '%s' "$LOG" | grep -iE 'pairing.*code|approve.*[A-Z0-9]{4,8}' | tail -1 | grep -oE '[A-Z0-9]{4,8}' | head -1)
  if [ -n "$PAIRING_CODE" ]; then
    echo "Pairing code detected: $PAIRING_CODE — approving..."
    ssh "$VPS_USER@$VPS_IP" "hermes pairing approve mattermost '$PAIRING_CODE'" || true
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Mattermost did not connect within 30s. Check token + network. Rolling back."; rollback; exit 1; }
```

---

## Step 11 — live smoke test (DM from an allowlisted user)

```bash
FIRST_USER=$(printf '%s' "$MATTERMOST_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Mattermost user ($FIRST_USER):
  1. Open Mattermost; find your bot in Direct Messages.
  2. Send "ping".
  3. The bot should reply within 5s.

If no reply: 'hermes logs gateway -n 50 | grep -i mattermost' on the VPS.
EOF

ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -i mattermost" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set MATTERMOST_ENABLED false 2>/dev/null || \
    sed -i 's|^MATTERMOST_ENABLED=true|MATTERMOST_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Mattermost disabled. Token + URL preserved."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^MATTERMOST_URL=/d;
            /^MATTERMOST_TOKEN=/d;
            /^MATTERMOST_ALLOWED_USERS=/d;
            /^MATTERMOST_HOME_CHANNEL=/d;
            /^MATTERMOST_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. All Mattermost config wiped."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Public DNS used for Mattermost on a shared VPS | Container can't resolve public IP (CDN, host firewall) → connection refused | Use internal Docker URL (`http://mattermost:8065`) + `docker network connect` (Step 5) |
| 2 | `MATTERMOST_ENABLED=true` before allowlist | Bot fails OPEN — any server user can DM | Step 3 hard-gate; Step 8 only fires after Step 7 passes |
| 3 | Trailing slash in URL | Hermes constructs `URL/api/v4/...` → double slash → 404 | Step 3 validator rejects trailing slash |
| 4 | Token treated as opaque secret but shown only once | Lose it = create a new bot | Store immediately on creation; this skill writes it to `~/.hermes/.env` and locks it 600 |
| 5 | Allowlist using `@handle` instead of 26-char ID | Allowlist matcher is exact-string on the ID | Step 3 validator requires `[a-z0-9]{26}` |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` (Step 9) |
| 7 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 6), or the documented sed pattern |
| 8 | Token in `config.yaml` | `config.yaml` often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 9 | Skipping the pairing approval | Connection sits in "waiting for approval" forever | Step 10 detects PIN/CODE in logs and auto-approves |
| 10 | Wrong protocol (http vs https) on a public install | Mixed-content / TLS errors | Match the actual Mattermost server config; public installs are usually https |
| 11 | sed with `/` delimiter on tokens | Mattermost tokens are alphanumeric, but URL has `/` | Always `\|` delimiter (universal rule) |
| 12 | Reverse proxy stripping headers | Behind nginx/Traefik, missing `X-Forwarded-Proto` breaks websocket | Configure proxy to forward `Upgrade`/`Connection`/`X-Forwarded-*` |
| 13 | Container vs host confusion | `hermes` inside a container is invisible to host SSH | Step 1 detects both |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if enabled + URL + token + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every ID is 26 lowercase alphanumeric; URL is `http(s)://...` with no trailing slash; token ≥20 chars
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] If `MATTERMOST_NETWORK` supplied: Hermes container connected to the Mattermost network
- [ ] All secrets written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Pre-flight ping `GET $MATTERMOST_URL/api/v4/system/ping` returned `200` from inside the Hermes container
- [ ] `MATTERMOST_ENABLED=true` set ONLY after pre-flight ping passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Connection confirmed in logs within 30s; pairing approved if a PIN appeared
- [ ] Live smoke: allowlisted user DM'd the bot and got a reply
- [ ] Rollback function defined (`rollback`: disable + keep secrets; `hard_rollback`: wipe everything)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Docker
network, and Mattermost-specific failure modes.
