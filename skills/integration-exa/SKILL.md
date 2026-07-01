---
name: integration-exa
description: Connect Exa (semantic web search, company/person research, code context, web crawl) to a self-hosted Hermes Agent over SSH using Exa's official remote MCP server with a static x-api-key. Idempotent and rollback-safe. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI).
---

# /integration-exa — connect Exa to a remote Hermes (SSH-first)

You are the engineer connecting Exa to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not on the
local machine. The user only does the one thing a machine cannot: mint the Exa API key
in the dashboard.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently, with a working rollback on any failure.

**Honest auth picture (verified 2026-06):** Exa ships an official **remote** MCP server at
`https://mcp.exa.ai/mcp`. It authenticates with a **static API key** via the `x-api-key`
header (the REST API also accepts `Authorization: Bearer <key>`). No OAuth dance, no
session token rotation — this is the headless-friendly path. The remote MCP `initialize`
handshake accepts unauthenticated requests; auth is enforced on `tools/call`, so a
"Connected!" line on registration is not proof — only the smoke test in Step 8 is.

Sources: <https://exa.ai/docs/reference/exa-mcp>, <https://exa.ai/mcp>.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$EXA_API_KEY` | Exa API key (static) | <https://dashboard.exa.ai/api-keys> (sign up at <https://exa.ai> first) |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

Detect host vs container, then version-check. If you land in a container shell (hostname
is a hex string), back out — `hermes` lives on the host or in the named container.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci exa" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Exa is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write EXA_API_KEY (length ${#EXA_API_KEY}, prefix ${EXA_API_KEY:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add exa --url https://mcp.exa.ai/mcp --auth header (x-api-key)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*exa"
  6. Smoke test: POST https://api.exa.ai/search -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set EXA_API_KEY '$EXA_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^EXA_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: EXA_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — Exa keys are alnum today but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^EXA_API_KEY=' ~/.hermes/.env || printf 'EXA_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^EXA_API_KEY=.*|EXA_API_KEY=$EXA_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Exa MCP server

Path A is preferred — Exa ships an official remote MCP that takes a static key.

### Path A (preferred) — official remote MCP at `https://mcp.exa.ai/mcp`

Exa's MCP enforces the `x-api-key` header (NOT `Authorization`). Register with the token
referenced from `.env`, never inlined:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add exa \
    --url 'https://mcp.exa.ai/mcp' \
    --auth-header 'x-api-key' \
    --auth-scheme '' \
    --placeholder-token 'placeholder'
"
# Inject the real key into the config with pipe delimiter (safe for any token shape)
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$EXA_API_KEY\"'|g' ~/.hermes/config.yaml"
```

The resulting config entry should resemble:
```yaml
exa:
  url: https://mcp.exa.ai/mcp
  headers:
    x-api-key: ${EXA_API_KEY}
  enabled: true
```

Tools registered include `web_search_exa`, `company_research_exa`, `linkedin_search_exa`,
`get_code_context_exa`, `crawling_exa`, and `deep_researcher_*`.

### Path B (fallback) — generic HTTP tool against the Exa REST API

If the Hermes build is stdio-MCP-only or cannot register a remote HTTP MCP:

- **Base URL:** `https://api.exa.ai`
- **Auth header:** `x-api-key: ${EXA_API_KEY}` (or `Authorization: Bearer ${EXA_API_KEY}`)
- **Content type:** `Content-Type: application/json`
- **Core endpoint:** `POST /search` with `{"query":"...","numResults":N}`

Do NOT pick `Authorization` at the MCP `--auth-header` prompt for Path A — Exa's MCP
example uses `x-api-key`; mixing them invites silent `401`s on `tools/call`.

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
       | grep -qiE "registered.*tool.*exa|MCP server.*exa.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: exa registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: exa not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success line looks like:
```
INFO tools.mcp_tool: MCP server 'exa' (HTTP): registered N tool(s): mcp_exa_web_search_exa, mcp_exa_company_research_exa, ...
```

---

## Step 8 — live API smoke test (token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST 'https://api.exa.ai/search' \
    -H \"x-api-key: \$EXA_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"hermes agent\",\"numResults\":1}'
")
case "$HTTP" in
  200) echo "OK: Exa API reachable and key valid." ;;
  401) echo "FAIL: key invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: key valid but blocked (quota or plan)."; exit 1 ;;
  429) echo "WARN: rate-limited. Key is valid; back off and retry." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Exa API. Check manually." ;;
esac
```

`200` with an empty `results` array is still a wiring pass — that is just the query
returning nothing, not a token failure.

End-to-end from chat: `@<agent> using exa, search the web for "<topic>"` returns results.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove exa 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset EXA_API_KEY 2>/dev/null || \
    sed -i '/^EXA_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Exa is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Picking `Authorization` at the `--auth-header` prompt | Exa's MCP enforces `x-api-key`; bearer works on REST but mixing them yields silent `401` on `tools/call` | Type `x-api-key` exactly at the header-name prompt |
| 2 | Treating `initialize` "Connected!" as proof | Exa accepts unauthenticated handshakes; auth is enforced on `tools/call` | Only the Step 8 smoke test (HTTP 200) proves the key works |
| 3 | Pasting the real key into an interactive `printf` pipe | Special chars can mangle in non-TTY pipes; key gets logged in shell history | Placeholder via CLI, real value via `sed` (Step 5) |
| 4 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by the Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 5 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 6 | `echo "...key..." >> .env` instead of `config set` | `echo >>` can merge onto a prior line without a trailing newline; sed-fix needed | Always `hermes config set`; if you must append, use `printf '\n%s\n'` |
| 7 | sed with `/` delimiter on tokens | Future key formats may contain `/+=`; `/`-delimited sed breaks | Always use `\|` delimiter |
| 8 | Container vs host confusion | Adding the key inside a container leaves it invisible to the host gateway | `whoami; hostname` check first; exit container shells before writing |
| 9 | Rate limits and quota | Exa bills per search and per tool call; bursts can `429` or exhaust quota silently | Watch `hermes logs` for `429`; check usage at <https://dashboard.exa.ai> |
| 10 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `EXA_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (remote MCP with `x-api-key`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'exa'` within 30s
- [ ] Smoke test: `POST https://api.exa.ai/search` from the VPS returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
