---
name: integration-railway
description: Connect Railway (app hosting / infra) to a running Hermes agent — store a static Railway API token for the public GraphQL API (headless), or wire Railway's official remote MCP server (OAuth-only) via /hermes-mcp-add. Use when the user wants their Hermes agent to list projects, read service variables, trigger deploys, or inspect Railway infrastructure.
---

# /integration-railway — connect Railway to Hermes

You are the engineer connecting Railway to a running Hermes agent. Railway ships a
**first-party remote MCP server** at `https://mcp.railway.com`, but it is **OAuth-only** — it
authenticates through a browser flow and **explicitly rejects static API/project tokens**
("Project tokens are not accepted. The remote MCP server requires a user identity for billing
and audit trails."). That breaks the usual one-click "paste a token" promise, so pick the
honest path below before touching anything.

Two real options:

- **Path A — headless GraphQL API via a static token (recommended for an unattended agent).**
  No MCP server is involved. You store a Railway **account or workspace token** in
  `/opt/data/.env` and a generic HTTP/GraphQL tool calls the public API at
  `https://backboard.railway.com/graphql/v2`. Fully scriptable, no browser. A bare token alone
  does not "connect" anything — you still need a tool that speaks the GraphQL API.
- **Path B — official remote MCP server (OAuth, interactive).** Railway-managed endpoint at
  `https://mcp.railway.com`, full permission enforcement and per-call consent. Requires a
  per-user browser OAuth flow; there is no static-token form. Wire it via `/hermes-mcp-add`.

Do everything autonomously. Stop only for the things a machine cannot do: the user must mint
the token in their browser (Path A) or complete the OAuth consent in a browser (Path B).

Verified facts (as of 2026-06):
- Public GraphQL API endpoint: `https://backboard.railway.com/graphql/v2` (first-party).
- Auth: account & workspace tokens use `Authorization: Bearer <token>`; **project tokens use a
  different header**, `Project-Access-Token: <token>` (NOT `Authorization: Bearer`).
- Token mint page: account/workspace tokens at `https://railway.com/account/tokens`; project
  tokens from the project's Settings → Tokens page.
- Remote MCP endpoint: `https://mcp.railway.com` — **OAuth-only**, static/project tokens rejected.

## Before you start — gather (ask once)

1. **Which path** — A (headless GraphQL, fully unattended, static token) or B (remote MCP,
   OAuth, an interactive browser consent is acceptable).
2. **Railway API token (Path A)** — the user creates an **account** or **workspace** token at
   **https://railway.com/account/tokens** ("Create Token", name it, copy it; shown once). Use a
   **workspace** token scoped to the relevant workspace for least privilege; use an **account**
   token only for personal/all-resource access. Treat the value as opaque.
   - Avoid **project** tokens unless the agent only ever touches one environment: they need the
     `Project-Access-Token` header instead of `Authorization: Bearer`, which a generic Bearer
     tool will not send.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Never paste any token into chat. Secrets go only in `/opt/data/.env` (chmod 600).

Set shell vars from answers:
```bash
AGENT=<container-name>      # docker ps --format '{{.Names}}' | grep hermes
TOKEN=<railway-token>       # never log or commit
```

---

## Path A — headless GraphQL API via a static token (recommended)

### Step 1 — sanity-check the token against the API (fast, no Hermes changes yet)

Confirm the token is live and authenticates before storing it. The `me` query is the cheapest
authenticated call.

```bash
curl -sS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query { me { name email } }"}'
```

- `{"data":{"me":{"name":...,"email":...}}}` → token works.
- `{"errors":[{"message":"Not Authorized"}]}` or `401` → bad, revoked, or wrong token type
  (e.g. a project token sent on the `Authorization` header — see Pitfalls).

List the projects the token can see (confirms scope):
```bash
curl -sS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query { projects { edges { node { id name } } } }"}'
```

### Step 2 — store the token for Hermes runtime (never config.yaml, never echo >>)

```bash
docker exec -i -u hermes "$AGENT" hermes config set RAILWAY_API_TOKEN '<railway-token>'
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

`hermes config set` writes to `/opt/data/.env` (the Hermes runtime env), not `config.yaml`.
`chmod 600` is mandatory — this file holds a bearer credential.

Verify it landed (prints the var name only, not the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^RAILWAY_API_TOKEN=' /opt/data/.env"
# Should print 1
```

### Step 3 — make the API callable by the agent

**Be honest: a token in `.env` does not by itself connect Railway to the agent.** It only makes
the credential available. To let the agent actually call Railway, point a generic HTTP/GraphQL
tool (or a thin MCP/skill) at this surface:

- Endpoint: `https://backboard.railway.com/graphql/v2`
- Header: `Authorization: Bearer $RAILWAY_API_TOKEN`
- Useful queries/mutations: `me`, `projects`, `project(id:)`, `variables(...)` (read service
  variables), `deploymentTriggerCreate` / `serviceInstanceRedeploy` (trigger deploys). The full
  schema is introspectable from the endpoint above and documented at
  https://docs.railway.com/integrations/api/graphql-overview.

If no generic GraphQL tool is available in the build, treat Path B (OAuth MCP) as the way to get
turnkey tools — Railway exposes no static-token MCP.

---

## Path B — official remote MCP server (OAuth, interactive)

The MCP host is **fixed by Railway** — do not run the `/hermes-mcp-add` probe matrix expecting a
bearer/path-token variant to authenticate; the remote server only completes auth through the
browser OAuth flow.

- Endpoint: `https://mcp.railway.com`

Run the **/hermes-mcp-add** skill — do not re-implement its body. Feed it:

```bash
NAME=railway                       # → env var MCP_RAILWAY_API_KEY (unused for pure OAuth)
URL=https://mcp.railway.com        # first-party Railway remote MCP endpoint
# auth: OAuth (browser). NOT a static bearer/header token.
```

OAuth specifics for this server:
- The user (or the host UI) must complete a **browser consent** and select which workspaces and
  projects the client may access. Tokens are **short-lived and revocable** from account settings.
- Because Hermes runs headless in a container, completing OAuth requires a host capable of the
  browser handoff. If the Hermes build/host cannot perform the OAuth dance, **fall back to
  Path A** — that is the only fully-unattended option.
- The `MCP_RAILWAY_API_KEY` env var that `/hermes-mcp-add` would seed is not the auth mechanism
  here (OAuth issues its own short-lived tokens); leave it as the placeholder, do not inject a
  Railway token into it.

Alternative for coding-agent hosts: Railway also offers a **local MCP** that runs through the
Railway CLI and reuses the CLI's login. That is not applicable to a containerized headless
Hermes agent without an interactive CLI login on the host; prefer Path A there.

---

## Pitfalls

- **The official MCP is OAuth-only.** `https://mcp.railway.com` rejects static and project
  tokens by design (it needs a user identity for billing/audit). Do not try to wire a Railway
  API token as a bearer header to it — it will not authenticate. Use Path A for static tokens.
- **Project tokens use a different header.** A **project** token must be sent as
  `Project-Access-Token: <token>`, NOT `Authorization: Bearer <token>`. A generic Bearer tool
  will get "Not Authorized" with a project token. Prefer account/workspace tokens for the
  Bearer-based GraphQL path.
- **`Not Authorized` is the catch-all error.** Railway returns "Not Authorized" for a bad token,
  a revoked token, the wrong header for the token type, or a query touching resources outside the
  token's scope. Re-check token type, header, and workspace scope before assuming the token is dead.
- **Token shown once.** If the user did not copy it at creation, they must regenerate — it cannot
  be recovered.
- **Workspace vs account scope.** An account token can touch everything across all workspaces;
  prefer a workspace token scoped to just the relevant workspace for least privilege.
- **A bare token does not connect anything.** Storing `RAILWAY_API_TOKEN` only makes the
  credential available; the agent still needs a tool/MCP that calls the GraphQL API (Path A) or
  the OAuth MCP (Path B).
- **Rate limits / destructive ops.** The API is rate-limited; have the agent back off on `429`
  rather than hammer. Deploys, redeploys, and deletes are destructive — gate them behind explicit
  user intent in the agent's soul/skills rather than letting it act freely.

---

## Verify

**Path A (GraphQL token):**
1. Token authenticates — the `me` query in Step 1 returns the user's name/email.
2. Scope is correct — the `projects` query returns the expected projects (or a valid empty edge
   list if the workspace has none).
3. Stored safely — `grep -c '^RAILWAY_API_TOKEN=' /opt/data/.env` prints `1` and the file is
   `chmod 600`.
4. End to end — once a GraphQL tool is wired, a chat call like
   `@<agent> list my Railway projects` returns real data (or a valid empty list).

**Path B (OAuth MCP):** after the OAuth consent and gateway reload,
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool.*railway|MCP server 'railway'" | tail -5
```
should show `MCP server 'railway' (HTTP): registered N tool(s): ...`, and a chat call
(`@<agent> using railway, list my projects`) returns data or a valid empty result.

---

## Definition of done

- [ ] **Path chosen and stated** to the user (A headless GraphQL token, or B OAuth MCP), with the
      OAuth-only caveat for B made explicit.
- [ ] **Token verified live** — the `me` query (Path A) or the OAuth consent (Path B) succeeds.
- [ ] **Secret stored correctly** — Path A: `RAILWAY_API_TOKEN` present only in `/opt/data/.env`
      (chmod 600), never in `config.yaml`, never in chat. Path B: no Railway token injected into
      `MCP_RAILWAY_API_KEY` (OAuth handles auth).
- [ ] **A real call returns data** — Path A via the wired GraphQL tool, or Path B via a chat tool
      call against the registered `railway` MCP.

See `reference/TROUBLESHOOTING.md` for gateway, env-reload, and MCP probe/OAuth failure modes.
