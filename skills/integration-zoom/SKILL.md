---
name: integration-zoom
description: Connect Zoom (meetings, cloud recordings) to a running Hermes agent using Server-to-Server OAuth credentials. Use when the user wants Hermes to create, list, or fetch Zoom meetings and read cloud recording metadata.
---

# /integration-zoom — connect Zoom to Hermes

You are the engineer connecting Zoom to a running Hermes agent. Primary use is meetings and
recordings: create / list / fetch meetings, read past meeting metadata, list cloud recordings.
Work autonomously; stop only for what a machine cannot do: creating the Server-to-Server OAuth
app in the Zoom Marketplace and copying the three credentials out.

**Honest auth picture (verified 2026-06):** Zoom ships an official remote MCP server family
(<https://developers.zoom.us/docs/mcp/>), but it requires **OAuth 2.1 with PKCE** — a user-driven
browser flow. Zoom docs state: "your MCP client must include it as a Bearer token in the
Authorization header," but the token must come from an interactive OAuth handshake, not a static
secret. That breaks the headless promise for a server-side agent, so we do **not** wire the
hosted MCP via `/hermes-mcp-add`. Instead we drive the Zoom REST API directly using
**Server-to-Server OAuth** (S2S), which gives Hermes a renewable bearer token from three static
credentials.

**S2S scope caveat:** the `cloud_recording:*` scopes are **not available** to S2S apps. If the
user needs cloud recording access, you must create a **General** OAuth app instead (still
documented below in Step 3). Meetings, users, webinars, and reports work fine with S2S.

## Before you start — gather (ask once)

1. **Server-to-Server OAuth app credentials** — three values:
   - `ZOOM_ACCOUNT_ID`
   - `ZOOM_CLIENT_ID`
   - `ZOOM_CLIENT_SECRET`

   Mint them at <https://marketplace.zoom.us/develop/create> → **Server-to-Server OAuth** →
   **Create** → name the app → on the **App Credentials** tab copy all three values → on
   **Scopes** add at minimum `meeting:read:admin`, `meeting:write:admin`, `user:read:admin`
   (add `report:read:admin` for analytics). Click **Activate**. Account-level admin is required.
2. **Recording access?** If the user needs cloud recordings, the S2S app type will not work —
   note this and either drop the requirement or switch to a General OAuth app (interactive
   install required).
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log secrets):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
ACCOUNT_ID=<zoom-account-id>
CLIENT_ID=<zoom-client-id>
CLIENT_SECRET=<zoom-client-secret>
```

---

## Step 1 — store the three credentials in the Hermes runtime .env (chmod 600)

Write the secrets to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put credentials in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set ZOOM_ACCOUNT_ID "$ACCOUNT_ID"
docker exec -i -u hermes "$AGENT" hermes config set ZOOM_CLIENT_ID "$CLIENT_ID"
docker exec -i -u hermes "$AGENT" hermes config set ZOOM_CLIENT_SECRET "$CLIENT_SECRET"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify all three vars landed (each prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -cE '^ZOOM_(ACCOUNT|CLIENT)_ID=|^ZOOM_CLIENT_SECRET=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, use the sed pattern from
> `/hermes-mcp-add` (note the `|` delimiter — client secrets contain `/`, `+`, `=`):
> ```bash
> docker exec "$AGENT" sh -c "
>   for kv in 'ZOOM_ACCOUNT_ID=${ACCOUNT_ID}' 'ZOOM_CLIENT_ID=${CLIENT_ID}' 'ZOOM_CLIENT_SECRET=${CLIENT_SECRET}'; do
>     k=\${kv%%=*}
>     grep -q \"^\${k}=\" /opt/data/.env || printf '%s\n' \"\${k}=\" >> /opt/data/.env
>     sed -i \"s|^\${k}=.*|\${kv}|\" /opt/data/.env
>   done
>   chmod 600 /opt/data/.env"
> ```

---

## Step 2 — confirm credentials by minting a real access token

Zoom S2S returns a 1-hour bearer token. Run the mint inside the container so the secrets stay
in env and never appear in shell history.

```bash
docker exec -u hermes "$AGENT" sh -c '
  curl -sS -o /tmp/zoom_tok -w "%{http_code}\n" \
    -X POST "https://zoom.us/oauth/token" \
    -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" \
    -d "grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID"
  grep -q access_token /tmp/zoom_tok && echo OK || echo FAIL
  rm -f /tmp/zoom_tok'
```

- `200` + `OK` — credentials valid; you can mint tokens.
- `400 invalid_request` — `account_id` wrong or missing scopes; re-check Step 2 of Marketplace.
- `401 invalid_client` — `client_id` / `client_secret` mismatch; re-copy from App Credentials.
- `4300` (Zoom error) — app not Activated; click **Activate** in the Marketplace.

---

## Step 3 — connect Zoom. No first-party static-bearer MCP exists, so use the REST API.

**No first-party MCP server verified as of 2026-06 for headless server-to-server use.** Zoom's
hosted MCP servers (<https://developers.zoom.us/docs/mcp/>) require OAuth 2.1 + PKCE in a
user's browser; bearer-token-only clients cannot complete the handshake. Pick one of:

### Path A (recommended for meetings/users/webinars) — generic HTTP tool against Zoom REST

Point a generic HTTP/tool capability at the Zoom REST API. The agent mints a fresh access token
per request (or caches for ~55 minutes) using the credentials in `/opt/data/.env`.

- **Token endpoint:** `POST https://zoom.us/oauth/token` (Basic auth `$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET`,
  body `grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID`)
- **API base URL:** `https://api.zoom.us/v2`
- **Auth header on API calls:** `Authorization: Bearer <access_token>`
- **Common endpoints:**
  - `GET /users/{userId}/meetings` — list scheduled meetings (userId `me` works for the host)
  - `POST /users/{userId}/meetings` — create a meeting
  - `GET /meetings/{meetingId}` — fetch one meeting
  - `GET /past_meetings/{meetingId}` — past meeting details
  - `GET /report/users/{userId}/meetings` — usage reports

### Path B (only if recordings are required) — General OAuth app, interactive install

S2S cannot read cloud recordings. If the user needs `GET /users/{userId}/recordings` or
`GET /meetings/{meetingId}/recordings`, create a **General** OAuth app in the Marketplace, run
the interactive consent flow once to capture a refresh token, store `ZOOM_REFRESH_TOKEN` in
`/opt/data/.env` (same `hermes config set` flow as Step 1), and exchange it for access tokens
with `grant_type=refresh_token`. Flag this to the user — it requires a one-time browser step
that a headless agent cannot do alone.

### Path C (last resort) — community stdio MCP

Community stdio MCPs exist (e.g. `echelon-ai-labs/zoom-mcp` on GitHub). Treat as unaudited;
prefer Path A. If you do register one, use the stdio MCP pattern from `/integration-notion`
Path A, exporting `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` into the child env.

---

## Step 4 — reload the gateway so the new env is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new env is
re-read cleanly — same rule as `/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trying to wire the hosted Zoom MCP with a static bearer | Zoom MCP requires OAuth 2.1 + PKCE; no headless bearer path. | Drive the REST API directly (Path A). |
| 2 | Picking S2S then asking for cloud recordings | `cloud_recording:*` scopes are blocked for Server-to-Server OAuth apps. | Use a General OAuth app (Path B) or drop the requirement. |
| 3 | Caching the access token forever | S2S tokens expire after 3600 seconds and have no refresh token. | Re-mint on `401`, or refresh every ~55 minutes. |
| 4 | App created but token call returns `4300` | App was never Activated in the Marketplace. | Open the app → **Activation** tab → Activate. |
| 5 | Missing scopes show as `4711` on API calls | Scopes were not granted before activation. | Add scopes, re-activate, mint a new token. |
| 6 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` / sed. |
| 7 | Rate limits on heavy meeting lists | Zoom enforces per-account QPS limits; bursts get `429`. | Honor `Retry-After`; paginate with `next_page_token`. |

---

## Verify

Confirm credentials and a live call before declaring done.

1. **Token mint works (already done in Step 2).** Re-run if needed; expect `200` + `OK`.
2. **Real API call returns data.** Run inside the container so the token never appears in logs:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     TOK=$(curl -sS -X POST "https://zoom.us/oauth/token" \
       -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" \
       -d "grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" \
       | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $TOK" \
       "https://api.zoom.us/v2/users/me/meetings?page_size=1"'
   ```
   `200` = scopes correct, account active. `401` = bad / expired token. `4711` = missing scope.
3. **End-to-end from chat:** `@<agent> list my upcoming Zoom meetings` should return real
   meetings (or a valid empty list if the account has none scheduled).

---

## Definition of done

- [ ] `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` are all in `/opt/data/.env` with `chmod 600`; none in `config.yaml` or chat.
- [ ] Token mint at `https://zoom.us/oauth/token` returns `200` with an `access_token`.
- [ ] `GET /v2/users/me/meetings` returns `200` from inside the container.
- [ ] Chat-driven meeting list returns real data (or valid empty result).
- [ ] If recordings were requested, the user is told S2S cannot do it and Path B is documented.

See `reference/TROUBLESHOOTING.md` for gateway reload and OAuth credential failure modes.
