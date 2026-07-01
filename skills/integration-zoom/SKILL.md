---
name: integration-zoom
description: Connect Zoom (meetings, users, webinars, reports) to a self-hosted Hermes Agent over SSH via Server-to-Server OAuth. Refuses the hosted MCP (OAuth+PKCE only). Warns explicitly if cloud recordings requested (S2S can't do them; requires General OAuth Path B). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-zoom — connect Zoom to a remote Hermes (SSH-first)

You are the engineer connecting Zoom to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does one thing a machine cannot: create the Server-to-Server
OAuth app in Zoom Marketplace, add scopes, activate, and copy the three credentials.

Everything else — credential storage, live token mint, gateway reload, smoke test — runs on
the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Zoom ships an official hosted MCP
(https://developers.zoom.us/docs/mcp/) but it requires **OAuth 2.1 + PKCE** — user browser
flow. Bearer-token clients cannot complete the handshake. So we do NOT wire the hosted MCP.
The headless path is **Server-to-Server OAuth (S2S)**: three static credentials mint a
1-hour bearer token per call.

**S2S scope caveat — CLOUD RECORDINGS NOT AVAILABLE.** The `cloud_recording:*` scopes are
BLOCKED for S2S apps. If cloud recordings are required, drop the requirement OR switch to a
**General** OAuth app (interactive install; Path B, documented).

**Token lifecycle:** S2S access tokens expire after 3600 seconds and have NO refresh token.
Re-mint on 401 or refresh every ~55 minutes.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ZOOM_ACCOUNT_ID` | S2S OAuth account ID | Zoom Marketplace → Develop → your S2S app → App Credentials |
| `$ZOOM_CLIENT_ID` | S2S OAuth client ID | Same |
| `$ZOOM_CLIENT_SECRET` | S2S OAuth client secret | Same |
| `$NEEDS_RECORDINGS` *(optional)* | `1` if cloud recordings needed | Skill aborts and points to Path B if S2S was chosen |

Zoom Marketplace setup:
1. https://marketplace.zoom.us/develop/create → Server-to-Server OAuth → Create → name it
2. App Credentials tab → copy Account ID, Client ID, Client Secret
3. Scopes: at minimum `meeting:read:admin`, `meeting:write:admin`, `user:read:admin`
   (add `report:read:admin` for analytics)
4. **Activate** the app (Activation tab)

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
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^ZOOM_(ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET)=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$COUNT" = "3" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Zoom already wired (all 3 creds present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (recording requirement + live S2S token mint)

```bash
# S2S cannot do cloud recordings — abort if requested
if [ "${NEEDS_RECORDINGS:-0}" = "1" ]; then
  echo "ABORT: NEEDS_RECORDINGS=1 but S2S OAuth cannot access cloud_recording:* scopes."
  echo "Options:"
  echo "  1. Drop the recording requirement and continue with S2S (meetings/users/webinars/reports work)."
  echo "  2. Create a General OAuth app in Zoom Marketplace (requires interactive browser install)."
  echo "     Docs: https://developers.zoom.us/docs/integrations/oauth/"
  echo "Set NEEDS_RECORDINGS=0 to proceed with S2S (no recordings)."
  exit 1
fi

# Basic sanity on the three vars
[ -n "$ZOOM_ACCOUNT_ID" ] && [ -n "$ZOOM_CLIENT_ID" ] && [ -n "$ZOOM_CLIENT_SECRET" ] \
  || { echo "ABORT: all 3 S2S credentials required."; exit 1; }
[ "${#ZOOM_CLIENT_SECRET}" -ge 20 ] \
  || { echo "ABORT: ZOOM_CLIENT_SECRET looks too short."; exit 1; }

# Live S2S token mint
RESP=$(curl -sS --max-time 10 \
  -X POST 'https://zoom.us/oauth/token' \
  -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" \
  -d "grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" 2>/dev/null) || true
if printf '%s' "$RESP" | grep -q '"access_token"'; then
  echo "Zoom S2S OK: token mint successful."
elif printf '%s' "$RESP" | grep -q 'invalid_client'; then
  echo "ABORT: invalid_client — CLIENT_ID/CLIENT_SECRET mismatch."; exit 1
elif printf '%s' "$RESP" | grep -q 'invalid_request'; then
  echo "ABORT: invalid_request — ACCOUNT_ID wrong or scopes missing. Re-check Marketplace."; exit 1
elif printf '%s' "$RESP" | grep -q '4300'; then
  echo "ABORT: 4300 — S2S app not activated. Open the app in Marketplace → Activation → Activate."; exit 1
else
  echo "ABORT: unexpected token response."; echo "$RESP" | head -3; exit 1
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write ZOOM_ACCOUNT_ID ($ZOOM_ACCOUNT_ID)
  2. Write ZOOM_CLIENT_ID ($ZOOM_CLIENT_ID)
  3. Write ZOOM_CLIENT_SECRET (length ${#ZOOM_CLIENT_SECRET}) — NEVER plaintext-logged
  4. chmod 600 ~/.hermes/.env
  5. Verify all 3 landed (grep -c)
  6. No MCP server registered (Zoom MCP is OAuth+PKCE, refused)
  7. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  8. Smoke test: mint token + GET /v2/users/me/meetings?page_size=1 — expect 200

S2S tokens live 3600s with NO refresh — REST tool must re-mint per expiry.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the 3 credentials (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ZOOM_ACCOUNT_ID '$ZOOM_ACCOUNT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZOOM_CLIENT_ID '$ZOOM_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZOOM_CLIENT_SECRET '$ZOOM_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^ZOOM_(ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "3" ] || { echo "FAIL: credentials did not all land (got $COUNT, need 3). Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter — secrets contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'ZOOM_ACCOUNT_ID=$ZOOM_ACCOUNT_ID' 'ZOOM_CLIENT_ID=$ZOOM_CLIENT_ID' 'ZOOM_CLIENT_SECRET=$ZOOM_CLIENT_SECRET'; do
>     K=\$(printf '%s' \"\$KV\" | cut -d= -f1)
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put secrets in `config.yaml`.

---

## Step 6 — REST surface (no MCP to register)

The Zoom hosted MCP is not reachable for headless Hermes. Generic HTTP tool reads env and:

- **Token endpoint:** `POST https://zoom.us/oauth/token` — Basic auth `$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET`, body `grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID` → returns `access_token` (expires 3600s)
- **API base:** `https://api.zoom.us/v2`
- **Auth on API calls:** `Authorization: Bearer <access_token>`

Common endpoints (S2S-compatible):
- `GET /users/{userId}/meetings` — list scheduled meetings (`me` = the host)
- `POST /users/{userId}/meetings` — create meeting
- `GET /meetings/{meetingId}` — fetch one meeting
- `GET /past_meetings/{meetingId}` — past meeting details
- `GET /report/users/{userId}/meetings` — usage reports

NOT S2S-compatible (require General OAuth Path B):
- `GET /users/{userId}/recordings`
- `GET /meetings/{meetingId}/recordings`

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (from inside the container)

```bash
RESULT=$(ssh "$VPS_USER@$VPS_IP" "
  . ~/.hermes/.env 2>/dev/null
  TOK=\$(curl -sS --max-time 10 -X POST 'https://zoom.us/oauth/token' \
    -u \"\$ZOOM_CLIENT_ID:\$ZOOM_CLIENT_SECRET\" \
    -d \"grant_type=account_credentials&account_id=\$ZOOM_ACCOUNT_ID\" \
    | sed -n 's/.*\"access_token\":\"\\([^\"]*\\)\".*/\\1/p')
  [ -z \"\$TOK\" ] && echo NO_TOKEN && exit 0
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$TOK\" \
    'https://api.zoom.us/v2/users/me/meetings?page_size=1'
")
case "$RESULT" in
  200) echo "OK: Zoom REST reachable from VPS (S2S token + /users/me/meetings)." ;;
  NO_TOKEN) echo "FAIL: no access_token minted. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: unexpected HTTP $RESULT." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^ZOOM_ACCOUNT_ID=/d;
            /^ZOOM_CLIENT_ID=/d;
            /^ZOOM_CLIENT_SECRET=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Rotate the S2S secret in Marketplace → App Credentials if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the hosted Zoom MCP with static bearer | Zoom MCP requires OAuth 2.1 + PKCE (browser) — no headless path | This skill refuses; uses REST only |
| 2 | S2S + cloud recordings | `cloud_recording:*` scopes BLOCKED for S2S | Step 3 hard-aborts on `NEEDS_RECORDINGS=1`; documents Path B (General OAuth) |
| 3 | Caching S2S token forever | Tokens die at 3600s, NO refresh | Tool must re-mint on 401 or every ~55min |
| 4 | App created but token 4300 error | App never Activated in Marketplace | Marketplace → Activation → Activate |
| 5 | 4711 on API calls | Scopes not granted before activation | Add scopes → re-activate → mint new token |
| 6 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 7 | Rate limits per-account QPS | Bursty meeting lists 429 | Honor `Retry-After`; paginate with `next_page_token` |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter | Secrets contain `/+=` | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Confusing Marketplace app types (JWT, OAuth, S2S, Meeting SDK) | Wrong app type = wrong flow | This skill is S2S only; note Path B requires General OAuth (interactive) |
| 13 | Missing `user:read:admin` scope | 401 on `/users/me/meetings` | Include in minimum scope set |
| 14 | Community stdio MCP `echelon-ai-labs/zoom-mcp` used unaudited | Third-party code with your S2S creds | Path C last resort; document only |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if all 3 creds present, unless `FORCE=1`)
- [ ] HARD GATE passed: NEEDS_RECORDINGS not set to 1 (or user directed to Path B); all 3 creds present + secret ≥20 chars; live S2S token mint returned an access_token
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All 3 creds written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] No MCP registered (correctly — Zoom MCP is OAuth+PKCE)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: token mint from VPS + `GET /v2/users/me/meetings?page_size=1` returned 200
- [ ] REST surface documented (token mint contract + S2S-compatible endpoints)
- [ ] User informed that recordings need Path B (General OAuth) and that S2S tokens die every hour
- [ ] Rollback function defined; secret rotation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, S2S
activation, and Zoom scope failure modes.
