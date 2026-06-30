---
name: integration-gitlab
description: Connect GitLab (repos, MRs, issues, CI/CD pipelines) to a running Hermes agent. Use when the user wants their agent to read or act on GitLab projects on GitLab.com, self-managed, or Dedicated.
---

# /integration-gitlab — connect GitLab to Hermes

You are the engineer connecting GitLab to a running Hermes agent so it can read and act on
repositories, merge requests, issues, and CI/CD pipelines. Work autonomously; stop only for
the things a machine cannot do: minting the token in the GitLab UI and choosing scopes.

GitLab has two MCP realities, and you must be honest about which one applies:

- The **official GitLab MCP server** (`/api/v4/mcp`, GitLab 18.6+) is **OAuth-only** (Dynamic
  Client Registration). It needs GitLab Duo plus beta/experimental features enabled, and it
  cannot be driven by a static token. That breaks the one-click promise, so it is the
  **alternative path** here, not the default.
- The **one-click path** is a self-hosted community MCP server (`@zereight/mcp-gitlab`) that
  authenticates with a static **personal access token** and exposes a remote HTTP endpoint you
  then wire in with `/hermes-mcp-add`.

Pick the path with the user. Default to the static-token community MCP unless they specifically
want first-party OAuth.

## Before you start — gather (ask once)

1. **GitLab base URL** — `https://gitlab.com` for SaaS, or the self-managed/Dedicated host.
   The REST API base is `<base>/api/v4`.
2. **Personal access token (PAT)** — the credential. The user mints it at:
   - GitLab.com: `https://gitlab.com/-/user_settings/personal_access_tokens`
   - Self-managed: `<base>/-/user_settings/personal_access_tokens`
   - UI path: avatar -> Edit profile -> Access -> Personal access tokens -> Add new token.
   Token format is `glpat-...`. Choose the **smallest** scope that fits:
   - `read_api` — read-only (browse MRs, issues, pipelines). Prefer this for reporting agents.
   - `api` — full read/write (create MRs, comment, trigger pipelines). Only if the agent acts.
   Set a short expiry; the agent inherits the token owner's permissions.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers:
```bash
AGENT=<container-name>                 # e.g. hermes-agent-mxlc-hermes-agent-1
GITLAB_BASE=<base-url>                 # e.g. https://gitlab.com
GITLAB_API="$GITLAB_BASE/api/v4"
TOKEN=<glpat-token>                    # never log; never commit; placeholder-inject only
```

---

## Step 1 — validate the token against the REST API first

Never wire an MCP around a token you have not proven works. One curl confirms the token, base
URL, and scope in a single shot. GitLab accepts the `PRIVATE-TOKEN` header (recommended) or
`Authorization: Bearer`.

```bash
curl -sS -o /tmp/gl_user -w "user = %{http_code}\n" \
  -H "PRIVATE-TOKEN: $TOKEN" "$GITLAB_API/user"

curl -sS -o /tmp/gl_proj -w "projects = %{http_code}\n" \
  -H "PRIVATE-TOKEN: $TOKEN" "$GITLAB_API/projects?membership=true&per_page=1"
```

- `200` on `/user` -> token and base URL are correct.
- `401` -> bad/expired token or wrong base URL.
- `403` on a write later -> scope too low (`read_api` cannot write); re-mint with `api`.

Confirm the identity without printing the token:
```bash
grep -o '"username":"[^"]*"' /tmp/gl_user
```

---

## Step 2 — choose your path

### Path A (default, one-click) — self-hosted community MCP via static token

`@zereight/mcp-gitlab` is a widely used community GitLab MCP server. It authenticates with a
static PAT and can expose a remote streamable-HTTP endpoint, which is exactly what
`/hermes-mcp-add` consumes. **No first-party static-token MCP server is verified as of
2026-06** — this is a clearly-maintained community server, named and cited, not a fabrication.

Run it as a small sidecar reachable over HTTP, then register it in Hermes.

```bash
# Run the MCP server in remote HTTP mode (sidecar on the host or compose service).
# It listens on :3000 by default; put it behind your own TLS/reverse proxy for a public URL.
docker run -d --name gitlab-mcp \
  -e GITLAB_PERSONAL_ACCESS_TOKEN="$TOKEN" \
  -e GITLAB_API_URL="$GITLAB_API" \
  -e STREAMABLE_HTTP=true \
  -p 3000:3000 \
  node:20-alpine \
  npx -y @zereight/mcp-gitlab@2.1.28
```

Pin the exact version (`@2.1.28` above is verified-present; bump only after re-checking the
package page). Set `GITLAB_READ_ONLY_MODE=true` on the sidecar if the PAT is `read_api` so the
server refuses writes that would 403 anyway.

Then wire the endpoint into Hermes by running **/hermes-mcp-add** with:
- MCP base URL: the sidecar's HTTP endpoint, e.g. `https://<your-host>/mcp` (or
  `http://gitlab-mcp:3000/mcp` if Hermes shares the compose network).
- Name: `gitlab` -> Hermes generates env var `MCP_GITLAB_API_KEY`.
- Auth shape: this sidecar holds the GitLab PAT itself, so the Hermes-side endpoint usually
  needs **no extra bearer**. If you front it with a gateway that requires one, use
  `--auth header` / `Authorization: Bearer` and let /hermes-mcp-add inject `MCP_GITLAB_API_KEY`
  via the `sed`-with-`|`-delimiter trick. Do not invent auth the sidecar does not enforce —
  run the /hermes-mcp-add probe matrix to find the real shape.

Do not copy the /hermes-mcp-add body here. Run that skill; it owns probe -> register
(placeholder) -> inject -> `gateway stop` + `gateway run` -> verify-in-logs.

### Path B (alternative) — official GitLab MCP server (OAuth only)

The first-party server lives at `<base>/api/v4/mcp` (HTTP transport, GitLab 18.6+) and is
available on GitLab.com, Self-Managed, and Dedicated. It is **OAuth 2.0 Dynamic Client
Registration only** — there is no static-token mode, so it does not fit the one-click flow and
needs a human to complete the browser consent. Use it only if the user wants first-party and
accepts the OAuth handoff.

Prerequisites the admin must enable first: **GitLab Duo** and **beta and experimental
features** on the instance. Then point an OAuth-capable MCP client at `<base>/api/v4/mcp`; the
client performs Dynamic Client Registration and the user approves the app in the browser. The
resulting OAuth access token (not a PAT) is what authorizes calls. Hermes' generic header-auth
MCP wiring cannot mint or refresh that token, so this path is hands-on.

### Path C (fallback) — store the PAT and use the REST API directly

If neither MCP fits, persist the validated PAT into the Hermes runtime env and let a generic
HTTP tool/skill call `<base>/api/v4`. Write it with `hermes config set` (never `echo >>`,
never `config.yaml`, never chat):

```bash
docker exec -u hermes "$AGENT" hermes config set GITLAB_TOKEN "$TOKEN"
docker exec -u hermes "$AGENT" hermes config set GITLAB_API_URL "$GITLAB_API"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Then any tool can call, e.g. `GET $GITLAB_API/projects/:id/merge_requests` with the
`PRIVATE-TOKEN` header. A stored key alone does **not** connect GitLab — it is only useful once
a tool or skill actually issues the REST calls.

---

## Pitfalls

- **Official MCP is OAuth-only.** No static-token mode on `/api/v4/mcp`. If a user hands you a
  `glpat-` token expecting the first-party server to accept it, it will not. Use Path A or C.
- **Scope mismatch -> silent 403 on writes.** `read_api` lets the agent browse but every
  create/comment/trigger returns 403. If the agent must act, mint with `api`. Set the sidecar
  to `GITLAB_READ_ONLY_MODE=true` when the token is read-only so failures are explicit.
- **Wrong API base.** The base must end in `/api/v4`. A self-managed host on a subpath
  (`https://host/gitlab`) needs `https://host/gitlab/api/v4`. A 404 on `/user` usually means a
  missing or wrong `/api/v4` suffix.
- **Token = the owner's blast radius.** A PAT inherits the creator's full membership and
  permissions across every group and project. Create it from a dedicated bot/service account,
  not a human admin, and set an expiry.
- **Rate limits.** GitLab.com enforces per-token request limits; a chatty agent can get `429`.
  Honor `Retry-After`. Self-managed limits are admin-configured and may differ.
- **Pin the community MCP version.** `npx -y @zereight/mcp-gitlab` without a tag pulls latest
  and can change tool surface or behavior between runs. Pin and bump deliberately.
- **OAuth tokens expire/refresh; Hermes header-auth cannot refresh them.** Path B is not
  set-and-forget through the generic MCP wiring.

---

## Verify

1. **REST proof (always):** Step 1 returns `200` on `/user` and your username.
2. **Path A — tools registered:** after /hermes-mcp-add reloads the gateway,
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*gitlab|MCP server .gitlab" | tail -5
   ```
   should show `registered N tool(s)` for `gitlab`.
3. **Live call:** from chat, `@<agent> using gitlab, list my open merge requests`. Real data
   or a valid empty result (`[]`) is a pass. "Bearer token missing" or a tool error means the
   token did not land — recheck the /hermes-mcp-add inject step.
4. **Path C:** a tool/skill call to `$GITLAB_API/projects?membership=true` returns project JSON.

---

## Definition of done

- [ ] PAT validated against `$GITLAB_API/user` (HTTP 200) before any wiring.
- [ ] Credential lives only in `/opt/data/.env` (via /hermes-mcp-add inject or `hermes config set`), `chmod 600`; never in `config.yaml` or chat.
- [ ] Chosen path is honest: Path A (community static-token MCP, cited) wired via /hermes-mcp-add, or Path B (OAuth) acknowledged as hands-on, or Path C (REST fallback) documented.
- [ ] `hermes logs` shows GitLab tools registered (Path A), or a REST call returns data (Path C).
- [ ] Token scope matches intent (`read_api` for read-only, `api` for write); read-only sidecar set to `GITLAB_READ_ONLY_MODE=true`.

See `reference/TROUBLESHOOTING.md` for gateway reload, env-file, and MCP registration failure modes.
