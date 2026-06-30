---
name: integration-airtable
description: Connect Airtable (bases, tables, records) to a running Hermes agent via Airtable's official remote MCP server using a static Personal Access Token. Use when the user wants their Hermes agent to read or write Airtable data — databases, ops workflows, CRM-style records.
---

# /integration-airtable — connect Airtable to Hermes

You are the engineer connecting Airtable to a running Hermes agent. Airtable ships a
**first-party remote MCP server** at `https://mcp.airtable.com/mcp` that accepts a static
**Personal Access Token (PAT)** as a bearer credential — so this keeps the one-click promise
without an OAuth browser dance. Wire it through the existing `/hermes-mcp-add` procedure.

Do everything autonomously. Stop only for the one thing a machine cannot do: the user must
mint the PAT in their browser and paste it to you.

## Before you start — gather (ask once)

1. **Airtable Personal Access Token** — the user creates it at
   **https://airtable.com/create/tokens** ("Personal access tokens" under the Developers
   section). It is shown **once**; if lost, mint a new one. Format: an opaque string
   prefixed with `pat` (e.g. `patXXXXXXXXXXXXXX.xxxxxxxx…`). Treat the rest as opaque —
   do not validate length or shape beyond the `pat` prefix.
2. **Scopes** — tell the user to grant, at minimum:
   - `data.records:read` and `schema.bases:read` for read-only.
   - add `data.records:write` to create/update records.
   - add `schema.bases:write` only if the agent must create or alter tables/fields.
3. **Base/workspace access** — a PAT is inert until you "add a base" to it. Have the user
   attach the specific bases or workspaces the agent should touch (least privilege; avoid
   "all workspaces" unless the user explicitly wants it).
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Verified facts (as of 2026-06):
- Official MCP endpoint: `https://mcp.airtable.com/mcp` (first-party, Airtable-operated).
- Auth shapes accepted: OAuth **and** PAT via `Authorization: Bearer <pat>`. Use the PAT.
- REST API base (fallback path below): `https://api.airtable.com/v0/`.

---

## Step 1 — sanity-check the PAT against the REST API (fast, no MCP needed)

Confirm the token is live and scoped before wiring anything. This call lists the bases the
token can see and surfaces scope problems immediately.

```bash
PAT='<airtable-pat>'   # never log or commit; quote it (contains a dot)

curl -sS -H "Authorization: Bearer $PAT" \
  https://api.airtable.com/v0/meta/bases
```

- `{"bases":[...]}` → token works and at least one base is attached.
- `{"bases":[]}` → token has no base attached; user must "add a base" at the token page.
- `401 / AUTHENTICATION_REQUIRED` → bad or revoked token.
- `403 / INSUFFICIENT_SCOPES` → missing `schema.bases:read` (needed to list bases).

---

## Step 2 — wire the MCP server via /hermes-mcp-add

Run the **/hermes-mcp-add** skill — do not re-implement its body. Feed it these values:

```bash
NAME=airtable                       # → env var MCP_AIRTABLE_API_KEY
URL=https://mcp.airtable.com/mcp    # first-party Airtable MCP endpoint
# auth shape: header  →  Authorization: Bearer <pat>
TOKEN=<airtable-pat>
```

That procedure will, in order:
1. **Probe** `https://mcp.airtable.com/mcp` with the matrix (expect the **bearer** variant,
   `Authorization: Bearer`, to be the one that authenticates `tools/list`).
2. **Register** with a placeholder token:
   ```bash
   printf 'y\nAuthorization\nplaceholder\n' | \
     docker exec -i -u hermes "$AGENT" \
       hermes mcp add airtable --url https://mcp.airtable.com/mcp --auth header
   ```
   This writes the `Authorization: Bearer ${MCP_AIRTABLE_API_KEY}` header to `config.yaml`
   and seeds `MCP_AIRTABLE_API_KEY=placeholder` in `/opt/data/.env`.
3. **Inject the real PAT** via `sed` with the `|` delimiter (the PAT contains `.` and may
   contain `/+=`, so a `/`-delimited sed would break), then `chmod 600`:
   ```bash
   docker exec "$AGENT" sh -c \
     "sed -i 's|^MCP_AIRTABLE_API_KEY=.*|MCP_AIRTABLE_API_KEY=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
   ```
4. **Reload** with `hermes gateway stop` + `hermes gateway run` (not `restart` — env is only
   re-read on a clean start).
5. **Verify** tool registration in `hermes logs`.

The secret lives **only** in `/opt/data/.env` (chmod 600). It must never appear in
`config.yaml` (only the `${MCP_AIRTABLE_API_KEY}` placeholder) and never in chat.

---

## Step 3 — fallback if you must avoid MCP (REST API directly)

The MCP server above is first-party and verified, so prefer it. If for some reason MCP is not
viable (e.g. a locked-down build), store the PAT for Hermes runtime and document the REST API
so a generic HTTP tool can call it:

```bash
# Write the PAT to Hermes runtime env (never config.yaml, never echo >>)
docker exec -i -u hermes "$AGENT" hermes config set AIRTABLE_PAT '<airtable-pat>'
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

REST surface for a generic tool: base `https://api.airtable.com/v0/`, header
`Authorization: Bearer $AIRTABLE_PAT`. Useful endpoints: `GET /meta/bases` (list bases),
`GET /meta/bases/{baseId}/tables` (schema), `GET /{baseId}/{tableId}` (list records),
`POST /{baseId}/{tableId}` (create), `PATCH /{baseId}/{tableId}` (update). A bare PAT in
`.env` does **not** by itself connect Airtable to the agent — it only makes the credential
available; you still need a tool or MCP that consumes it.

---

## Pitfalls

- **PAT, not the legacy API key.** Airtable retired global account API keys. Only Personal
  Access Tokens (or OAuth) work now. A `key…`-style legacy key will fail.
- **A scope-less or base-less token returns empty/403, not an error you'd expect.** "No base
  attached" looks like an empty list, and a missing `schema.bases:read` blocks `GET /meta/bases`
  even when records are readable. Check scopes AND attached bases.
- **`schema.bases:write` is dangerous.** Grant it only if the agent genuinely needs to create
  or alter tables/fields. Most ops workflows need just `data.records:read`/`:write`.
- **Token shown once.** If the user didn't copy it, they must regenerate — you cannot recover it.
- **The PAT contains a `.` (and may contain `/+=`).** Always quote it in shells and use the
  `|` sed delimiter when injecting. Never `echo >>` into `.env`.
- **OAuth alternative exists but is not needed here.** The MCP server also supports OAuth via
  the Airtable Builder Hub; skip it — the PAT keeps this fully scriptable.
- **Rate limits.** Airtable enforces ~5 requests/second per base; bursts of agent tool calls
  can return `429`. Have the agent back off rather than hammer.

---

## Verify

1. **MCP tools registered** — after the gateway reload:
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool.*airtable|MCP server 'airtable'" | tail -5
   ```
   Expect a line like `MCP server 'airtable' (HTTP): registered N tool(s): ...` (the server
   exposes tools for listing bases/tables, reading schema, and listing/creating/updating records).
2. **Live call from chat** — prove the full path end to end:
   ```
   @<agent> using airtable, list my bases
   ```
   A real list (or a valid empty `[]` if the token has no bases attached) is a **pass**.
   "Bearer token missing" / `401` means the PAT didn't land in `/opt/data/.env` — re-check
   the inject step.

---

## Definition of done

- [ ] `GET /meta/bases` with the PAT returns the user's bases (token live + scoped).
- [ ] `hermes logs` shows `registered N tool(s)` for MCP server `airtable`.
- [ ] A real chat tool call (`list my bases`) returns data or a valid empty result.
- [ ] PAT is present only in `/opt/data/.env` (chmod 600); `config.yaml` shows only
      `${MCP_AIRTABLE_API_KEY}`; the token never appeared in chat or git.

See `reference/TROUBLESHOOTING.md` for gateway, env-reload, and MCP probe failure modes.
