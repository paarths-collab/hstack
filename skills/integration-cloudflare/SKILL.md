---
name: integration-cloudflare
description: Connect Cloudflare (DNS, Workers, tunnels/Cloudflare One, security) to a running Hermes agent via Cloudflare's first-party remote MCP server. Use when the user wants their Hermes agent to manage Cloudflare resources.
---

# /integration-cloudflare — wire Cloudflare into Hermes

You are the engineer connecting Cloudflare to a running Hermes agent. Cloudflare ships a
**first-party remote MCP server** (`https://mcp.cloudflare.com/mcp`) that exposes the full
Cloudflare API — Workers, KV, R2, D1, Pages, DNS, Firewall, Load Balancers, Stream, Images,
AI Gateway, Vectorize, Access, and Gateway (Cloudflare One). It supports OAuth (interactive)
**and** a static API token as a bearer header, which is the path you take here to keep the
one-click promise. Do everything autonomously; stop only for the token (a machine cannot mint
it) and the agent container name.

## Before you start — gather (ask once)

1. **Cloudflare API token** — minted by the user at
   `https://dash.cloudflare.com/profile/api-tokens` → **Create Token**. They should use a
   custom token (or a template) scoped to only what the agent needs. For account-level
   features include **Account Resources: Read** so the server can auto-detect the account ID;
   add **Zone : DNS : Edit**, **Account : Workers Scripts : Edit**, **Access : Apps and
   Policies : Edit**, etc. per use case. The secret is shown **once** — copy it immediately.
   New tokens use the `cfut_`-prefixed scannable format.
2. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers:
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
NAME=cloudflare                 # -> env var MCP_CLOUDFLARE_API_KEY
URL=https://mcp.cloudflare.com/mcp
TOKEN=<cloudflare-api-token>    # never log; injected via sed in the mcp-add flow
```

---

## Step 1 — wire it via /hermes-mcp-add (header / bearer auth)

This is a standard remote HTTP MCP server, so run the full **/hermes-mcp-add** procedure end
to end — do not re-implement it here. Feed it these exact parameters:

- **URL:** `https://mcp.cloudflare.com/mcp` (streamable HTTP; do not use the deprecated `/sse`)
- **Auth shape:** header — `Authorization: Bearer <token>`
- **Env var:** `MCP_CLOUDFLARE_API_KEY` (Hermes derives this from `NAME=cloudflare`)

The mcp-add probe matrix (its Step 1) will confirm the bearer-header variant is the one that
returns `tools/list` data; the path-token, query-token, and `X-API-Key` variants will fail.
mcp-add then registers with a **placeholder** token (Step 3) and injects the real value with
`sed` using the `|` delimiter (Step 4) — Cloudflare tokens are alphanumeric but always inject
via sed, never `echo >>`, and never put the token in `config.yaml`.

After registration `config.yaml` should read:
```yaml
cloudflare:
  url: https://mcp.cloudflare.com/mcp
  headers:
    Authorization: Bearer ${MCP_CLOUDFLARE_API_KEY}
  enabled: true
```

The real token lands only in `/opt/data/.env` as `MCP_CLOUDFLARE_API_KEY=cfut_...`, `chmod 600`.

---

## Step 2 — reload the gateway and confirm registration

Follow mcp-add Steps 5–6: reload with `gateway stop` + `gateway run` (not `restart`), then
read the logs for the registered tool count. Cloudflare's server publishes many tools, so
expect a large count.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|cloudflare" | tail -5
```

---

## Pitfalls

- **OAuth is the default; you must opt into the token.** Connecting a fresh client to
  `mcp.cloudflare.com/mcp` triggers an interactive OAuth redirect, which a headless Hermes
  agent cannot complete. The static API token in the `Authorization: Bearer` header is the
  supported automation path — without it the server falls back to OAuth and the agent stalls.
- **Token scope is the silent failure mode.** The server only exposes operations the token is
  permitted to do; a too-narrow token makes tools appear but return 403/`Authentication error`
  at call time. If account-scoped tools 404 on the account ID, the token is missing
  **Account Resources: Read** (used to auto-detect the account).
- **Token is shown once.** If lost, the user must roll a new one in the dashboard and you
  re-inject via mcp-add Step 4; there is no way to read it back.
- **Least privilege.** Do not hand the agent a Global API Key or an all-scopes token. Scope to
  the specific zones/products in play (DNS edit on one zone, Workers edit, etc.). Add a TTL or
  IP filter on the token in the dashboard for extra containment.
- **Remote-only, no npm package.** There is nothing to `npx`/self-host for this server; it is
  the hosted endpoint above. (Cloudflare also ships product-specific remote servers such as
  `dns-analytics.mcp.cloudflare.com/mcp` and `casb.mcp.cloudflare.com/mcp` for narrower needs —
  same bearer-token wiring if you want a smaller tool surface.)

## Verify

```bash
# 1. Tools registered in the gateway logs
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool.*cloudflare" | tail -3

# 2. Token itself is valid (run on host or in container; bearer header)
curl -sS -H "Authorization: Bearer ${TOKEN}" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
# expect: {"result":{"status":"active"}, ... "success":true}
```

Then trigger a real call from chat, e.g. `@<agent> using cloudflare, list the DNS records for
<zone>`. A valid empty or populated list is a pass; `Authentication error` means the token
didn't land (re-check mcp-add Step 4) or the token lacks the needed scope.

## Definition of done

- [ ] `hermes logs` shows `registered N tool(s)` for the `cloudflare` MCP server.
- [ ] `config.yaml` holds only `Bearer ${MCP_CLOUDFLARE_API_KEY}` — no raw token anywhere.
- [ ] `/opt/data/.env` has `MCP_CLOUDFLARE_API_KEY=cfut_...` and is `chmod 600`.
- [ ] `/user/tokens/verify` returns `"status":"active"` and a real chat call returns data.
- [ ] Token is scoped to least privilege (specific zones/products), not a Global API Key.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP auth failure modes.
