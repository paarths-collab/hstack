---
name: integration-airtable
description: Connect Airtable (bases, tables, records) to a self-hosted Hermes Agent over SSH. Wires Airtable's official remote MCP server with a static Personal Access Token (PAT). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-airtable — connect Airtable to a remote Hermes (SSH-first)

You are the engineer connecting Airtable to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Personal Access Token in the Airtable UI.
2. Attach the specific bases/workspaces the token is allowed to touch.

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Airtable ships a first-party hosted remote MCP
at `https://mcp.airtable.com/mcp` that accepts BOTH OAuth and a static Personal Access Token
(`pat...`) via `Authorization: Bearer <pat>`. Unlike Notion's hosted MCP, this one works
with bearer tokens — so for headless self-hosted agents we wire the hosted MCP directly
(Path A). Path B (REST fallback) is documented in case the build can't reach the hosted MCP.

Airtable also retired legacy global account API keys: only PATs (or OAuth) work now.
A `key...`-style legacy key will fail.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$AIRTABLE_PAT` | Personal Access Token (`pat...`) | <https://airtable.com/create/tokens> → Create token |
| Scopes | What the token can do | At minimum `data.records:read` + `schema.bases:read`; add `data.records:write` to mutate; add `schema.bases:write` ONLY if the agent must alter tables/fields |
| Attached bases | Which bases the PAT can see | On the token page → "Add a base" → pick specific bases or workspaces (least privilege) |

The PAT format is `pat<id>.<secret>` — an opaque string prefixed `pat`. It is shown
**once**; if lost the user must regenerate. Treat anything after the `pat` prefix as opaque.

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

If you land in a `root@<hex-string>` shell (e.g. `root@dd635306c545`) you are inside a
container — type `exit` and re-run on the host. SSH keys and `~/.hermes/.env` paths
differ between host and container; everything below assumes the host.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci airtable" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Airtable is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Sanity check PAT against https://api.airtable.com/v0/meta/bases (no write)
  2. Write AIRTABLE_PAT (length ${#AIRTABLE_PAT}, prefix ${AIRTABLE_PAT:0:3}...) via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add airtable --url https://mcp.airtable.com/mcp --auth header (Authorization: Bearer)
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*airtable"
  7. Smoke test: GET https://api.airtable.com/v0/meta/bases -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

First, a pre-write sanity check against Airtable REST (fast, surfaces scope/base problems
before you touch the gateway):

```bash
PRE=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Authorization: Bearer $AIRTABLE_PAT' \
    https://api.airtable.com/v0/meta/bases
")
case "$PRE" in
  200) echo "OK: PAT is live and at least one base is attached." ;;
  401) echo "FAIL: PAT invalid or revoked."; exit 1 ;;
  403) echo "FAIL: PAT missing schema.bases:read. Re-mint with scope."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $PRE from /v0/meta/bases" ;;
esac
```

Then write the secret:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set AIRTABLE_PAT '$AIRTABLE_PAT'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^AIRTABLE_PAT=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: AIRTABLE_PAT not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern. The PAT
> contains `.` and may contain `/+=` — always use the `|` delimiter, never `/`, and never
> `echo >>` (it can merge onto a prior line without a trailing newline):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^AIRTABLE_PAT=' ~/.hermes/.env || printf 'AIRTABLE_PAT=\n' >> ~/.hermes/.env
>   sed -i 's|^AIRTABLE_PAT=.*|AIRTABLE_PAT=$AIRTABLE_PAT|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Airtable MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — first-party hosted remote MCP with bearer PAT

Airtable's official endpoint `https://mcp.airtable.com/mcp` accepts a bearer PAT, so we
register it as an HTTP MCP with a header auth shape. The token stays in `~/.hermes/.env`
and is referenced via `${AIRTABLE_PAT}` indirection — never inlined in `config.yaml`.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add airtable \
    --url 'https://mcp.airtable.com/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --env 'AIRTABLE_PAT=\${AIRTABLE_PAT}'
"
```

If the build uses the older interactive `hermes mcp add` flow, pipe a placeholder and let
`/hermes-mcp-add` handle injection. The placeholder pattern (token containing `.` and
possibly `/+=` is why the `|` delimiter is mandatory):

```bash
AGENT=$(ssh "$VPS_USER@$VPS_IP" 'docker ps --filter name=hermes --format "{{.Names}}" | head -1')
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    docker exec -i -u hermes '$AGENT' \
      hermes mcp add airtable --url https://mcp.airtable.com/mcp --auth header
  docker exec '$AGENT' sh -c \
    \"sed -i 's|^MCP_AIRTABLE_API_KEY=.*|MCP_AIRTABLE_API_KEY=$AIRTABLE_PAT|' /opt/data/.env && chmod 600 /opt/data/.env\"
"
```

### Path B (fallback) — generic HTTP tool against the Airtable REST API

If the Hermes build is HTTP-MCP-only and cannot reach `mcp.airtable.com`:

- **Base URL:** `https://api.airtable.com/v0/`
- **Auth header:** `Authorization: Bearer ${AIRTABLE_PAT}`
- **Content type:** `Content-Type: application/json`
- **Useful endpoints:**
  - `GET /meta/bases` — list bases the PAT can see
  - `GET /meta/bases/{baseId}/tables` — schema for a base
  - `GET /{baseId}/{tableId}` — list records
  - `POST /{baseId}/{tableId}` — create records
  - `PATCH /{baseId}/{tableId}` — update records

A bare PAT in `.env` does NOT by itself connect Airtable to the agent — it only makes the
credential available; you still need a tool or MCP that consumes it.

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
       | grep -qiE "registered.*tool.*airtable|MCP server.*airtable.*(ok|ready|registered)"; then
    REGISTERED=1
    echo "OK: airtable registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: airtable not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Expect a line like `MCP server 'airtable' (HTTP): registered N tool(s): ...` — the server
exposes tools for listing bases/tables, reading schema, and listing/creating/updating records.

---

## Step 8 — live API smoke test (from the VPS so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: Bearer \$AIRTABLE_PAT\" \
    https://api.airtable.com/v0/meta/bases
")
case "$HTTP" in
  200) echo "OK: Airtable API reachable and PAT valid." ;;
  401) echo "FAIL: PAT invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: PAT valid but missing schema.bases:read scope."; exit 1 ;;
  429) echo "WARN: rate-limited (~5 req/s per base). Retry after backoff." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Airtable API. Check manually." ;;
esac
```

`200` with `{"bases":[]}` means the token works but no base is attached — not a failure
of wiring, just a user step (Pitfall 2).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove airtable 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset AIRTABLE_PAT 2>/dev/null || \
    sed -i '/^AIRTABLE_PAT=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Airtable is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using a legacy `key...` API key | Airtable retired global account keys; only PATs/OAuth work | Mint a PAT at `airtable.com/create/tokens` |
| 2 | PAT works but `/meta/bases` returns `{"bases":[]}` | PAT is inert until the user "adds a base" to it | On the token page, attach the bases or workspaces the agent needs |
| 3 | `GET /meta/bases` returns 403 even though records read fine | Missing `schema.bases:read` scope | Re-mint with `schema.bases:read` (and `data.records:read` minimum) |
| 4 | Granting `schema.bases:write` casually | Lets the agent alter tables/fields, not just data | Grant only if truly needed; most workflows want `data.records:*` only |
| 5 | Token shown once, then lost | Airtable does not let you reveal a PAT after creation | Regenerate; you cannot recover it |
| 6 | sed with `/` delimiter on the PAT | PAT contains `.` and may contain `/+=` | Always use `\|` delimiter |
| 7 | `echo "$PAT" >> .env` | Can merge onto the prior line without trailing newline; SSH-style `authorized_keys` failure mode | Always `hermes config set` (or the documented `sed` fallback) |
| 8 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `~/.hermes/.env` (or `/opt/data/.env` in container), `chmod 600` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | Container vs host confusion | Adding the PAT inside the container when host expects it (or vice versa) | Always check `whoami; hostname` first; `root@<hex>` means container |
| 11 | OAuth vs PAT confusion on the hosted MCP | The hosted MCP supports both; OAuth needs a browser dance | Use the PAT — fully scriptable |
| 12 | Hammering Airtable with agent tool calls | ~5 req/s per base; bursts return `429` | Have the agent back off rather than retry hot |
| 13 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Pre-write `GET /v0/meta/bases` returned `200` (PAT live + scoped)
- [ ] `AIRTABLE_PAT` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] At least one base attached to the PAT (user step verified)
- [ ] MCP registered via Path A (hosted bearer MCP) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'airtable'` within 30s
- [ ] Smoke test: `GET /v0/meta/bases` from the VPS returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
