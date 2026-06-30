---
name: integration-jira
description: Connect Jira (Atlassian Cloud) to a running Hermes agent via Atlassian's official remote MCP server, so the agent can search, create, and update issues. Use when the user wants their Hermes agent to read or act on Jira.
---

# /integration-jira — connect Jira to Hermes

You are the engineer connecting Jira (Atlassian Cloud) to a running Hermes agent. Jira has a
verified first-party remote MCP server (Atlassian Rovo MCP Server), so the happy path is to wire
that endpoint through the standard `/hermes-mcp-add` procedure. Do everything autonomously; stop
only for things a machine cannot do: minting the Atlassian API token, and the one-time org-admin
toggle that enables API-token auth for the MCP server.

This is Atlassian **Cloud** only. Jira Data Center / Server is not served by the remote MCP
endpoint — see Pitfalls for the fallback.

## Before you start — gather (ask once)

1. **Atlassian account email** — the email of the account whose Jira permissions the agent will
   act under. The MCP server runs *within that user's permissions*, so pick the right account.
2. **Atlassian API token** — mint at <https://id.atlassian.com/manage-profile/security/api-tokens>
   → "Create API token" (or "Create API token with scopes" and grant the Jira read/write scopes
   you need). Tokens are variable-length opaque strings; copy it once, it is shown only at creation.
3. **Org-admin confirmation** — an Atlassian **organization admin** must enable API-token auth for
   the Rovo MCP Server in Atlassian Administration before headless token auth works. If it is not
   enabled, every call fails auth even with a valid token. Confirm this is done (or ask the admin).
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars (do not log the token):
```bash
AGENT=<container-name>                 # e.g. hermes-agent-mxlc-hermes-agent-1
EMAIL=<atlassian-account-email>        # e.g. you@company.com
TOKEN=<atlassian-api-token>            # from id.atlassian.com; never commit or echo to chat
NAME=jira                              # Hermes MCP name → env var MCP_JIRA_API_KEY
URL=https://mcp.atlassian.com/v1/mcp   # verified official remote endpoint
```

---

## Step 1 — choose the auth shape (this decides everything downstream)

The official endpoint `https://mcp.atlassian.com/v1/mcp` accepts two header shapes for headless use:

| Credential | Header | Access |
|------------|--------|--------|
| **Personal API token** (recommended) | `Authorization: Basic <base64(email:token)>` | Full — read **and** write (create/update issues) |
| Service-account API key | `Authorization: Bearer <api_key>` | Read-only tools |

Use **Basic** with `email:token` unless the user explicitly wants a read-only service account.
A common, silent failure is sending a personal token as `Bearer` — it authenticates but exposes
only read tools, so writes appear "missing." Default to Basic.

Build the Basic value now. The header *value* must include the literal `Basic ` scheme prefix,
because you will pass the whole value to Hermes as one opaque header value (the `email:token`
pair is not a bearer token, so Hermes cannot synthesize the scheme for you):
```bash
B64=$(printf '%s' "$EMAIL:$TOKEN" | base64 -w0)   # -w0: no line wrap (GNU base64)
# macOS base64 has no -w0 and does not wrap for short input; drop the flag there.
HEADER_VALUE="Basic $B64"
```

---

## Step 2 — wire it via /hermes-mcp-add

Run the full **`/hermes-mcp-add`** procedure — do not re-implement it here. Feed it these values:

- **URL**: `https://mcp.atlassian.com/v1/mcp` (no token in the path; it is a header-auth server)
- **Name**: `jira`
- **Auth**: `header`, header name `Authorization`, header value `Basic <base64(email:token)>`
- **Env var Hermes generates**: `MCP_JIRA_API_KEY`

`/hermes-mcp-add` will: probe the endpoint (Step 1–2 of that skill), register with a **placeholder**
header value, then inject the real value into `/opt/data/.env` via `sed` with the `|` delimiter,
reload with `gateway stop` + `gateway run`, and verify in logs.

Two Jira-specific notes for the injected value:

1. The real value you inject is the **whole** `Basic <b64>` string, not just the token. The base64
   blob can contain `+`, `/`, and `=` — this is exactly why `/hermes-mcp-add` uses `sed 's|...|...|'`
   (pipe delimiter). Keep it.
2. Inject the real value safely (mirrors `/hermes-mcp-add` Step 4 — never `echo >>` into `.env`):
   ```bash
   ENV_VAR=MCP_JIRA_API_KEY
   docker exec "$AGENT" sh -c \
     "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${HEADER_VALUE}|' /opt/data/.env && chmod 600 /opt/data/.env"
   ```

The resulting `config.yaml` block should read (token stays out of it):
```yaml
jira:
  url: https://mcp.atlassian.com/v1/mcp
  headers:
    Authorization: ${MCP_JIRA_API_KEY}
  enabled: true
```

---

## Pitfalls

- **Org admin must enable API-token auth first.** This is the #1 cause of "valid token, still 401."
  It is an org-level Atlassian Administration setting, separate from minting the token. No CLI for
  it; the admin toggles it in the Atlassian admin console.
- **Bearer vs Basic = write access.** Personal token over `Bearer` authenticates but yields
  read-only tools. For create/update-issue, you must use `Basic base64(email:token)`. Match the
  credential type to the header.
- **Cloud only.** `https://mcp.atlassian.com/v1/mcp` serves Atlassian **Cloud**. Jira Data
  Center / Server is not covered. Fallback for self-hosted Jira: write the token to
  `/opt/data/.env` via `hermes config set` (chmod 600) and document the Jira REST base
  `https://<your-domain>/rest/api/3/` with `Authorization: Basic base64(email:token)` for a
  generic HTTP tool. A key alone does not connect it — there is no Hermes-native Jira tool.
- **Token scope.** A "Create API token with scopes" token only exposes data its scopes allow; a
  classic (unscoped) token inherits the user's full permissions. If tools register but return
  "permission denied," widen the token scopes or use a classic token.
- **Rate limits.** Atlassian Cloud applies per-account REST rate limits (HTTP 429 with
  `Retry-After`). The MCP server proxies these, so heavy agent loops can be throttled. Keep
  agent polling/automation modest.
- **SSE endpoint sunset.** The legacy `https://mcp.atlassian.com/v1/sse` transport is deprecated
  after 2026-06-30. Use `/v1/mcp` (streamable HTTP), as above.
- **Permission boundary.** The MCP server acts strictly within the signed-in account's
  permissions. The agent can never see or change a Jira project the credential account cannot.

## Verify

1. Tools registered — after the `/hermes-mcp-add` reload:
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*'jira'|MCP server 'jira'" | tail -5
   ```
   Expect a line like `MCP server 'jira' (HTTP): registered N tool(s): ...`.
2. Real call returns data — from the chat interface:
   ```
   @<agent> using jira, search for issues assigned to me
   ```
   A real issue list — or an empty-but-valid result for an account with no issues — is a pass.
   `401`/`Unauthorized` means the header value is wrong or admin enablement is missing (recheck
   Steps 1 and the admin toggle). "Tool not found" for create/update means you are on `Bearer`
   read-only; switch to `Basic`.

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for MCP server `jira`.
- [ ] A chat-triggered Jira search returns a real or empty-but-valid result set.
- [ ] Token lives only in `/opt/data/.env` as `MCP_JIRA_API_KEY` (chmod 600); `config.yaml`
      shows only `${MCP_JIRA_API_KEY}`, never the token or email:token pair.
- [ ] Auth shape is `Basic base64(email:token)` if writes are needed (not `Bearer`).
- [ ] Org-admin API-token enablement confirmed for the Rovo MCP Server.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
