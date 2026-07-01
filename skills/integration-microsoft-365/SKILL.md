---
name: integration-microsoft-365
description: Connect Microsoft 365 (Outlook, Teams, OneDrive, SharePoint, Excel) to a self-hosted Hermes Agent over SSH via Microsoft Graph. Idempotent, dry-run, rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-microsoft-365 — connect Microsoft 365 (Graph) to a remote Hermes (SSH-first)

You are the engineer connecting Microsoft 365 to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH as
root against the VPS. Every command in this skill runs on the VPS, not on the local machine.

The user only does the things a machine cannot:

1. Register the Microsoft Entra app and grant **admin consent** for Graph permissions.
2. Mint the **client secret** under Certificates & secrets and hand it over.
3. (Path B only) Run the elevated PowerShell consent for the Enterprise MCP server.

Everything else — token storage, MCP/REST wiring, gateway reload, verification — runs on the
VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):**

1. **M365 / Graph is OAuth, not a static API key.** There is no "paste one key" path. Every
   call rides a short-lived OAuth bearer minted from an Entra app. Client-credentials
   (app-only) + a client secret is the closest to set-and-forget for a headless agent.
2. **No first-party remote MCP covers the productivity surface.** Microsoft's official remote
   MCP at `https://mcp.svc.cloud.microsoft/enterprise` is **preview, read-only, and limited to
   Entra identity/directory data** — not Outlook, Teams, OneDrive, SharePoint, or Excel.
3. **Path A (recommended) — community MCP `@softeria/ms-365-mcp-server`** (200+ tools mapping
   to Graph; runs as stdio or `--http`; covers Outlook, Teams, OneDrive, SharePoint, Excel).
   It is a community project, not Microsoft-published — say so to the user.
4. **Path B — official Microsoft Enterprise MCP** at `https://mcp.svc.cloud.microsoft/enterprise`.
   Only useful if the user's real goal is Entra identity/admin reporting. Delegated-OAuth only,
   no app-only.
5. **Path C (fallback) — direct Graph REST** when the Hermes build is HTTP-MCP-only and cannot
   spawn a stdio command. The agent calls `https://graph.microsoft.com/v1.0/...` with a bearer
   the server (or your code) mints from the client secret.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MS365_TENANT_ID` | Directory (tenant) GUID | Entra admin center → App registrations → Overview |
| `$MS365_CLIENT_ID` | Application (client) GUID | Entra admin center → App registrations → Overview |
| `$MS365_CLIENT_SECRET` | Client secret **Value** (not Secret ID) | App → Certificates & secrets → New client secret → copy Value immediately (Entra never shows it again) |
| Graph permissions consented | **Application** permissions (e.g. `Mail.Read`, `Files.Read.All`, `Sites.Read.All`, `ChannelMessage.Read.All`) with **Grant admin consent** clicked | App → API permissions |

Docs the user mints these from:
- App registration + client credentials: <https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow>
- Graph permissions reference: <https://learn.microsoft.com/en-us/graph/permissions-reference>

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci ms365" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Microsoft 365 is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MS365_MCP_TENANT_ID (length ${#MS365_TENANT_ID}, prefix ${MS365_TENANT_ID:0:4}...)
  2. Write MS365_MCP_CLIENT_ID  (length ${#MS365_CLIENT_ID}, prefix ${MS365_CLIENT_ID:0:4}...)
  3. Write MS365_MCP_CLIENT_SECRET (length ${#MS365_CLIENT_SECRET}, prefix ${MS365_CLIENT_SECRET:0:4}...)
     ... all three via 'hermes config set' into ~/.hermes/.env
  4. chmod 600 ~/.hermes/.env
  5. Register MCP: hermes mcp add ms365 --command npx --args -y,@softeria/ms-365-mcp-server,--org-mode
  6. Reload gateway: hermes gateway stop && hermes gateway run
  7. Verify in logs: grep -i "registered.*ms365"
  8. Smoke test: POST https://login.microsoftonline.com/.../oauth2/v2.0/token → expect access_token
                 GET  https://graph.microsoft.com/v1.0/users?\$top=1 → expect 200

The secret is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MS365_MCP_TENANT_ID '$MS365_TENANT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set MS365_MCP_CLIENT_ID '$MS365_CLIENT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set MS365_MCP_CLIENT_SECRET '$MS365_CLIENT_SECRET'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns counts, NEVER the values):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^MS365_MCP_(TENANT_ID|CLIENT_ID|CLIENT_SECRET)=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "3" ] || { echo "FAIL: not all three MS365 vars written (got $WROTE/3). Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with the
> `|` delimiter (client secrets may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for V in MS365_MCP_TENANT_ID MS365_MCP_CLIENT_ID MS365_MCP_CLIENT_SECRET; do
>     grep -q \"^\$V=\" ~/.hermes/.env || printf '%s=\n' \"\$V\" >> ~/.hermes/.env
>   done
>   sed -i 's|^MS365_MCP_TENANT_ID=.*|MS365_MCP_TENANT_ID=$MS365_TENANT_ID|'         ~/.hermes/.env
>   sed -i 's|^MS365_MCP_CLIENT_ID=.*|MS365_MCP_CLIENT_ID=$MS365_CLIENT_ID|'         ~/.hermes/.env
>   sed -i 's|^MS365_MCP_CLIENT_SECRET=.*|MS365_MCP_CLIENT_SECRET=$MS365_CLIENT_SECRET|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server (or REST fallback)

Pick the path that matches the Hermes build and the user's goal. Path A is preferred for the
productivity surface; Path B is identity-only; Path C is the REST fallback.

### Path A (preferred) — Softeria community MCP, app-only (organization) mode

The Softeria server takes the three Entra values from env and mints/refreshes Graph tokens
itself. App-only avoids the device-code interactive sign-in, so it survives restarts unattended.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add ms365 \
    --command npx \
    --args '-y,@softeria/ms-365-mcp-server,--org-mode' \
    --env 'MS365_MCP_TENANT_ID=\${MS365_MCP_TENANT_ID},MS365_MCP_CLIENT_ID=\${MS365_MCP_CLIENT_ID},MS365_MCP_CLIENT_SECRET=\${MS365_MCP_CLIENT_SECRET}'
"
```

The flag names vary by Hermes version; if unsure, run `hermes mcp add --help` first and match
its stdio syntax. Secrets stay in `~/.hermes/.env` and are referenced via `${...}` indirection —
never inlined into `config.yaml`.

> If the user prefers **delegated (per-user) access** instead of app-only, drop `--org-mode`.
> The Softeria server then falls back to the OAuth **device-code** flow: a one-time interactive
> sign-in at `https://microsoft.com/devicelink` that caches a refresh token. That is the one
> step a machine cannot do for them.

### Path B — official Microsoft Enterprise MCP (identity/admin reporting only)

Only if the user's goal is identity/directory reporting, not productivity data. This server is
**delegated-OAuth only — app-only is NOT supported** — so it requires an interactive admin
sign-in. Provision once per tenant (the user runs this in elevated PowerShell on a workstation):

```powershell
Install-Module Microsoft.Entra.Beta -Force -AllowClobber
Connect-Entra -Scopes 'Application.ReadWrite.All','Directory.Read.All','DelegatedPermissionGrant.ReadWrite.All'
Grant-EntraBetaMCPServerPermission -ApplicationId "<MCP_Client_Application_Id>" -Scopes "MCP.User.Read.All"
```

Then wire `https://mcp.svc.cloud.microsoft/enterprise` (HTTP MCP) via `hermes mcp add`. Tell
the user plainly: read-only, preview, Entra data only, interactive consent required.

### Path C (fallback) — direct Graph REST

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command:

- **Token endpoint:** `https://login.microsoftonline.com/${MS365_MCP_TENANT_ID}/oauth2/v2.0/token`
- **Token body (app-only):** `client_id=...&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=...&grant_type=client_credentials`
- **Graph base:** `https://graph.microsoft.com/v1.0`
- **Auth header on every Graph call:** `Authorization: Bearer <access_token>`
- **Token lifetime:** ~3600s; refresh by re-POSTing the token endpoint.

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
       | grep -qiE "registered.*tool.*ms365|MCP server.*ms365.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: ms365 registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: ms365 not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (token mint + Graph call)

Prove end-to-end that the Entra app, secret, and consent actually work. Run inside the VPS so
the secret never leaves it.

```bash
TOKEN_RESP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
    -d \"client_id=\$MS365_MCP_CLIENT_ID&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=\$MS365_MCP_CLIENT_SECRET&grant_type=client_credentials\" \
    \"https://login.microsoftonline.com/\$MS365_MCP_TENANT_ID/oauth2/v2.0/token\"
")
echo "$TOKEN_RESP" | grep -q '"access_token"' \
  || { echo "FAIL: token mint failed. Check tenant/client/secret and admin consent."; rollback; exit 1; }

HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  AT=\$(curl -sS -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
    -d \"client_id=\$MS365_MCP_CLIENT_ID&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default&client_secret=\$MS365_MCP_CLIENT_SECRET&grant_type=client_credentials\" \
    \"https://login.microsoftonline.com/\$MS365_MCP_TENANT_ID/oauth2/v2.0/token\" \
    | sed -n 's/.*\"access_token\":\"\([^\"]*\)\".*/\1/p')
  curl -sS -o /dev/null -w '%{http_code}' \
    -H \"Authorization: Bearer \$AT\" \
    'https://graph.microsoft.com/v1.0/users?\$top=1'
")
case "$HTTP" in
  200) echo "OK: Graph reachable and app-only token has read access." ;;
  401) echo "FAIL: token rejected. Re-check secret value and tenant."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but missing scope. Confirm Application perms + admin consent."; exit 1 ;;
  429) echo "WARN: Graph throttled (429). Back off and retry; wiring is OK." ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Graph. Check manually." ;;
esac
```

A `200` with an empty `value` array still means wiring is correct — there are just no users
visible to that scope.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove ms365 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    for V in MS365_MCP_TENANT_ID MS365_MCP_CLIENT_ID MS365_MCP_CLIENT_SECRET; do
      hermes config unset \"\$V\" 2>/dev/null || sed -i \"/^\$V=/d\" ~/.hermes/.env
    done
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Microsoft 365 is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Promising a single static M365 API key | OAuth-only; every call uses a short-lived bearer minted from client_credentials | Use the client secret + token mint; the MCP server handles refresh |
| 2 | Delegated permissions on an app-only flow | App-only uses `.default` scope + **Application** perms; delegated perms cannot satisfy it → every call 403s | Match permission type to flow: app-only → Application perms |
| 3 | Missing **admin consent** | Application perms do nothing until a tenant admin clicks Grant admin consent | Symptom: `AADSTS65001` / "no permission"; user must consent in Entra |
| 4 | Client secret expires (6–24 months) | Every call fails with auth error after expiry | Don't debug the MCP layer — mint a new secret and re-inject |
| 5 | Graph throttling (429 + `Retry-After`) | High-volume mailbox/file scans hit per-app limits | Back off on 429; don't retry-storm |
| 6 | Pointing user at the official Enterprise MCP for productivity tasks | It is **preview, read-only, identity-only**; physically cannot send mail or edit files | Use Path A (Softeria) for productivity; Path B only for identity reporting |
| 7 | Putting the secret in `config.yaml` | World-readable; not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600`, via `hermes config set` |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >>` to append to `.env` | Can merge onto a prior line without trailing newline → silently broken vars | Always `hermes config set` (or the sed-fallback in Step 4) |
| 10 | sed with `/` delimiter on tokens | Client secrets contain `/+=` | Always use `\|` delimiter |
| 11 | Container vs host confusion | Vars set inside a container are invisible to the host's gateway, and vice versa | Step 1 checks `command -v hermes` first, then container; pick one layer and stay there |
| 12 | Device-code flow chosen unattended | Falls back to interactive sign-in at `microsoft.com/devicelink`; daemon hangs forever waiting | Use `--org-mode` (app-only) for headless agents |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `MS365_MCP_TENANT_ID`, `MS365_MCP_CLIENT_ID`, `MS365_MCP_CLIENT_SECRET` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Entra app: **Application** perms added and **admin consent** granted
- [ ] MCP registered via Path A (Softeria stdio, recommended), Path B (Enterprise identity-only), or Path C (REST documented)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'ms365'` within 30s
- [ ] Smoke test: token mint returned `access_token` AND `GET /v1.0/users?$top=1` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
