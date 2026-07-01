---
name: integration-digitalocean
description: Connect DigitalOcean (Droplets, App Platform, Databases, Kubernetes, Spaces, and more) to a self-hosted Hermes Agent over SSH via DigitalOcean's first-party remote MCP servers. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-digitalocean — connect DigitalOcean to a remote Hermes (SSH-first)

You are the engineer connecting DigitalOcean to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Personal Access Token (PAT) in the DigitalOcean control panel.
2. Pick which DigitalOcean service(s) to wire (each is a separate MCP endpoint).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** DigitalOcean ships first-party **remote MCP
servers** — one HTTPS endpoint per service (Droplets, Apps, Databases, etc.) — all of which
accept a static PAT as a plain `Authorization: Bearer` header. No OAuth dance, no refresh
flow. The docs call PATs "ordinary OAuth access tokens," but operationally they are a static
secret you mint once and store. Each service is its own MCP server; wire one at a time and
each gets its own Hermes name and env var. The **Documentation** server
(`https://docs.mcp.digitalocean.com/mcp`) needs **no** token.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$DO_TOKEN` | DigitalOcean PAT (prefixed `dop_v1_`) | <https://cloud.digitalocean.com/account/api/tokens> → Generate New Token → Full Access or scoped |
| `$DO_SERVICE` | Which service to wire (e.g. `droplets`, `apps`, `databases`) | See table below |

DigitalOcean MCP endpoints (pick one per wiring run; share the same PAT across all):

| Service | MCP URL | Hermes name |
|---------|---------|-------------|
| Droplets | `https://droplets.mcp.digitalocean.com/mcp` | `do-droplets` |
| App Platform | `https://apps.mcp.digitalocean.com/mcp` | `do-apps` |
| Databases | `https://databases.mcp.digitalocean.com/mcp` | `do-databases` |
| Kubernetes (DOKS) | `https://doks.mcp.digitalocean.com/mcp` | `do-doks` |
| Spaces | `https://spaces.mcp.digitalocean.com/mcp` | `do-spaces` |
| Networking | `https://networking.mcp.digitalocean.com/mcp` | `do-networking` |
| Container Registry | `https://docr.mcp.digitalocean.com/mcp` | `do-docr` |
| Volumes (Block Storage) | `https://volumes.mcp.digitalocean.com/mcp` | `do-volumes` |
| Accounts | `https://accounts.mcp.digitalocean.com/mcp` | `do-accounts` |
| Insights | `https://insights.mcp.digitalocean.com/mcp` | `do-insights` |

Full list of 19+ endpoints: <https://docs.digitalocean.com/reference/mcp/>.

Set shell vars from answers:

```bash
DO_SERVICE=droplets                                         # or apps, databases, doks, ...
DO_NAME="do-$DO_SERVICE"                                    # Hermes MCP name
DO_URL="https://${DO_SERVICE}.mcp.digitalocean.com/mcp"     # service endpoint
DO_ENV_VAR="DO_$(echo "$DO_SERVICE" | tr '[:lower:]' '[:upper:]')_TOKEN"
```

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci '$DO_NAME'" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "$DO_NAME is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

To wire multiple services, run this skill once per service — each gets its own
idempotency check, name, and env var.

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write $DO_ENV_VAR (length ${#DO_TOKEN}, prefix ${DO_TOKEN:0:7}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add $DO_NAME --url $DO_URL --auth header
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -iE "registered.*$DO_NAME"
  6. Smoke test: GET https://api.digitalocean.com/v2/account → expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set $DO_ENV_VAR '$DO_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$DO_ENV_VAR=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: $DO_ENV_VAR not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; `dop_v1_` tokens contain alnum/underscore but the pattern is safe for any token):
>
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^$DO_ENV_VAR=' ~/.hermes/.env || printf '%s=\n' '$DO_ENV_VAR' >> ~/.hermes/.env
>   sed -i 's|^$DO_ENV_VAR=.*|$DO_ENV_VAR=$DO_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

The token lives **only** in `~/.hermes/.env`. `config.yaml` holds only the
`${DO_<SERVICE>_TOKEN}` placeholder. Never put the token in `config.yaml` and never paste
it into chat.

---

## Step 5 — register the DigitalOcean MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred — DigitalOcean's
remote MCP works out of the box with bearer auth.

### Path A (preferred) — first-party remote MCP server with bearer header

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add $DO_NAME \
    --url '$DO_URL' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject the real token with pipe delimiter (PATs are alnum/underscore but be safe).
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$DO_TOKEN\"'|g' ~/.hermes/config.yaml"
```

Optional pre-flight: confirm the endpoint+token before registering. DigitalOcean only
supports the bearer-header form, so the full 5-variant probe matrix from
`/hermes-mcp-add` is overkill here — one initialize call is enough:

```bash
ssh "$VPS_USER@$VPS_IP" "
  H='Accept: application/json, text/event-stream'
  C='Content-Type: application/json'
  INIT='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'
  curl -sS -o /dev/null -w 'bearer = %{http_code}\n' \
    -X POST -H \"\$H\" -H \"\$C\" -H \"Authorization: Bearer \$$DO_ENV_VAR\" \
    -d \"\$INIT\" '$DO_URL'
"
```

`200` confirms endpoint + token; `401`/`403` means the token is wrong or lacks the scope
for this service.

### Path B (fallback) — generic HTTP tool against the DigitalOcean REST API

If the Hermes build is stdio-MCP-only and cannot reach remote MCP endpoints:

- **Base URL:** `https://api.digitalocean.com/v2`
- **Auth header:** `Authorization: Bearer ${DO_<SERVICE>_TOKEN}`
- **Content type:** `Content-Type: application/json`
- **Per-service paths:** `/droplets`, `/apps`, `/databases`, `/kubernetes/clusters`,
  `/spaces`, `/registry`, `/volumes`, `/account`, etc.

API reference: <https://docs.digitalocean.com/reference/api/>.

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
       | grep -qiE "registered.*tool.*$DO_NAME|MCP server.*$DO_NAME.*(ok|ready|registered)"; then
    REGISTERED=1
    echo "OK: $DO_NAME registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: $DO_NAME not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Expect a line like `MCP server 'do-droplets' (HTTP): registered N tool(s): ...`.

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://api.digitalocean.com/v2/account' \
    -H \"Authorization: Bearer \$$DO_ENV_VAR\" \
    -H 'Content-Type: application/json'
")
case "$HTTP" in
  200) echo "OK: DigitalOcean API reachable and token valid." ;;
  401) echo "FAIL: token invalid or expired. Re-check Step 4 or mint a new PAT."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing scope for $DO_SERVICE. Re-mint with Full Access or correct custom scope."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from DigitalOcean API. Check manually." ;;
esac
```

A `200` returning a JSON `account` object proves the token authenticates. End-to-end proof
from the chat interface (an empty-but-valid result is a pass):

```
@<agent> using do-droplets, list my droplets
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove $DO_NAME 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset $DO_ENV_VAR 2>/dev/null || \
    sed -i '/^'\"$DO_ENV_VAR\"'=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. $DO_NAME is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating PATs as OAuth tokens | Docs call them "ordinary OAuth access tokens" but they DON'T refresh | Treat as a static secret; if it expires, mint a new one |
| 2 | Scope missing returns 403, not 401 | A custom-scoped PAT can `initialize` but 403 on a real tool call | Re-mint with Full Access or add the missing scope (e.g. `droplet:read`) |
| 3 | Wiring one service and expecting all | There is no single "DigitalOcean MCP" endpoint | One MCP server per service; run this skill per service |
| 4 | Token expiry | PATs can be created with an expiration; silent 401 on previously-working calls | Check expiry in the control panel; mint a new one |
| 5 | Confusing Spaces PAT with Spaces S3 keys | Spaces MCP uses the PAT; raw bucket access (S3 API) uses separate keys | Don't conflate; mint Spaces keys separately if needed |
| 6 | Token shown only once | Lost token can't be re-displayed | User must generate a new one |
| 7 | Wiring the wrong service URL | Droplet tools aren't on the Databases server | Match `$DO_SERVICE` to the table; missing tool = wrong endpoint |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 10 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 11 | sed with `/` delimiter on tokens | Generic tokens can contain `/+=`; sed breaks | Always use `\|` delimiter |
| 12 | Container vs host confusion | Running `hermes` inside a container vs on the host gives different config paths | Step 1 detects both layers |
| 13 | Hermes not running when SSH connects | First call hangs forever | Step 1 hard-gates on version check |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed for `$DO_NAME` (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `$DO_ENV_VAR` written to `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (remote HTTP MCP) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s)` for `$DO_NAME` within 30s
- [ ] Smoke test: `GET /v2/account` returned `200` with a JSON `account` object
- [ ] Token never appeared in chat or `config.yaml`; rotate if exposed
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)
- [ ] If wiring multiple services, repeat steps 2–8 per service (same PAT, different `$DO_SERVICE`)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
