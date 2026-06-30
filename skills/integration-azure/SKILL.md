---
name: integration-azure
description: Connect a Hermes agent to Microsoft Azure via the first-party Azure MCP Server (@azure/mcp), authenticated with an Entra ID service principal. Use when the user wants their Hermes agent to manage or query Azure resources (storage, Cosmos DB, Key Vault, monitor, resource groups) in natural language.
---

# /integration-azure — connect Azure to a Hermes agent

You are the engineer connecting Microsoft Azure to a running Hermes agent. Azure is enterprise
cloud infra, so treat its credentials accordingly: least-privilege RBAC, secret in
`/opt/data/.env` only, `chmod 600`. Do everything autonomously; stop only for things a machine
cannot do (creating the service principal in the customer's tenant, granting RBAC roles).

**Read this before you start — Azure is NOT the typical hstack remote-HTTP MCP case:**

- The official server is **Microsoft's first-party Azure MCP Server**, package `@azure/mcp`
  (also `mcr.microsoft.com/azure-sdk/azure-mcp` Docker image), source
  `https://github.com/microsoft/mcp` (`servers/Azure.Mcp.Server`). Verified 2026-06.
- It runs as a **local stdio process** (`npx -y @azure/mcp@latest server start`), NOT a hosted
  HTTPS endpoint. There is **no first-party remote MCP base URL** to bearer-auth against, so the
  remote-HTTP `/hermes-mcp-add` probe-and-bearer flow does **not** apply here. (You *can*
  self-host it behind Azure Container Apps + Entra, but that is the customer's infra, not a
  one-click target.)
- Auth is **not a static API key**. The server uses `DefaultAzureCredential`. For a headless
  container the correct path is an **Entra ID service principal** via three env vars:
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. There is no API-key shortcut —
  do not pretend one exists.

So the happy path here is: register `@azure/mcp` as a **stdio MCP** inside the Hermes container,
put the service-principal secret in `/opt/data/.env`, and reload the gateway.

## Before you start — gather (ask once)

1. **A service principal** scoped to the resources the agent should touch. The user mints it in
   their tenant (you cannot — it requires their Entra admin). Have them run, on a machine with
   Azure CLI logged in:
   ```bash
   # Least-privilege: scope to one resource group, role Reader (or Contributor if writes needed)
   az ad sp create-for-rbac \
     --name "hermes-agent" \
     --role Reader \
     --scopes /subscriptions/<sub-id>/resourceGroups/<rg-name>
   ```
   The JSON output gives `appId` (→ `AZURE_CLIENT_ID`), `password` (→ `AZURE_CLIENT_SECRET`),
   `tenant` (→ `AZURE_TENANT_ID`). Docs:
   `https://learn.microsoft.com/en-us/azure/developer/azure-mcp-server/get-started` and the auth
   guide at `https://github.com/microsoft/mcp/blob/main/docs/Authentication.md`.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (never log the secret):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
AZ_TENANT=<tenant-id>           # GUID
AZ_CLIENT=<app-id>              # GUID
AZ_SECRET=<client-secret>       # treat as a password; injected via sed in step 2
```

---

## Step 1 — register the Azure MCP Server as a stdio MCP in Hermes

The server is launched as a child process over stdio. Register it with the `npx` launcher so
Hermes starts it on gateway boot. Use a **placeholder** for the secret in the CLI prompt (same
reason as `/hermes-mcp-add` step 3: special chars mangle in non-TTY `docker exec` pipes); the
real value is injected via `sed` in step 2.

```bash
# Answers piped: confirm-add(y) → command → args. Env vars are wired in config below.
printf 'y\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add azure \
      --command "npx" \
      --args "-y,@azure/mcp@latest,server,start"
```

This writes a stdio entry to the agent's `config.yaml`. Make it reference the three Azure env
vars plus the production-hardening flag (prevents `DefaultAzureCredential` from falling back to
an interactive browser prompt, which would hang a headless container):

```yaml
azure:
  command: npx
  args: ["-y", "@azure/mcp@latest", "server", "start"]
  env:
    AZURE_TENANT_ID: ${AZURE_TENANT_ID}
    AZURE_CLIENT_ID: ${AZURE_CLIENT_ID}
    AZURE_CLIENT_SECRET: ${AZURE_CLIENT_SECRET}
    AZURE_TOKEN_CREDENTIALS: prod
  enabled: true
```

If `hermes mcp add` did not template the `env:` block, edit `config.yaml` to match the above
(only the `${...}` placeholders go here — never the literal secret).

---

## Step 2 — write the service-principal secret to `/opt/data/.env`

Append the three vars (and the hardening flag) to the Hermes runtime env file, then lock it.
Use `printf` to add new keys; use `sed` with the `|` delimiter to set values that may contain
`/`, `+`, `=` (Azure secrets routinely do). Never `echo >>` — it can glue onto a prior line.

```bash
docker exec "$AGENT" sh -c '
  set -e
  f=/opt/data/.env
  touch "$f"
  for k in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TOKEN_CREDENTIALS; do
    grep -q "^${k}=" "$f" || printf "%s=\n" "$k" >> "$f"
  done
  chmod 600 "$f"
'

# Inject real values (| delimiter so secrets with / + = survive)
docker exec "$AGENT" sh -c "sed -i 's|^AZURE_TENANT_ID=.*|AZURE_TENANT_ID=${AZ_TENANT}|'   /opt/data/.env"
docker exec "$AGENT" sh -c "sed -i 's|^AZURE_CLIENT_ID=.*|AZURE_CLIENT_ID=${AZ_CLIENT}|'    /opt/data/.env"
docker exec "$AGENT" sh -c "sed -i 's|^AZURE_CLIENT_SECRET=.*|AZURE_CLIENT_SECRET=${AZ_SECRET}|' /opt/data/.env"
docker exec "$AGENT" sh -c "sed -i 's|^AZURE_TOKEN_CREDENTIALS=.*|AZURE_TOKEN_CREDENTIALS=prod|'  /opt/data/.env && chmod 600 /opt/data/.env"
```

Verify the keys landed (prints counts only, never the values):
```bash
docker exec "$AGENT" sh -c 'for k in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET; do grep -c "^${k}=" /opt/data/.env; done'
# Each line should print 1
```

---

## Step 3 — reload the gateway

The gateway reads `.env` once at startup. As with `/hermes-mcp-add`, use **stop + run** (not
`restart`) so the new env is re-read cleanly:

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 12   # first npx run downloads @azure/mcp; allow extra time
```

The first launch downloads `@azure/mcp`, so the initial registration is slower than an HTTP MCP.
If startup is sluggish on every boot, pin and pre-install a version instead of `@latest`, e.g.
set args to `-y,@azure/mcp@<pinned-version>,server,start` after confirming the version on npm.

---

## Step 4 — verify tool registration in logs

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server.*azure|DefaultAzureCredential|Azure.Identity" | tail -10
```

Success looks like a line registering Azure tools (subscription, group, storage, monitor, etc.).
A real end-to-end check from the chat interface:
```
@<agent> using azure, list my resource groups
```
An empty list is still a **pass** (auth and transport worked); the SP may simply have no
in-scope groups. A `DefaultAzureCredential failed to retrieve a token` error means the SP env
vars did not land — re-check step 2.

---

## Pitfalls

- **No static API key — service principal only.** Anyone expecting a single `AZURE_API_KEY` is
  wrong. The credential is an Entra ID app (`tenant`/`appId`/`secret`). If the user can only do
  OAuth/managed identity, this skill's stdio+SP path still works; managed identity only applies
  when the host is itself in Azure.
- **No first-party remote MCP URL.** Do not try to `/hermes-mcp-add` an Azure URL with a bearer
  header — there is no hosted endpoint. The server is stdio. (Self-hosting behind Azure
  Container Apps + Entra is possible but is customer infra, out of scope here.)
- **Interactive browser hang.** Without `AZURE_TOKEN_CREDENTIALS=prod`, `DefaultAzureCredential`
  can fall back to `InteractiveBrowserCredential` and block forever in a headless container.
  Always set it to `prod`.
- **RBAC scope = blast radius.** The agent can do anything the SP's role allows. Start with
  `Reader` on a single resource group; widen only on request. Misconfigured Contributor scope
  lets an autonomous agent delete resources.
- **Secret expiry.** `az ad sp create-for-rbac` secrets expire (default ~1 year). When tools
  start failing auth, the secret likely rotated — re-mint and re-run step 2.
- **First-run latency.** `npx @azure/mcp@latest` downloads on first boot; the gateway needs the
  longer `sleep` in step 3 or registration appears to fail.

## Verify

- [ ] `hermes logs` shows Azure MCP tools registered, no `DefaultAzureCredential failed` error.
- [ ] `@<agent> using azure, list my resource groups` returns data or a valid empty list.
- [ ] `grep -c '^AZURE_CLIENT_SECRET=' /opt/data/.env` prints 1 and the file is `chmod 600`.

## Definition of done

- [ ] `@azure/mcp` registered as a stdio MCP in `config.yaml` with `env:` referencing the three
      `${AZURE_*}` placeholders plus `AZURE_TOKEN_CREDENTIALS=prod`.
- [ ] Service-principal secret lives only in `/opt/data/.env` (chmod 600); never in `config.yaml`
      or chat.
- [ ] Gateway reloaded via stop + run; Azure tools appear in `hermes logs`.
- [ ] A real Azure call from chat returns data or a valid empty result.
- [ ] SP scoped least-privilege (Reader unless writes were explicitly requested).

See `reference/TROUBLESHOOTING.md` for gateway, env-reload, and MCP registration failure modes.
