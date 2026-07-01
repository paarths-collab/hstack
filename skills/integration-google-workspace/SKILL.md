---
name: integration-google-workspace
description: Connect Google Workspace (Gmail, Drive, Calendar, Docs, Sheets, Meet) to a self-hosted Hermes agent over SSH. Google is OAuth-only with no static API key, so this skill runs the self-hosted community MCP server with a service-account key for headless auth. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-google-workspace — connect Google Workspace to a remote Hermes (SSH-first)

You are the engineer connecting Google Workspace to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. Every command below runs on the VPS, not the local machine.

The user only does the three things a machine cannot:

1. Create the Google Cloud project, enable APIs, and mint the service-account JSON key.
2. As a Workspace admin, authorize the service account's client ID for the needed OAuth scopes
   via domain-wide delegation (DWD).
3. Hand off the JSON key file.

Everything else — placing the credential, running the community MCP server, registering it with
Hermes, gateway reload, verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Google Workspace has **no static API key** for
Gmail, Drive, Calendar, Docs, or Sheets. Two real paths exist:

1. **Official Google remote MCP servers** (per-product, e.g. `https://gmailmcp.googleapis.com/mcp/v1`,
   `https://drivemcp.googleapis.com/mcp/v1`, `https://calendarmcp.googleapis.com/mcp/v1`,
   `https://chatmcp.googleapis.com/mcp/v1`) — **OAuth 2.0 with an interactive browser redirect**.
   No human is at a server, so this is **not headless**. Docs/Sheets also not covered.
   Source: <https://developers.google.com/workspace/guides/configure-mcp-servers>
2. **Self-hosted community MCP server** — `taylorwilsdon/google_workspace_mcp` (12 services
   incl. Gmail/Drive/Calendar/Docs/Sheets/Slides/Tasks/Chat, 100+ tools, streamable-HTTP). Supports
   **service account + domain-wide delegation** — the only **non-interactive** auth path.
   Source: <https://github.com/taylorwilsdon/google_workspace_mcp> and <https://workspacemcp.com/docs>

This skill uses path 2. Meet data is reached via Calendar events (conference links) and the
Meet REST surface the server exposes.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SA_SRC` | Local path to the service-account JSON key | Google Cloud Console -> IAM -> Service Accounts -> Keys -> Add key -> JSON |
| `$IMPERSONATE` | The Workspace user the agent acts as (e.g. `agent@<domain>`) | The customer's Workspace admin chooses this identity |
| APIs enabled | Gmail, Drive, Calendar, Docs, Sheets (and Slides/Tasks/Chat/People if wanted) | Cloud Console -> APIs & Services -> Enable APIs |
| DWD granted | Admin authorized the SA client ID for the needed scopes | <https://admin.google.com> -> Security -> API controls -> Domain-wide delegation |

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

If Hermes lives in a container, capture the container name for later steps:

```bash
AGENT=$(ssh "$VPS_USER@$VPS_IP" "docker ps --filter name=hermes --format '{{.Names}}' | head -1")
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci google-workspace" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Google Workspace is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Copy service-account JSON (length: $(wc -c < "$SA_SRC") bytes) to /opt/data/gws-sa.json, chmod 600
  2. hermes config set GOOGLE_APPLICATION_CREDENTIALS=/opt/data/gws-sa.json
  3. hermes config set USER_GOOGLE_EMAIL=$IMPERSONATE
  4. chmod 600 ~/.hermes/.env (and /opt/data/.env if container layout)
  5. Run gws-mcp container (taylorwilsdon/google_workspace_mcp) on agent network, single-user
  6. Register MCP: hermes mcp add google-workspace --url http://localhost:8000/mcp (no auth header)
  7. Reload gateway: hermes gateway stop && hermes gateway run
  8. Verify in logs: grep -i "registered.*google-workspace"
  9. Smoke test: MCP initialize handshake -> expect HTTP 200

The service-account JSON is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

The credential is the JSON key file itself. Copy it onto the VPS / into the container's data
dir, then lock it down. Do NOT paste its contents into `config.yaml` and do NOT echo it.

```bash
# Copy the JSON onto the VPS, then into the container's /opt/data (sibling of /opt/data/.env)
scp "$SA_SRC" "$VPS_USER@$VPS_IP:/tmp/gws-sa.json"
ssh "$VPS_USER@$VPS_IP" "
  set -e
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  if [ -n \"\$AGENT\" ]; then
    docker cp /tmp/gws-sa.json \"\$AGENT:/opt/data/gws-sa.json\"
    docker exec \"\$AGENT\" sh -c 'chmod 600 /opt/data/gws-sa.json && chown hermes /opt/data/gws-sa.json || true'
  else
    install -m 600 /tmp/gws-sa.json /opt/data/gws-sa.json
  fi
  rm -f /tmp/gws-sa.json
"
```

Record the config (path + impersonation email) via `hermes config set` — never `echo >>`:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_APPLICATION_CREDENTIALS '/opt/data/gws-sa.json'"
ssh "$VPS_USER@$VPS_IP" "hermes config set USER_GOOGLE_EMAIL '$IMPERSONATE'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env 2>/dev/null || true"
```

Verify the credential file is a service-account key and the config keys landed (no value
ever printed):

```bash
ssh "$VPS_USER@$VPS_IP" "
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  if [ -n \"\$AGENT\" ]; then
    docker exec \"\$AGENT\" sh -c 'grep -o \"\\\"type\\\": *\\\"service_account\\\"\" /opt/data/gws-sa.json'
  else
    grep -o '\"type\": *\"service_account\"' /opt/data/gws-sa.json
  fi
" | grep -q "service_account" \
  || { echo "FAIL: /opt/data/gws-sa.json is not a service-account key. Rolling back."; rollback; exit 1; }

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GOOGLE_APPLICATION_CREDENTIALS=' ~/.hermes/.env 2>/dev/null || echo 0")
[ "$WROTE" = "1" ] || { echo "FAIL: GOOGLE_APPLICATION_CREDENTIALS not written. Rolling back."; rollback; exit 1; }
```

> Sed-fallback if your Hermes build has no `config set`. Pipe delimiter required — paths
> contain `/`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^GOOGLE_APPLICATION_CREDENTIALS=' ~/.hermes/.env || printf 'GOOGLE_APPLICATION_CREDENTIALS=\n' >> ~/.hermes/.env
>   sed -i 's|^GOOGLE_APPLICATION_CREDENTIALS=.*|GOOGLE_APPLICATION_CREDENTIALS=/opt/data/gws-sa.json|' ~/.hermes/.env
>   grep -q '^USER_GOOGLE_EMAIL=' ~/.hermes/.env || printf 'USER_GOOGLE_EMAIL=\n' >> ~/.hermes/.env
>   sed -i 's|^USER_GOOGLE_EMAIL=.*|USER_GOOGLE_EMAIL=$IMPERSONATE|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server

### Path A (preferred) — self-hosted community MCP server with service account

Run `taylorwilsdon/google_workspace_mcp` in HTTP mode on the agent's Docker network so Hermes
reaches it at `http://localhost:8000/mcp`. `--single-user` means one impersonated identity,
no per-request OAuth — perfect for a headless agent.

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  [ -n \"\$AGENT\" ] || { echo 'FAIL: no hermes container'; exit 1; }
  docker rm -f gws-mcp 2>/dev/null || true
  docker run -d --name gws-mcp \
    --network container:\"\$AGENT\" \
    -v /opt/data/gws-sa.json:/app/gws-sa.json:ro \
    -e GOOGLE_APPLICATION_CREDENTIALS=/app/gws-sa.json \
    -e USER_GOOGLE_EMAIL='$IMPERSONATE' \
    -e WORKSPACE_MCP_PORT=8000 \
    ghcr.io/taylorwilsdon/google_workspace_mcp:latest \
    --transport streamable-http --single-user
  sleep 5
"
```

Pin a tag instead of `latest` once the user confirms a known-good version. Then register the
no-auth HTTP MCP with Hermes — the JSON key authenticates server-side, so Hermes sends no
bearer token:

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'n\n' | hermes mcp add google-workspace --url 'http://localhost:8000/mcp'
"
```

### Path B (fallback) — official OAuth remote MCP (NOT headless)

Only if the user insists on first-party and accepts an interactive browser OAuth flow once
per product. Endpoints:

- Gmail:    `https://gmailmcp.googleapis.com/mcp/v1`
- Drive:    `https://drivemcp.googleapis.com/mcp/v1`
- Calendar: `https://calendarmcp.googleapis.com/mcp/v1`
- Chat:     `https://chatmcp.googleapis.com/mcp/v1`

Auth: OAuth 2.0 authorization-code flow with a per-client callback URI. Docs/Sheets are not
covered. Do NOT attempt to wire these with a bearer token — they reject it. Source:
<https://developers.google.com/workspace/guides/configure-mcp-servers>

> If you later switch the community server to its **OAuth 2.1 multi-user** mode, that path
> uses per-user bearer tokens — only then inject `MCP_GOOGLE_WORKSPACE_API_KEY` into
> `~/.hermes/.env` via the standard `/hermes-mcp-add` sed pattern. With a service account
> there is no token to inject.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*google-workspace|MCP server.*google-workspace.*(ok|ready|registered)"; then
    REGISTERED=1
    echo "OK: google-workspace registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: google-workspace not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success looks like: `MCP server 'google-workspace' (HTTP): registered N tool(s): ...`.

---

## Step 8 — live API smoke test (MCP initialize handshake, server-side)

The credential never leaves the VPS — auth is the service-account JSON, handled by the MCP
server. We verify the handshake responds 200 from inside the agent's network namespace:

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  docker exec \"\$AGENT\" sh -c 'curl -sS -o /dev/null -w \"%{http_code}\" \
    -X POST -H \"Accept: application/json, text/event-stream\" -H \"Content-Type: application/json\" \
    -d \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"method\\\":\\\"initialize\\\",\\\"params\\\":{\\\"protocolVersion\\\":\\\"2025-03-26\\\",\\\"capabilities\\\":{},\\\"clientInfo\\\":{\\\"name\\\":\\\"probe\\\",\\\"version\\\":\\\"0\\\"}}}\" \
    http://localhost:8000/mcp'
")
case "$HTTP" in
  200) echo "OK: MCP handshake succeeded. Service account is reaching Google." ;;
  401) echo "FAIL: server says unauthorized — DWD likely missing or scopes too narrow. See Pitfalls 3/4."; rollback; exit 1 ;;
  403) echo "FAIL: forbidden — admin has not authorized the SA client ID. See Pitfall 3."; rollback; exit 1 ;;
  000) echo "FAIL: gws-mcp container not reachable. Check 'docker logs gws-mcp'."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from MCP server. Check 'docker logs gws-mcp' manually." ;;
esac
```

For end-to-end confidence, ask the user to trigger a real read from chat:

```
@<agent> using google-workspace, list my 3 most recent Gmail messages
```

A real list (or a valid empty result) is a pass. `unauthorized_client` -> DWD missing
(Pitfall 3). `insufficient permission` -> scopes too narrow (Pitfall 4).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove google-workspace 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "docker rm -f gws-mcp 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset GOOGLE_APPLICATION_CREDENTIALS 2>/dev/null || \
    sed -i '/^GOOGLE_APPLICATION_CREDENTIALS=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset USER_GOOGLE_EMAIL 2>/dev/null || \
    sed -i '/^USER_GOOGLE_EMAIL=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "
    AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
    if [ -n \"\$AGENT\" ]; then
      docker exec \"\$AGENT\" sh -c 'rm -f /opt/data/gws-sa.json'
    else
      rm -f /opt/data/gws-sa.json
    fi
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Google Workspace is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Expecting a static API key | Google Workspace has **no** API-key auth for Gmail/Drive/Calendar/Docs/Sheets | Use service account (Path A) or OAuth (Path B); tell the user up front |
| 2 | Picking the official remote endpoints for a server agent | They require an **interactive browser OAuth redirect**; no human is at the server. Docs/Sheets also not covered | Use the self-hosted server + service account for headless |
| 3 | Skipping domain-wide delegation | Service account exists but admin never authorized its client ID -> every call returns `unauthorized_client` | Confirm the admin granted DWD for the exact scopes before testing |
| 4 | Scope too narrow | Some Calendar scopes are read-only (`...events.readonly`); the agent then cannot create events | Request read/write scopes the use case needs when granting DWD |
| 5 | Service-account JSON world-readable | It is a full credential; leaking it grants impersonation | `chmod 600 /opt/data/gws-sa.json`; never in `config.yaml`, never in chat |
| 6 | Wiring `mcp.notion.com`-style hosted endpoints with a bearer token | Google's hosted MCPs are OAuth-only and reject bearer tokens | Use the self-hosted server (Path A) |
| 7 | Per-user quotas / rate limits | Gmail and Drive enforce per-user API quotas; bulk reads 429 | Keep tool calls scoped; back off on 429; raise quota in Cloud Console |
| 8 | OAuth refresh-token expiry (OAuth mode) | Unused refresh tokens expire (~6 months); unverified apps in testing ~7 days | Prefer the service account (no refresh tokens) for long-running agents |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline and silently corrupt config | Always `hermes config set` |
| 11 | Secret in `config.yaml` | World-readable; not loaded by runtime | Only `~/.hermes/.env` + the JSON at `/opt/data/gws-sa.json`, both `chmod 600` |
| 12 | sed with `/` delimiter on paths/tokens | Paths contain `/`, tokens contain `/+=` | Always use `\|` delimiter |
| 13 | Container vs host confusion | Skill assumed wrong layer; key written to a container that gets recreated | Always `whoami; hostname` first; persist credential via `/opt/data` volume |
| 14 | Skipping the verify step | "Silent success" — config written, never picked up | Always wait + grep logs (Step 7) |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `/opt/data/gws-sa.json` is a `service_account` key, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `GOOGLE_APPLICATION_CREDENTIALS` and `USER_GOOGLE_EMAIL` in `~/.hermes/.env`, `chmod 600`
- [ ] Domain-wide delegation granted by the Workspace admin for the needed scopes
- [ ] `gws-mcp` container running on the agent's Docker network, port 8000
- [ ] MCP registered via Path A (community server, no auth header) — or Path B documented if user chose OAuth
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s)` for `google-workspace` within 30s
- [ ] Smoke test: MCP `initialize` handshake returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway reload,
`unauthorized_client`, and MCP registration failure modes.
