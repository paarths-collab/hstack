---
name: integration-bitbucket
description: Connect Bitbucket Cloud to a running Hermes agent via the official Atlassian Rovo remote MCP server. Use when the user wants their Hermes agent to browse Bitbucket repos, read files/branches, and open, comment on, or merge pull requests.
---

# /integration-bitbucket — connect Bitbucket Cloud to Hermes

You are the engineer connecting Bitbucket Cloud to a running Hermes agent. Bitbucket is reached
through the **official Atlassian Rovo remote MCP server** (`https://mcp.atlassian.com/v1/mcp`),
which exposes Bitbucket workspace/repo browsing and the full pull-request lifecycle. Wire it with
the `/hermes-mcp-add` procedure — this skill gives you the Bitbucket-specific URL, auth shape, and
the one footgun that breaks every first attempt. Do everything autonomously; stop only for the
things a machine cannot do (minting the token, the org-admin enablement toggle).

Verified 2026-06: a **first-party remote MCP server exists** (Atlassian Rovo, `atlassian/atlassian-mcp-server`)
and it supports Bitbucket Cloud. Per Atlassian, **Bitbucket Cloud tools are available only via API-token
auth — OAuth 2.1 does not yet cover Bitbucket.** Static-token auth keeps the one-click promise.

## Before you start — gather (ask once)

1. **Auth style** — decide which credential the agent will use:
   - **Personal API token** (acts as one human user). Mint at
     `https://id.atlassian.com/manage-profile/security/api-tokens` → *Create API token with scopes*.
     You also need the **Atlassian account email** that owns the token (it is half of the credential).
   - **Service-account API key** (recommended for an always-on agent; no human identity). An org admin
     creates this in Atlassian Administration → Rovo / MCP settings. No email needed.
2. **The token/key value** — paste it once; it never goes in chat history beyond this step or into git.
3. **Bitbucket scopes** — when minting, grant at least repository read plus the pull-request scopes the
   agent needs (e.g. `read:repository:bitbucket`, `read:pullrequest:bitbucket`, and
   `write:pullrequest:bitbucket` to create/comment/merge PRs). Scope it to the narrowest workspace/repos
   that the task requires.
4. **Admin enablement** — API-token auth for the Rovo MCP server must be turned on by an organization
   admin under Atlassian Administration before any token will authenticate. Confirm this is done; if you
   get `401`/`403` on a correctly-formed request, this toggle is the usual cause.
5. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars:
```bash
AGENT=<container-name>             # e.g. hermes-agent-mxlc-hermes-agent-1
NAME=bitbucket                     # → env var MCP_BITBUCKET_API_KEY
URL=https://mcp.atlassian.com/v1/mcp
```

---

## Step 1 — build the exact `Authorization` value (the #1 footgun)

The Atlassian MCP server uses **two different header shapes** depending on credential type. Picking the
wrong one is the single most common failure.

- **Personal API token → HTTP Basic**, base64 of `email:token` (NOT Bearer):
  ```bash
  AUTH="Basic $(printf '%s' '<atlassian-email>:<api-token>' | base64 -w0)"
  ```
  Use `-w0` so base64 does not wrap the output onto multiple lines (a wrapped value is an invalid header).
  On BSD/macOS `base64` has no `-w` flag; use `printf '%s' '<email>:<token>' | base64 | tr -d '\n'`.

- **Service-account API key → Bearer** (passed directly, no encoding):
  ```bash
  AUTH="Bearer <service-account-api-key>"
  ```

`$AUTH` is the complete header value you will inject in step 3. Treat it as a secret — do not echo it.

---

## Step 2 — wire the MCP via /hermes-mcp-add

Run the **/hermes-mcp-add** procedure (do not re-paste its body). It probes the endpoint, registers the
server in `config.yaml`, injects the secret into `/opt/data/.env`, reloads the gateway with
`gateway stop` + `gateway run`, and verifies tool registration in the logs. For Bitbucket, feed it:

- **MCP base URL:** `https://mcp.atlassian.com/v1/mcp`
- **Name:** `bitbucket` → env var `MCP_BITBUCKET_API_KEY`
- **Auth mode:** `header`, header name `Authorization`. Register with a **placeholder** value (per
  mcp-add step 3) so special chars in the base64/token never get mangled through the non-TTY pipe:
  ```bash
  printf 'y\nAuthorization\nplaceholder\n' | \
    docker exec -i -u hermes "$AGENT" hermes mcp add "$NAME" --url "$URL" --auth header
  ```
  This writes to `config.yaml`:
  ```yaml
  bitbucket:
    url: https://mcp.atlassian.com/v1/mcp
    headers:
      Authorization: ${MCP_BITBUCKET_API_KEY}
    enabled: true
  ```

Note: unlike a plain Bearer MCP, the **full** header value (`Basic <b64>` or `Bearer <key>`) lives in the
env var here — so the template must be `Authorization: ${MCP_BITBUCKET_API_KEY}`, with no literal `Bearer`
prefix in `config.yaml`. If mcp-add generated `Bearer ${MCP_BITBUCKET_API_KEY}`, edit `config.yaml` to drop
the literal `Bearer ` so the prefix is not duplicated.

---

## Step 3 — inject the real `Authorization` value into /opt/data/.env

Put the complete `$AUTH` string (from step 1) into the env var via sed with `|` as the delimiter — the
base64 and tokens contain `/`, `+`, `=` which break a `/`-delimited expression:

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # → MCP_BITBUCKET_API_KEY

docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${AUTH}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

`chmod 600` is mandatory — this file now holds a working credential. Never write the token to
`config.yaml` and never `echo >>` into `.env`. Confirm the line exists without printing the value:
```bash
docker exec "$AGENT" sh -c "grep -c '^${ENV_VAR}=' /opt/data/.env"   # expect 1
```

Then reload per mcp-add step 5 (`gateway stop` + `gateway run`, not `restart`).

---

## Pitfalls

| Footgun | Why it bites | Fix |
|---------|--------------|-----|
| Using `Bearer` with a personal API token | Personal tokens need `Basic base64(email:token)`; Bearer is only for service-account keys. Server returns `401`. | Match header to credential type (step 1). |
| Forgetting the email in the Basic value | The credential is `email:token`, not the token alone. | Always base64 `email:token`. |
| Wrapped base64 | `base64` without `-w0` inserts newlines → malformed header. | `base64 -w0` (Linux) or `base64 \| tr -d '\n'`. |
| OAuth expectation | OAuth 2.1 works for Jira/Confluence but **not** Bitbucket Cloud yet — API token is the only path for Bitbucket. | Use an API token; do not wait for OAuth. |
| API-token auth not enabled org-wide | Org admin must enable API-token auth for the Rovo MCP server; otherwise every token 401s. | Confirm the admin toggle (gather step 4). |
| Over-broad token scope | A workspace/account-wide token gives the agent more than the task needs. | Scope to the specific repos/PR permissions; prefer a service account. |
| `/v1/sse` endpoint | The legacy SSE endpoint is unsupported after 2026-06-30. | Use `https://mcp.atlassian.com/v1/mcp`. |
| Rate limits | Atlassian throttles MCP/API calls per token; bursty PR automation can 429. | Back off on `429`; avoid tight polling loops. |

---

## Verify

1. **Tools registered** (per mcp-add step 6):
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server .*bitbucket" | tail -5
   ```
   Expect a line registering Bitbucket tools (workspace/repo browse, pull-request create/comment/merge).
2. **Live call from chat** — proves auth, scopes, and routing end to end:
   ```
   @<agent> using bitbucket, list the repositories in workspace <workspace-slug>
   ```
   A real repo list (or a valid empty list for an empty workspace) is a pass. `401/403` → re-check the
   header shape (step 1) and the admin enablement toggle. `403` on a write → the token lacks
   `write:pullrequest:bitbucket`.

---

## Definition of done

- [ ] `bitbucket` MCP registered in `config.yaml` with `Authorization: ${MCP_BITBUCKET_API_KEY}` (no literal token, no literal `Bearer`).
- [ ] `MCP_BITBUCKET_API_KEY` holds the full `Basic <b64>` or `Bearer <key>` value in `/opt/data/.env`, `chmod 600`.
- [ ] `hermes logs` shows Bitbucket tools registered after `gateway stop` + `gateway run`.
- [ ] A chat-triggered Bitbucket call (list repos / read a PR) returns real data.
- [ ] Token is scoped to the minimum repos/PR permissions and org-admin API-token auth is enabled.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
