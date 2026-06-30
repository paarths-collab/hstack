---
name: integration-trello
description: Connect Trello (boards, lists, cards) to a running Hermes agent for simple kanban automation using a static API key + user token. Use when the user wants their agent to read or update Trello boards.
---

# /integration-trello — connect Trello to a Hermes agent

You are the engineer connecting Trello to a running Hermes agent so it can read and update
boards, lists, and cards (simple kanban). Trello has **no first-party remote MCP server**, so
you will store a static API key + user token in the agent's runtime `.env` and expose the REST
API base + auth so a generic MCP/tool layer can call it. Do everything autonomously; stop only
for the two things a machine cannot mint: the API key and the user token.

## Before you start — gather (ask once)

1. **Trello API key** — the user generates this at https://trello.com/power-ups/admin
   (open or create a Power-Up, go to the **API key** tab, **Generate a new API Key**). The key
   is a 32-char hex string. It is low-sensitivity but still treat it as a secret.
2. **Trello user token** — from the API key page, click the **Token** link, or build the URL
   yourself and have the user open it in a browser:
   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=<API_KEY>&name=Hermes%20Agent
   ```
   They review the scopes, click **Allow**, and paste back the token (a ~64+ char hex string).
   The token grants access to the user's whole account — never log it, never put it in chat.
3. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (do not echo TOKEN):
```bash
AGENT=<container-name>      # e.g. hermes-agent-mxlc-hermes-agent-1
KEY=<trello-api-key>        # 32-char hex
TOKEN=<trello-user-token>   # never log this
```

---

## Step 1 — verify the credentials work against the live API

The base URL is `https://api.trello.com/1`. Auth goes in query params `key=` and `token=`.
Confirm both before writing anything to the agent:

```bash
curl -sS "https://api.trello.com/1/members/me?key=${KEY}&token=${TOKEN}" \
  | head -c 400; echo
```

- A JSON object with your `id`, `username`, `fullName` → both credentials are valid.
- `invalid key` → the API key is wrong.
- `invalid token` / `unauthorized token permissions` → token wrong or missing the scope.

List the boards the agent will be able to see (sanity check the token's reach):
```bash
curl -sS "https://api.trello.com/1/members/me/boards?fields=name,id,url&key=${KEY}&token=${TOKEN}"
```

---

## Step 2 — write both credentials to the agent's runtime `.env`

Use `hermes config set` so the values land in `/opt/data/.env` (the Hermes runtime env file),
never in `config.yaml` and never in chat. Run inside the container as the `hermes` user:

```bash
docker exec -i -u hermes "$AGENT" hermes config set TRELLO_API_KEY "$KEY"
docker exec -i -u hermes "$AGENT" hermes config set TRELLO_TOKEN  "$TOKEN"
```

If your Hermes build lacks `config set` for arbitrary keys, write them directly with the
mcp-add `sed` pattern (use `|` as the delimiter — tokens are hex but stay consistent):
```bash
docker exec "$AGENT" sh -c '
  touch /opt/data/.env
  grep -q "^TRELLO_API_KEY=" /opt/data/.env \
    && sed -i "s|^TRELLO_API_KEY=.*|TRELLO_API_KEY='"$KEY"'|" /opt/data/.env \
    || printf "TRELLO_API_KEY=%s\n" "'"$KEY"'" >> /opt/data/.env
  grep -q "^TRELLO_TOKEN=" /opt/data/.env \
    && sed -i "s|^TRELLO_TOKEN=.*|TRELLO_TOKEN='"$TOKEN"'|" /opt/data/.env \
    || printf "TRELLO_TOKEN=%s\n" "'"$TOKEN"'" >> /opt/data/.env
'
```

Lock the file down (mandatory — it now holds account-level credentials):
```bash
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^TRELLO_TOKEN=' /opt/data/.env"   # should print 1
```

---

## Step 3 — connect it (no first-party MCP — choose one honest path)

**No first-party MCP server is verified for Trello as of 2026-06.** The official Atlassian
Remote MCP Server (https://github.com/atlassian/atlassian-mcp-server) covers Jira, Confluence,
JSM, Bitbucket, and Compass — **not Trello**. A static key + token in `.env` does not connect
anything on its own; you must give the agent a way to call the API. Pick one:

**Option A — community local (stdio) MCP server.** The actively maintained
`@delorenj/mcp-server-trello` (https://github.com/delorenj/mcp-server-trello) runs over
**stdio**, not HTTP, so it is wired as a local command MCP, not via `/hermes-mcp-add` (that
procedure is HTTP-only). It reads `TRELLO_API_KEY` and `TRELLO_TOKEN` from the environment —
the exact vars you set in step 2. Register it as a stdio MCP that runs `bunx
@delorenj/mcp-server-trello` with those two env vars passed through. Vet the source before
enabling write scope; it is community-maintained, not first-party.

**Option B — generic REST tool.** Point the agent's HTTP/tool layer at base
`https://api.trello.com/1`, appending `key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}` to every
request. Common simple-kanban calls:
```bash
# list cards on a list
curl -sS "https://api.trello.com/1/lists/<LIST_ID>/cards?key=${KEY}&token=${TOKEN}"
# create a card
curl -sS -X POST "https://api.trello.com/1/cards?idList=<LIST_ID>&name=<TITLE>&key=${KEY}&token=${TOKEN}"
# move a card to another list
curl -sS -X PUT "https://api.trello.com/1/cards/<CARD_ID>?idList=<NEW_LIST_ID>&key=${KEY}&token=${TOKEN}"
```

If a maintained **remote HTTP** Trello MCP later appears and you verify it, prefer wiring it via
`/hermes-mcp-add` with auth shape from its docs and a `MCP_TRELLO_API_KEY` env var.

---

## Pitfalls

- **Token scope vs need.** A `scope=read` token cannot create or move cards; the call returns
  `unauthorized token permissions`. For kanban automation mint with `scope=read,write`.
- **Token expiration.** `expiration=never` is convenient but the token then lives until manually
  revoked at https://trello.com/<username>/account → "Allowed accounts". For shorter blast radius
  use `30days` and re-mint on a schedule (`/hermes-cron`).
- **The key is not the token.** The 32-char API key alone authenticates nothing useful — every
  user-data call needs both `key` and `token`. A `400 invalid token` usually means the token was
  dropped, not that the key is wrong.
- **Rate limits.** 300 requests / 10s per API key and 100 requests / 10s per token. Bursts of
  card updates can 429; back off and batch.
- **No remote MCP.** Do not claim Trello connects through the Atlassian Remote MCP Server — it
  does not. Community servers are stdio; treat their write access as untrusted until reviewed.
- **Board/org IDs, not names.** API calls take 24-char object IDs, not human board names. Resolve
  names to IDs via `/members/me/boards` first.

## Verify

```bash
# Credential reachability from inside the container, reading the stored env
docker exec -u hermes "$AGENT" sh -c '
  . /opt/data/.env 2>/dev/null
  curl -sS "https://api.trello.com/1/members/me?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}" \
    | head -c 200; echo'
```
A JSON member object is a pass. If you chose Option A, also confirm tool registration:
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 | grep -iE "trello|registered.*tool" | tail -5
```
For end-to-end proof, from the chat interface: `@<agent> list my Trello boards` should return
real board names. An empty board list for a fresh account is still a pass — auth worked.

## Definition of done

- [ ] `TRELLO_API_KEY` and `TRELLO_TOKEN` are in `/opt/data/.env` with `chmod 600`; neither is in `config.yaml` or chat.
- [ ] `curl .../members/me` from inside the container returns the user's JSON (credentials valid).
- [ ] A connection path is chosen and working: Option A (stdio MCP tools registered) or Option B (generic REST tool reaching `api.trello.com/1`).
- [ ] The token was minted with `read,write` scope if the agent must create or move cards.
- [ ] User informed that no first-party MCP exists and that any community server is unvetted until reviewed.

See `reference/TROUBLESHOOTING.md` for gateway, `.env`, and MCP registration failure modes.
