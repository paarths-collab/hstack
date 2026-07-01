---
name: integration-pinecone
description: Connect Pinecone (managed vector database — indexes, upserts, queries, hybrid search) to a self-hosted Hermes Agent over SSH. Path A — official developer stdio MCP (pinecone-io/pinecone-mcp) for full index CRUD. Path B — hosted Assistant MCP with Bearer key (RAG over pre-built assistant). Uses pcsk_ API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-pinecone — connect Pinecone vector DB to a remote Hermes (SSH-first)

You are the engineer connecting Pinecone (managed vector database for embeddings + hybrid
search + RAG) to a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes,
Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against
the VPS. The user does one thing a machine cannot: mint the `pcsk_` API key at
https://app.pinecone.io.

Everything else — key storage, live API verification, MCP registration, gateway reload,
live query smoke test — runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Pinecone ships **two** first-party MCP servers:

- **Path A — Developer MCP (stdio, default here):** `pinecone-io/pinecone-mcp` runs via
  `uvx` or `npx`. Full CRUD on indexes, upserts, queries, list-indexes, describe. Reads
  `PINECONE_API_KEY` from env. This is what most autonomous agents want.
  https://github.com/pinecone-io/pinecone-mcp
- **Path B — Assistant MCP (hosted HTTP):** `https://<ASSISTANT_HOST>/mcp/assistants/<NAME>`
  with `Authorization: Bearer <PINECONE_API_KEY>`. Chat/RAG over a Pinecone Assistant
  you've already built. Only useful if you've built an Assistant in the Pinecone Console.
  https://docs.pinecone.io/guides/assistant/mcp-server

**Key format:** Pinecone API keys start with `pcsk_`. Store in `~/.hermes/.env` never in
`config.yaml` or chat.

**Key scope:** a Pinecone API key is scoped to a **project**. The key can access ALL
indexes in that project. There's no per-index key. If you need tighter isolation, use
separate projects.

**Read-only agents:** Pinecone has no built-in read-only mode at the key level. If the
agent shouldn't upsert or delete vectors, enforce that in the agent's system prompt or
by wrapping the MCP tool set (e.g. only expose `query` / `describe_index` tools).

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PINECONE_API_KEY` | API key starting with `pcsk_` | https://app.pinecone.io → API Keys → Create |
| `$WIRE_PATH` *(optional)* | `A` (Developer MCP, default) or `B` (Assistant MCP) | B requires a pre-built Assistant + host URL |
| `$PINECONE_ASSISTANT_HOST` *(Path B — required)* | Assistant host (e.g. `prod-1-data.ke.pinecone.io`) | Pinecone Console → your Assistant → sidebar |
| `$PINECONE_ASSISTANT_NAME` *(Path B — required)* | Assistant name (URL-safe slug) | Pinecone Console → your Assistant name |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + Path A prereqs on the VPS

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

# Path A needs uvx OR npx
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires uvx or npx on the VPS. Install: pip install uv"; exit 1; }
fi
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci pinecone" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^PINECONE_API_KEY=pcsk_' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Pinecone already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (key format + path-specific validation + live API check)

```bash
# Key format
printf '%s' "$PINECONE_API_KEY" | grep -qE '^pcsk_[A-Za-z0-9_-]+$' \
  || { echo "ABORT: PINECONE_API_KEY must start with 'pcsk_' (Pinecone key)."; exit 1; }
[ "${#PINECONE_API_KEY}" -ge 20 ] \
  || { echo "ABORT: PINECONE_API_KEY looks too short."; exit 1; }

# Live control-plane check: GET /indexes
HTTP=$(curl -sS -o /tmp/pc.json -w '%{http_code}' --max-time 10 \
  -H "Api-Key: $PINECONE_API_KEY" \
  -H 'X-Pinecone-API-Version: 2025-10' \
  'https://api.pinecone.io/indexes' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    INDEX_COUNT=$(grep -oE '"name":"[^"]+"' /tmp/pc.json | wc -l | tr -d ' ')
    echo "Pinecone control plane OK. Project has $INDEX_COUNT index(es)."
    ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://app.pinecone.io → API Keys."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/pc.json | head -3; exit 1 ;;
esac
rm -f /tmp/pc.json

# Path B: verify Assistant MCP endpoint
if [ "${WIRE_PATH:-A}" = "B" ]; then
  [ -n "$PINECONE_ASSISTANT_HOST" ] && [ -n "$PINECONE_ASSISTANT_NAME" ] \
    || { echo "ABORT: Path B requires PINECONE_ASSISTANT_HOST and PINECONE_ASSISTANT_NAME."; exit 1; }
  ASSISTANT_URL="https://$PINECONE_ASSISTANT_HOST/mcp/assistants/$PINECONE_ASSISTANT_NAME"

  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
  RESP=$(curl -sS --max-time 15 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $PINECONE_API_KEY" \
    -d "$INIT" \
    "$ASSISTANT_URL" 2>/dev/null) || true
  printf '%s' "$RESP" | grep -q '"result"' \
    && echo "Pinecone Assistant MCP OK at $ASSISTANT_URL." \
    || { echo "ABORT: Pinecone Assistant MCP probe failed."; echo "$RESP" | head -3; exit 1; }
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
    1. Write PINECONE_API_KEY (length ${#PINECONE_API_KEY}, prefix pcsk_) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env

  Path A (Developer stdio MCP):
    3. Register MCP: hermes mcp add pinecone --command uvx --args pinecone-mcp
       --env PINECONE_API_KEY=\${PINECONE_API_KEY}
    4. Reload gateway: stop + run
    5. Verify in logs: grep "registered.*pinecone"
    6. Smoke test: GET /indexes — expect 200

  Path B (Assistant HTTP MCP):
    3. Write PINECONE_ASSISTANT_HOST + PINECONE_ASSISTANT_NAME
    4. Register MCP: hermes mcp add pinecone --url https://\${HOST}/mcp/assistants/\${NAME}
       --auth-header Authorization --auth-scheme Bearer
    5. Reload gateway: stop + run
    6. Smoke test: MCP tools/list returned result

Key is NEVER printed in plaintext beyond a length + prefix.
Note: no read-only mode; agent can upsert/delete unless system-prompt restricted.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set PINECONE_API_KEY '$PINECONE_API_KEY'"
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set PINECONE_ASSISTANT_HOST '$PINECONE_ASSISTANT_HOST'"
  ssh "$VPS_USER@$VPS_IP" "hermes config set PINECONE_ASSISTANT_NAME '$PINECONE_ASSISTANT_NAME'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^PINECONE_API_KEY=pcsk_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: Pinecone key not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^PINECONE_API_KEY=' ~/.hermes/.env || printf 'PINECONE_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^PINECONE_API_KEY=.*|PINECONE_API_KEY=$PINECONE_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP

### Path A — Developer stdio MCP (default)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add pinecone \
      --command 'uvx' \
      --args 'pinecone-mcp' \
      --env 'PINECONE_API_KEY=\${PINECONE_API_KEY}'
  "
fi
```

### Path B — hosted Assistant MCP

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add pinecone \
      --url 'https://$PINECONE_ASSISTANT_HOST/mcp/assistants/$PINECONE_ASSISTANT_NAME' \
      --auth-header 'Authorization' \
      --auth-scheme 'Bearer' \
      --placeholder-token 'placeholder'
  "
  ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${PINECONE_API_KEY}|g' ~/.hermes/config.yaml"
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

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE "registered.*tool.*pinecone|MCP server.*pinecone.*(ok|ready)"; then
    REGISTERED=1; echo "OK: pinecone MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: pinecone not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (from inside the container)

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
      -H \"Api-Key: \$PINECONE_API_KEY\" \
      -H 'X-Pinecone-API-Version: 2025-10' \
      'https://api.pinecone.io/indexes'
  ")
  case "$HTTP" in
    200) echo "OK: Pinecone control plane reachable from VPS." ;;
    *) echo "FAIL: HTTP $HTTP from control plane. Rolling back."; rollback; exit 1 ;;
  esac
fi
if [ "${WIRE_PATH:-A}" = "B" ]; then
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
      -X POST 'https://\$PINECONE_ASSISTANT_HOST/mcp/assistants/\$PINECONE_ASSISTANT_NAME' \
      -H 'Accept: application/json, text/event-stream' \
      -H 'Content-Type: application/json' \
      -H \"Authorization: Bearer \$PINECONE_API_KEY\" \
      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'
  ")
  case "$HTTP" in
    200) echo "OK: Assistant MCP tools/list reachable from VPS." ;;
    *) echo "FAIL: HTTP $HTTP from Assistant MCP. Rolling back."; rollback; exit 1 ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove pinecone 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^PINECONE_API_KEY=/d;
            /^PINECONE_ASSISTANT_HOST=/d;
            /^PINECONE_ASSISTANT_NAME=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://app.pinecone.io → API Keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | No read-only mode at the key level | Agent can upsert/delete/`delete_index` — data loss possible | Enforce via system prompt OR expose only `query`/`describe_index` tools from the MCP |
| 2 | Key scoped to project, not index | Compromise = all indexes in the project exposed | Use separate projects for isolation |
| 3 | Confusing Api-Key header (control plane) with Authorization: Bearer (Assistant MCP) | Two different auth headers for two different surfaces | Step 3 uses correct header per path; Step 9 verifies both |
| 4 | Free-tier index limits | Serverless free tier is 5M vectors / 5 indexes — exhaustion silently fails | Monitor at app.pinecone.io; upgrade if exhausted |
| 5 | Assistant not built yet for Path B | Endpoint 404s | Confirm Assistant exists in Pinecone Console before Path B; Path A doesn't need one |
| 6 | Deleting an index accidentally | `delete_index` is irreversible; recreation loses all vectors | Set project-level deletion protection via Console; enforce in system prompt |
| 7 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Rate limits (control plane vs data plane) | Bursty upserts hit 429; queries have separate limits | Batch upserts (default 100 vectors); back off on 429 |
| 9 | Wrong `X-Pinecone-API-Version` | Older API versions have different response shapes | Pin to a recent version (`2025-10` as of skill write); revisit yearly |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | URL contains `/`, key may contain `/+=` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Assistant host looks like a URL but isn't | `PINECONE_ASSISTANT_HOST` is just the host part, no `https://` or `/mcp/...` | Step 3 constructs the full URL |
| 15 | Confusing Assistant name with Assistant ID | Some Pinecone tooling uses IDs elsewhere; MCP uses NAME | Copy the name from the Assistant sidebar |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `uvx` or `npx` present on VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: key starts with `pcsk_` + ≥20 chars; live `/indexes` returned 200; Path B → Assistant MCP `initialize` returned result
- [ ] Dry-run shown to user; read-only-mode-not-native reminder acknowledged; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: Developer stdio MCP registered with `PINECONE_API_KEY=${PINECONE_API_KEY}` env indirection
- [ ] Path B: Assistant HTTP MCP registered with `${PINECONE_API_KEY}` bearer indirection
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'pinecone'` within 30s
- [ ] Live smoke: Path A `/indexes` OR Path B `tools/list` returned 200
- [ ] User told: agent tools can delete indexes/upsert — either restrict via system prompt or expose only read tools
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, Api-Key
vs Bearer, and Pinecone project-vs-index scoping failure modes.
