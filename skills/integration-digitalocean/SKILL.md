---
name: integration-digitalocean
description: Connect DigitalOcean (Droplets, App Platform, Databases, Kubernetes, Spaces, and more) to a running Hermes agent via DigitalOcean's first-party remote MCP servers. Use when the user wants Hermes to manage or query their DigitalOcean infrastructure.
---

# /integration-digitalocean — wire DigitalOcean infra into Hermes

You are the engineer connecting DigitalOcean to a running Hermes agent. DigitalOcean ships
first-party **remote MCP servers** (one HTTPS endpoint per service), so the happy path is the
standard `/hermes-mcp-add` wiring — no local binary, no proxy. Do everything autonomously; stop
only for the API token (a machine cannot mint it) and the choice of which service(s) to wire.

## Before you start — gather (ask once)

1. **DigitalOcean API token** — a Personal Access Token (PAT). Create it in the control panel:
   **Account → API → Tokens → Generate New Token** (https://cloud.digitalocean.com/account/api/tokens).
   - Choose **Full Access** (`api:write`) for read+write, **Read Only** (`api:read`) to be safe,
     or pick **Custom Scopes** (e.g. `droplet:read`, `app:read`) for least privilege.
   - The token is shown **once**. Copy it immediately. It is conventionally prefixed `dop_v1_`.
2. **Which service(s) to wire** — each DigitalOcean service is a separate MCP server with its own
   URL. Pick what the user needs; wire one at a time. Common ones:

   | Service | MCP base URL | Hermes name |
   |---------|--------------|-------------|
   | Droplets | `https://droplets.mcp.digitalocean.com/mcp` | `do-droplets` |
   | App Platform | `https://apps.mcp.digitalocean.com/mcp` | `do-apps` |
   | Databases | `https://databases.mcp.digitalocean.com/mcp` | `do-databases` |
   | Kubernetes (DOKS) | `https://doks.mcp.digitalocean.com/mcp` | `do-doks` |
   | Spaces | `https://spaces.mcp.digitalocean.com/mcp` | `do-spaces` |
   | Networking | `https://networking.mcp.digitalocean.com/mcp` | `do-networking` |
   | Container Registry | `https://docr.mcp.digitalocean.com/mcp` | `do-docr` |
   | Volumes (Block Storage) | `https://volumes.mcp.digitalocean.com/mcp` | `do-volumes` |
   | Accounts | `https://accounts.mcp.digitalocean.com/mcp` | `do-accounts` |
   | Insights | `https://insights.mcp.digitalocean.com/mcp` | `do-insights` |

   Full list of 19+ service endpoints: https://docs.digitalocean.com/reference/mcp/
   The **Documentation** server (`https://docs.mcp.digitalocean.com/mcp`) needs **no** token.

3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers:
```bash
AGENT=<container-name>                              # e.g. hermes-agent-mxlc-hermes-agent-1
URL=https://droplets.mcp.digitalocean.com/mcp       # the chosen service endpoint
NAME=do-droplets                                    # short Hermes name → MCP_DO_DROPLETS_API_KEY
TOKEN=<dop_v1_...>                                  # the DigitalOcean PAT; never log it
```

---

## Step 1 — confirm auth shape (it is a plain bearer header)

DigitalOcean's remote MCP servers use one consistent auth shape: the PAT as a bearer token in the
`Authorization` header. No path token, no query param. You can confirm before registering:

```bash
H='Accept: application/json, text/event-stream'
C='Content-Type: application/json'
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'

curl -sS -o /dev/null -w "bearer = %{http_code}\n" \
  -X POST -H "$H" -H "$C" -H "Authorization: Bearer $TOKEN" -d "$INIT" "$URL"
```

A `200` with a JSON-RPC `result` confirms the endpoint and token are good. A `401`/`403` means the
token is wrong or lacks the scope for that service. This is the same handshake the full
`/hermes-mcp-add` probe matrix runs; you can skip the other four variants because DigitalOcean
only supports the bearer-header form.

---

## Step 2 — wire it via /hermes-mcp-add

Run the **`/hermes-mcp-add`** procedure with these values. Do not re-implement it here; that skill
owns the placeholder-token → `sed`-inject → `gateway stop`+`run` → verify-in-logs flow.

- **URL**: the chosen `https://<service>.mcp.digitalocean.com/mcp`
- **Auth shape**: header, `Authorization: Bearer ${MCP_<NAME>_API_KEY}`
- **Name**: `do-<service>` → Hermes generates env var `MCP_DO_<SERVICE>_API_KEY`
  (e.g. `do-droplets` → `MCP_DO_DROPLETS_API_KEY`)

The registration call mcp-add makes looks like:
```bash
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" --url "$URL" --auth header
```

Then mcp-add injects the real token into `/opt/data/.env` with `|`-delimited `sed` (tokens never
go through the `printf` pipe) and `chmod 600`:
```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

The token lives **only** in `/opt/data/.env`. `config.yaml` holds only the `${MCP_..._API_KEY}`
placeholder. Never put the token in `config.yaml` and never paste it into chat.

Repeat steps 1–2 per service the user wants — each gets its own name, URL, and env var. They can
share the same PAT (scope it for all the services in play).

---

## Pitfalls

- **Static token, but it behaves OAuth-ish.** DigitalOcean PATs are static bearer credentials you
  store yourself — there is no refresh flow — but the docs call them "ordinary OAuth access tokens."
  Treat them as a static secret: it does not auto-rotate, and if it expires you mint a new one.
- **Scope = 403, not 401.** A token missing a required custom scope returns **403 Forbidden** on the
  tool call (not 401). If `initialize` succeeds but a real tool call 403s, re-mint with the right
  scope (e.g. add `droplet:read`/`app:read`) or use Full Access. Each custom scope maps to one API
  endpoint, so partial scopes can silently disable individual tools.
- **One server per service.** There is no single "DigitalOcean MCP" endpoint. Droplet tools are not
  on the Databases server. Wire each service URL separately; a tool you expect missing usually means
  you wired the wrong service.
- **Token expiry.** PATs can be created with an expiration. An expired token fails every call with
  401. Check the token's expiry in the control panel if a previously-working integration breaks.
- **Spaces keys are different.** The Spaces *MCP server* still uses the PAT, but Spaces *object
  storage* (S3 API) uses separate Spaces access keys — don't confuse the two if the user wants raw
  bucket access vs. managing Spaces via MCP.
- **Token shown once.** If the user lost it, they must generate a new one; it cannot be re-displayed.

## Verify

After `/hermes-mcp-add` reloads the gateway:

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server" | tail -5
```

Expect a line like `MCP server 'do-droplets' (HTTP): registered N tool(s): ...`.

End-to-end proof from the chat interface (an empty-but-valid result is a pass):
```
@<agent> using do-droplets, list my droplets
```

Or confirm the token+scope directly against the live API:
```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.digitalocean.com/v2/account" | head -c 400
```
A JSON `account` object proves the token authenticates; `unable to authenticate` means the token or
scope is wrong (fix before re-running mcp-add).

## Definition of done

- [ ] DigitalOcean remote MCP server(s) wired via `/hermes-mcp-add`, one per chosen service.
- [ ] `hermes logs` shows `registered N tool(s)` for each `do-<service>` MCP name.
- [ ] The PAT lives only in `/opt/data/.env` (chmod 600); `config.yaml` shows only `${MCP_..._API_KEY}`.
- [ ] A real tool call (or `GET /v2/account`) returns data, confirming token + scope are valid.
- [ ] Token never appeared in chat or `config.yaml`; rotate it if it was exposed.

See `reference/TROUBLESHOOTING.md` for gateway reload, env-not-picked-up, and auth-shape failure modes.
