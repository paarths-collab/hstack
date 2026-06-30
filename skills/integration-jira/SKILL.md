---
name: integration-jira
description: Connect Jira (Atlassian Cloud — issues, projects, comments, transitions) to a self-hosted Hermes agent over SSH. Wires the Jira Cloud REST API with an Atlassian API token because the hosted Atlassian MCP is OAuth-only. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-jira — connect Jira to a remote Hermes (SSH-first)

You are the engineer connecting Jira to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Atlassian API token in their account security settings.
2. Confirm the Atlassian site URL (the `<workspace>.atlassian.net` host) and which
   account email the token belongs to.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Atlassian ships a hosted remote MCP at
`https://mcp.atlassian.com/v1/sse` (and the newer `/v1/mcp` streamable HTTP variant), but
it is **OAuth-only** with browser-driven consent — no static API-token path completes
headlessly. So we do NOT wire the hosted MCP. We use Jira Cloud's REST API directly with
an Atlassian API token, sent as HTTP **Basic** auth with `email:token`. There is a
community stdio package (`@mcp-server/atlassian` and similar) that wraps the same REST
API with the same credentials; if you choose Path A below, it sits on top of the REST
path documented here.

**The #1 Jira gotcha — Basic, not Bearer.** Jira Cloud's REST API does not accept
`Authorization: Bearer <token>` for API tokens. The required shape is
`Authorization: Basic $(printf '%s' "email@example.com:$JIRA_API_TOKEN" | base64)` —
the token is paired with the account's email, base64-encoded, and sent as Basic. Every
other API you have wired probably wants Bearer. Jira Cloud does not. Sending Bearer
returns 401.

(Jira **Data Center / Server** is the opposite — it uses Personal Access Tokens with
`Authorization: Bearer <PAT>` at `/rest/api/2/`. Brief note in Pitfalls. Everything else
in this skill is Cloud.)

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$JIRA_SITE` | Atlassian Cloud site host, e.g. `mycompany.atlassian.net` (no scheme, no trailing slash) | Browser URL bar when logged into Jira |
| `$JIRA_EMAIL` | Atlassian account email the token belongs to | The account whose permissions the agent will act under |
| `$JIRA_API_TOKEN` | Atlassian API token | <https://id.atlassian.com/manage-profile/security/api-tokens> → **Create API token**. Tokens have no scopes — they inherit the user's full Jira permissions. Shown once at creation. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci jira" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Jira is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write JIRA_SITE=$JIRA_SITE, JIRA_EMAIL=$JIRA_EMAIL, and JIRA_API_TOKEN
     (length ${#JIRA_API_TOKEN}, prefix ${JIRA_API_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add jira (Path A: community stdio MCP, or Path B: Jira REST)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*jira"
  6. Smoke test: GET https://$JIRA_SITE/rest/api/3/myself with Basic email:token → expect 200

The token is NEVER printed in plaintext. The base64 auth header is built on the VPS,
so the token never leaves /opt/data/.env.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set JIRA_SITE '$JIRA_SITE'"
ssh "$VPS_USER@$VPS_IP" "hermes config set JIRA_EMAIL '$JIRA_EMAIL'"
ssh "$VPS_USER@$VPS_IP" "hermes config set JIRA_API_TOKEN '$JIRA_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each (returns `1`, NEVER the value):

```bash
for k in JIRA_SITE JIRA_EMAIL JIRA_API_TOKEN; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^${k}=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $k not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern.
> Pipe delimiter is required — Atlassian API tokens contain `/`, `+`, and `=`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for kv in 'JIRA_SITE=$JIRA_SITE' 'JIRA_EMAIL=$JIRA_EMAIL' 'JIRA_API_TOKEN=$JIRA_API_TOKEN'; do
>     k=\${kv%%=*}
>     grep -q \"^\${k}=\" ~/.hermes/.env || printf '%s\n' \"\${k}=\" >> ~/.hermes/.env
>     sed -i \"s|^\${k}=.*|\${kv}|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Jira endpoint

Pick the path that matches the Hermes build on the VPS. Path B (REST) is the primary
recommendation — it has no extra dependencies and matches Atlassian's own docs. Path A
is a convenience wrapper.

### Path A (optional) — community stdio MCP server

The community `@mcp-server/atlassian` (and similar `mcp-atlassian` packages) wrap the
same Jira REST API with a tool surface (`jira_search_issues`, `jira_create_issue`,
`jira_transition_issue`, etc.). They are not first-party Atlassian and not maintained by
Atlassian — vet before production use. Credentials pass through indirection only:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add jira \
    --command npx \
    --args '-y,@mcp-server/atlassian' \
    --env 'JIRA_SITE=\${JIRA_SITE}' \
    --env 'JIRA_EMAIL=\${JIRA_EMAIL}' \
    --env 'JIRA_API_TOKEN=\${JIRA_API_TOKEN}'
"
```

Flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax.

Do NOT try to register `https://mcp.atlassian.com/v1/sse` (or `/v1/mcp`) with a static
token. That endpoint is OAuth-only with browser-driven consent; a static `Authorization`
header gets 401.

### Path B (preferred) — generic HTTP tool against Jira Cloud REST

- **Base URL:** `https://${JIRA_SITE}/rest/api/3`
- **Method:** mostly `GET` / `POST` / `PUT`
- **Auth header:** `Authorization: Basic $(printf '%s' "${JIRA_EMAIL}:${JIRA_API_TOKEN}" | base64 -w0)`
  — **Basic, not Bearer**. Build the base64 blob on the VPS so the token never crosses
  the wire in plaintext.
- **Content type:** `Content-Type: application/json`
- **Accept:** `Accept: application/json`
- **Body shape for descriptions/comments:** Atlassian Document Format (ADF) — a nested
  JSON document, **not** plain markdown. See Pitfall 4.

Useful endpoints to surface to the agent:

| Verb | Path | Use |
|------|------|-----|
| GET | `/myself` | Smoke test — returns the calling account |
| GET | `/search?jql=...` | JQL search |
| GET | `/issue/{key}` | Fetch one issue |
| POST | `/issue` | Create issue (body uses project key, issuetype, ADF description) |
| POST | `/issue/{key}/comment` | Add comment (ADF body) |
| POST | `/issue/{key}/transitions` | Transition issue (id from `/transitions`) |

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
       | grep -qiE "registered.*tool.*jira|MCP server.*jira.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: jira registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: jira not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the VPS so token + base64 stay there)

`GET /rest/api/3/myself` is the canonical "is the token alive" probe — read-only, no
project scope, never mutates. We build the Basic header on the VPS so neither the token
nor the base64 blob is constructed locally.

```bash
RESP=$(ssh "$VPS_USER@$VPS_IP" "
  AUTH=\$(printf '%s' \"\$JIRA_EMAIL:\$JIRA_API_TOKEN\" | base64 -w0)
  curl -sS -w '\nHTTP:%{http_code}' \
    -X GET 'https://'\"\$JIRA_SITE\"'/rest/api/3/myself' \
    -H \"Authorization: Basic \$AUTH\" \
    -H 'Accept: application/json'
")
HTTP=$(printf '%s' "$RESP" | sed -n 's/^HTTP://p' | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

case "$HTTP" in
  200) echo "OK: Jira REST reachable, account resolved." ;;
  401) echo "FAIL: 401 — token invalid, wrong email pairing, or sent as Bearer instead of Basic. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: 403 — token valid but the account lacks permission. Check Jira permission scheme."; exit 1 ;;
  404) echo "FAIL: 404 — likely wrong JIRA_SITE host. Confirm the <workspace>.atlassian.net value."; rollback; exit 1 ;;
  429) echo "WARN: rate-limited on the smoke test. Wait and re-run." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Jira REST. Body: $BODY" ;;
esac
```

`200` with a JSON body containing `accountId` and `emailAddress` = wired. `401` almost
always means a stray `Bearer` prefix, a typo in `JIRA_EMAIL`, or a token that was
revoked. `404` on `/myself` is nearly always a wrong site host.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove jira 2>/dev/null || true"
  for k in JIRA_SITE JIRA_EMAIL JIRA_API_TOKEN; do
    ssh "$VPS_USER@$VPS_IP" "hermes config unset $k 2>/dev/null || \
      sed -i '/^${k}=/d' ~/.hermes/.env"
  done
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Jira is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer $JIRA_API_TOKEN` | Jira Cloud rejects Bearer for API tokens; returns 401 | Always `Basic $(printf '%s' "$JIRA_EMAIL:$JIRA_API_TOKEN" | base64 -w0)` |
| 2 | Using the token alone, without the email | API tokens are credentials for an **account**; Basic auth needs `email:token` as the pair | Always pair the token with `JIRA_EMAIL` before base64 |
| 3 | Wrong `JIRA_SITE` host | Each Atlassian workspace has its own `<workspace>.atlassian.net`; using the wrong one returns 404 on every call before auth is even checked | Confirm the host from a browser URL bar; no scheme, no trailing slash |
| 4 | Sending plain markdown / plain text as issue description or comment body | Jira Cloud REST v3 requires **ADF** (Atlassian Document Format) — a nested JSON document. Plain strings return 400 `"INVALID_INPUT"` | Wrap text as `{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}` or use REST v2 (`/rest/api/2/`) which still accepts wiki markup |
| 5 | Permission scheme blocks the call before auth fails | Jira returns 403 with no helpful message when the project's permission scheme excludes the token-owner account, even with a perfectly valid token | The token can only act with the user's permissions; add that user to the project or widen the permission scheme |
| 6 | Wiring the hosted `mcp.atlassian.com/v1/sse` or `/v1/mcp` with the API token | OAuth-only; a static `Authorization` header gets 401 | Use REST (Path B) or the community stdio wrapper (Path A) |
| 7 | Cloud vs Server/DC URL split | Jira **Data Center / Server** uses `<host>/rest/api/2/` with **Bearer PAT**, not `/rest/api/3/` with Basic; mixing them silently fails | Detect by host: `*.atlassian.net` is Cloud (v3, Basic); anything else is almost certainly DC/Server (v2, Bearer PAT) |
| 8 | Confusing project key with project ID | `POST /issue` accepts both, but mixing `project.key` and `project.id` in the same body, or passing the **name** instead of the key, returns 400 | Always pass `project.key` (e.g. `"ENG"`) — visible in any issue key like `ENG-123` |
| 9 | Rate limits — bursty agents hit 429 | Atlassian Cloud applies per-account REST limits (~100 req/s sustained, higher bursts) with `Retry-After`; complex JQL costs more | Backoff on `429` honoring `Retry-After`; prefer one paginated JQL over N round-trips |
| 10 | Using a webhook secret as the API token | Jira webhook secrets are separate credentials used to **sign incoming webhook payloads** — they are not API tokens and cannot authenticate outgoing REST calls | Mint a fresh API token at `id.atlassian.com/manage-profile/security/api-tokens` — never reuse a webhook secret |
| 11 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 12 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (community stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'jira'` within 30s
- [ ] Smoke test: `GET https://${JIRA_SITE}/rest/api/3/myself` returned `200` with an `accountId`, using **Basic** (not Bearer), built on the VPS
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
