---
name: integration-google-workspace
description: Connect Google Workspace (Gmail, Drive, Calendar, Docs, Sheets, Meet) to a running Hermes agent. Use when the user wants their agent to read or act on their Google Workspace data. Google is OAuth-only — there is no static API key — so this skill uses a self-hosted MCP server with a service account for headless auth, and documents the official OAuth remote endpoints as the alternative.
---

# /integration-google-workspace — connect Google Workspace to Hermes

You are the engineer connecting Google Workspace to a running Hermes agent. Read this whole file
before you touch anything: Google Workspace is **OAuth-only**, so the one-click "paste a key"
promise does not apply here. There is no static API key for Gmail, Drive, Calendar, Docs, or
Sheets. Your job is to pick the one auth path that does not require a human clicking through a
browser on the server, wire it through the standard `/hermes-mcp-add` procedure, and be honest
with the user about the trade-offs.

Do everything autonomously. Stop only for things a machine cannot do: creating the Google Cloud
project, enabling APIs in the console, minting the service-account key, and (for domain-wide
delegation) the Workspace admin granting scopes. Those are console clicks only the user's
identity can perform.

## Auth reality (read this first)

As of 2026-06, Google Workspace has **no static API key / bearer token** for these products.
Two real paths exist:

1. **Official Google remote MCP servers** — first-party, hosted. Per-product endpoints, e.g.
   `https://gmailmcp.googleapis.com/mcp/v1`, `https://drivemcp.googleapis.com/mcp/v1`,
   `https://calendarmcp.googleapis.com/mcp/v1`, `https://chatmcp.googleapis.com/mcp/v1`.
   Auth is **OAuth 2.0 with an interactive browser redirect** (callback URI per client). This
   requires a human to complete a sign-in flow and Docs/Sheets are not covered. **Not headless** —
   document it, do not pick it for a server agent unless the user insists on first-party.
   Source: https://developers.google.com/workspace/guides/configure-mcp-servers
2. **Self-hosted community MCP server** — `taylorwilsdon/google_workspace_mcp` (actively
   maintained, 12 services incl. Gmail/Drive/Calendar/Docs/Sheets/Slides/Tasks/Chat, 100+ tools).
   Runs as a streamable-HTTP MCP server. Supports **service account + domain-wide delegation**,
   which is the only **non-interactive** auth — perfect for a server-side Hermes agent.
   Source: https://github.com/taylorwilsdon/google_workspace_mcp and https://workspacemcp.com/docs

This skill uses path 2 (self-hosted + service account). It is the only way to keep the deploy
hands-off after the one-time console setup. Meet data is reached via Calendar events (conference
links) and the Meet REST API surface where the server exposes it.

## Before you start — gather (ask once)

1. **Service-account JSON key file** — the credential. The user mints it in Google Cloud Console:
   https://console.cloud.google.com/iam-admin/serviceaccounts → create service account →
   Keys → Add key → JSON. This downloads `<project>-<id>.json`. That file is the secret.
2. **Impersonation email** — the Workspace user the agent acts as (e.g. `agent@<domain>`).
   With domain-wide delegation the service account impersonates exactly this one user.
3. **APIs enabled** — confirm the user enabled, in that project: Gmail, Drive, Calendar, Docs,
   Sheets (and Slides/Tasks/Chat/People if wanted). Console → APIs & Services → Enable APIs.
4. **Domain-wide delegation granted** — a Workspace **admin** must authorize the service
   account's client ID for the needed OAuth scopes at
   https://admin.google.com → Security → Access and data control → API controls →
   Domain-wide delegation. Without this, every call returns `unauthorized_client`.
5. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers:
```bash
AGENT=<container-name>              # e.g. hermes-agent-mxlc-hermes-agent-1
IMPERSONATE=<agent@your-domain>     # the Workspace user to act as
SA_SRC=<path-to-service-account>.json   # local path to the JSON key you were given
NAME=google-workspace              # MCP name in Hermes  →  env var MCP_GOOGLE_WORKSPACE_API_KEY (unused; see step 3)
```

---

## Step 1 — place the service-account key inside the container (chmod 600)

The JSON key is a credential. It goes next to the other Hermes runtime secrets in `/opt/data`,
never in `config.yaml`, never echoed to chat. Copy it in, then lock it down.

```bash
# Copy the JSON into the container's data dir (sibling of /opt/data/.env)
docker cp "$SA_SRC" "$AGENT:/opt/data/gws-sa.json"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/gws-sa.json && chown hermes /opt/data/gws-sa.json"

# Confirm it is valid JSON and is a service account (prints type only, not the key material)
docker exec "$AGENT" sh -c "grep -o '\"type\": *\"service_account\"' /opt/data/gws-sa.json"
# Expect: "type": "service_account"
```

Record the impersonation email and key path in `/opt/data/.env` so the server picks them up.
Use `hermes config set` (never `echo >>`, which can merge lines). These are config, not the
secret itself; the secret stays in `gws-sa.json`.

```bash
docker exec -u hermes "$AGENT" hermes config set GOOGLE_APPLICATION_CREDENTIALS /opt/data/gws-sa.json
docker exec -u hermes "$AGENT" hermes config set USER_GOOGLE_EMAIL "$IMPERSONATE"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

---

## Step 2 — run the self-hosted Google Workspace MCP server (streamable-http)

Run `taylorwilsdon/google_workspace_mcp` in HTTP mode so Hermes can reach it as a normal remote
MCP. Point it at the service-account key and run it in **single-user** mode (one impersonated
identity, no per-request OAuth). Easiest is the published container alongside the agent on the
same Docker network.

```bash
docker run -d --name gws-mcp \
  --network container:"$AGENT" \
  -v /opt/data/gws-sa.json:/app/gws-sa.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/gws-sa.json \
  -e USER_GOOGLE_EMAIL="$IMPERSONATE" \
  -e WORKSPACE_MCP_PORT=8000 \
  ghcr.io/taylorwilsdon/google_workspace_mcp:latest \
  --transport streamable-http --single-user
```

`--network container:"$AGENT"` shares the agent's network namespace, so the server is reachable
at `http://localhost:8000/mcp` from inside the agent. Confirm it is up and answers MCP:

```bash
docker exec "$AGENT" sh -c \
  'curl -sS -o /dev/null -w "%{http_code}\n" \
   -X POST -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
   -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}" \
   http://localhost:8000/mcp'
# Expect 200 (handshake). Auth is handled server-side by the service account, not by a header.
```

> Pin a tag instead of `latest` once you confirm a known-good version with the user — this skill
> does not assert a specific pinned version because the upstream tag scheme is not verified here.

---

## Step 3 — register the server in Hermes via /hermes-mcp-add

The credential lives **server-side** (the service-account JSON), so Hermes does not send a bearer
token. Wire it as a no-auth local HTTP MCP. Run the standard **/hermes-mcp-add** procedure with:

- **URL**: `http://localhost:8000/mcp`
- **NAME**: `google-workspace`
- **Auth**: none (the MCP server authenticates to Google itself; do not add an `Authorization`
  header and do not set `MCP_GOOGLE_WORKSPACE_API_KEY`).

Follow `/hermes-mcp-add` Step 1 (probe), then register without auth:

```bash
# No-auth registration — answer "n" to the use-auth prompt
printf 'n\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add google-workspace \
      --url http://localhost:8000/mcp
```

If you ever switch to the community server's **OAuth 2.1 multi-user** mode instead of a service
account, that path DOES use a per-user bearer token — only then follow the full /hermes-mcp-add
sed-inject of `MCP_GOOGLE_WORKSPACE_API_KEY` into `/opt/data/.env`. With the service account,
there is no token to inject.

---

## Step 4 — reload the gateway and verify (per /hermes-mcp-add)

Use **stop + run**, not `restart`, so the new config is re-read cleanly:

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Expecting a static API key | Google Workspace has **no** API-key auth for Gmail/Drive/Calendar/Docs/Sheets. | Use service account (this skill) or OAuth; tell the user up front. |
| 2 | Picking the official remote endpoints for a server agent | They require an **interactive browser OAuth redirect** (e.g. `https://claude.ai/api/mcp/auth_callback`); no human is at the server. Docs/Sheets also not covered. | Use the self-hosted server + service account for headless. |
| 3 | Skipping domain-wide delegation | Service account exists but admin never authorized its client ID → every call returns `unauthorized_client`. | Confirm the admin granted DWD for the exact scopes before testing. |
| 4 | Scope too narrow | Some official Calendar scopes are read-only (`...events.readonly`); the agent then cannot create events. | Request read/write scopes the use case needs when granting DWD. |
| 5 | Service-account JSON world-readable | It is a full credential; leaking it grants impersonation. | `chmod 600 /opt/data/gws-sa.json`; never in `config.yaml`, never in chat. |
| 6 | `echo >>` into `.env` | Can merge onto a prior line with no trailing newline and silently corrupt config. | Use `hermes config set` (Step 1). |
| 7 | Per-user quotas / rate limits | Gmail and Drive enforce per-user API quotas; bulk reads 429. | Keep tool calls scoped; back off on 429; raise quota in Cloud Console if needed. |
| 8 | OAuth refresh-token expiry (if you use OAuth mode) | Unused refresh tokens expire (~6 months) and for unverified apps in testing ~7 days. | Prefer the service account (no refresh tokens) for long-running agents. |

---

## Verify

1. **Tools registered** — check the gateway logs for the new server:
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*google" | tail -5
   ```
   Success looks like `MCP server 'google-workspace' (HTTP): registered N tool(s): ...`.
2. **Live call returns data** — from the chat interface, trigger a real read that only succeeds
   if impersonation + delegation worked:
   ```
   @<agent> using google-workspace, list my 3 most recent Gmail messages
   ```
   A real list (or a valid empty result for an empty mailbox) is a pass. `unauthorized_client`
   means domain-wide delegation is missing (Pitfall 3); `insufficient permission` means the
   granted scopes are too narrow (Pitfall 4).

---

## Definition of done

- [ ] `/opt/data/gws-sa.json` exists, is a `service_account` key, and is `chmod 600`.
- [ ] The self-hosted MCP server answers `initialize` with `200` at `http://localhost:8000/mcp`.
- [ ] `hermes logs` shows `registered N tool(s)` for `google-workspace`.
- [ ] A real chat call (e.g. list recent Gmail) returns data or a valid empty result.
- [ ] No credential is in `config.yaml` or chat; only `GOOGLE_APPLICATION_CREDENTIALS` path is referenced.

See `reference/TROUBLESHOOTING.md` for gateway reload, `unauthorized_client`, and MCP registration failure modes.
