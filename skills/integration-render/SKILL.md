---
name: integration-render
description: Connect Render (backend hosting, static sites, cron jobs, Postgres) to a self-hosted Hermes agent over SSH using Render's first-party hosted MCP server. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-render — connect Render to a remote Hermes (SSH-first)

You are the engineer connecting Render to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not on the
local machine. The user only does the one thing a machine cannot: mint the API key in
the Render dashboard.

**Honest auth picture (verified 2026-06):** Render ships a first-party hosted MCP at
`https://mcp.render.com/mcp` using streamable HTTP with bearer auth — exactly the
shape Hermes' `mcp add --auth header` handles. The Render API key is a **static bearer
credential**, not OAuth. But: Render API keys are **broadly scoped** — a single key
grants access to **all workspaces and services** the account can reach. There is no
per-service, per-workspace, or read-only scope. Prefer a key on an account/workspace
with the minimum blast radius. The hosted MCP is also **workspace-aware** and starts
with no workspace selected — Step 8 (or a follow-up) drives the agent to pick one.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$RENDER_API_KEY` | Static bearer API key (shown once at creation) | <https://dashboard.render.com/u/settings?add-api-key> -> Account Settings -> API Keys -> Create API Key |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci render" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Render is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_RENDER_API_KEY (length ${#RENDER_API_KEY}, prefix ${RENDER_API_KEY:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add render --url https://mcp.render.com/mcp --auth header
  4. Inject real bearer with sed (pipe delimiter)
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*render"
  7. Smoke test: GET https://api.render.com/v1/services -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_RENDER_API_KEY '$RENDER_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_RENDER_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: MCP_RENDER_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Render keys are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_RENDER_API_KEY=' ~/.hermes/.env || printf 'MCP_RENDER_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_RENDER_API_KEY=.*|MCP_RENDER_API_KEY=$RENDER_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Render MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred — Render's
hosted MCP tracks new Render features automatically.

### Path A (preferred) — official hosted Render MCP with bearer header

Register with a **placeholder** token first, then inject the real key into
`~/.hermes/.env` with a `|`-delimited `sed`. Never pipe the real token through
`docker exec` or shell history.

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    hermes mcp add render \
      --url 'https://mcp.render.com/mcp' \
      --auth header
"
```

Hermes derives the env var name `MCP_RENDER_API_KEY` from the MCP name `render`. The
`config.yaml` references it via `${MCP_RENDER_API_KEY}`; the value lives only in
`~/.hermes/.env`.

> Note on the probe: Render's MCP `initialize` handshake may succeed before auth is
> enforced. Confirm a real `tools/list` returns data **with** the bearer header (per
> `/hermes-mcp-add` step 2) rather than trusting the initialize result.

### Path B (fallback) — generic HTTP against the Render REST API

If the Hermes build is stdio-MCP-only or cannot reach `mcp.render.com`:

- **Base URL:** `https://api.render.com/v1`
- **Auth header:** `Authorization: Bearer ${MCP_RENDER_API_KEY}`
- **Content type:** `Content-Type: application/json`

This is heavier (you lose the auto-tracking of new Render tools) but the same key
works.

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
       | grep -qiE "registered.*tool.*render|MCP server.*render.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: render registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: render not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success shows `registered N tool(s)` for `render` (list_services, create_web_service,
get_service, deploy/log/metric tools, Postgres query, etc.).

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.render.com/v1/services?limit=1' \
    -H \"Authorization: Bearer \$MCP_RENDER_API_KEY\" \
    -H 'Accept: application/json'
")
case "$HTTP" in
  200) echo "OK: Render API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but blocked (workspace/scope). Confirm key permissions."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Render API. Check manually." ;;
esac
```

`200` with an empty list (`[]`) is a pass — every layer worked. After this, drive the
agent to select a workspace before resource calls return useful data:

```
@<agent> using render, list my workspaces, then select <workspace-name>
```

`select_workspace` takes the `ownerID` returned by `list_workspaces`. Until that's set,
expect "no workspace selected" style errors even though auth is correct.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove render 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset MCP_RENDER_API_KEY 2>/dev/null || \
    sed -i '/^MCP_RENDER_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Render is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Broad-scope API key, no read-only mode | A Render key is all-or-nothing across every workspace and service on the account | Use a key on a minimum-blast-radius account; rotate at `https://dashboard.render.com/u/settings` if leaked |
| 2 | Workspace not selected | Tool calls fail with "no workspace selected" even though auth is correct | Drive `list_workspaces` then `select_workspace` (Step 8) before resource calls |
| 3 | Static key, shown once at creation | If lost, you cannot retrieve it | Treat creation as one-shot; on loss, create new + revoke old |
| 4 | Trusting `initialize` for auth | Render's MCP `initialize` may pass before auth is enforced | Probe `tools/list` with the bearer header — that's the real auth check |
| 5 | Rate limits / throttling | Bursty polling loops (e.g. tight deploy-status checks) get throttled | Have the agent back off; don't hammer |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 8 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, real key referenced via `${MCP_RENDER_API_KEY}` |
| 9 | sed with `/` delimiter on tokens | Future tokens may contain `/+=` | Always use `\|` delimiter |
| 10 | Container vs host confusion | SSH lands you on host; Hermes may be in a container | Step 1's host-or-container detection handles both |
| 11 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_RENDER_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (hosted `https://mcp.render.com/mcp` with bearer header) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'render'` within 30s
- [ ] Smoke test: `GET /v1/services` from inside the container returned `200`
- [ ] Workspace selected (or user told to drive `list_workspaces` + `select_workspace`)
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
