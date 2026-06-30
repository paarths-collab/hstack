---
name: integration-github
description: Connect GitHub (code, issues, PRs, CI) to a running Hermes agent via GitHub's first-party remote MCP server. Use when the user wants their Hermes agent to read and act on repos, issues, pull requests, and Actions.
---

# /integration-github — connect GitHub to Hermes

You are the engineer connecting GitHub to a running Hermes agent. GitHub ships a first-party
**remote** MCP server, so the happy path is to wire that server in with the standard
`/hermes-mcp-add` procedure — no local process, no extra container. Do everything autonomously;
stop only for the one thing a machine cannot do: minting the user's personal access token.

GitHub's remote MCP server (verified 2026-06) is hosted at:

```
https://api.githubcopilot.com/mcp/
```

Auth shape: `Authorization: Bearer <token>` (a static GitHub PAT, OR one-click OAuth in clients
that support it). For a headless Hermes agent we use the PAT — it keeps the one-click,
no-browser promise. Source: https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server

## Before you start — gather (ask once)

1. **GitHub personal access token (PAT)** — the credential the MCP server authenticates with.
   The user mints it; a machine cannot. Two valid forms:
   - **Fine-grained PAT** (recommended): https://github.com/settings/personal-access-tokens/new
     Scope it to the specific repos/org and grant the permissions you need:
     Repository → Contents, Issues, Pull requests, Actions (read/write as needed);
     Metadata is mandatory and added automatically.
   - **Classic PAT**: https://github.com/settings/tokens/new — `repo` scope (and `workflow`
     if the agent triggers/edits Actions). Broader than fine-grained; prefer fine-grained.

   The MCP server inherits exactly the scopes/permissions on the PAT, subject to any org PAT
   policy. Token format: fine-grained tokens start with `github_pat_`, classic with `ghp_`.

2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (do not log the token):

```bash
AGENT=<container-name>                    # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://api.githubcopilot.com/mcp/    # GitHub remote MCP base
NAME=github                               # env var becomes MCP_GITHUB_API_KEY
TOKEN=<github-pat>                        # github_pat_... or ghp_...; never commit
```

---

## Step 1 — wire it with /hermes-mcp-add

This is a standard remote HTTP MCP server with bearer auth, so run the **`/hermes-mcp-add`**
procedure against it rather than reinventing the wiring. Feed it:

- **URL**: `https://api.githubcopilot.com/mcp/`
- **Name**: `github`  → env var `MCP_GITHUB_API_KEY`
- **Auth**: header `Authorization: Bearer ${MCP_GITHUB_API_KEY}`

`/hermes-mcp-add` will probe the endpoint, register the server with a placeholder, inject the
real token into `/opt/data/.env` via `sed` (with the `|` delimiter), `chmod 600` it, and reload
the gateway with `gateway stop` + `gateway run`. Do not echo the token into any file.

If you are running this inline, the load-bearing commands are:

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"   # -> MCP_GITHUB_API_KEY

# Register with a placeholder token (real value injected next, safely)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" hermes mcp add "$NAME" --url "$URL" --auth header

# Inject the real token straight into the Hermes runtime .env ( | delimiter; tokens vary )
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# Reload so the gateway re-reads .env (restart does not reliably re-read env)
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

The resulting `config.yaml` block should read (token stays out of it):

```yaml
github:
  url: https://api.githubcopilot.com/mcp/
  headers:
    Authorization: Bearer ${MCP_GITHUB_API_KEY}
  enabled: true
```

---

## Step 2 — (optional) scope down the toolset

The full GitHub MCP server exposes a large toolset (repos, issues, PRs, Actions, code scanning,
notifications, and more). If you want fewer tools, the server supports read-only and toolset
selection via the `X-MCP-Readonly` and `X-MCP-Toolsets` request headers. Add them alongside
`Authorization` in the `config.yaml` headers block, e.g. `X-MCP-Readonly: true` for a read-only
agent, or `X-MCP-Toolsets: repos,issues,pull_requests` to limit surface. Reload the gateway
after editing. Leave defaults if unsure.

---

## Pitfalls

- **PAT scopes are the ceiling.** The MCP server can only do what the token allows. A
  fine-grained PAT with no repo selected, or missing the Issues/Pull requests permission, yields
  "tools registered" but every call returns 403/404. Match permissions to the use case before
  blaming the wiring.
- **Org PAT policy can silently block it.** If the target org restricts/forbids PATs (or requires
  approval for fine-grained tokens), the token returns 401/403 until an org owner approves it.
  This is org config, not a Hermes bug.
- **Fine-grained PATs are org/owner-scoped.** A fine-grained token only reaches repos under the
  owner you selected at creation. To touch repos across multiple orgs/users you need multiple
  tokens or a classic PAT.
- **Token expiry.** Fine-grained PATs expire (max ~1 year, often less). When calls start failing
  with 401 after working fine, the token expired — mint a new one and re-run Step 1's inject +
  reload. Classic tokens can be set non-expiring but that is worse hygiene.
- **OAuth is the other path, not required here.** GitHub's server also supports one-click OAuth,
  but that needs an interactive browser flow a headless agent cannot complete. Stay on the PAT
  path for Hermes.
- **Enterprise hosts differ.** For GitHub Enterprise Cloud with data residency the URL is
  `https://copilot-api.<subdomain>.ghe.com/mcp`, not the public endpoint. Only use that if the
  user is on `ghe.com`.
- **Rate limits apply.** Calls count against the token's GitHub REST/GraphQL rate limits
  (5,000 req/hr for authenticated users; lower for some resources). A burst of agent activity can
  hit them; back off rather than retrying in a tight loop.

## Verify

Tools registered:

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool.*'github'|MCP server 'github'" | tail -5
```

Live call (proves the token actually authenticates), from the chat interface:

```
@<agent> using github, list the open issues on <owner>/<repo>
```

A real list (or a valid empty result) is a pass. "Bad credentials" / 401 means the token did not
land or is wrong-scoped — re-check Step 1's inject and the PAT permissions. You can also confirm
the token independently before wiring:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" https://api.github.com/user | grep -o '"login":[^,]*'
```

A `"login": "<you>"` line confirms the PAT is valid; `Bad credentials` means re-mint it.

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for the `github` MCP server.
- [ ] The PAT lives only in `/opt/data/.env` as `MCP_GITHUB_API_KEY`, `chmod 600`; `config.yaml`
      shows only the `${MCP_GITHUB_API_KEY}` placeholder.
- [ ] `curl https://api.github.com/user` with the token returns the expected login.
- [ ] A real GitHub call from chat (list issues/PRs on a repo) returns data or a valid empty set.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
