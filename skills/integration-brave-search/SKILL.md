---
name: integration-brave-search
description: Connect the Brave Search API (real-time web, news, image, video, local POI, summarizer, llm-context) to a self-hosted Hermes agent over SSH. Wires the official open-source MCP server with a static subscription token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and any AI agent.
---

# /integration-brave-search — connect Brave Search to a remote Hermes (SSH-first)

You are the engineer connecting Brave Search to a self-hosted Hermes agent on the user's
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work
over SSH as root against the VPS. Every command in this skill runs on the VPS, not on
the local machine.

Do everything autonomously; stop only for the one thing a machine cannot do — minting
the Brave Search subscription key in the dashboard.

**Honest auth picture (verified 2026-06):** Brave ships an official open-source MCP
server at `github.com/brave/brave-search-mcp-server` (npm `@brave/brave-search-mcp-server`).
It supports **stdio (default) and HTTP** transports, takes a static `BRAVE_API_KEY`, and
is **self-hosted** — there is no first-party hosted remote MCP URL to point at. So we
either run the official server as a stdio MCP (Path A, preferred) or self-host it in
HTTP mode and wire via `/hermes-mcp-add` (Path B). Brave's REST API itself authenticates
via the `X-Subscription-Token` header — NOT `Authorization: Bearer` — which matters for
the REST fallback and the smoke test.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$BRAVE_API_KEY` | Brave Search subscription token (opaque alnum, no fixed prefix) | <https://api-dashboard.search.brave.com/> -> sign in -> **API Keys** -> **Add API Key** (Free tier: 1 req/sec, 2,000 q/month) |
| Surface plan | Which endpoints to enable (web, news, image, video, local POI, summarizer, llm-context) | Same dashboard; summarizer + llm-context are plan-gated |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci brave-search" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Brave Search is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write BRAVE_API_KEY (length ${#BRAVE_API_KEY}, prefix ${BRAVE_API_KEY:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add brave-search --command npx --args -y,@brave/brave-search-mcp-server
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -iE "registered.*brave|MCP server.*brave"
  6. Smoke test: GET https://api.search.brave.com/res/v1/web/search?q=hermes -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set BRAVE_API_KEY '$BRAVE_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^BRAVE_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: BRAVE_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Brave keys are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^BRAVE_API_KEY=' ~/.hermes/.env || printf 'BRAVE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^BRAVE_API_KEY=.*|BRAVE_API_KEY=$BRAVE_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Brave Search MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with static token

`@brave/brave-search-mcp-server` reads `BRAVE_API_KEY` from env and exposes web, news,
image, video, local POI, summarizer, and `llm-context` tools over stdio.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add brave-search \
    --command npx \
    --args '-y,@brave/brave-search-mcp-server' \
    --env 'BRAVE_API_KEY=\${BRAVE_API_KEY}'
"
```

Use `${BRAVE_API_KEY}` indirection so the secret stays only in `~/.hermes/.env`. The
default transport is stdio; no extra flags needed. Flag names (`--command` / `--args` /
`--env`) vary by Hermes version — run `hermes mcp add --help` first and match its
stdio syntax if uncertain.

**Warm the npx cache** to avoid a first-call timeout while npm fetches the package:

```bash
ssh "$VPS_USER@$VPS_IP" "
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  if [ -n \"\$AGENT\" ]; then
    docker exec \"\$AGENT\" sh -c 'npx -y @brave/brave-search-mcp-server --help' >/dev/null 2>&1 || true
  else
    npx -y @brave/brave-search-mcp-server --help >/dev/null 2>&1 || true
  fi
"
```

### Path B (fallback) — self-host the official MCP server in HTTP mode

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command, run the same
server as a sidecar with `BRAVE_MCP_TRANSPORT=http` (defaults: `BRAVE_MCP_HOST=0.0.0.0`,
`BRAVE_MCP_PORT=8080`), then point `/hermes-mcp-add` at it. The server reads
`BRAVE_API_KEY` from its own env, so the Hermes-side MCP needs no auth header.

```bash
ssh "$VPS_USER@$VPS_IP" "
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  NET=\$(docker inspect -f '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}}{{end}}' \"\$AGENT\")
  docker rm -f brave-mcp 2>/dev/null || true
  docker run -d --name brave-mcp \
    --network \"\$NET\" \
    -e BRAVE_API_KEY='$BRAVE_API_KEY' \
    -e BRAVE_MCP_TRANSPORT=http \
    -p 127.0.0.1:8080:8080 \
    ghcr.io/brave/brave-search-mcp-server:latest
"
```

Then follow `/hermes-mcp-add` end-to-end with `URL=http://brave-mcp:8080/mcp`,
`NAME=brave-search`, auth=none. The probe matrix in `/hermes-mcp-add` Step 1 should
return 200 on variant B (bare, no header) since auth is enforced by Brave's REST under
the hood, not by the MCP wrapper.

### Path C (last resort) — generic HTTP tool against the Brave REST API

If neither MCP path is viable, document the REST surface for a generic HTTP capability:

- **Base URL:** `https://api.search.brave.com/res/v1`
- **Auth header:** `X-Subscription-Token: ${BRAVE_API_KEY}` (NOT `Authorization: Bearer`)
- **Accept:** `application/json`
- **Accept-Encoding:** `gzip`

Endpoints: `GET /web/search?q=<query>`, `GET /news/search`, `GET /images/search`,
`GET /videos/search`, `GET /summarizer/search?key=<summarizer_key>` (key returned by
web search), `GET /local/pois`.

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
       | grep -qiE "registered.*tool.*brave|MCP server.*brave.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: brave-search registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: brave-search not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the VPS so the token stays there)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Accept: application/json" \
    -H "Accept-Encoding: gzip" \
    -H "X-Subscription-Token: $BRAVE_API_KEY" \
    "https://api.search.brave.com/res/v1/web/search?q=hermes+agent&count=1"
')
case "$HTTP" in
  200) echo "OK: Brave Search API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty (check X-Subscription-Token header, NOT Bearer)."; rollback; exit 1 ;;
  403) echo "FAIL: endpoint not on your plan (summarizer/llm-context are plan-gated)."; exit 1 ;;
  429) echo "WARN: rate limited (Free tier = 1 req/sec, 2000/month). Token works." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Brave API. Check manually." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove brave-search 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "docker rm -f brave-mcp 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset BRAVE_API_KEY 2>/dev/null || \
    sed -i '/^BRAVE_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Brave Search is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer <key>` | Brave rejects it — REST auth is `X-Subscription-Token`. Returns `401`. | Use `X-Subscription-Token` exactly (case-sensitive). |
| 2 | Looking for a hosted remote MCP URL | None exists; the server is self-hosted only. Wiring a made-up URL fails. | Use Path A (stdio) or Path B (self-host + wire). |
| 3 | Free-tier rate limit | 1 req/sec, 2,000 q/month. Bursty agent traffic hits `429`. | Backoff on `429`; cache repeats; upgrade for production. |
| 4 | `summarizer` / `llm-context` plan gating | Higher-tier endpoints return `403` on Free. | Confirm plan before enabling those tools in chat. |
| 5 | `npx` cold start in Path A | First call after gateway boot times out while npm fetches the package. | Warm it once (Step 5 includes the warm command). |
| 6 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env`. | Always `stop` + `run`. |
| 7 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline. | Always `hermes config set`. |
| 8 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by Hermes runtime. | Only `~/.hermes/.env`, `chmod 600`. |
| 9 | sed with `/` delimiter on tokens | Tokens may contain `/+=`; sed breaks. | Always use `\|` delimiter. |
| 10 | Container vs host confusion | Skill assumed wrong layer; key invisible to sshd or runtime. | Step 1 detects host vs container; always check `whoami; hostname`. |
| 11 | Skipping the verify step | "Silent success" — config written, never picked up by gateway. | Always poll logs + smoke test. |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `BRAVE_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (stdio), Path B (self-hosted HTTP via `/hermes-mcp-add`), or REST documented via Path C
- [ ] Gateway reloaded with `stop` + `run` (NOT `restart`)
- [ ] Logs show `registered N tool(s) for 'brave-search'` within 30s
- [ ] Smoke test: `GET /res/v1/web/search` returned `200` (or `429` = key valid, just throttled)
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
