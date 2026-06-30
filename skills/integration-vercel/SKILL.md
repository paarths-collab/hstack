---
name: integration-vercel
description: Connect Vercel (frontend deploys + project/deployment management) to a running Hermes agent via the Vercel REST API and a static access token. Use when the user wants Hermes to trigger or inspect Vercel deployments, list projects, or read build/runtime logs.
---

# /integration-vercel — connect Vercel to Hermes

You are the engineer connecting Vercel to a running Hermes agent so it can trigger and inspect
frontend deployments, list projects, and read deployment logs. Work autonomously; stop only for
the one thing a machine cannot do: minting the access token in the Vercel dashboard.

Read the honest state of play before you start:

- **Vercel ships an official remote MCP server at `https://mcp.vercel.com`** (verified at
  https://vercel.com/docs/agent-resources/vercel-mcp, last updated 2026-06-11). It is **OAuth-only,
  read-only, and restricted to a Vercel-maintained allowlist of approved clients** (Claude Code,
  Claude.ai, ChatGPT, Cursor, VS Code, etc.). A self-hosted Hermes agent is **not** on that
  allowlist and there is **no static-token / bearer path** into it. So you cannot wire
  `https://mcp.vercel.com` through `/hermes-mcp-add` — it would never get past the OAuth consent
  + allowlist gate. Do not attempt it.
- **The supported path for Hermes is the Vercel REST API** (`https://api.vercel.com`) with a
  static Bearer access token. This keeps the one-click promise. That is what this skill does.

## Before you start — gather (ask once)

1. **Vercel access token** — the user mints it at **https://vercel.com/account/tokens**
   (Settings → Tokens on the Personal Account; make sure the top-left dropdown shows the Personal
   Account, not a Team). Click **Create Token**, name it `hermes-agent`, choose the scope (a
   specific Team if their projects live under a Team, otherwise Full Account), set an expiry if
   desired, and copy the value. The token is shown **once** and can never be retrieved again.
   Token form: an opaque ~24-char string (no fixed public prefix). Used as `Authorization: Bearer <token>`.
2. **Team ID or slug (if applicable)** — if the user's projects live under a Vercel Team, you need
   the team scope for every call (`?teamId=<id>` or `?slug=<slug>`). Personal-account projects need none.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (never echo `$TOKEN`):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<vercel-token>       # from https://vercel.com/account/tokens
TEAM=<team-id-or-slug>     # optional; leave empty for a personal account
```

## Step 1 — validate the token against the REST API (before storing anything)

Confirm the token works and is scoped correctly. The `/v2/user` endpoint is the cheapest check.

```bash
curl -sS -o /dev/null -w "user = %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  https://api.vercel.com/v2/user
```

- `200` → token is valid.
- `401 / 403` → token is wrong, expired, or lacks scope. Re-mint at the dashboard; do not store it.

Then confirm it can see the projects you expect (this is the read your agent will rely on):

```bash
# Personal account:
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v9/projects?limit=5"

# Team-scoped (append teamId or slug to EVERY call):
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v9/projects?limit=5&teamId=$TEAM"
```

An empty `{"projects":[]}` on a personal account is normal if all projects live under a Team —
that is the signal you need the `teamId`/`slug` scope on every request. Sort that out now, not later.

## Step 2 — write the token to the Hermes runtime `.env` (chmod 600)

No first-party MCP server is reachable for Hermes (see the note at the top), so the credential
lives in the Hermes runtime env file `/opt/data/.env` inside the container, written via
`hermes config set` so Hermes owns the file. The env var is `VERCEL_TOKEN`.

```bash
# Write the secret into the Hermes runtime env (NOT config.yaml, NOT the compose .env)
docker exec -i -u hermes "$AGENT" hermes config set VERCEL_TOKEN "$TOKEN"

# If the user's projects are under a Team, store the scope too:
docker exec -i -u hermes "$AGENT" hermes config set VERCEL_TEAM_ID "$TEAM"

# Lock the file down — it now holds a bearer credential
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

If `hermes config set` is unavailable in this build, inject directly with `sed`, mirroring the
`/hermes-mcp-add` pattern — **use `|` as the sed delimiter** (tokens can contain `/ + =`) and
**never `echo >>`** (it merges onto a line missing a trailing newline and corrupts the file):

```bash
docker exec "$AGENT" sh -c '
  touch /opt/data/.env
  if grep -q "^VERCEL_TOKEN=" /opt/data/.env; then
    sed -i "s|^VERCEL_TOKEN=.*|VERCEL_TOKEN='"$TOKEN"'|" /opt/data/.env
  else
    printf "VERCEL_TOKEN=%s\n" "'"$TOKEN"'" >> /opt/data/.env
  fi
  chmod 600 /opt/data/.env
'
```

Verify the var landed without printing its value:
```bash
docker exec "$AGENT" sh -c "grep -c '^VERCEL_TOKEN=' /opt/data/.env"   # should print 1
```

## Step 3 — reload the gateway so the new env is read

The gateway reads `.env` once at startup. Use **stop + run**, not `restart` (Hermes does not
always re-read env on `restart`):

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

## Step 4 — give the agent the REST calls it needs

There is **no first-party Vercel MCP server usable with a static token** as of 2026-06, so expose
Vercel to Hermes as REST calls the agent runs with `VERCEL_TOKEN`. The endpoints for the
"frontend deploys" use case (all on base `https://api.vercel.com`, all `Authorization: Bearer $VERCEL_TOKEN`):

| Action | Method + path | Notes |
|--------|---------------|-------|
| List projects | `GET /v9/projects` | append `?teamId=` / `?slug=` when team-scoped |
| List deployments | `GET /v6/deployments` | filter with `?projectId=` or `?app=<name>` |
| Get one deployment | `GET /v13/deployments/{idOrUrl}` | status, readyState, url |
| Create a deployment | `POST /v13/deployments` | a git-linked project can deploy by ref; non-git needs the file set in the body |
| Read build/runtime logs | `GET /v3/deployments/{id}/events` | follow build output |

Trigger a redeploy of the latest production deployment of a git-linked project (the common
"ship the frontend" path):

```bash
# 1. Find the project's latest deployment
DEP=$(curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.vercel.com/v6/deployments?app=<project-name>&limit=1&target=production${TEAM:+&teamId=$TEAM}" \
  | sed -n 's/.*"uid":"\([^"]*\)".*/\1/p' | head -1)

# 2. Create a new deployment that redeploys it
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.vercel.com/v13/deployments?${TEAM:+teamId=$TEAM}" \
  -d "{\"name\":\"<project-name>\",\"deploymentId\":\"$DEP\",\"target\":\"production\"}"
```

If the project is **not** git-linked, `POST /v13/deployments` requires the full file manifest in the
body — that is a heavier flow; prefer git-linked projects so a redeploy is one ID reference.
Confirm the exact create-deployment body shape at
https://vercel.com/docs/rest-api/deployments/create-a-new-deployment before relying on it.

## Pitfalls

- **The official MCP is OAuth-only and allowlisted — it is a dead end for Hermes.** Do not waste a
  cycle pointing `/hermes-mcp-add` at `https://mcp.vercel.com`; a self-hosted agent is not an
  approved client and there is no bearer path. The MCP is also read-only, so even allowlisted
  clients cannot create deployments through it. The REST API is the only way to *trigger* deploys.
- **Team scope is silent.** A valid personal-account token returns `200` and an **empty** project
  list when the projects live under a Team. You will think auth failed when it is just unscoped.
  Always confirm with Step 1's project list and carry `teamId`/`slug` on every call.
- **The token is shown once.** If it is lost, it cannot be retrieved — re-mint. Never paste it into
  chat or `config.yaml`. If it is ever exposed, revoke it immediately at
  https://vercel.com/account/tokens (Vercel also auto-revokes tokens it detects as leaked).
- **Token expiry.** If the user set an `expiresAt`, calls start returning `403` after that date with
  no other warning. A non-expiring token trades convenience for risk; recommend an expiry plus a
  rotation reminder.
- **Rate limits.** The REST API is rate-limited per token; a tight polling loop on
  `/v6/deployments` will hit `429`. Poll deployment status on an interval (a few seconds), not in a
  hot loop.

## Verify

```bash
# Token reachable from inside the container with the stored env:
docker exec -u hermes "$AGENT" sh -c \
  'curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $VERCEL_TOKEN" https://api.vercel.com/v2/user'
# Expect 200

# Real data: list projects through the stored token
docker exec -u hermes "$AGENT" sh -c \
  'curl -sS -H "Authorization: Bearer $VERCEL_TOKEN" "https://api.vercel.com/v9/projects?limit=3${VERCEL_TEAM_ID:+&teamId=$VERCEL_TEAM_ID}"'
```

Then, from the chat interface, ask the agent for a real read:
```
@<agent> list my Vercel projects and the status of the latest deployment
```
A populated project list (or a valid empty `{"projects":[]}` with correct scoping) is a pass. A
`401`/`403` means the token or team scope is wrong — re-check Step 1.

## Definition of done

- [ ] Token validated against `https://api.vercel.com/v2/user` (`200`) before being stored.
- [ ] `VERCEL_TOKEN` (and `VERCEL_TEAM_ID` if team-scoped) is in `/opt/data/.env`, `chmod 600`, and **not** in `config.yaml` or chat.
- [ ] Gateway reloaded via `gateway stop` + `gateway run`; the container can reach the API with the stored env.
- [ ] A real REST read returns project/deployment data (or a correctly-scoped empty set).
- [ ] User told plainly: the official `https://mcp.vercel.com` MCP is OAuth-only/read-only/allowlisted and is not wired here; Hermes uses the REST API for deploys.

See `reference/TROUBLESHOOTING.md` for gateway reload and `.env` injection failure modes.
