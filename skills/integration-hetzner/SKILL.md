---
name: integration-hetzner
description: Connect a running Hermes agent to Hetzner Cloud so it can read and manage VPS infrastructure (servers, volumes, firewalls, load balancers). Use when the user wants their Hermes agent to query or operate Hetzner Cloud resources.
---

# /integration-hetzner — connect Hetzner Cloud to Hermes

You are the engineer connecting Hetzner Cloud to a running Hermes agent. Hetzner Cloud exposes a
clean REST API guarded by a static Bearer token, so the credential half is a one-shot job. The
gap is the wiring: as of 2026-06 there is **no first-party Hetzner MCP server**, so you cannot
point `/hermes-mcp-add` at a hosted endpoint. Pick one of the two honest paths in Step 2 and tell
the user which one you took and why.

Do everything autonomously. Stop only for the one thing a machine cannot do: minting the API token
(it is shown exactly once and is tied to the user's project).

## Before you start — gather (ask once)

1. **Hetzner Cloud API token** — a static Bearer token, scoped to a single Hetzner *project*.
   Mint it in the Hetzner Cloud Console: **Security → API tokens → Generate API token**. Choose
   the scope deliberately:
   - **Read** for query-only agents (GET only — safest default).
   - **Read & Write** only if the agent must create/delete/power-cycle servers (GET/POST/PUT/DELETE).
   The token is shown **once** and cannot be viewed again — have the user copy it immediately.
   Console + steps: https://docs.hetzner.com/cloud/api/getting-started/generating-api-token/
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Token format: an opaque alphanumeric string (the docs' example is `jEheVytlAoFl7F8MqUQ7jAo2hOXASztX`).
There is no `hcl_`-style prefix and no expiry shown in the console; treat it as long-lived and rotate
manually. One token = one project; a multi-project user needs one token per project.

Set shell vars from the answers:
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<hetzner-api-token>  # never log; injected via sed below
```

---

## Step 1 — sanity-check the token against the live API

Confirm the token works and observe its scope before wiring anything. Base URL is
`https://api.hetzner.cloud/v1/`; auth is `Authorization: Bearer <token>`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  'https://api.hetzner.cloud/v1/servers?per_page=1' \
  -w '\nHTTP %{http_code}\n'
```

- **HTTP 200 + a `servers` array** (even empty `[]`) → token is valid.
- **HTTP 401** (`unauthorized`) → wrong/typo'd token, or it belongs to a different project.
- **HTTP 403 on a later POST/DELETE but 200 on GET** → the token is **Read-only**. Fine for a
  query agent; re-mint as Read & Write if the user needs to mutate infra.

Reference: https://docs.hetzner.com/cloud/api/getting-started/using-api/

---

## Step 2 — wire it into Hermes (choose the honest path)

**There is no first-party Hetzner MCP server verified as of 2026-06.** Do not pretend a stored key
alone gives the agent Hetzner tools — a key in `.env` is just a secret until something reads it.
Pick one:

### Path A (default) — store the key + expose the REST API to a generic HTTP tool

Write the token to the Hermes runtime `.env` so any generic HTTP/REST tool the agent has can call
Hetzner with it. Use `hermes config set` (it writes to `/opt/data/.env` inside the container);
never `echo >>`.

```bash
docker exec -u hermes "$AGENT" hermes config set HETZNER_API_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c 'chmod 600 /opt/data/.env'
```

Then point the agent's generic HTTP tool at the Hetzner REST API:
- Base URL: `https://api.hetzner.cloud/v1/`
- Auth header: `Authorization: Bearer ${HETZNER_API_TOKEN}`
- Useful read endpoints: `GET /servers`, `GET /volumes`, `GET /firewalls`,
  `GET /load_balancers`, `GET /datacenters`, `GET /pricing`.
- Mutations (Read & Write token only): `POST /servers`, `POST /servers/{id}/actions/poweroff`,
  `DELETE /servers/{id}`.
Full reference: https://docs.hetzner.cloud/reference/cloud

### Path B — self-host a community MCP server, then run /hermes-mcp-add

If the user wants first-class MCP tools, the maintained community option is **dkruyt/mcp-hetzner**
(MIT, Python): https://github.com/dkruyt/mcp-hetzner . It is **not a hosted endpoint** — it ships
as a local stdio server with an optional SSE/HTTP mode (default `localhost:8080`), and it reads the
token from the `HCLOUD_TOKEN` env var. To use it as a *remote* MCP for Hermes you must host it
yourself behind a URL Hermes can reach, then follow the existing `/hermes-mcp-add` procedure
end-to-end (probe → register → sed-inject token → `gateway stop` + `gateway run` → verify logs),
passing:
- the MCP base URL you exposed (e.g. `https://hetzner-mcp.<your-domain>/mcp`),
- auth shape `header` / `Authorization: Bearer`,
- env var `MCP_HETZNER_API_KEY` (Hermes derives this from the name `hetzner`).

Do not invent or assume a public URL for this server — there is no official hosted one. If you have
not actually stood up the server, do not claim it is connected; fall back to Path A.

Other community implementations exist (Xodus-CO/hcloud-mcp, MahdadGhasemian/mcp-hetzner-go); vet
maintenance and provenance before trusting any of them with a Read & Write token.

---

## Pitfalls

- **No OAuth, but no first-party MCP either.** Auth is trivially a static Bearer token; the real
  work is choosing Path A vs B. A key sitting in `.env` connects nothing on its own.
- **Token is project-scoped and shown once.** It only sees resources in the one Hetzner project it
  was minted in. If the agent "can't see" a server, the token is for the wrong project. Re-minting
  is the only recovery — the value is never displayed again.
- **Read vs Read & Write is decided at mint time.** You cannot upgrade a Read token's scope; you
  re-create it. Default to Read unless the user explicitly wants the agent to change infra.
- **Rate limit: 3600 requests/hour per project.** It refills ~1 request/second, not all at once; a
  burst that drains it returns **HTTP 429** with `RateLimit-Remaining: 0`. A polling agent should
  back off on 429 and watch the `RateLimit-Remaining` header. Both authenticated and unauthenticated
  requests count. (https://github.com/hetznercloud/hcloud-go/issues/79)
- **Hetzner Cloud ≠ Hetzner Robot.** This token works only for the Cloud API
  (`api.hetzner.cloud`). Dedicated/Robot servers use a separate, different API and won't authenticate
  with this token.
- **Self-hosted MCP (Path B) needs `HCLOUD_TOKEN`, not `HETZNER_API_TOKEN`.** dkruyt/mcp-hetzner
  reads `HCLOUD_TOKEN`; Hermes' MCP wiring injects `MCP_HETZNER_API_KEY`. Map them in the server's
  own env so the names line up, or the server starts unauthenticated.

---

## Verify

Path A — prove the agent can reach Hetzner with the stored token. Confirm the var landed (prints
the var name only, never the value):
```bash
docker exec -u hermes "$AGENT" sh -c 'grep -c "^HETZNER_API_TOKEN=" /opt/data/.env'
# Should print 1
```
Then ask the agent in chat to use its HTTP tool against `https://api.hetzner.cloud/v1/servers` and
confirm it returns a server list (or a valid empty `{"servers":[]}`). An empty-but-valid response
is a pass — every layer worked.

Path B — after `/hermes-mcp-add`, confirm tool registration in the gateway logs:
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server.*hetzner" | tail -5
```
Then trigger a real call: `@<agent> using hetzner, list my servers`.

---

## Definition of done

- [ ] Token validated against `https://api.hetzner.cloud/v1/servers` (HTTP 200) and its scope
      (Read vs Read & Write) confirmed.
- [ ] Token stored only in `/opt/data/.env` with `chmod 600` — never in `config.yaml` or chat.
- [ ] The chosen path is wired: Path A (REST base URL + `Authorization: Bearer ${HETZNER_API_TOKEN}`
      handed to the agent's HTTP tool) **or** Path B (`/hermes-mcp-add` completed against a
      self-hosted community MCP, tools registered in logs).
- [ ] A real query returns Hetzner data (server list or a valid empty response).
- [ ] User told plainly that no first-party MCP exists and which path was used.

See `reference/TROUBLESHOOTING.md` for gateway, `.env`, and MCP registration failure modes.
