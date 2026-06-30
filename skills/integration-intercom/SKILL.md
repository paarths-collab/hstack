---
name: integration-intercom
description: Connect Intercom (support inbox, conversations, contacts, companies) to a self-hosted Hermes Agent over SSH. Stores a workspace Access Token and wires the REST API against the correct regional base URL. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-intercom — connect Intercom to a remote Hermes (SSH-first)

You are the engineer connecting Intercom to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Access Token in the Intercom Developer Hub.
2. Confirm which region the workspace lives in (US, EU, or AU).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Intercom ships an official hosted remote
MCP at `https://mcp.intercom.com/sse` (see <https://developers.intercom.com/docs/mcp>),
but it is **OAuth-only** — static workspace Access Tokens are rejected. So we do NOT
wire the hosted MCP for headless self-hosted Hermes. We wire the **REST API** with the
workspace Access Token, which Intercom designs precisely for app-owner / first-party
automation. This is the supported path for autonomous agents in 2026.

Intercom is regional: US, EU, and AU each have their own base URL, and the workspace
region is fixed at workspace creation. A US token aimed at the EU base URL returns
`401` with a misleading message — picking the right base URL is the single most common
failure mode (Pitfall 1).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$INTERCOM_ACCESS_TOKEN` | Workspace Access Token (`dG9rOg...` base64-ish blob) | <https://app.intercom.com/a/apps/_/developer-hub> → **New app** (or pick existing) → **Authentication** → **Access Token** → copy once. Single-workspace scope, no expiry by default |
| `$INTERCOM_REGION` | `us`, `eu`, or `au` (default `us`) | Intercom Settings → Workspace → **Data hosting**. Fixed at workspace creation, cannot be changed |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

Sanity-check the region value and compute the base URL locally (catches typos before
they reach the VPS):

```bash
INTERCOM_REGION="${INTERCOM_REGION:-us}"
case "$INTERCOM_REGION" in
  us) INTERCOM_BASE="https://api.intercom.io" ;;
  eu) INTERCOM_BASE="https://api.eu.intercom.io" ;;
  au) INTERCOM_BASE="https://api.au.intercom.io" ;;
  *)  echo "ABORT: INTERCOM_REGION must be us|eu|au (got: $INTERCOM_REGION)"; exit 1 ;;
esac
echo "OK: region=$INTERCOM_REGION base=$INTERCOM_BASE"
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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci intercom" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Intercom is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write INTERCOM_ACCESS_TOKEN (length ${#INTERCOM_ACCESS_TOKEN}, prefix ${INTERCOM_ACCESS_TOKEN:0:6}...) via 'hermes config set'
  2. Write INTERCOM_REGION=$INTERCOM_REGION and INTERCOM_BASE=$INTERCOM_BASE
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add intercom --url $INTERCOM_BASE (REST shim) with required headers
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*intercom"
  7. Smoke test: GET $INTERCOM_BASE/me → expect 200

Region: $INTERCOM_REGION  Base: $INTERCOM_BASE
The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set INTERCOM_ACCESS_TOKEN '$INTERCOM_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set INTERCOM_REGION '$INTERCOM_REGION'"
ssh "$VPS_USER@$VPS_IP" "hermes config set INTERCOM_BASE '$INTERCOM_BASE'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^INTERCOM_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: INTERCOM_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern. Intercom
> Access Tokens are base64-ish and can contain `/`, `+`, `=`, so the `|` delimiter is
> mandatory:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^INTERCOM_ACCESS_TOKEN=' ~/.hermes/.env || printf 'INTERCOM_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^INTERCOM_ACCESS_TOKEN=.*|INTERCOM_ACCESS_TOKEN=$INTERCOM_ACCESS_TOKEN|' ~/.hermes/.env
>   grep -q '^INTERCOM_REGION=' ~/.hermes/.env || printf 'INTERCOM_REGION=\n' >> ~/.hermes/.env
>   sed -i 's|^INTERCOM_REGION=.*|INTERCOM_REGION=$INTERCOM_REGION|' ~/.hermes/.env
>   grep -q '^INTERCOM_BASE=' ~/.hermes/.env || printf 'INTERCOM_BASE=\n' >> ~/.hermes/.env
>   sed -i 's|^INTERCOM_BASE=.*|INTERCOM_BASE=$INTERCOM_BASE|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Intercom REST shim

The hosted MCP at `https://mcp.intercom.com/sse` is OAuth-only and rejects workspace
Access Tokens, so we register Intercom as a REST endpoint with the regional base URL,
the required `Intercom-Version` header, and bearer auth. The token stays in
`~/.hermes/.env` and is referenced via `${INTERCOM_ACCESS_TOKEN}` indirection — never
inlined.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add intercom \
    --url '$INTERCOM_BASE' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --header 'Intercom-Version: 2.13' \
    --header 'Accept: application/json' \
    --env 'INTERCOM_ACCESS_TOKEN=\${INTERCOM_ACCESS_TOKEN}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first
and match its REST/HTTP syntax.

**REST surface for the registered shim (and for direct Hermes HTTP tools):**

- **Base URL:** `$INTERCOM_BASE` (US/EU/AU — see gather step)
- **Auth header:** `Authorization: Bearer ${INTERCOM_ACCESS_TOKEN}`
- **Required version header:** `Intercom-Version: 2.13` — unversioned and older versions
  are deprecated and return 4xx in 2026
- **Content type:** `Content-Type: application/json`
- **Accept:** `Accept: application/json`

Common read-side endpoints (single workspace scope, admin-context):

- `GET /me` — admin/account info; the canonical token sanity check
- `POST /conversations/search` — search conversations by state, assignee, tags, custom attrs
- `GET /conversations/{id}` — full conversation with parts
- `POST /contacts/search` — search contacts
- `GET /contacts/{id}` — single contact
- `GET /companies` — list companies
- `POST /conversations/{id}/reply` — reply (write scope required)

> Do NOT register `https://mcp.intercom.com/sse` with the Access Token — that endpoint
> is **OAuth-only** and will return an auth error.

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
       | grep -qiE "registered.*tool.*intercom|MCP server.*intercom.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: intercom registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: intercom not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

`GET /me` is side-effect-free, requires no Intercom data, exercises every layer (env
var, token validity, region routing, network egress), and confirms the
`Intercom-Version` header is accepted.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  : "${INTERCOM_REGION:=us}"
  case "$INTERCOM_REGION" in
    us) BASE="https://api.intercom.io" ;;
    eu) BASE="https://api.eu.intercom.io" ;;
    au) BASE="https://api.au.intercom.io" ;;
  esac
  curl -sS -o /dev/null -w "%{http_code}" \
    -X GET "$BASE/me" \
    -H "Authorization: Bearer $INTERCOM_ACCESS_TOKEN" \
    -H "Intercom-Version: 2.13" \
    -H "Accept: application/json"
')
case "$HTTP" in
  200) echo "OK: Intercom API reachable, token valid, region correct." ;;
  401) echo "FAIL: token invalid OR region mismatch (US token + EU/AU base = 401). Re-check Step 4 and INTERCOM_REGION."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but lacks scope. Widen Access Token scopes in the Developer Hub."; exit 1 ;;
  404) echo "FAIL: 404 on /me usually means wrong base URL for region."; exit 1 ;;
  429) echo "WARN: rate-limited at smoke test — retry in a few seconds." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Intercom API. Check manually." ;;
esac
```

`200` returns the admin/workspace metadata for the token's workspace. That confirms the
wiring end-to-end: env loaded, token valid, regional base correct, version header
accepted.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove intercom 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset INTERCOM_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^INTERCOM_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset INTERCOM_REGION 2>/dev/null || \
    sed -i '/^INTERCOM_REGION=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset INTERCOM_BASE 2>/dev/null || \
    sed -i '/^INTERCOM_BASE=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Intercom is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Regional endpoint mismatch (US token + EU/AU base, or vice versa) | Intercom returns `401` with a confusing "not authorized" message that looks like a bad token, not a wrong region | Confirm region in Intercom Settings → Workspace → Data hosting; compute `$INTERCOM_BASE` from `$INTERCOM_REGION` (gather step). Workspace region is fixed at creation |
| 2 | Missing `Intercom-Version` header | Older API versions are deprecated in 2026; unversioned calls also drift silently | Always send `Intercom-Version: 2.13` (or current). Pin to a version you tested against |
| 3 | Trying to wire the hosted MCP `https://mcp.intercom.com/sse` with the Access Token | The hosted MCP is **OAuth-only** — bearer Access Tokens are rejected | Use the REST shim (Step 5). Static-token MCP is not available from Intercom in 2026 |
| 4 | Workspace scope confusion | One Access Token = one workspace. Multi-workspace orgs need one token per workspace | Mint one token per workspace; don't reuse across regions |
| 5 | Rate limits (regular endpoints) | Default is **~1000 req/min per workspace**. Bursty agent loops 429 the whole workspace | Backoff on `429` (use `Retry-After`); cache list results; prefer search over per-record loops |
| 6 | Rate limits (search) | `POST /contacts/search` and `POST /conversations/search` are throttled to **~83 req/min**, much lower than regular endpoints | Paginate aggressively; cache; don't poll search endpoints |
| 7 | Conversation REST writes require admin context | `POST /conversations/{id}/reply` needs an `admin_id` or `type: admin` body field; without it Intercom returns 400/422 | Pass `admin_id` from `GET /admins`; document which admin the agent acts as |
| 8 | Articles vs Help Center vs Macros are separate APIs | `/articles`, `/help_center/*`, and Macros each have their own shapes/scopes — they're not unified | Treat each as a distinct surface; don't assume a Help Center token reads Articles |
| 9 | Soft-archived vs hard-deleted contacts/conversations | Soft-archived records still surface in some endpoints and not others, leading to "ghost" results | Filter by `state` / `archived` explicitly; treat archived data as separate |
| 10 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 11 | sed with `/` delimiter on tokens | Intercom Access Tokens are base64-ish — contain `/`, `+`, `=` | Always use `\|` delimiter |
| 12 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Region confirmed (us/eu/au) and `$INTERCOM_BASE` computed correctly
- [ ] `INTERCOM_ACCESS_TOKEN`, `INTERCOM_REGION`, `INTERCOM_BASE` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered as REST shim with `Intercom-Version: 2.13` header (hosted MCP NOT wired — OAuth-only)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'intercom'` within 30s
- [ ] Smoke test: `GET $INTERCOM_BASE/me` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
