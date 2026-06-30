---
name: integration-linear
description: Connect Linear (issues, projects, cycles, comments) to a self-hosted Hermes agent over SSH. Wires the Linear GraphQL API with a personal API key because Linear's hosted MCP is OAuth-only. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-linear — connect Linear to a remote Hermes (SSH-first)

You are the engineer connecting Linear to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the personal API key in Linear settings.
2. Pick the scope (Read / Write / Admin and which teams) on that key.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Linear ships a hosted remote MCP at
`https://mcp.linear.app/sse`, but it is **OAuth-only** with dynamic client registration —
no static API key path that a headless agent can complete. So we do NOT wire the hosted
MCP. We use Linear's GraphQL API directly with a personal API key (`lin_api_...`) — the
only path that works without a browser-driven OAuth dance. There is a community
`linear-mcp-server` npm package; it also wraps this same GraphQL API with the same key,
so the REST/GraphQL path here is the source of truth either way.

**The #1 Linear gotcha — no `Bearer` prefix.** Linear's GraphQL API takes the personal
key raw in the `Authorization` header. `Authorization: lin_api_...`, NOT
`Authorization: Bearer lin_api_...`. Every other API you have used probably wants
`Bearer`. Linear does not. Sending `Bearer` returns 401 with `"Authentication required"`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$LINEAR_API_KEY` | Personal API key (`lin_api_...`) | <https://linear.app/settings/api> → **Personal API keys** → **New API key**. Pick the narrowest scope (Read / Write / Admin, and optionally restrict to specific teams). Read+Write is enough for most agent use. |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci linear" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Linear is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write LINEAR_API_KEY (length ${#LINEAR_API_KEY}, prefix ${LINEAR_API_KEY:0:8}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add linear (Path A: community stdio MCP, or Path B: GraphQL REST)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*linear"
  6. Smoke test: POST https://api.linear.app/graphql { viewer { id name email } } → expect 200 with no errors

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set LINEAR_API_KEY '$LINEAR_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^LINEAR_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: LINEAR_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — `lin_api_` keys are alnum + underscore so `/` would also work,
> but pipe is universal and matches the rest of hstack):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^LINEAR_API_KEY=' ~/.hermes/.env || printf 'LINEAR_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^LINEAR_API_KEY=.*|LINEAR_API_KEY=$LINEAR_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Linear endpoint

Pick the path that matches the Hermes build on the VPS. Path B (GraphQL REST) is the
primary recommendation — it has no extra dependencies and exactly matches how Linear
itself documents the API. Path A is a convenience wrapper.

### Path A (optional) — community stdio MCP server

The community `linear-mcp-server` npm package wraps the same GraphQL API with a tool
surface (`linear_create_issue`, `linear_search_issues`, etc.). It is not first-party and
not maintained by Linear, so vet it before adopting in production. The key still goes
through indirection — never inlined:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add linear \
    --command npx \
    --args '-y,linear-mcp-server' \
    --env 'LINEAR_API_KEY=\${LINEAR_API_KEY}'
"
```

Flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax.

### Path B (preferred) — generic HTTP tool against Linear GraphQL

- **Endpoint:** `https://api.linear.app/graphql` (Linear is GraphQL-only — no REST)
- **Method:** `POST`
- **Auth header:** `Authorization: ${LINEAR_API_KEY}`  — **no `Bearer` prefix**
- **Content type:** `Content-Type: application/json`
- **Body shape:** `{"query":"...","variables":{...}}`

Do NOT try to register `https://mcp.linear.app/sse` with a static key. That endpoint is
OAuth-only with dynamic client registration; a static `Authorization` header gets 401.

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
       | grep -qiE "registered.*tool.*linear|MCP server.*linear.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: linear registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: linear not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

The canonical "is the key alive" GraphQL query is `{ viewer { id name email } }`. It
hits no team scope, never mutates, and is the same probe Linear's own docs use.

```bash
RESP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -w '\nHTTP:%{http_code}' \
    -X POST 'https://api.linear.app/graphql' \
    -H \"Authorization: \$LINEAR_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"query\":\"query { viewer { id name email } }\"}'
")
HTTP=$(printf '%s' "$RESP" | sed -n 's/^HTTP://p' | tail -1)
BODY=$(printf '%s' "$RESP" | sed '$d')

case "$HTTP" in
  200)
    if printf '%s' "$BODY" | grep -q '"errors"'; then
      echo "FAIL: 200 with GraphQL errors (likely scope / token shape). Body: $BODY"; rollback; exit 1
    else
      echo "OK: Linear GraphQL reachable, viewer resolved."
    fi
    ;;
  401) echo "FAIL: 401 — token invalid, missing, or sent with a 'Bearer' prefix. Re-check Step 4 and remove any 'Bearer'."; rollback; exit 1 ;;
  429) echo "WARN: rate-limited on the smoke test. Wait a minute and re-run." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Linear GraphQL. Body: $BODY" ;;
esac
```

`200` with a `data.viewer` block and no `errors` array = wired. `200` with an `errors`
array usually means the key is valid but the scope is too narrow for what was queried.
`401` almost always means a stray `Bearer` prefix or the key was not written.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove linear 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset LINEAR_API_KEY 2>/dev/null || \
    sed -i '/^LINEAR_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Linear is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer lin_api_...` | Linear's GraphQL API rejects the `Bearer` prefix on personal keys; returns 401 `"Authentication required"` | Send the key raw: `Authorization: ${LINEAR_API_KEY}` |
| 2 | Wiring the hosted `mcp.linear.app/sse` MCP with a static key | It is OAuth-only with dynamic client registration — no static-bearer path completes headlessly | Use GraphQL (Path B) or the community stdio wrapper (Path A) |
| 3 | Treating Linear as REST | Linear has no REST API; every call goes through `/graphql` | Always POST a `{"query":"..."}` body to `https://api.linear.app/graphql` |
| 4 | Key is user-scoped, not workspace-scoped | The agent sees only what that user can see; team restrictions on the key narrow this further | Mint with the broadest team scope the user actually wants the agent to act in |
| 5 | Read-only key fails on create/update | Mutations return a GraphQL `errors` array even with HTTP 200 | Mint a Read+Write key (or Admin) when the agent must create issues/comments |
| 6 | Archived issues invisible by default | Linear hides archived issues unless `includeArchived: true` is in the query filter | Pass `filter: { ... }, includeArchived: true` when the agent needs full history |
| 7 | Rate limits — bursty agents hit 429 | Personal-key requests are counted per user with a budget on the order of a few thousand req/hour; complex queries cost more | Backoff on `429`; batch via single GraphQL queries with `first: N` rather than N round-trips |
| 8 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | sed with `/` delimiter on tokens | Safe for `lin_api_` (alnum + `_`), but copy-pasting this pattern to another integration with `/+=` breaks | Use `\|` delimiter everywhere |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `LINEAR_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (community stdio) or GraphQL documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'linear'` within 30s
- [ ] Smoke test: `POST https://api.linear.app/graphql { viewer { id name email } }` returned `200` with no `errors` array, key sent **without** `Bearer` prefix
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
