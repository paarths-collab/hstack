---
name: integration-pipedrive
description: Connect Pipedrive CRM (SMB sales) to a self-hosted Hermes Agent over SSH using a personal API token, so the agent can read and update deals, people, organizations, and activities. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-pipedrive — connect Pipedrive CRM to a remote Hermes (SSH-first)

You are the engineer connecting Pipedrive to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not on the
local machine. The user only does the one thing a machine cannot: mint the personal API
token in the Pipedrive UI.

**Honest auth picture (verified 2026-06):** there is **no first-party Pipedrive MCP
server**, and the most-cited community server (`@nubiia/mcp-pipedrive`) is **local
stdio only** — it cannot be wired as a remote HTTP MCP. The supported path is therefore
a static personal API token written to `~/.hermes/.env`, with the agent calling the
Pipedrive REST API directly via Path B. A remote MCP option exists at Pipedream
(`https://mcp.pipedream.com/app/pipedrive`) but it is **OAuth-backed** and needs four
extra routing headers — it breaks the one-token promise, so it is documented as an
alternative in Path A only when the user already runs Pipedream Connect.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PIPEDRIVE_API_TOKEN` | 40-char hex personal API token | <https://app.pipedrive.com/settings/api> (account top-right > Company settings > Personal preferences > API; API access must be enabled for the company) |
| `$PIPEDRIVE_COMPANY_DOMAIN` | Subdomain in the Pipedrive URL, e.g. `acme` for `acme.pipedrive.com` | The URL the user logs in at |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci pipedrive" || echo 0)
HAVE_ENV=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^PIPEDRIVE_API_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY" -gt 0 ] || [ "$HAVE_ENV" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Pipedrive is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write PIPEDRIVE_API_TOKEN (length ${#PIPEDRIVE_API_TOKEN}, prefix ${PIPEDRIVE_API_TOKEN:0:4}...) via 'hermes config set'
  2. Write PIPEDRIVE_COMPANY_DOMAIN=$PIPEDRIVE_COMPANY_DOMAIN via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register REST endpoint (Path B): https://$PIPEDRIVE_COMPANY_DOMAIN.pipedrive.com/api/v2
     header x-api-token: \${PIPEDRIVE_API_TOKEN}
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*pipedrive"
  7. Smoke test: GET /v1/users/me → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set PIPEDRIVE_API_TOKEN '$PIPEDRIVE_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set PIPEDRIVE_COMPANY_DOMAIN '$PIPEDRIVE_COMPANY_DOMAIN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^PIPEDRIVE_API_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: PIPEDRIVE_API_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with
> **pipe delimiter** (Pipedrive tokens are hex, but later secrets often contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^PIPEDRIVE_API_TOKEN=' ~/.hermes/.env || printf 'PIPEDRIVE_API_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^PIPEDRIVE_API_TOKEN=.*|PIPEDRIVE_API_TOKEN=$PIPEDRIVE_API_TOKEN|' ~/.hermes/.env
>   grep -q '^PIPEDRIVE_COMPANY_DOMAIN=' ~/.hermes/.env || printf 'PIPEDRIVE_COMPANY_DOMAIN=\n' >> ~/.hermes/.env
>   sed -i 's|^PIPEDRIVE_COMPANY_DOMAIN=.*|PIPEDRIVE_COMPANY_DOMAIN=$PIPEDRIVE_COMPANY_DOMAIN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```
> Never use `echo >>` — an un-newlined file glues the key onto the previous line.

---

## Step 5 — register Pipedrive so the agent can call it

Pick the path that matches the Hermes build and the user's stack. Path B is preferred
because there is no first-party Pipedrive MCP and Path A's only option is OAuth.

### Path A (only for users already on Pipedream Connect) — Pipedream-hosted OAuth MCP

A maintained remote MCP exists at `https://mcp.pipedream.com/app/pipedrive`
(Pipedream Connect, streamable HTTP). It does **not** fit the clean single-token shape:
every request needs a developer **OAuth Bearer** access token (from Pipedream client
credentials) **plus** four routing headers:

- `x-pd-project-id: <pd-project>`
- `x-pd-environment: <pd-env>`
- `x-pd-external-user-id: <end-user-id>`
- `x-pd-app-slug: pipedrive`

The end user's Pipedrive account is linked through Pipedream's managed OAuth flow, not
the API token above. Only choose this if the user already runs Pipedream Connect and
explicitly wants managed OAuth. If so:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add pipedrive \
    --url 'https://mcp.pipedream.com/app/pipedrive' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder' \
    --header 'x-pd-project-id:<pd-project>' \
    --header 'x-pd-environment:<pd-env>' \
    --header 'x-pd-external-user-id:<end-user-id>' \
    --header 'x-pd-app-slug:pipedrive'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$MCP_PIPEDRIVE_BEARER\"'|g' ~/.hermes/config.yaml"
```

Be explicit with the user that this is OAuth, not the static API token from Step 4.

### Path B (preferred) — generic HTTP tool against the Pipedrive REST API

There is no first-party Pipedrive MCP, and `@nubiia/mcp-pipedrive` is local stdio only,
so point the agent's generic HTTP/tool capability at Pipedrive's REST directly:

- **Base URL:** `https://${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v2`
- **Auth header:** `x-api-token: ${PIPEDRIVE_API_TOKEN}` on every request
  (**NOT** `Authorization: Bearer` — that silently 401s).
- Pipedrive also accepts `?api_token=` as a query param, but the header keeps the token
  out of logs and URLs — prefer the header.
- **Useful v2 endpoints:** `GET /deals`, `GET /persons`, `GET /organizations`,
  `GET /activities`, `POST /deals`, `PATCH /deals/{id}`.
- **v1 fallback:** a few endpoints still live only on v1 (e.g. `GET /v1/users/me`);
  fall back to `/api/v1/...` when a v2 path 404s.

Register the REST endpoint as a generic tool/skill so the agent reads the env vars:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add pipedrive \
    --rest-base 'https://\${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v2' \
    --auth-header 'x-api-token' \
    --auth-env 'PIPEDRIVE_API_TOKEN'
" || echo "NOTE: this Hermes build may use a different REST-tool syntax; run 'hermes mcp add --help' and adapt."
```

The token stays in `~/.hermes/.env` and is referenced via `${PIPEDRIVE_API_TOKEN}`
indirection — never inlined into `config.yaml`.

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
       | grep -qiE "registered.*pipedrive|MCP server.*pipedrive.*(ok|ready)|tool.*pipedrive.*loaded"; then
    REGISTERED=1
    echo "OK: pipedrive registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: pipedrive not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

`/users/me` is the most reliable probe — it lives on v1, hits the company domain, and
proves both the token and the domain. An empty `data` array on `/deals` is also a pass.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v1/users/me' \
    -H \"x-api-token: \$PIPEDRIVE_API_TOKEN\"
")
case "$HTTP" in
  200) echo "OK: Pipedrive REST reachable and token valid." ;;
  401) echo "FAIL: token invalid, expired, or rotated. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but lacks permission on this user."; exit 1 ;;
  404) echo "FAIL: wrong company subdomain ($PIPEDRIVE_COMPANY_DOMAIN). DNS/path 404."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Pipedrive. Check manually." ;;
esac
```

Optional second probe — confirm a real data endpoint:

```bash
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w 'deals=%{http_code}\n' \
    -X GET 'https://${PIPEDRIVE_COMPANY_DOMAIN}.pipedrive.com/api/v2/deals?limit=1' \
    -H \"x-api-token: \$PIPEDRIVE_API_TOKEN\"
"
```

`200` with an empty `data` array means the wiring is correct and the account simply has
no deals yet — not a failure.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove pipedrive 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset PIPEDRIVE_API_TOKEN 2>/dev/null || \
    sed -i '/^PIPEDRIVE_API_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset PIPEDRIVE_COMPANY_DOMAIN 2>/dev/null || \
    sed -i '/^PIPEDRIVE_COMPANY_DOMAIN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Pipedrive is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using `Authorization: Bearer <token>` | Pipedrive's REST uses a custom header; Bearer silently 401s | Always send `x-api-token: ${PIPEDRIVE_API_TOKEN}` |
| 2 | Calling `api.pipedrive.com` or the wrong subdomain | Company-domain base is mandatory; bare host gives 404/DNS, not a clear auth error | Always use `https://<company>.pipedrive.com` |
| 3 | One active personal token per user | Regenerating in Settings instantly kills the old token; every integration breaks | Re-run Step 2 on rotation; consider a dedicated agent user |
| 4 | Token = full account access | Personal API tokens are unscoped and inherit the user's permissions | Use a dedicated low-privilege Pipedrive user for the agent |
| 5 | Rate-limit budget exhaustion (HTTP 429) | Pipedrive uses a per-company "request cost" budget per window; polling burns it fast | Back off on 429; batch via filters/limits; cache where possible |
| 6 | Claiming a first-party MCP exists | None is verified as of 2026-06; sets a false expectation | Use Path B (REST); only mention Path A (Pipedream) as OAuth, not "one-click" |
| 7 | Trying to wire `@nubiia/mcp-pipedrive` as an HTTP MCP | It is **local stdio only**; `/hermes-mcp-add` expects remote HTTP | Use Path B REST, or run stdio outside Hermes |
| 8 | v2-only assumption | A few endpoints (e.g. `/users/me`) still only exist on v1 | Fall back to `/api/v1/...` when a v2 path 404s |
| 9 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 10 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 11 | `echo "TOKEN=..." >> .env` | Un-newlined file glues the key onto a prior line; SSH/parsing silently invalid | Always `hermes config set` or the `printf`/`sed` pattern above |
| 12 | sed with `/` delimiter on tokens | Pipedrive tokens are hex, but later secrets contain `/+=` and break the pattern | Always use `\|` delimiter |
| 13 | Container vs host confusion | SSH lands in a container; changes invisible to the host gateway | `whoami; hostname` first; exit any nested container |
| 14 | Skipping the verify step | "Silent success" — config written, never picked up | Always wait + grep logs + smoke test |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `PIPEDRIVE_API_TOKEN` and `PIPEDRIVE_COMPANY_DOMAIN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Pipedrive wired via Path B (REST + `x-api-token` header) or Path A (Pipedream OAuth) — the choice was stated honestly to the user
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'pipedrive'` within 30s
- [ ] Smoke test: `GET /v1/users/me` against `https://<company>.pipedrive.com` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, MCP, and auth failure modes.
