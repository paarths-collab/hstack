---
name: integration-netlify
description: Connect Netlify (static/frontend deploys, site + deploy management) to a running Hermes agent using the official @netlify/mcp server with a Personal Access Token. Use when the user wants their agent to create sites, trigger deploys, or read deploy status on Netlify.
---

# /integration-netlify — connect Netlify to Hermes

You are the engineer connecting Netlify to a running Hermes agent so it can manage sites and
trigger frontend/static deploys. Do everything autonomously; stop only for the one thing a
machine cannot do: minting the Netlify Personal Access Token (PAT) in the dashboard.

Netlify ships an official MCP server (`@netlify/mcp`, repo `netlify/netlify-mcp`). There are two
ways to reach it, and the choice matters for a headless server:

- **Remote MCP** at `https://netlify-mcp.netlify.app/mcp` authenticates via **OAuth (browser
  sign-in) by default.** A headless Hermes container has no browser, so the OAuth handshake
  cannot complete there. Do not wire the remote URL expecting a token header to "just work" —
  Netlify documents the PAT only as a fallback env var on the local server, not as a remote
  header.
- **Local stdio MCP** (`npx -y @netlify/mcp`) takes a `NETLIFY_PERSONAL_ACCESS_TOKEN` env var.
  This is the token-based, headless-friendly path and the one this skill uses.

## Before you start — gather (ask once)

1. **Netlify Personal Access Token (PAT)** — mint it in the dashboard:
   user icon -> **User settings** -> **OAuth** -> **Personal access tokens** ->
   **New access token**. Give it a name, set an expiration, generate, copy immediately (the
   value is shown once). Direct URL: https://app.netlify.com/user/applications#personal-access-tokens
   Docs: https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/
   The token is account-scoped (it inherits your full account access — there are no per-token
   scopes), so treat it like a password.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.
3. **Node 22+ inside the container** — the official MCP server requires it. Confirm with
   `docker exec -u hermes "$AGENT" node --version` before relying on the stdio server.

Set shell vars from the answers:
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<netlify-pat>            # never log this; injected via sed in step 2
NAME=netlify                  # MCP name in Hermes -> env var MCP_NETLIFY_API_KEY
```

---

## Step 1 — sanity-check the token against the Netlify REST API

Before wiring anything into Hermes, prove the PAT is valid. The REST API base is
`https://api.netlify.com/api/v1/` and auth is a bearer header.

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "User-Agent: hermes-agent (ops)" \
  https://api.netlify.com/api/v1/sites
```

- `200` -> token is valid; the body is the JSON array of sites you can manage.
- `401` -> token is wrong, expired, or was invalidated (a password reset invalidates all PATs).

---

## Step 2 — write the PAT to the Hermes runtime .env (chmod 600)

The secret lives in `/opt/data/.env` inside the container, never in `config.yaml` and never in
chat. Append the var with the Hermes config helper, then overwrite the value with `sed` so the
token never rides through an interactive prompt that could mangle `/ + =` characters.

```bash
# Create/seed the key with a placeholder via the config helper
docker exec -u hermes "$AGENT" hermes config set NETLIFY_PERSONAL_ACCESS_TOKEN placeholder

# Inject the real value with | as the sed delimiter (tokens contain / + =)
docker exec "$AGENT" sh -c \
  "sed -i 's|^NETLIFY_PERSONAL_ACCESS_TOKEN=.*|NETLIFY_PERSONAL_ACCESS_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"

# Confirm exactly one line, without printing the value
docker exec "$AGENT" sh -c "grep -c '^NETLIFY_PERSONAL_ACCESS_TOKEN=' /opt/data/.env"
# -> 1
```

If `hermes config set` is not available in this build, fall back to the mcp-add sed pattern:
seed the line once with `printf 'NETLIFY_PERSONAL_ACCESS_TOKEN=placeholder\n' >> /opt/data/.env`
**only if the key does not already exist** (`grep -q` first), then run the same `sed` overwrite.
Never use a bare `echo >>` that can glue onto a line missing a trailing newline.

---

## Step 3 — register the official Netlify MCP server (stdio, token from env)

This is the happy path: run the official `@netlify/mcp` server as a stdio MCP, passing the PAT
through the env var it reads. The base wiring procedure is `/hermes-mcp-add`; this is the stdio
variant of it, so the register call differs from the HTTP probe matrix.

```bash
# Register a stdio (command) MCP that launches the official Netlify server.
# The NETLIFY_PERSONAL_ACCESS_TOKEN from /opt/data/.env is passed into the child process.
docker exec -u hermes "$AGENT" \
  hermes mcp add "$NAME" \
    --command "npx" \
    --args "-y,@netlify/mcp" \
    --env "NETLIFY_PERSONAL_ACCESS_TOKEN=\${NETLIFY_PERSONAL_ACCESS_TOKEN}"
```

The resulting `config.yaml` block should reference the env var, not the literal token:
```yaml
netlify:
  command: npx
  args: ["-y", "@netlify/mcp"]
  env:
    NETLIFY_PERSONAL_ACCESS_TOKEN: ${NETLIFY_PERSONAL_ACCESS_TOKEN}
  enabled: true
```

If this Hermes build only supports HTTP MCP servers (no stdio `--command`), do not fall back to
the OAuth-gated remote URL on a headless box. Instead skip to Step 5 (REST API option) and tell
the user the agent will call Netlify over REST rather than via MCP tools.

---

## Step 4 — reload the gateway and verify tools registered

The gateway reads env and MCP config at startup. Use stop + run, not `restart` (env changes are
not always re-read by the running process).

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 10   # first npx run may download @netlify/mcp; allow extra time

docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server.*netlify" | tail -5
```

Success looks like a line such as:
```
INFO tools.mcp_tool: MCP server 'netlify' (stdio): registered N tool(s): mcp_netlify_...
```

Then trigger a real call from the chat interface:
```
@<agent> using netlify, list my sites
```
An empty-but-valid list is a pass. "401" or "unauthorized" means the token did not land — re-check Step 2.

---

## Step 5 — fallback: no MCP available, drive the REST API directly

If stdio MCP is unsupported in this build (and the remote MCP is OAuth-only, so unusable
headless), the honest connection is the REST API. The PAT from Step 2 is already in
`/opt/data/.env`. A skill or generic HTTP tool can then call:

- Base URL: `https://api.netlify.com/api/v1/`
- Auth header: `Authorization: Bearer ${NETLIFY_PERSONAL_ACCESS_TOKEN}`
- List sites: `GET /sites` ; trigger a build: `POST /sites/{site_id}/builds`

Do not claim the agent is "connected via MCP" in this case — it is calling REST with the stored
token. State that plainly to the user.

> Status note (verify when revisiting): a first-party MCP server exists
> (`@netlify/mcp`, remote at `https://netlify-mcp.netlify.app/mcp`), but the remote endpoint is
> OAuth-first and not headless-friendly as of 2026-06. The token path here uses the official
> stdio server, falling back to the REST API.

---

## Pitfalls

- **Remote MCP is OAuth, not token-by-header.** `https://netlify-mcp.netlify.app/mcp` expects a
  browser OAuth sign-in. Pointing a headless agent at it and hoping a Bearer header authenticates
  will fail. Use the stdio server with the PAT env var, or REST.
- **PATs have no scopes.** A Netlify PAT inherits your entire account access. There is no
  read-only or per-site narrowing. Mint a dedicated token with an expiration and rotate it.
- **Password reset nukes all tokens.** Resetting the Netlify password permanently invalidates
  every PAT and OAuth token issued before the reset. After any reset, re-mint and re-run Step 2.
- **Node version.** `@netlify/mcp` needs Node 22+. On an older runtime the stdio server exits
  immediately and you will see no registered tools — check `node --version` first.
- **First run is slow.** `npx -y @netlify/mcp` downloads the package on first launch; give the
  gateway extra time (Step 4) before concluding registration failed.
- **For public/multi-user integrations Netlify mandates OAuth2**, not PATs. PATs are for your own
  account's automation only.

## Verify

- [ ] `curl ... /api/v1/sites` with the PAT returns `200` (Step 1).
- [ ] `grep -c '^NETLIFY_PERSONAL_ACCESS_TOKEN=' /opt/data/.env` returns `1` and the file is `chmod 600`.
- [ ] `hermes logs` shows `registered N tool(s)` for `netlify` (MCP path), or the REST fallback is documented to the user.
- [ ] A real chat call ("list my sites") returns data or a valid empty list.

## Definition of done

- [ ] Netlify PAT minted, validated against the REST API, and stored only in `/opt/data/.env` (`chmod 600`).
- [ ] Token does not appear in `config.yaml` or chat — only `${NETLIFY_PERSONAL_ACCESS_TOKEN}` is referenced.
- [ ] Official `@netlify/mcp` stdio server registered and tools visible in `hermes logs` (or REST fallback explicitly chosen and explained).
- [ ] A real Netlify call from the agent returns data.
- [ ] User told that the remote MCP is OAuth-only and this setup uses the token-based stdio/REST path.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
