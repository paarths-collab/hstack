---
name: integration-azure
description: Connect Microsoft Azure (resource groups, storage, Cosmos DB, Key Vault, monitor) to a self-hosted Hermes Agent over SSH. Wires Microsoft's first-party `@azure/mcp` stdio server with an Entra ID service principal. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-azure — connect Azure to a remote Hermes (SSH-first)

You are the engineer connecting Microsoft Azure to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Entra ID service principal in their tenant (`az ad sp create-for-rbac`).
2. Confirm RBAC scope and role (least-privilege Reader on a single resource group is the default).

Everything else — secret storage, stdio MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Azure is NOT the typical hstack remote-HTTP MCP case.

- Microsoft's first-party server is `@azure/mcp` (package `@azure/mcp`, image
  `mcr.microsoft.com/azure-sdk/azure-mcp`, source `github.com/microsoft/mcp`). It runs as a
  **local stdio process** (`npx -y @azure/mcp@latest server start`), NOT a hosted HTTPS endpoint.
  There is **no first-party remote MCP base URL** to bearer-auth against, so the
  remote-HTTP `/hermes-mcp-add` probe-and-bearer flow does **not** apply here.
- Auth is **not a static API key**. The server uses `DefaultAzureCredential`. For a headless
  container the correct path is an **Entra ID service principal** via three env vars:
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, plus the production-hardening
  flag `AZURE_TOKEN_CREDENTIALS=prod` to block interactive browser fallback.

So Path A here is: register `@azure/mcp` as a **stdio MCP** inside the Hermes container with
`${AZURE_*}` indirection; the SP secret lives only in `~/.hermes/.env`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$AZURE_TENANT_ID` | Entra ID tenant GUID | `tenant` field of `az ad sp create-for-rbac` output |
| `$AZURE_CLIENT_ID` | Service principal app ID (GUID) | `appId` field of the same output |
| `$AZURE_CLIENT_SECRET` | SP client secret | `password` field of the same output |
| RBAC scope | Resource group + role | User picks; default Reader on one RG |

Have the user mint the SP on a machine with Azure CLI logged in:

```bash
# Least-privilege: scope to one resource group, role Reader (Contributor only if writes needed).
az ad sp create-for-rbac \
  --name "hermes-agent" \
  --role Reader \
  --scopes /subscriptions/<sub-id>/resourceGroups/<rg-name>
```

Docs: `https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/get-started`
and the auth guide at `https://github.com/microsoft/mcp/blob/main/docs/Authentication.md`.

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci azure" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Azure is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write AZURE_TENANT_ID (length ${#AZURE_TENANT_ID}, prefix ${AZURE_TENANT_ID:0:4}...) via 'hermes config set'
  2. Write AZURE_CLIENT_ID (length ${#AZURE_CLIENT_ID}, prefix ${AZURE_CLIENT_ID:0:4}...) via 'hermes config set'
  3. Write AZURE_CLIENT_SECRET (length ${#AZURE_CLIENT_SECRET}, prefix ${AZURE_CLIENT_SECRET:0:2}...) via 'hermes config set'
  4. Write AZURE_TOKEN_CREDENTIALS=prod (blocks interactive browser fallback)
  5. chmod 600 ~/.hermes/.env
  6. Register stdio MCP: hermes mcp add azure --command npx --args -y,@azure/mcp@latest,server,start
  7. Reload gateway: hermes gateway stop && hermes gateway run (sleep 12 — first npx download)
  8. Verify in logs: grep -i "registered.*azure|DefaultAzureCredential"
  9. Smoke test: subscription list via SP token → expect 200

The client secret is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set AZURE_TENANT_ID '$AZURE_TENANT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AZURE_CLIENT_ID '$AZURE_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AZURE_CLIENT_SECRET '$AZURE_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AZURE_TOKEN_CREDENTIALS 'prod'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each key landed (each line prints `1`, never the value):

```bash
ssh "$VPS_USER@$VPS_IP" "
  for k in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TOKEN_CREDENTIALS; do
    grep -c \"^\${k}=\" ~/.hermes/.env
  done
"
```

If any line is `0`, roll back and abort.

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> with `|` delimiter (Azure secrets routinely contain `/`, `+`, `=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   f=~/.hermes/.env
>   touch \$f
>   for k in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TOKEN_CREDENTIALS; do
>     grep -q \"^\${k}=\" \$f || printf '%s=\n' \"\$k\" >> \$f
>   done
>   sed -i 's|^AZURE_TENANT_ID=.*|AZURE_TENANT_ID=$AZURE_TENANT_ID|'           \$f
>   sed -i 's|^AZURE_CLIENT_ID=.*|AZURE_CLIENT_ID=$AZURE_CLIENT_ID|'             \$f
>   sed -i 's|^AZURE_CLIENT_SECRET=.*|AZURE_CLIENT_SECRET=$AZURE_CLIENT_SECRET|' \$f
>   sed -i 's|^AZURE_TOKEN_CREDENTIALS=.*|AZURE_TOKEN_CREDENTIALS=prod|'         \$f
>   chmod 600 \$f
> "
> ```

---

## Step 5 — register the Azure MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official `@azure/mcp` stdio server with SP env indirection

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add azure \
    --command npx \
    --args '-y,@azure/mcp@latest,server,start' \
    --env 'AZURE_TENANT_ID=\${AZURE_TENANT_ID}' \
    --env 'AZURE_CLIENT_ID=\${AZURE_CLIENT_ID}' \
    --env 'AZURE_CLIENT_SECRET=\${AZURE_CLIENT_SECRET}' \
    --env 'AZURE_TOKEN_CREDENTIALS=\${AZURE_TOKEN_CREDENTIALS}'
"
```

This writes a stdio entry to `config.yaml` referencing only `${AZURE_*}` placeholders — the
real values stay in `~/.hermes/.env`. The flag names vary by Hermes version; run
`hermes mcp add --help` and match its stdio syntax if unsure. If the build did not template
the `env:` block, edit `config.yaml` so the `azure:` entry looks like:

```yaml
azure:
  command: npx
  args: ["-y", "@azure/mcp@latest", "server", "start"]
  env:
    AZURE_TENANT_ID: ${AZURE_TENANT_ID}
    AZURE_CLIENT_ID: ${AZURE_CLIENT_ID}
    AZURE_CLIENT_SECRET: ${AZURE_CLIENT_SECRET}
    AZURE_TOKEN_CREDENTIALS: ${AZURE_TOKEN_CREDENTIALS}
  enabled: true
```

To avoid first-boot latency on every restart, pin a version after confirming it on npm:
replace `@azure/mcp@latest` with `@azure/mcp@<pinned-version>`.

### Path B (fallback) — Azure Resource Manager REST API with SP-issued bearer

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command, use ARM directly.
There is **no first-party hosted Azure MCP URL** — do not invent one. Mint a token from the
service principal at runtime and call ARM:

- **Token endpoint:** `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`
  with `grant_type=client_credentials`, `scope=https://management.azure.com/.default`,
  `client_id=${AZURE_CLIENT_ID}`, `client_secret=${AZURE_CLIENT_SECRET}`.
- **ARM base URL:** `https://management.azure.com`
- **Auth header:** `Authorization: Bearer <token-from-above>`
- **API version:** append `?api-version=2022-12-01` (or current) to every ARM request.

Do NOT try to `hermes mcp add` an Azure URL with a static bearer header — there is no hosted
MCP endpoint and the bearer would expire within an hour anyway.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run. First boot also
downloads `@azure/mcp` via `npx`, so allow extra time before polling.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 12
```

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*azure|MCP server.*azure.*(ok|ready)|Azure\.Identity"; then
    REGISTERED=1
    echo "OK: azure registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: azure not in logs after 30s. Rolling back."; rollback; exit 1; }
```

A `DefaultAzureCredential failed to retrieve a token` line means the SP env vars did not land
in the stdio child process — re-check Step 4 and the `${...}` indirection in `config.yaml`.

---

## Step 8 — live API smoke test (inside the container so the secret stays on the VPS)

Mint a token from the SP and hit ARM `subscriptions`. A `200` proves auth, transport, and
RBAC end-to-end; an empty `value` array still counts as success (the SP just has no
in-scope subscriptions yet — not a wiring failure).

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -e
  . ~/.hermes/.env
  TOKEN=$(curl -sS -X POST \
    "https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" \
    -d "client_id=${AZURE_CLIENT_ID}" \
    -d "client_secret=${AZURE_CLIENT_SECRET}" \
    -d "scope=https://management.azure.com/.default" \
    | sed -n "s/.*\"access_token\":\"\([^\"]*\)\".*/\1/p")
  [ -n "$TOKEN" ] || { echo 000; exit 0; }
  curl -sS -o /dev/null -w "%{http_code}" \
    "https://management.azure.com/subscriptions?api-version=2022-12-01" \
    -H "Authorization: Bearer ${TOKEN}"
')
case "$HTTP" in
  200) echo "OK: Azure ARM reachable and SP token valid." ;;
  401) echo "FAIL: SP secret invalid or expired. Re-mint and re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: SP authenticated but RBAC denies subscriptions. Confirm role+scope."; exit 1 ;;
  000) echo "FAIL: token mint failed (tenant/client/secret mismatch). Re-check Step 4."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from ARM. Check manually." ;;
esac
```

An end-to-end check from the chat interface, once registered:
```
@<agent> using azure, list my resource groups
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove azure 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    for k in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TOKEN_CREDENTIALS; do
      hermes config unset \$k 2>/dev/null || sed -i \"/^\${k}=/d\" ~/.hermes/.env
    done
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Azure is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Expecting a static `AZURE_API_KEY` | Azure has no per-tenant API key; credential is an Entra ID app | Always SP: `tenant`/`appId`/`secret` triple |
| 2 | Wiring a remote `https://...azure...` MCP URL with a bearer | No first-party hosted Azure MCP exists | Use stdio Path A, or ARM REST Path B with runtime-minted token |
| 3 | Interactive browser hang in headless container | Without `AZURE_TOKEN_CREDENTIALS=prod`, `DefaultAzureCredential` falls back to `InteractiveBrowserCredential` | Always set `AZURE_TOKEN_CREDENTIALS=prod` |
| 4 | Over-broad RBAC scope | Agent inherits all SP permissions; Contributor on subscription can delete resources | Start `Reader` on one resource group; widen only on request |
| 5 | SP secret expiry | `az ad sp create-for-rbac` defaults to ~1 year; tools start returning 401 | Re-mint and re-run Step 4 when 401 appears |
| 6 | First-run latency | `npx @azure/mcp@latest` downloads on first boot; short sleep races registration | Step 6 sleeps 12s; pin version to skip download on subsequent boots |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 8 | `echo >> .env` instead of `config set` / sed | Can glue onto a prior line without trailing newline; SSH silently corrupts | Always `hermes config set` (or sed with `|` delimiter) |
| 9 | Secret in `config.yaml` instead of `.env` | World-readable; SP-secret leak; not reloaded by runtime | Only `~/.hermes/.env`, `chmod 600`, `${AZURE_*}` indirection in YAML |
| 10 | sed with `/` delimiter on SP secrets | Secrets contain `/`, `+`, `=` — `/` delimiter breaks the substitution | Always use `\|` delimiter |
| 11 | Container vs host confusion | Adding key inside container is invisible to host sshd | Check `whoami; hostname` first; exit container if needed |
| 12 | Skipping the verify step | "Silent success" — config written, child process never started | Always poll `hermes logs` and run the ARM smoke test |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TOKEN_CREDENTIALS=prod` all in `~/.hermes/.env`, `chmod 600`
- [ ] Secrets NOT in `config.yaml` and NOT echoed in chat (only `${AZURE_*}` indirection in YAML)
- [ ] SP scoped least-privilege (Reader unless writes explicitly requested)
- [ ] MCP registered via Path A (stdio `@azure/mcp`) or ARM REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart); 12s sleep to allow npx download
- [ ] Logs show `registered N tool(s) for 'azure'` within 30s, no `DefaultAzureCredential failed`
- [ ] Smoke test: SP-token mint + `GET /subscriptions` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, env-reload, and MCP registration failure modes.
