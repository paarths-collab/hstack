---
name: integration-qdrant
description: Connect Qdrant (open-source vector database — Qdrant Cloud managed or self-hosted, semantic search + payload filtering) to a self-hosted Hermes Agent over SSH via Qdrant's official stdio MCP (github.com/qdrant/mcp-server-qdrant). Uses QDRANT_URL + QDRANT_API_KEY. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-qdrant — connect Qdrant vector DB to a remote Hermes (SSH-first)

You are the engineer connecting Qdrant (open-source vector database + payload filter engine)
to a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code,
Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against the VPS. The
user does two things a machine cannot:

1. Provision the Qdrant instance (Qdrant Cloud cluster, self-hosted docker, or Fly.io
   deploy) and copy the cluster URL.
2. (Cloud only) Mint the API key in the Qdrant Cloud Console.

Everything else — key storage, live cluster reachability, MCP registration via stdio,
gateway reload, live collection-list smoke test — runs on the VPS via SSH, idempotently
with a rollback path.

**Honest auth picture (verified 2026-06):** Qdrant ships an **official stdio MCP** at
`github.com/qdrant/mcp-server-qdrant` (published as `mcp-server-qdrant` on PyPI). There is
**no first-party hosted HTTP MCP** — Qdrant intentionally distributes their MCP as stdio
so the agent runs it against whichever cluster the operator points to.

Sources:
- https://github.com/qdrant/mcp-server-qdrant
- https://qdrant.tech/documentation/cloud/authentication/
- https://pypi.org/project/mcp-server-qdrant/

**Two deploy topologies:**

- **Qdrant Cloud (managed):** cluster URL like
  `https://<UUID>.<REGION>.aws.cloud.qdrant.io:6333` with a Bearer API key.
- **Self-hosted:** cluster URL like `http://qdrant.internal:6333` or
  `https://qdrant.example.com`. API key optional but strongly recommended for anything
  reachable from the internet.

**Key format:** Qdrant API keys are opaque tokens (~64 chars, alphanumeric).

**Collection scoping:** the official MCP takes a `COLLECTION_NAME` env — if set, the
agent's memory/RAG tools scope to that collection. Recommended for multi-tenant setups
(one collection per user/tenant/persona).

**Embedding provider:** the MCP embeds text with an embedding model (default
`sentence-transformers/all-MiniLM-L6-v2` via fastembed). For OpenAI/Cohere embeddings, set
`EMBEDDING_PROVIDER` + provider-specific env vars.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$QDRANT_URL` | Cluster URL (`https://<uuid>.<region>.aws.cloud.qdrant.io:6333` or `http://host:6333`) | Qdrant Cloud Console → cluster → Details, OR your self-hosted deploy |
| `$QDRANT_API_KEY` | API key (Cloud) or self-hosted key (optional but recommended) | Qdrant Cloud Console → API keys, or self-hosted `QDRANT__SERVICE__API_KEY` config |
| `$QDRANT_COLLECTION_NAME` *(optional but recommended)* | Collection the MCP tools operate on | Set a per-tenant/persona name; the MCP auto-creates if missing |
| `$QDRANT_EMBEDDING_MODEL` *(optional)* | Embedding model for the MCP's memory tools (default `sentence-transformers/all-MiniLM-L6-v2`) | Pick to match your embedding pipeline; must match if reading vectors written by another process |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + uvx on the VPS

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

ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1" \
  || { echo "ABORT: uvx required on the VPS. Install: pip install uv"; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci qdrant" || echo 0)
HAS_URL=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^QDRANT_URL=http' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_URL" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Qdrant already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (URL format + live cluster reachability)

```bash
# URL: http(s)://host:port, no trailing slash
printf '%s' "$QDRANT_URL" | grep -qE '^https?://[^[:space:]/]+(:[0-9]+)?$' \
  || { echo "ABORT: QDRANT_URL must be 'http[s]://host[:port]' with no trailing slash."; exit 1; }

# Warn if HTTP not HTTPS on non-localhost
case "$QDRANT_URL" in
  http://127.*|http://localhost*|http://qdrant*|http://192.168.*|http://10.*) : ;;
  http://*) echo "WARN: QDRANT_URL is HTTP on a non-local host — traffic (and key) are plaintext." ;;
esac

# Live reachability: GET /collections
HEADERS=()
if [ -n "${QDRANT_API_KEY:-}" ]; then
  HEADERS=(-H "api-key: $QDRANT_API_KEY")
fi
HTTP=$(curl -sS -o /tmp/qd.json -w '%{http_code}' --max-time 10 \
  "${HEADERS[@]}" \
  "$QDRANT_URL/collections" 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    COLL_COUNT=$(grep -oE '"name":"[^"]+"' /tmp/qd.json | wc -l | tr -d ' ')
    echo "Qdrant cluster OK. Reachable at $QDRANT_URL ($COLL_COUNT existing collection(s))."
    ;;
  401|403)
    if [ -z "${QDRANT_API_KEY:-}" ]; then
      echo "ABORT: cluster requires an API key (401/403). Set QDRANT_API_KEY."
    else
      echo "ABORT: 401/403 — key rejected."
    fi
    exit 1 ;;
  000) echo "ABORT: cannot reach $QDRANT_URL (network/firewall/DNS)."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP from cluster."; cat /tmp/qd.json | head -3; exit 1 ;;
esac
rm -f /tmp/qd.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
COLLECTION=${QDRANT_COLLECTION_NAME:-hstack-default}
EMBED=${QDRANT_EMBEDDING_MODEL:-sentence-transformers/all-MiniLM-L6-v2}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write QDRANT_URL ($QDRANT_URL) via 'hermes config set'
  2. Write QDRANT_API_KEY (length ${#QDRANT_API_KEY}) if supplied — NEVER plaintext-logged
  3. Write QDRANT_COLLECTION_NAME ($COLLECTION)
  4. Write QDRANT_EMBEDDING_MODEL ($EMBED)
  5. chmod 600 ~/.hermes/.env
  6. Register MCP: hermes mcp add qdrant --command uvx --args mcp-server-qdrant
       env: QDRANT_URL, QDRANT_API_KEY, COLLECTION_NAME, EMBEDDING_MODEL
  7. Reload gateway: stop + run (NOT restart)
  8. Verify in logs: grep "registered.*qdrant"
  9. Smoke test: GET /collections/$COLLECTION — expect 200 or 404 (auto-created on first use)

Key is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set QDRANT_URL '$QDRANT_URL'"
if [ -n "${QDRANT_API_KEY:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set QDRANT_API_KEY '$QDRANT_API_KEY'"
fi
ssh "$VPS_USER@$VPS_IP" "hermes config set QDRANT_COLLECTION_NAME '${QDRANT_COLLECTION_NAME:-hstack-default}'"
ssh "$VPS_USER@$VPS_IP" "hermes config set QDRANT_EMBEDDING_MODEL '${QDRANT_EMBEDDING_MODEL:-sentence-transformers/all-MiniLM-L6-v2}'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^QDRANT_URL=http' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: QDRANT_URL not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the API key in `config.yaml`.

---

## Step 6 — register the Qdrant MCP (stdio)

```bash
# Build env list — only include API_KEY if it's set (self-hosted no-auth setups skip it)
ENV_LIST='QDRANT_URL=${QDRANT_URL},COLLECTION_NAME=${QDRANT_COLLECTION_NAME},EMBEDDING_MODEL=${QDRANT_EMBEDDING_MODEL}'
if [ -n "${QDRANT_API_KEY:-}" ]; then
  ENV_LIST="$ENV_LIST,QDRANT_API_KEY=\${QDRANT_API_KEY}"
fi

ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add qdrant \
    --command 'uvx' \
    --args 'mcp-server-qdrant' \
    --env '$ENV_LIST'
"
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
       | grep -qiE "registered.*tool.*qdrant|MCP server.*qdrant.*(ok|ready)"; then
    REGISTERED=1; echo "OK: qdrant MCP registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: qdrant not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (from inside the container)

```bash
COLLECTION=${QDRANT_COLLECTION_NAME:-hstack-default}
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  HEADERS=''
  [ -n \"\$QDRANT_API_KEY\" ] && HEADERS=\"-H 'api-key: \$QDRANT_API_KEY'\"
  eval curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \$HEADERS \"\$QDRANT_URL/collections/$COLLECTION\"
")
case "$HTTP" in
  200) echo "OK: collection '$COLLECTION' reachable and exists." ;;
  404) echo "OK: cluster reachable; collection '$COLLECTION' does not exist yet — will be auto-created on first upsert." ;;
  401|403) echo "FAIL: 401/403 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove qdrant 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^QDRANT_URL=/d;
            /^QDRANT_API_KEY=/d;
            /^QDRANT_COLLECTION_NAME=/d;
            /^QDRANT_EMBEDDING_MODEL=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the Qdrant Cloud key in console if compromised. Collections in the cluster are NOT deleted."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Self-hosted cluster on public IP without API key | Anyone on the internet can read/write your vectors | Always set `QDRANT_API_KEY` for public clusters; bind to localhost or private network if internal |
| 2 | HTTP on non-local host | Key + payloads travel plaintext | Use HTTPS for anything not on localhost / private network |
| 3 | `api-key` header (Qdrant) vs `Authorization: Bearer` | Qdrant uses lowercase `api-key` header, NOT Bearer | Step 3 + Step 9 use `api-key` correctly |
| 4 | Embedding model mismatch | If different processes write vectors with different embedders, search returns nonsense | Pin `QDRANT_EMBEDDING_MODEL` to whatever your indexing pipeline uses |
| 5 | Auto-creating collections with wrong dimensions | First upsert sets dimensions; can't change later without dropping | Pre-create collections with explicit vector config for production |
| 6 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 7 | Cluster suspended on Qdrant Cloud free tier | Inactive clusters auto-suspend; first call cold-starts | Monitor cluster status; upgrade if needed |
| 8 | Collection name confusion in multi-tenant | Agents accessing the wrong tenant's collection | Set `QDRANT_COLLECTION_NAME` explicitly per deploy; use one collection per tenant |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | URL contains `/`, key may contain `/+=` | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Trailing slash on URL | Qdrant appends paths — trailing slash → `//collections` = 404 | Step 3 validator rejects trailing slash |
| 14 | Confusing gRPC port (6334) with REST port (6333) | MCP uses REST (6333); gRPC is 6334 | Always :6333 in the URL for the MCP |
| 15 | Community stdio MCP not audited | Even official `qdrant/mcp-server-qdrant` should be pinned + reviewed | Pin the version (`uvx mcp-server-qdrant@0.x.y`); read source before granting writes |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] `uvx` present on VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: URL format valid; live `/collections` returned 200; HTTPS check called out if HTTP on non-local
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep (key NEVER printed)
- [ ] MCP registered with env indirection (`QDRANT_URL=${QDRANT_URL}` etc.)
- [ ] `QDRANT_API_KEY` only included in MCP env if actually set (self-hosted no-auth omits it)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'qdrant'` within 30s
- [ ] Smoke test: `/collections/<name>` from VPS returned 200 or 404 (both OK — 404 means auto-create-on-first-upsert)
- [ ] `QDRANT_COLLECTION_NAME` scoping documented (one collection per tenant / persona)
- [ ] User informed of embedding-model-must-match rule
- [ ] Rollback function defined; key revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, api-key
header, and Qdrant cluster failure modes.
