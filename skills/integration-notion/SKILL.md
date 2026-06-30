---
name: integration-notion
description: Connect Notion (docs, CRM-lite, memory, SOPs) to a self-hosted Hermes Agent over SSH. Wires the official open-source MCP server with a static internal integration token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-notion — connect Notion to a remote Hermes (SSH-first)

You are the engineer connecting Notion to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the integration token in the Notion UI.
2. Share each target page or database with the integration.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Notion ships a hosted remote MCP at
`https://mcp.notion.com/mcp`, but it is **OAuth-only** — bearer tokens are rejected. So we
do NOT wire the hosted MCP. We use the official open-source server
`@notionhq/notion-mcp-server` which takes a static `ntn_` token — perfect for headless,
self-hosted agents.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$NOTION_TOKEN` | Internal integration token (`ntn_...`) | <https://www.notion.com/my-integrations> → Build → Internal connections → Create → Configuration tab |
| Shared pages | Pages/DBs the integration can see | In each Notion page: `...` → **+ Add Connections** → select the integration |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci notion" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Notion is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write NOTION_TOKEN (length ${#NOTION_TOKEN}, prefix ${NOTION_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add notion --command npx --args -y,@notionhq/notion-mcp-server
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*notion"
  6. Smoke test: POST https://api.notion.com/v1/search → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set NOTION_TOKEN '$NOTION_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^NOTION_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: NOTION_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; `ntn_` tokens stay alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^NOTION_TOKEN=' ~/.hermes/.env || printf 'NOTION_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^NOTION_TOKEN=.*|NOTION_TOKEN=$NOTION_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Notion MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with static token

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add notion \
    --command npx \
    --args '-y,@notionhq/notion-mcp-server' \
    --env 'NOTION_TOKEN=\${NOTION_TOKEN}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first
and match its stdio syntax. The token stays in `~/.hermes/.env` and is referenced via
`${NOTION_TOKEN}` indirection — never inlined.

### Path B (fallback) — generic HTTP tool against the Notion REST API

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command:

- **Base URL:** `https://api.notion.com/v1`
- **Auth header:** `Authorization: Bearer ${NOTION_TOKEN}`
- **Required version header:** `Notion-Version: 2025-09-03`
- **Content type:** `Content-Type: application/json`

Do NOT try to register `https://mcp.notion.com/mcp` with a bearer token — that endpoint
is OAuth-only and will return an auth error.

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
       | grep -qiE "registered.*tool.*notion|MCP server.*notion.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: notion registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: notion not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://api.notion.com/v1/search' \
    -H \"Authorization: Bearer \$NOTION_TOKEN\" \
    -H 'Notion-Version: 2025-09-03' \
    -H 'Content-Type: application/json' \
    -d '{\"page_size\":1}'
")
case "$HTTP" in
  200) echo "OK: Notion API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but no scope. Confirm shared pages."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Notion API. Check manually." ;;
esac
```

`200` with an empty `results` array means the token works but nothing is shared yet —
not a failure of wiring, just a user step (Pitfall 2).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove notion 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset NOTION_TOKEN 2>/dev/null || \
    sed -i '/^NOTION_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Notion is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the hosted `mcp.notion.com` MCP with a token | It is **OAuth-only**; bearer tokens are rejected | Use the stdio server (Path A) or REST (Path B) |
| 2 | Token set but every call returns empty / 404 | Integration not **shared** with target pages/DBs | In Notion: `...` → **+ Add Connections** on each target |
| 3 | Missing `Notion-Version` header | Notion API rejects unversioned requests | Always send `Notion-Version: 2025-09-03` |
| 4 | Internal vs OAuth/public token confusion | Public tokens behave differently and can expire | Use an **internal** integration token (`ntn_...`) |
| 5 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 7 | sed with `/` delimiter on tokens | `ntn_` is safe, but later tokens have `/+=` | Always use `\|` delimiter |
| 8 | Search returns partial results | `/search` only spans shared content; paginated | Confirm sharing; follow `next_cursor` |
| 9 | Rate limits | Notion throttles ~3 req/sec; bursts get `429` | Backoff on `429`; batch via DB queries |
| 10 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `NOTION_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Target Notion pages/DBs shared with the integration (+ Add Connections done)
- [ ] MCP registered via Path A (stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'notion'` within 30s
- [ ] Smoke test: `POST /v1/search` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
