---
name: integration-asana
description: Connect Asana (team task management) to a running Hermes agent so it can read and create tasks, projects, and comments. Use when the user wants their Hermes agent to work with their Asana workspace.
---

# /integration-asana — connect Asana to Hermes

You are the engineer connecting Asana to a running Hermes agent. Asana is a project- and
task-management tool; once wired, the agent can list projects, read and create tasks, post
comments, and update status from chat.

Read the honest constraint first: Asana ships a **first-party remote MCP server, but it is
OAuth-only** (`https://mcp.asana.com/v2/mcp`, streamable HTTP). It requires a browser-based
authorization flow with a registered client ID/secret and has no static-bearer or
Personal-Access-Token mode. A headless Hermes container cannot complete that browser handshake
unattended, so it breaks the one-click, paste-a-token promise. This skill therefore wires Asana
via its **REST API using a Personal Access Token (PAT)** — a static credential that needs no
browser. If the user genuinely wants the OAuth MCP, that is a manual client-side setup outside
this skill (see Pitfalls).

## Before you start — gather (ask once)

1. **Asana Personal Access Token (PAT)** — the static credential. The user mints it at
   `https://app.asana.com/0/my-apps` → "Personal access tokens" → "Create new token", agrees to
   the API terms, names it (e.g. `hermes-agent`), and copies the value once. Treat tokens as
   opaque (Asana may change the format); store as a password. Default PATs are persistent
   (Enterprise+ admins can set expiry policies).
2. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers:
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<asana-pat>          # never log or commit; injected via sed below
```

---

## Step 1 — validate the PAT against the live REST API

The Asana REST base is `https://app.asana.com/api/1.0`; the PAT goes in
`Authorization: Bearer <token>`. Confirm the credential works before storing it.

```bash
curl -sS -o /dev/null -w "users/me = %{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  https://app.asana.com/api/1.0/users/me
```

- `200` → the token is valid; the body identifies the authenticated user and their workspaces.
- `401` → token is wrong, revoked, or pasted with stray whitespace.

Capture the workspace GID you will operate in (most calls need it):
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://app.asana.com/api/1.0/users/me?opt_fields=workspaces.name" | head -c 800
```

---

## Step 2 — write the PAT into the Hermes runtime env (no MCP server verified)

**No first-party static-token MCP server is verified as of 2026-06.** The official MCP V2 server
is OAuth-only, so we store the PAT for REST/tool use instead of running the /hermes-mcp-add
procedure.

Write the secret into `/opt/data/.env` inside the container using `hermes config set`, then
lock the file down. The secret never goes in `config.yaml` and never into chat.

```bash
docker exec -i -u hermes "$AGENT" \
  hermes config set ASANA_ACCESS_TOKEN "$TOKEN"

docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

If your Hermes build does not support `hermes config set` for arbitrary keys, fall back to the
safe sed-inject pattern from /hermes-mcp-add — append the key once, then set the value with `|`
as the sed delimiter (the PAT can contain `/`, `+`, `=`), and `chmod 600`. **Never use
`echo >>`** (it merges onto the previous line if that line lacks a trailing newline):

```bash
docker exec "$AGENT" sh -c '
  grep -q "^ASANA_ACCESS_TOKEN=" /opt/data/.env \
    || printf "\nASANA_ACCESS_TOKEN=\n" >> /opt/data/.env
'
docker exec "$AGENT" sh -c \
  "sed -i 's|^ASANA_ACCESS_TOKEN=.*|ASANA_ACCESS_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Confirm the key landed (prints the count, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^ASANA_ACCESS_TOKEN=' /opt/data/.env"   # should print 1
```

---

## Step 3 — give the agent a way to call the API, then reload the gateway

The PAT alone does not connect anything — the agent needs a tool that reads
`ASANA_ACCESS_TOKEN` and hits the REST API. Two honest options:

- **Option A — community remote MCP server.** No first-party static-token MCP exists. A widely
  used community server is `roychri/mcp-server-asana`
  (https://github.com/roychri/mcp-server-asana), which authenticates with an Asana PAT via the
  `ASANA_ACCESS_TOKEN` env var. It is a stdio/Node server, not a hosted HTTP endpoint, so it is
  not a drop-in for /hermes-mcp-add (which wires remote HTTP MCP). Use it only if you self-host
  it behind an HTTP transport and have vetted the code; treat it as third-party.
- **Option B — generic REST tool (recommended default).** Point a generic HTTP/tool action at
  the documented REST API. Base URL `https://app.asana.com/api/1.0`, auth header
  `Authorization: Bearer ${ASANA_ACCESS_TOKEN}`. Common endpoints: `GET /workspaces`,
  `GET /projects?workspace=<gid>`, `GET /tasks?assignee=me&workspace=<gid>`,
  `POST /tasks` with `{"data":{"workspace":"<gid>","name":"...","assignee":"me"}}`.

Reload the gateway so the new env is picked up (env is read once at startup; `restart` is not
reliably env-reload-clean in Hermes — use stop + run):

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

- **Official MCP is OAuth-only.** `https://mcp.asana.com/v2/mcp` needs a browser auth flow with
  a registered client ID/secret; a headless container cannot complete it. Do not configure it as
  a static-bearer MCP — the handshake will fail. (The V1 beta `https://mcp.asana.com/sse` is
  deprecated and shuts down 2026-05-11; do not use it.)
- **PAT acts as the whole user.** A Personal Access Token carries the full access of the human
  who created it across every workspace they belong to. There are no per-scope restrictions on a
  PAT. For least privilege, mint it from a dedicated service user with access only to the needed
  workspace/projects.
- **Token is opaque, no expiry guarantee.** Do not parse or pattern-match the token. PATs are
  persistent by default, but Enterprise+ admins can enforce expiry — a silently expired token
  shows up as `401`.
- **Rate limits.** Asana enforces per-token rate limits (free tier is lower than paid; a
  `429 Too Many Requests` includes a `Retry-After` header). Back off and retry; do not hammer.
- **Workspace GID required.** Most write endpoints (`POST /tasks`) fail without a `workspace`
  GID. Fetch it once in Step 1 and reuse it.
- **Two `.env` files.** The Hermes runtime secret belongs in `/opt/data/.env` (inside the
  container), not the host compose `.env`. Putting it in the wrong file means the agent never
  sees it.

## Verify

```bash
# 1. Secret present and locked down (value never printed)
docker exec "$AGENT" sh -c "grep -c '^ASANA_ACCESS_TOKEN=' /opt/data/.env"   # 1
docker exec "$AGENT" sh -c "ls -l /opt/data/.env"                            # -rw------- (600)

# 2. Live API call from inside the container using the stored token
docker exec -u hermes "$AGENT" sh -c '
  . /opt/data/.env
  curl -sS -o /dev/null -w "asana users/me = %{http_code}\n" \
    -H "Authorization: Bearer $ASANA_ACCESS_TOKEN" \
    https://app.asana.com/api/1.0/users/me
'   # expect 200
```

Then prove it end-to-end from chat:
```
@<agent> list my Asana tasks in <workspace>
```
A valid empty list is a pass — every layer worked. A `401`/`403` means the token did not land
(re-check Step 2); a `429` means rate-limited (back off).

## Definition of done

- [ ] PAT validated against `https://app.asana.com/api/1.0/users/me` (returns `200`).
- [ ] `ASANA_ACCESS_TOKEN` stored in `/opt/data/.env` with `chmod 600`; not in `config.yaml`, not in chat.
- [ ] Gateway reloaded with stop + run; container can read `$ASANA_ACCESS_TOKEN`.
- [ ] Agent returns real Asana data (tasks/projects) from a chat request, or a valid empty result.
- [ ] OAuth-only MCP caveat communicated to the user (no static-token first-party MCP as of 2026-06).

See `reference/TROUBLESHOOTING.md` for gateway reload and `.env` resolution failure modes.
