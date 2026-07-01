---
name: integration-hetzner
description: Connect Hetzner Cloud (servers, volumes, firewalls, load balancers) to a self-hosted Hermes Agent over SSH. Uses a static project-scoped Bearer token against the official REST API, with an optional self-hosted community MCP fallback. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-hetzner — connect Hetzner Cloud to a remote Hermes (SSH-first)

You are the engineer connecting Hetzner Cloud to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the one thing a machine cannot:

1. Mint the API token in the Hetzner Cloud Console (it is shown exactly once).

Everything else — token storage, REST wiring (or optional MCP registration), gateway reload,
verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Hetzner Cloud exposes a clean REST API at
`https://api.hetzner.cloud/v1/` guarded by a static project-scoped Bearer token. There is
**no first-party Hetzner MCP server**. Path A (default) stores the token and points the
agent's generic HTTP tool at the REST API. Path B documents how to self-host the community
`dkruyt/mcp-hetzner` server if the user wants first-class MCP tools — do not pretend a hosted
endpoint exists.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$HETZNER_API_TOKEN` | Static project-scoped Bearer token (opaque alphanumeric, no prefix; e.g. `jEheVytlAoFl7F8MqUQ7jAo2hOXASztX`) | Hetzner Cloud Console → **Security → API tokens → Generate API token** → pick **Read** (safe default) or **Read & Write** (mutations). Shown ONCE. See <https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/> |
| Scope choice | Read vs Read & Write | Decided at mint time — cannot be upgraded later, only re-minted |

One token = one Hetzner *project*. A multi-project user needs one token per project.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci hetzner" || echo 0)
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^HETZNER_API_TOKEN=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY" -gt 0 ] || [ "$HAS_TOKEN" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Hetzner is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Sanity-check token: GET https://api.hetzner.cloud/v1/servers?per_page=1 → expect 200
  2. Write HETZNER_API_TOKEN (length ${#HETZNER_API_TOKEN}, prefix ${HETZNER_API_TOKEN:0:4}...) via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Path A (default): document REST base + auth for the agent's HTTP tool
     Path B (optional): hermes mcp add hetzner against a self-hosted dkruyt/mcp-hetzner URL
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*hetzner" (Path B only)
  7. Smoke test: GET /v1/servers?per_page=1 → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

First sanity-check the token against the live API from the VPS so a bad token aborts before
anything is written:

```bash
PRECHECK=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Authorization: Bearer $HETZNER_API_TOKEN' \
    'https://api.hetzner.cloud/v1/servers?per_page=1'
")
case "$PRECHECK" in
  200) echo "OK: token validates against Hetzner Cloud API." ;;
  401) echo "ABORT: HTTP 401 — token invalid or for wrong project. Re-mint and retry."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $PRECHECK from Hetzner. Check connectivity."; exit 1 ;;
esac
```

Then write it:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set HETZNER_API_TOKEN '$HETZNER_API_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^HETZNER_API_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: HETZNER_API_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; Hetzner tokens are alnum but the pattern is safe for any token):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^HETZNER_API_TOKEN=' ~/.hermes/.env || printf 'HETZNER_API_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^HETZNER_API_TOKEN=.*|HETZNER_API_TOKEN=$HETZNER_API_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — wire it into Hermes (choose the honest path)

**There is no first-party Hetzner MCP server.** Pick one and tell the user which.

### Path A (default) — REST API via the agent's generic HTTP tool

The token is now in `~/.hermes/.env` as `HETZNER_API_TOKEN`. Point the agent's HTTP tool at:

- **Base URL:** `https://api.hetzner.cloud/v1/`
- **Auth header:** `Authorization: Bearer ${HETZNER_API_TOKEN}`
- **Useful read endpoints:** `GET /servers`, `GET /volumes`, `GET /firewalls`,
  `GET /load_balancers`, `GET /datacenters`, `GET /pricing`
- **Mutations (Read & Write token only):** `POST /servers`,
  `POST /servers/{id}/actions/poweroff`, `DELETE /servers/{id}`
- **Full reference:** <https://docs.hetzner.cloud/reference/cloud>

No `hermes mcp add` is needed for Path A. Skip directly to Step 6.

### Path B (optional) — self-host `dkruyt/mcp-hetzner` then register it

If the user wants first-class MCP tools, the maintained community option is
**dkruyt/mcp-hetzner** (MIT, Python): <https://github.com/dkruyt/mcp-hetzner>. It ships as a
local stdio server with an optional SSE/HTTP mode (default `localhost:8080`) and reads the
token from the `HCLOUD_TOKEN` env var (not `HETZNER_API_TOKEN` — see Pitfalls). To use it
remotely you must host it yourself behind a URL Hermes can reach, then:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add hetzner \
    --url 'https://hetzner-mcp.<your-domain>/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject the real token with pipe delimiter (tokens are alnum but the pattern is universal):
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$HETZNER_API_TOKEN\"'|g' ~/.hermes/config.yaml"
```

Do not invent or assume a public URL for this server — there is no official hosted one. If
you have not actually stood up the server, do not claim it is connected; fall back to Path A.

Other community implementations exist (Xodus-CO/hcloud-mcp, MahdadGhasemian/mcp-hetzner-go);
vet maintenance and provenance before trusting any of them with a Read & Write token.

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

## Step 7 — verify registration in logs (Path B only; poll up to 30s)

Path A has nothing to register in the gateway — the env var is just loaded on next gateway
start. Skip this step for Path A. For Path B:

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*hetzner|MCP server.*hetzner.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: hetzner registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: hetzner not in logs after 30s. Rolling back."; rollback; exit 1; }
```

For Path A, instead confirm the env var is loaded into the gateway process:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -100" \
  | grep -qiE "gateway.*(ready|started|listening)" \
  || { echo "FAIL: gateway did not come back up. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: Bearer \$HETZNER_API_TOKEN\" \
    'https://api.hetzner.cloud/v1/servers?per_page=1'
")
case "$HTTP" in
  200) echo "OK: Hetzner Cloud API reachable and token valid." ;;
  401) echo "FAIL: token invalid or wrong project. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token is Read-only and you tried a write op (or scope missing)."; exit 1 ;;
  429) echo "WARN: rate-limited (3600 req/hr per project). Backoff and retry." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Hetzner Cloud API. Check manually." ;;
esac
```

`200` with `{"servers":[]}` (empty array) is a pass — the project simply has no servers yet.
Every layer worked.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove hetzner 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset HETZNER_API_TOKEN 2>/dev/null || \
    sed -i '/^HETZNER_API_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Hetzner is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Assuming a hosted Hetzner MCP exists | There is **no first-party MCP**; a key in `.env` alone connects nothing | Pick Path A (REST) or Path B (self-hosted community MCP) — tell the user which |
| 2 | Token shown to wrong project's resources | Token is **project-scoped**, shown once, cannot be viewed again | Confirm correct project at mint time; re-mint if wrong |
| 3 | "Upgrading" a Read token to Read & Write | Scope is fixed at mint time | Re-mint as Read & Write; revoke the old one |
| 4 | Burst of calls returns `429` | Rate limit is **3600 req/hr per project**, refills ~1/sec, NOT all at once | Backoff on `429`; honour `RateLimit-Remaining` header |
| 5 | Token "works" but hits the wrong API | Hetzner Cloud (`api.hetzner.cloud`) ≠ Hetzner Robot (dedicated) — separate APIs and tokens | Cloud tokens only authenticate against `api.hetzner.cloud` |
| 6 | Path B server starts unauthenticated | dkruyt/mcp-hetzner reads `HCLOUD_TOKEN`; Hermes injects `MCP_HETZNER_API_KEY` | Map the names in the server's own env: `HCLOUD_TOKEN=${MCP_HETZNER_API_KEY}` |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` | Can merge onto a prior line without a trailing newline (silent breakage) | Always `hermes config set`; fallback is the sed pattern with pipe delimiter |
| 9 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 10 | sed with `/` delimiter on tokens | Future tokens may contain `/+=` | Always use `\|` delimiter |
| 11 | Container vs host confusion | SSH lands on host but Hermes runs in a container, or vice versa | Step 1 detects both layers; always check `whoami; hostname` first if confused |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Token sanity-checked against `GET /v1/servers?per_page=1` → HTTP 200
- [ ] `HETZNER_API_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Scope (Read vs Read & Write) confirmed and communicated to the user
- [ ] Chosen path is wired: Path A (REST base + Bearer header handed to the agent's HTTP tool) **or** Path B (`hermes mcp add hetzner` against self-hosted MCP, tools in logs)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path B only: logs show `registered N tool(s) for 'hetzner'` within 30s
- [ ] Smoke test: `GET /v1/servers?per_page=1` returned `200` (empty array is a pass)
- [ ] User told plainly that no first-party MCP exists and which path was used
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
