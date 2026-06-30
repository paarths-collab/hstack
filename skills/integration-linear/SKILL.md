---
name: integration-linear
description: Connect Linear (product and engineering issues, projects, cycles) to a running Hermes agent via Linear's first-party remote MCP server. Use when the user wants their agent to find, create, or update Linear issues, projects, and comments.
---

# /integration-linear — connect Linear to Hermes

You are the engineer connecting Linear to a running Hermes agent. Linear is a product and
engineering issue tracker: issues, projects, cycles, comments, teams. Your job is to give the
agent authenticated access to the user's Linear workspace and verify a real call returns data.

Read this before you start: **Linear ships a first-party remote MCP server at
`https://mcp.linear.app/mcp`** (verified 2026-06). Its standard flow is OAuth 2.1 with dynamic
client registration, but Linear's own MCP FAQ states the server also accepts a static credential:
"The MCP server now supports passing OAuth token and API keys directly in the
`Authorization: Bearer <yourtoken>` header instead of using the interactive authentication flow"
(https://linear.app/docs/mcp). That static-bearer path is what keeps the one-click promise, so the
happy path below wires the official MCP server with a Linear personal API key via the standard
`/hermes-mcp-add` bearer-header procedure. No community server is needed.

⚠️ **Bearer asymmetry — the #1 Linear gotcha.** Linear's raw GraphQL API takes the personal API
key with **no** prefix (`Authorization: <key>`). The MCP server takes the **same** key **with**
`Bearer` (`Authorization: Bearer <key>`). Step 1 uses the no-Bearer form to validate the key;
the MCP wiring (Step 2) uses the Bearer form. Mixing them returns 401.

## Before you start — gather (ask once)

1. **Linear personal API key** — format `lin_api_...`, long-lived, does not auto-expire. The user
   mints it at `https://linear.app/settings/account/security` → **Personal API keys** →
   **New API key**. When creating it they can scope it (Read / Write / Admin, or limit to specific
   teams) — a read+write key is enough for issue/project/comment tools; pick the narrowest scope the
   user actually needs. Docs: https://linear.app/developers/graphql
2. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the key):
```bash
AGENT=<container-name>      # e.g. hermes-agent-mxlc-hermes-agent-1
KEY=<lin_api_...>          # Linear personal API key; never commit, never echo to chat
```

---

## Step 1 — validate the key against the GraphQL API (no Bearer prefix)

Confirm the key is live before wiring anything. The GraphQL endpoint is
`https://api.linear.app/graphql`. Send the key **raw** in `Authorization` — **no** `Bearer`.

```bash
curl -sS -X POST https://api.linear.app/graphql \
  -H "Authorization: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ viewer { id name email } }"}'
```

- 200 + a `data.viewer` object → key is valid; note the user name.
- 401 / `"Authentication required"` → wrong key, or it was sent with a `Bearer` prefix (the
  GraphQL API rejects Bearer for personal keys).

This call is validation only — Hermes will reach Linear through the MCP server, not this raw
endpoint.

---

## Step 2 — wire the official MCP server via /hermes-mcp-add (bearer-header path)

Run `/hermes-mcp-add` and feed it these values. Do not re-derive the procedure here — that skill
owns the probe → register-with-placeholder → `sed`-inject → `gateway stop`+`run` → verify-in-logs
flow. Supply:

- **URL:** `https://mcp.linear.app/mcp`  (streamable HTTP; the `/sse` endpoint is being retired)
- **Name:** `linear`  → Hermes generates env var `MCP_LINEAR_API_KEY`
- **Auth shape:** header `Authorization` with value `Bearer ${MCP_LINEAR_API_KEY}`
- **Token value to inject:** the `lin_api_...` key from gather (Step 4 of mcp-add `sed`-injects it
  into `/opt/data/.env`, then `chmod 600`)

The resulting `config.yaml` block must look like this (token stays a placeholder, never literal):
```yaml
linear:
  url: https://mcp.linear.app/mcp
  headers:
    Authorization: Bearer ${MCP_LINEAR_API_KEY}
  enabled: true
```

Because the static credential is passed in the header, the agent skips Linear's interactive OAuth
flow entirely — no browser login, no dynamic client registration. The `/hermes-mcp-add` probe
matrix (its Step 1) will confirm the `Bearer` header variant is the one that authenticates here.

> Sanity-check before injecting: the same key must work with `Bearer` against the MCP endpoint.
> ```bash
> curl -sS -X POST https://mcp.linear.app/mcp \
>   -H 'Accept: application/json, text/event-stream' \
>   -H 'Content-Type: application/json' \
>   -H "Authorization: Bearer $KEY" \
>   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
> ```
> A JSON-RPC `result` with a `tools` array is the green light. 401 here with a key that passed
> Step 1 means you dropped the `Bearer` prefix the MCP server requires.

---

## Pitfalls

- **Bearer asymmetry (raw API vs MCP).** GraphQL: `Authorization: <key>` (no prefix). MCP server:
  `Authorization: Bearer <key>`. The validation in Step 1 and the MCP wiring in Step 2 deliberately
  differ. This is the most common 401 cause when connecting Linear.
- **OAuth is the documented default, static keys are the supported alternative.** The interactive
  flow uses OAuth 2.1 + dynamic client registration. We deliberately use the API-key-in-header path
  to stay headless. If Linear ever removes header-based auth, fall back to an OAuth bridge
  (`mcp-remote`) which needs a one-time browser login a machine cannot do.
- **Key scope limits the tools.** A Read-only key cannot create or update issues; create/comment
  tools will 403. Match the key scope to what the user wants the agent to do, and prefer the
  narrowest scope.
- **Key is user-scoped, not workspace-scoped.** The agent sees exactly what that user can see across
  their teams (and only the teams the key is restricted to, if any). It does not grant broader admin
  reach.
- **API rate limits.** Linear rate-limits the API (personal-key requests are counted per user; the
  published budget is on the order of a few thousand requests/hour and complex GraphQL queries cost
  more). Bursty agent loops can hit `429` — back off and batch.
- **Endpoint drift.** Use `https://mcp.linear.app/mcp` (streamable HTTP). The legacy
  `https://mcp.linear.app/sse` endpoint is being removed; do not wire it.

## Verify

After `/hermes-mcp-add` reloads the gateway, confirm the Linear tools registered:
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|linear" | tail -5
```
Success looks like `MCP server 'linear' (HTTP): registered N tool(s): mcp_linear_list_issues, ...`.

Then trigger a real call from the chat interface:
```
@<agent> using linear, list my assigned issues
```
A valid result — even an empty list if nothing is assigned — is a pass. A `401` / "Bearer token
missing" means the key did not land or lost its `Bearer` prefix; re-check the inject step in
`/hermes-mcp-add` and the MCP sanity curl in Step 2.

## Definition of done

- [ ] `{ viewer { id name } }` against `https://api.linear.app/graphql` returns the user with the
      supplied key (no Bearer prefix).
- [ ] The official MCP server `https://mcp.linear.app/mcp` is registered in Hermes via
      `/hermes-mcp-add` with `Authorization: Bearer ${MCP_LINEAR_API_KEY}`.
- [ ] `MCP_LINEAR_API_KEY` holds the `lin_api_...` key in `/opt/data/.env`, file is `chmod 600`, and
      the key appears only there — never in `config.yaml` and never in chat.
- [ ] `hermes logs` shows `registered N tool(s)` for `linear`.
- [ ] A real Linear call from chat returns data or a valid empty response.

See `reference/TROUBLESHOOTING.md` for gateway, env-reload, and platform failure modes.
