---
name: integration-zendesk
description: Connect Zendesk (support tickets, users, organizations, macros) to a self-hosted Hermes agent over SSH. Wires the Zendesk REST API with a static API token (Basic auth, email + `/token` suffix) because Zendesk does not yet ship a first-party headless MCP. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-zendesk — connect Zendesk to a remote Hermes (SSH-first)

You are the engineer connecting Zendesk to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the API token in Zendesk Admin Center (and turn on Token access).
2. Confirm the `*.zendesk.com` subdomain and the admin email the token belongs to.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Zendesk does **not** ship a first-party
remote MCP server with bearer-token auth. Their **MCP Client** (calling external MCP
servers from inside Zendesk) is in early access, and a first-party **MCP Server** is
announced for EAP in summer 2026 — not GA, no documented endpoint, no headless auth
shape. There are community npm packages (e.g. `zendesk-mcp-server`) that wrap the same
REST API documented here, but they are not first-party and not maintained by Zendesk;
vet before production use. The REST path is the verified headless option and matches
Zendesk's own developer docs for server-side automation.

**The #1 Zendesk gotcha — `/token` literal suffix on the email.** Zendesk API tokens use
HTTP **Basic** auth, but the username slot is not the email alone — it's
`<email>/token`. The string `/token` is a literal flag that tells Zendesk to treat the
password slot as an API token instead of an account password. Sending `email:token`
without the `/token` suffix returns 401 even with a perfectly valid token.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ZENDESK_SUBDOMAIN` | The `<subdomain>` part of `<subdomain>.zendesk.com` (no scheme, no `.zendesk.com`) | Browser URL when logged into Zendesk. Use the original `*.zendesk.com` host, NOT a vanity Help Center domain. |
| `$ZENDESK_EMAIL` | Admin email the token belongs to | The account whose permissions the agent will act under |
| `$ZENDESK_API_TOKEN` | Zendesk API token | **Admin Center** → **Apps and integrations** → **APIs** → **Zendesk API** → **Settings** tab → enable **Token access** → **Add API token** → copy (shown once). Requires admin role. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci zendesk" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Zendesk is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write ZENDESK_SUBDOMAIN=$ZENDESK_SUBDOMAIN, ZENDESK_EMAIL=$ZENDESK_EMAIL, and
     ZENDESK_API_TOKEN (length ${#ZENDESK_API_TOKEN}, prefix ${ZENDESK_API_TOKEN:0:4}...)
     via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add zendesk (Path A: community stdio MCP, or Path B: Zendesk REST)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*zendesk"
  6. Smoke test: GET https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json
     with Basic email/token:api_token → expect 200

The token is NEVER printed in plaintext. The base64 auth header is built on the VPS,
so the token never leaves ~/.hermes/.env.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_SUBDOMAIN '$ZENDESK_SUBDOMAIN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_EMAIL '$ZENDESK_EMAIL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set ZENDESK_API_TOKEN '$ZENDESK_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each (returns `1`, NEVER the value):

```bash
for k in ZENDESK_SUBDOMAIN ZENDESK_EMAIL ZENDESK_API_TOKEN; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^${k}=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $k not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern.
> Pipe delimiter is required — Zendesk API tokens contain `/`, `+`, and `=`, and the
> email contains `@`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for kv in 'ZENDESK_SUBDOMAIN=$ZENDESK_SUBDOMAIN' 'ZENDESK_EMAIL=$ZENDESK_EMAIL' 'ZENDESK_API_TOKEN=$ZENDESK_API_TOKEN'; do
>     k=\${kv%%=*}
>     grep -q \"^\${k}=\" ~/.hermes/.env || printf '%s\n' \"\${k}=\" >> ~/.hermes/.env
>     sed -i \"s|^\${k}=.*|\${kv}|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Zendesk endpoint

Pick the path that matches the Hermes build on the VPS. Path B (REST) is the primary
recommendation — it has no extra dependencies, matches Zendesk's own developer docs,
and is the only path verified against current (2026-06) Zendesk infrastructure. Path A
is a convenience wrapper on top of the same REST API.

### Path A (optional) — community stdio MCP server

Community packages such as `zendesk-mcp-server` wrap the same Zendesk REST API with a
tool surface (`zendesk_search_tickets`, `zendesk_get_ticket`, `zendesk_create_ticket`,
`zendesk_add_comment`, etc.). They are not first-party Zendesk; vet before production.
Credentials pass through indirection only:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add zendesk \
    --command npx \
    --args '-y,zendesk-mcp-server' \
    --env 'ZENDESK_SUBDOMAIN=\${ZENDESK_SUBDOMAIN}' \
    --env 'ZENDESK_EMAIL=\${ZENDESK_EMAIL}' \
    --env 'ZENDESK_API_TOKEN=\${ZENDESK_API_TOKEN}'
"
```

Flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax.

Do NOT try to wire a first-party Zendesk remote MCP today — none is GA. The summer-2026
EAP announcement does not include a documented endpoint or headless auth shape.

### Path B (preferred) — generic HTTP tool against Zendesk REST

- **Base URL:** `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2`
- **Method:** mostly `GET` / `POST` / `PUT`
- **Auth header:** `Authorization: Basic $(printf '%s' "${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}" | base64 -w0)`
  — **Basic, not Bearer**, and the username slot includes the literal `/token` suffix.
  Build the base64 blob on the VPS so the token never crosses the wire in plaintext.
- **Content type:** `Content-Type: application/json`
- **Accept:** `Accept: application/json`

Useful endpoints to surface to the agent:

| Verb | Path | Use |
|------|------|-----|
| GET | `/users/me.json` | Smoke test — returns the authenticated user, no scope needed |
| GET | `/tickets/{id}.json` | Fetch one ticket |
| GET | `/tickets/{id}/comments.json` | Full conversation thread |
| PUT | `/tickets/{id}.json` | Update status, assignee, tags, add a comment |
| POST | `/tickets.json` | Create a ticket |
| GET | `/search.json?query=type:ticket+status:open` | Search tickets, users, orgs |
| GET | `/users/search.json?query=...` | Find a user by email or name |
| GET | `/organizations/{id}.json` | Fetch one organization |

For list endpoints, append `?include=users,organizations,groups` to side-load related
records in one round-trip (see Pitfall 7).

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
       | grep -qiE "registered.*tool.*zendesk|MCP server.*zendesk.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: zendesk registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: zendesk not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the VPS so token + base64 stay there)

`GET /api/v2/users/me.json` is the canonical "is the token alive" probe — read-only, no
scope required, never mutates. We build the Basic header on the VPS so neither the token
nor the base64 blob is constructed locally.

```bash
RESP=$(ssh "$VPS_USER@$VPS_IP" "
  AUTH=\$(printf '%s/token:%s' \"\$ZENDESK_EMAIL\" \"\$ZENDESK_API_TOKEN\" | base64 -w0)
  curl -sS -w '\nHTTP:%{http_code}' \
    -X GET 'https://'\"\$ZENDESK_SUBDOMAIN\"'.zendesk.com/api/v2/users/me.json' \
    -H \"Authorization: Basic \$AUTH\" \
    -H 'Accept: application/json'
")
HTTP=$(printf '%s' "$RESP" | sed -n 's/^HTTP://p' | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

case "$HTTP" in
  200) echo "OK: Zendesk REST reachable, user resolved." ;;
  401) echo "FAIL: 401 — token invalid, Token access disabled in Admin Center, missing /token suffix on the email, or sent as Bearer. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: 403 — token valid but the account role is too low (likely not admin/agent for the endpoint)."; exit 1 ;;
  404) echo "FAIL: 404 — wrong ZENDESK_SUBDOMAIN. Confirm the *.zendesk.com host, not the vanity Help Center domain."; rollback; exit 1 ;;
  429) echo "WARN: rate-limited on the smoke test. Wait and re-run." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Zendesk REST. Body: $BODY" ;;
esac
```

`200` with a JSON body containing `user.id` and `user.email` = wired. `401` is almost
always one of: Token access toggled off, missing `/token` suffix, or wrong email pairing.
`404` on `/users/me.json` is nearly always the wrong subdomain.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove zendesk 2>/dev/null || true"
  for k in ZENDESK_SUBDOMAIN ZENDESK_EMAIL ZENDESK_API_TOKEN; do
    ssh "$VPS_USER@$VPS_IP" "hermes config unset $k 2>/dev/null || \
      sed -i '/^${k}=/d' ~/.hermes/.env"
  done
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Zendesk is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Missing literal `/token` suffix on the email | Zendesk treats the password slot as an account password and 401s, even with a valid API token | Username slot must be `<email>/token`, then `:<api_token>`, then base64 — exactly `printf '%s/token:%s' "$EMAIL" "$TOKEN" \| base64 -w0` |
| 2 | Sending `Authorization: Bearer $ZENDESK_API_TOKEN` | API tokens are Basic-auth credentials; Bearer is for OAuth access tokens only | Always `Basic <base64>`; only the OAuth flow uses Bearer |
| 3 | Token access toggled off in Admin Center | The token exists, but every call 401s with a generic message | Admin Center → APIs → Zendesk API → **Settings** tab → enable **Token access** |
| 4 | Subdomain confusion: vanity Help Center vs `*.zendesk.com` | Host-mapped Help Centers like `help.acme.com` route web traffic but API calls still need `acme.zendesk.com`. Wrong host returns 404 on every call before auth is even checked | Use the original `<subdomain>.zendesk.com` host. The subdomain is the `<subdomain>` part only — no scheme, no `.zendesk.com` |
| 5 | Sandbox subdomain mismatch | Zendesk sandboxes live at `<subdomain>sandbox<n>.zendesk.com` (or similar) with their own tokens. A production token on a sandbox host (or vice-versa) returns 401 | Confirm which environment the token was minted in; sandbox tokens stay in sandbox |
| 6 | Token owner role too low (agent vs admin) | Non-admin tokens can read most endpoints but cannot update tickets, manage users, or hit admin endpoints — returns 403 | Mint the token under an account with the role needed for the agent's work (admin for full coverage) |
| 7 | One round-trip per related record (no side-loading) | Each ticket has user, organization, group, assignee — fetching them individually multiplies calls and burns rate limit | Append `?include=users,organizations,groups,assignee` on list/show endpoints to side-load in one request |
| 8 | Soft-deleted tickets disappear silently | Zendesk soft-deletes tickets (recoverable for 30 days); `GET /tickets/{id}.json` returns 404 even though the row still exists in `deleted_tickets` | Use `GET /deleted_tickets.json` to find them; `PUT /deleted_tickets/{id}/restore.json` to recover |
| 9 | Custom field IDs differ per account | Every custom field has a numeric ID unique to that Zendesk instance; hard-coding IDs from one tenant into another fails silently or 400s | Discover via `GET /ticket_fields.json` per tenant; never reuse IDs across instances |
| 10 | Ticket comments are immutable | Once posted, a comment cannot be edited or deleted via API — only redacted (`PUT /tickets/{id}/comments/{cid}/redact.json` with PII scope) | Treat comments as append-only; redact, don't edit |
| 11 | Rate limits are plan-tiered and tight on lower plans | Default is 700 req/min/account on Suite Growth and above; Suite Team is much lower (~200/min). Bursts return `429` with `Retry-After` | Backoff on `429` honoring `Retry-After`; prefer one `/search.json` with `include=` over N round-trips; cache `/users/me.json` |
| 12 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 13 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL`, `ZENDESK_API_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Token access is enabled in Admin Center; token owner has the role the agent needs
- [ ] MCP registered via Path A (community stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'zendesk'` within 30s
- [ ] Smoke test: `GET https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/me.json` returned `200` with a `user.id`, using **Basic** with the `/token` suffix, built on the VPS
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
