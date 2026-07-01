---
name: integration-firecrawl
description: Connect Firecrawl (LLM-ready web scraping + crawling + search + structured extract — markdown output that pairs with mem0/supermemory RAG) to a self-hosted Hermes Agent over SSH via Firecrawl's first-party hosted MCP at mcp.firecrawl.dev with URL-embedded API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-firecrawl — connect Firecrawl to a remote Hermes (SSH-first)

You are the engineer connecting Firecrawl (the web-scraping API purpose-built for AI —
returns clean LLM-ready markdown, handles JS rendering, follows sitemaps, extracts
structured data) to a self-hosted Hermes agent on the user's VPS. You (the AI agent —
Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root
against the VPS. The user does one thing a machine cannot: mint the `fc-` API key at
https://firecrawl.dev/app.

Everything else — key storage, live API verification, MCP registration, gateway reload,
live scrape smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Firecrawl ships an **official first-party**
hosted MCP where the API key lives IN THE URL:
`https://mcp.firecrawl.dev/{FIRECRAWL_API_KEY}/v2/mcp` — headless-friendly, no separate
header needed. There's also an OAuth bearer path (`fco_` access tokens) for interactive
clients, but the URL-embedded key is the simplest for Hermes.

Sources:
- https://github.com/firecrawl/firecrawl-mcp-server
- https://docs.firecrawl.dev

**Two paths:**

- **Path A (default) — hosted MCP with URL-embedded key.** Simplest. Zero third-party code.
- **Path B (opt-in) — direct REST** against `https://api.firecrawl.dev/v1/` with
  `Authorization: Bearer <FIRECRAWL_API_KEY>`. Same capabilities, no MCP indirection.

**Why this pairs with mem0/supermemory:** Firecrawl's output is already clean markdown
optimized for LLMs. Feed the scrape result directly into `/integration-mem0` or
`/integration-supermemory` as a memory add — no HTML stripping, no boilerplate removal
needed.

**Credit consumption:** Free tier has monthly credit cap (per Firecrawl pricing). Deep
crawls of large sites can drain quickly. `scrape` costs 1 credit; `crawl` costs 1 per
page; `search` costs 1 per query.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$FIRECRAWL_API_KEY` | API key starting with `fc-` | https://firecrawl.dev/app → API Keys → Create |
| `$WIRE_PATH` *(optional)* | `A` (hosted MCP, default) or `B` (direct REST) | A is simpler; B for HTTP-tool-only setups |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci firecrawl" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^FIRECRAWL_API_KEY=fc-' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY" -gt 0 ]; then
    echo "Firecrawl already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "Firecrawl key present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (key format + live REST verify)

```bash
# Key format: fc-<alphanumeric>
printf '%s' "$FIRECRAWL_API_KEY" | grep -qE '^fc-[A-Za-z0-9]+$' \
  || { echo "ABORT: FIRECRAWL_API_KEY must start with 'fc-' (Firecrawl key)."; exit 1; }
[ "${#FIRECRAWL_API_KEY}" -ge 30 ] \
  || { echo "ABORT: FIRECRAWL_API_KEY looks too short."; exit 1; }

# Live REST — POST /v1/scrape on example.com (1 credit)
HTTP=$(curl -sS -o /tmp/fc.json -w '%{http_code}' --max-time 30 \
  -X POST 'https://api.firecrawl.dev/v1/scrape' \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200) echo "Firecrawl API OK — scraped example.com successfully (1 credit consumed)." ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://firecrawl.dev/app → API Keys."; exit 1 ;;
  402) echo "ABORT: 402 — insufficient credits. Top up at https://firecrawl.dev/app."; exit 1 ;;
  429) echo "ABORT: 429 — rate limited. Wait and retry."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/fc.json | head -3; exit 1 ;;
esac
rm -f /tmp/fc.json

# Path A: verify hosted MCP endpoint responds
if [ "${WIRE_PATH:-A}" = "A" ]; then
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
  MCP_URL="https://mcp.firecrawl.dev/$FIRECRAWL_API_KEY/v2/mcp"
  RESP=$(curl -sS --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -d "$INIT" \
    "$MCP_URL" 2>/dev/null) || true
  printf '%s' "$RESP" | grep -q '"result"' \
    && echo "Firecrawl hosted MCP OK." \
    || { echo "ABORT: Firecrawl MCP probe failed. Body:"; echo "$RESP" | head -3; exit 1; }
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write FIRECRAWL_API_KEY (length ${#FIRECRAWL_API_KEY}, prefix fc-) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env

  Path A (hosted MCP — URL-embedded key):
    3. Register MCP: hermes mcp add firecrawl --url https://mcp.firecrawl.dev/\${FIRECRAWL_API_KEY}/v2/mcp
       --auth none (key is in the URL path)
    4. Reload gateway: stop + run
    5. Verify in logs: grep "registered.*firecrawl"
    6. Smoke test: MCP tools/list — expect scrape/crawl/search/extract/map tools

  Path B (direct REST — no MCP):
    3. No MCP registration; generic HTTP tool reads FIRECRAWL_API_KEY
    4. Reload gateway: stop + run
    5. Smoke test: POST /v1/scrape example.com → expect 200

Key is NEVER printed in plaintext beyond a length + prefix.
Note: Path A puts the key in the MCP URL. Anyone with hermes logs access on the VPS could
see it. Keep ~/.hermes/config.yaml chmod 600 and access-controlled.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set FIRECRAWL_API_KEY '$FIRECRAWL_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^FIRECRAWL_API_KEY=fc-' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: Firecrawl key not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^FIRECRAWL_API_KEY=' ~/.hermes/.env || printf 'FIRECRAWL_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^FIRECRAWL_API_KEY=.*|FIRECRAWL_API_KEY=$FIRECRAWL_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP (Path A only)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add firecrawl \
      --url 'https://mcp.firecrawl.dev/\${FIRECRAWL_API_KEY}/v2/mcp' \
      --auth none
  "
  echo "Firecrawl MCP registered. Key is embedded in the URL via env-var indirection."
fi
```

Path B has no MCP to register. The generic HTTP tool reads env and uses:

- **Base URL:** `https://api.firecrawl.dev/v1`
- **Auth:** `Authorization: Bearer ${FIRECRAWL_API_KEY}`
- **Endpoints:**
  - `POST /scrape` — single-page markdown extract (`{"url":"...","formats":["markdown"]}`)
  - `POST /crawl` — full-site crawl (async — returns job ID; poll `/crawl/{id}`)
  - `POST /map` — sitemap-only fast URL discovery
  - `POST /search` — web search + optional scrape of top N
  - `POST /extract` — structured extraction with schema

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify registration (Path A) + live scrape smoke test

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*firecrawl|MCP server.*firecrawl.*(ok|ready)"; then
      REGISTERED=1; echo "OK: firecrawl MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: firecrawl not in logs after 30s. Rolling back."; rollback; exit 1; }
fi

# Smoke test (both paths) — scrape example.com from VPS
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST 'https://api.firecrawl.dev/v1/scrape' \
    -H \"Authorization: Bearer \$FIRECRAWL_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"url\":\"https://example.com\",\"formats\":[\"markdown\"]}'
")
case "$HTTP" in
  200) echo "OK: Firecrawl scrape reachable from VPS (1 credit consumed)." ;;
  401) echo "FAIL: 401. Rolling back."; rollback; exit 1 ;;
  402) echo "WARN: 402 — credits exhausted." ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove firecrawl 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^FIRECRAWL_API_KEY=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://firecrawl.dev/app if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Deep crawl exhausts credits fast | 1 credit per page; a 10k-page site = 10k credits | Set `limit` on crawl; use `/map` first to see scope; monitor at firecrawl.dev/app |
| 2 | Path A URL contains the API key | Anyone reading config.yaml sees the key | Keep `~/.hermes/.env` and `~/.hermes/config.yaml` chmod 600; use env-var indirection |
| 3 | `fco_` OAuth tokens confused with `fc-` API keys | Different auth flows; `fco_` needs OAuth refresh | This skill uses `fc-` only; refuses `fco_` in Step 3 (via regex) |
| 4 | Scraping sites that block bots | Firecrawl handles most, but paywalled/Cloudflare-protected sites still fail | Enable stealth mode in scrape params: `{"stealth":true}` (uses more credits) |
| 5 | Passing raw HTML into memory instead of markdown | Wastes tokens; loses semantic structure | Always request `formats:["markdown"]`; feed the markdown directly into mem0/supermemory |
| 6 | Rate limits (per-plan QPS) | Bursty batch scrapes hit 429 | Batch with `crawl` (server-side rate control) instead of many parallel `scrape` calls |
| 7 | Key in `config.yaml` (plaintext, not `${...}` indirection) | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; env-var indirection in yaml |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter | URL contains `/`, key may contain nothing but universal rule | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Self-hosted Firecrawl missing hosted MCP | Only cloud Firecrawl has `mcp.firecrawl.dev` | Self-hosted deploys wire Path B (REST) or stand up their own MCP wrapper |
| 13 | Scraping `robots.txt`-disallowed content | Firecrawl respects robots.txt by default | Set `{"skipTlsVerification":false}` if you need to override for known-good crawls |
| 14 | Assuming crawl is synchronous | Crawl is async — returns job ID, must poll | Tool implementation must poll `/crawl/{id}` until `status:"completed"` |
| 15 | Extracting structured data without schema | Free-form extraction is expensive and unreliable | Always pass a JSON schema to `/extract` for reliable structured output |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: key starts with `fc-` + ≥30 chars; live `/v1/scrape` on example.com returned 200; Path A → MCP `initialize` returned result
- [ ] Dry-run shown to user; credit consumption + key-in-URL caveats acknowledged; user approved (or `AUTO_APPROVE=1`)
- [ ] `FIRECRAWL_API_KEY` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: MCP registered with `${FIRECRAWL_API_KEY}` URL indirection (no plaintext in yaml)
- [ ] Path B: REST surface documented (base + Bearer + endpoints)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'firecrawl'` within 30s
- [ ] Smoke test: `/v1/scrape` from VPS returned 200
- [ ] User told: pair with `/integration-mem0` or `/integration-supermemory` — feed markdown directly to memory add
- [ ] User informed of credit consumption per operation
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, credit,
and Firecrawl rate-limit failure modes.
