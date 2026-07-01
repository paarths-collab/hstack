---
name: integration-railway
description: Connect Railway (app hosting / infra) to a self-hosted Hermes Agent over SSH. Path A — headless GraphQL API via static workspace/account token (recommended). Path B — official remote MCP (OAuth-only, interactive). Refuses to pretend a static token works with the hosted MCP. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-railway — connect Railway to a remote Hermes (SSH-first)

You are the engineer connecting Railway to a self-hosted Hermes agent on the user's VPS. You
(the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. The user does one thing a machine cannot: mint the token in browser
(Path A: https://railway.com/account/tokens) or complete OAuth consent (Path B).

Everything else — token storage, live GraphQL verify, MCP registration, gateway reload,
smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Railway ships a **first-party remote MCP** at
`https://mcp.railway.com`, but it is **OAuth-only** — it explicitly rejects static tokens
("Project tokens are not accepted. The remote MCP server requires a user identity for
billing and audit trails.")

Two honest paths:

- **Path A — headless GraphQL API (recommended for unattended):** static account/workspace
  token via `Authorization: Bearer` at `https://backboard.railway.com/graphql/v2`. Fully
  headless. A bare token in env doesn't "connect" anything by itself — the agent's
  generic GraphQL tool layer uses it to call the API.
- **Path B — official remote MCP (OAuth, interactive):** browser consent required. Ideal
  when a human user is nearby; not for pure headless.

**Token-type header gotcha:** Account/workspace tokens use `Authorization: Bearer`. **Project
tokens use `Project-Access-Token: <token>` (NOT Bearer)** — the #1 Railway integration
mistake. This skill enforces account/workspace tokens for Path A to avoid the confusion.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$WIRE_PATH` | `A` (headless GraphQL, default) or `B` (OAuth MCP, interactive) | A is fully headless; B needs browser consent |
| `$RAILWAY_API_TOKEN` *(Path A)* | Account or workspace token (shown ONCE) | https://railway.com/account/tokens → Create Token → workspace scope preferred |

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
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^RAILWAY_API_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci railway" || echo 0)
if [ "${WIRE_PATH:-A}" = "A" ] && [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Railway token already wired (Path A). Set FORCE=1 to rewire."; exit 0
fi
if [ "${WIRE_PATH:-A}" = "B" ] && [ "$ALREADY_MCP" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Railway MCP already wired (Path B). Set FORCE=1 to rewire."; exit 0
fi
```

---

## Step 3 — HARD GATE (path-specific)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}

if [ "$PATH_CHOSEN" = "A" ]; then
  # Token must be present + sane length
  [ -n "$RAILWAY_API_TOKEN" ] \
    || { echo "ABORT: Path A requires RAILWAY_API_TOKEN."; exit 1; }
  [ "${#RAILWAY_API_TOKEN}" -ge 20 ] \
    || { echo "ABORT: RAILWAY_API_TOKEN looks too short."; exit 1; }

  # Live GraphQL: `me` query
  ME_RESP=$(curl -sS --max-time 10 \
    -X POST 'https://backboard.railway.com/graphql/v2' \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"query":"query { me { name email } }"}' 2>/dev/null) || true
  if printf '%s' "$ME_RESP" | grep -q '"me"'; then
    EMAIL=$(printf '%s' "$ME_RESP" | grep -oE '"email":"[^"]+"' | head -1 | cut -d'"' -f4)
    echo "Railway OK. Token belongs to: $EMAIL"
  elif printf '%s' "$ME_RESP" | grep -qi 'not authorized'; then
    echo "ABORT: Railway API returned 'Not Authorized'. Common causes:"
    echo "  - Wrong or revoked token"
    echo "  - Project token sent on Authorization: Bearer (should be 'Project-Access-Token: <token>')"
    echo "  - Query touching resources outside token's workspace scope"
    exit 1
  else
    echo "ABORT: unexpected response from Railway."
    printf '%s' "$ME_RESP" | head -c 200
    exit 1
  fi
fi

if [ "$PATH_CHOSEN" = "B" ]; then
  echo "Path B: OAuth flow requires a browser handoff."
  echo "The Hermes host must be able to complete OAuth (headless containers cannot)."
  echo "If unsure, use Path A (WIRE_PATH=A) with a workspace token."
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Path A (headless GraphQL — recommended):
    1. Write RAILWAY_API_TOKEN (length ${#RAILWAY_API_TOKEN:-0}) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. Verify token landed (grep -c)
    4. No MCP registered; generic GraphQL tool reads env
    5. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
    6. Smoke test: 'me' query from VPS — expect 200 + user email

  Path B (OAuth MCP — interactive):
    1. Register MCP: hermes mcp add railway --url https://mcp.railway.com --auth oauth
    2. USER completes browser OAuth consent
    3. Reload gateway: stop + run
    4. Verify in logs: grep "registered.*railway"

Token is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the token (Path A only)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set RAILWAY_API_TOKEN '$RAILWAY_API_TOKEN'"
  ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^RAILWAY_API_TOKEN=' ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
fi
```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — wire the chosen path

### Path A (headless GraphQL — default, recommended)

Generic GraphQL tool layer reads `RAILWAY_API_TOKEN` and calls:

- **Endpoint:** `POST https://backboard.railway.com/graphql/v2`
- **Auth:** `Authorization: Bearer ${RAILWAY_API_TOKEN}`
- **Content-Type:** `application/json`

Useful queries/mutations:
- `me { name email }` — auth check
- `projects { edges { node { id name } } }` — list projects
- `project(id:) { ... }` — one project details
- `variables(...)` — read service variables
- `deploymentTriggerCreate` / `serviceInstanceRedeploy` — trigger deploys

Full schema introspectable from the endpoint. Docs:
https://docs.railway.com/integrations/api/graphql-overview

### Path B (OAuth MCP — interactive)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add railway \
      --url 'https://mcp.railway.com' \
      --auth oauth
  "
  echo ""
  echo "ACTION REQUIRED: Hermes will print an OAuth consent URL."
  echo "Open it in a browser logged into your Railway account."
  echo "Select the workspaces/projects to grant access; consent."
  echo "Watch 'hermes logs gateway -f' for confirmation."
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

## Step 8 — verify

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ME_HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -X POST 'https://backboard.railway.com/graphql/v2' \
      -H \"Authorization: Bearer \$RAILWAY_API_TOKEN\" \
      -H 'Content-Type: application/json' \
      -d '{\"query\":\"query { me { email } }\"}'
  ")
  [ "$ME_HTTP" = "200" ] \
    && echo "OK: Railway GraphQL reachable from VPS." \
    || { echo "FAIL: HTTP $ME_HTTP. Rolling back."; rollback; exit 1; }
fi

if [ "${WIRE_PATH:-A}" = "B" ]; then
  REGISTERED=0
  for i in $(seq 1 12); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*railway|MCP server.*railway.*(ok|ready)"; then
      REGISTERED=1; echo "OK: railway MCP registered (consent completed)."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: railway MCP not in logs after 60s. Did OAuth consent complete? Rolling back."; rollback; exit 1; }
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "sed -i '/^RAILWAY_API_TOKEN=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove railway 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at https://railway.com/account/tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trying to wire `mcp.railway.com` with a static bearer | Railway MCP is OAuth-only; explicitly rejects static/project tokens | This skill refuses; uses GraphQL for headless (A) or OAuth (B) |
| 2 | Project token sent as `Authorization: Bearer` | Project tokens need `Project-Access-Token: <token>` header | This skill uses account/workspace tokens for Path A (Bearer) |
| 3 | `Not Authorized` catch-all error | Bad/revoked token OR wrong header for token type OR out-of-scope query | Step 3 checks + Pitfalls documents debug order |
| 4 | Token shown once | Must regenerate if lost | Store immediately in env |
| 5 | Account-scope when workspace suffices | Overbroad blast radius on leak | Prefer workspace tokens |
| 6 | Assuming a token "connects" the agent | Bare token in env doesn't do anything without a GraphQL tool layer | Step 6 docs the tool contract |
| 7 | Bursty deploys/redeploys | Destructive AND rate-limited | Gate destructive ops behind explicit user intent; back off on 429 |
| 8 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Local MCP via Railway CLI on the container | Needs interactive CLI login on the host; not applicable to headless Hermes | This skill wires headless GraphQL (A) or OAuth remote MCP (B) — no CLI |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: Path A → live `me` query returned an email; Path B → user warned of OAuth requirement
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Path A: token written to `~/.hermes/.env`, `chmod 600`, verified by grep; generic GraphQL tool documented
- [ ] Path B: MCP registered with `--auth oauth`; user completed browser consent
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: Path A `me` query from VPS returned 200; Path B `registered N tool(s)` in logs
- [ ] Rollback function defined; token revocation URL included
- [ ] User informed that project tokens use a DIFFERENT header (not wired here)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, OAuth
consent, and Railway token-type failure modes.
