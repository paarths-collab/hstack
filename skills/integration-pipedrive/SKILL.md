---
name: integration-pipedrive
description: Connect Pipedrive CRM (SMB sales) to a running Hermes agent using a personal API token. Use when the user wants their Hermes agent to read or update Pipedrive deals, people, organizations, and activities.
---

# /integration-pipedrive — connect Pipedrive CRM to Hermes

You are the engineer connecting Pipedrive to a running Hermes agent. Pipedrive is an SMB sales
CRM; the agent will use it to read and update deals, people, organizations, and activities.

Be honest about the connection shape up front: **no first-party Pipedrive MCP server exists as
of 2026-06**, and the most-cited community server is local stdio only (not a remote HTTP MCP).
So the supported path here is the static API token written to `/opt/data/.env`, plus the REST
base a generic MCP/tool calls. A remote MCP option exists (Pipedream) but it is OAuth-backed and
breaks the one-token promise — covered as the alternative in Step 3.

## Before you start — gather (ask once)

1. **Pipedrive personal API token** — a static per-user, per-company token. Mint it at
   `https://app.pipedrive.com/settings/api` (or: account name top-right > Company settings >
   Personal preferences > API). API access must be enabled for the company first. The token is
   a 40-char hex string and grants full access to that user's data, so treat it as a secret.
2. **Company domain** — the subdomain in the user's Pipedrive URL, e.g. `acme` for
   `https://acme.pipedrive.com`. The REST base is `https://<company>.pipedrive.com/api/v2`.
3. **Agent container name** — output of `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from the answers (never log the token):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
COMPANY=<company-subdomain>     # e.g. acme
TOKEN=<pipedrive-api-token>     # the 40-char hex token; injected via sed, never echoed
BASE="https://${COMPANY}.pipedrive.com/api/v2"
```

---

## Step 1 — verify the token and domain with a live REST call

Pipedrive authenticates with the token in the `x-api-token` header against the company-domain
base URL. Prove both the token and the domain are correct before wiring anything.

```bash
curl -sS -o /tmp/pd_probe -w "users/me = %{http_code}\n" \
  -H "x-api-token: ${TOKEN}" \
  "${BASE}/../v1/users/me"
```

- **200 + a JSON `data` block with the user's name/company** → token and domain are correct.
- **401** → token is wrong, expired, or rotated (a user has only one active token at a time).
- **404 / DNS failure** → wrong company subdomain; re-check the URL the user logs in at.

Then confirm a real data endpoint responds (v2):
```bash
curl -sS -w "\ndeals = %{http_code}\n" \
  -H "x-api-token: ${TOKEN}" \
  "${BASE}/deals?limit=1"
```
An empty `{"data":[],...}` with `200` is a pass — auth works, the account just has no deals yet.

---

## Step 2 — write the token to `/opt/data/.env` (chmod 600)

Store the credential in the Hermes runtime env file inside the container, never in `config.yaml`
and never in chat. Use `hermes config set` so Hermes owns the write; fall back to a `sed`-style
append only if the CLI lacks the subcommand.

```bash
# Preferred: let Hermes manage the runtime env
docker exec -u hermes "$AGENT" hermes config set PIPEDRIVE_API_TOKEN "$TOKEN"
docker exec -u hermes "$AGENT" hermes config set PIPEDRIVE_COMPANY_DOMAIN "$COMPANY"

# Lock it down — this file now holds a full-access CRM credential
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

If `hermes config set` is unavailable on this build, inject the key directly. Use `|` as the sed
delimiter and `printf`/`sed`, never `echo >>` (an un-newlined append glues the key onto the
previous line):
```bash
docker exec "$AGENT" sh -c '
  touch /opt/data/.env
  if grep -q "^PIPEDRIVE_API_TOKEN=" /opt/data/.env; then
    sed -i "s|^PIPEDRIVE_API_TOKEN=.*|PIPEDRIVE_API_TOKEN='"$TOKEN"'|" /opt/data/.env
  else
    printf "\nPIPEDRIVE_API_TOKEN=%s\n" "'"$TOKEN"'" >> /opt/data/.env
  fi
  chmod 600 /opt/data/.env
'
```

Confirm it landed without printing the value:
```bash
docker exec "$AGENT" sh -c "grep -c '^PIPEDRIVE_API_TOKEN=' /opt/data/.env"   # → 1
```

---

## Step 3 — connect it so the agent can actually call Pipedrive

A key in `.env` does not by itself give the agent tools. Pick one of the two honest options.

### Option A (recommended for the one-click promise) — generic HTTP tool over the REST API

There is **no first-party Pipedrive MCP server verified as of 2026-06**, and the most-cited
community server (`@nubiia/mcp-pipedrive`, npm) is a **local stdio** server — it cannot be wired
through `/hermes-mcp-add`, which expects a remote HTTP MCP. So point the agent's generic
HTTP/tool capability at Pipedrive's REST API directly:

- **Base URL:** `https://<company>.pipedrive.com/api/v2`
- **Auth:** header `x-api-token: ${PIPEDRIVE_API_TOKEN}` on every request (NOT a Bearer header).
  Pipedrive also accepts `?api_token=` as a query param, but the header keeps the token out of
  logs and URLs — prefer the header.
- **Useful endpoints:** `GET /deals`, `GET /persons`, `GET /organizations`, `GET /activities`,
  `POST /deals`, `PATCH /deals/{id}`. A few endpoints still live only on v1 (e.g.
  `GET /v1/users/me`); fall back to `/api/v1/...` when a v2 path 404s.

Document these in the agent's tool/skill config so it knows the base, the header name, and the
env var to read. This keeps a single static token and no OAuth dance.

### Option B (remote MCP, but OAuth-backed) — Pipedream-hosted Pipedrive MCP

A maintained **remote** MCP exists at `https://mcp.pipedream.com/app/pipedrive` (Pipedream
Connect, streamable HTTP). It does **not** fit the clean single-token shape `/hermes-mcp-add`
assumes: every request needs a developer **OAuth** Bearer access token (from Pipedream client
credentials) **plus** four routing headers — `x-pd-project-id`, `x-pd-environment`,
`x-pd-external-user-id`, `x-pd-app-slug: pipedrive` — and the end user's Pipedrive account is
linked through Pipedream's managed OAuth flow, not the API token above. Only choose this if the
user already runs Pipedream Connect and wants managed OAuth. If so, run `/hermes-mcp-add` with
URL `https://mcp.pipedream.com/app/pipedrive`, `--auth header` for the Bearer token (stored as
`MCP_PIPEDRIVE_API_KEY`), and add the four `x-pd-*` headers; the probe matrix in that skill will
confirm the exact shape. Be explicit with the user that this is OAuth, not a static key.

---

## Pitfalls

- **Header is `x-api-token`, not `Authorization: Bearer`.** A Bearer header silently 401s; the
  community guides that show Bearer are wrong for Pipedrive's own REST API.
- **Company-domain base URL is mandatory.** Calls to a bare `api.pipedrive.com` or the wrong
  subdomain fail with 404/DNS errors, not a clear auth error. Always use `https://<company>.pipedrive.com`.
- **One active token per user.** If the user regenerates the token in Settings, the old one dies
  instantly and every integration using it breaks. Rotating means re-running Step 2.
- **Token = full account access.** A personal API token is not scoped — it inherits the user's
  full permissions. Prefer a dedicated low-privilege Pipedrive user for the agent if possible.
- **Rate limits are budget-based.** Pipedrive uses an API token "request cost" budget per
  company per window; heavy polling can throttle (HTTP 429). Have the agent back off on 429.
- **No first-party MCP.** Do not claim an official Pipedrive MCP endpoint — none is verified.
  The Pipedream path (Option B) is OAuth, not a static key; do not present it as one-click.

## Verify

- REST reachable: `curl -H "x-api-token: $TOKEN" "$BASE/deals?limit=1"` returns `200` (empty
  `data` array is fine).
- Env present: `docker exec "$AGENT" sh -c "grep -c '^PIPEDRIVE_API_TOKEN=' /opt/data/.env"` → `1`,
  and the value is absent from `config.yaml`.
- End to end: from the chat interface, `@<agent> list my 3 most recent Pipedrive deals` returns
  real records (or a valid empty result). If Option B was used, also confirm
  `hermes logs | grep -i "registered.*tool"` shows the Pipedrive MCP tools.

## Definition of done

- [ ] `PIPEDRIVE_API_TOKEN` (and `PIPEDRIVE_COMPANY_DOMAIN`) live only in `/opt/data/.env`, `chmod 600`, never in `config.yaml` or chat.
- [ ] A live `x-api-token` REST call against `https://<company>.pipedrive.com/api/v2` returns `200`.
- [ ] The agent is wired to Pipedrive via Option A (REST base + `x-api-token` header) or Option B (Pipedream OAuth MCP), and the choice was stated honestly to the user.
- [ ] The agent returns real Pipedrive data (or a valid empty response) from the chat interface.

See `reference/TROUBLESHOOTING.md` for gateway reload, `.env` path, and auth failure modes.
