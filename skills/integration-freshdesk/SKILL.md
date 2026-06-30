---
name: integration-freshdesk
description: Connect Freshdesk (SMB support tickets, contacts, companies) to a running Hermes agent using a static API key. Use when the user wants Hermes to triage, read, create, or update Freshdesk tickets and related support data.
---

# /integration-freshdesk — connect Freshdesk to Hermes

You are the engineer connecting Freshdesk to a running Hermes agent. Freshdesk is the agent's
support-ticket surface: tickets, conversations, contacts, companies, agents, groups. Work
autonomously; stop only for the two things a machine cannot do: minting the API key in the
Freshdesk UI, and confirming the Freshdesk plan / EAP enrollment.

**Honest auth picture (verified 2026-06):** Freshdesk ships a **first-party remote MCP
server** at `https://<your-domain>.freshdesk.com/mcp`. It is in **Early Access Program (EAP)**,
restricted to **Enterprise plan** accounts, with a 100 calls/min and 5,000 calls/month cap
during EAP. Auth is the raw Freshdesk **API key** in the `Authorization` header — **no
`Bearer ` prefix**. The v2 REST API itself stays available on every plan and uses HTTP Basic
auth (API key as username, any string as password); use it as the fallback when the MCP EAP
is not granted.

## Before you start — gather (ask once)

1. **Freshdesk domain** — the subdomain prefix, e.g. `acme` for `acme.freshdesk.com`. The MCP
   URL is `https://<domain>.freshdesk.com/mcp`; the REST base is
   `https://<domain>.freshdesk.com/api/v2`.
2. **API key** — log in as the agent that will own the integration → profile picture (top
   right) → **Profile Settings** → right pane **View API key** → complete the captcha → copy
   the key. The owning agent must be **verified** or the key field is hidden. Treat this as a
   long-lived, highly privileged credential — it inherits the agent's role and scope.
3. **Plan / EAP status** — confirm the account is on **Enterprise** and the MCP EAP has been
   granted by the Freshworks TAM or `support@freshdesk.com`. If not, skip to Path B.
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
DOMAIN=<freshdesk-subdomain>    # e.g. acme  →  acme.freshdesk.com
TOKEN=<freshdesk-api-key>       # raw API key; injected via sed, never echoed
```

---

## Step 1 — store the API key in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set FRESHDESK_API_KEY "$TOKEN"
docker exec -i -u hermes "$AGENT" hermes config set FRESHDESK_DOMAIN "$DOMAIN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify both vars landed (prints `1` for each, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^FRESHDESK_API_KEY=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^FRESHDESK_DOMAIN=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (note the `|` delimiter — Freshdesk keys are alnum but stay
> consistent with the base procedure):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^FRESHDESK_API_KEY=' /opt/data/.env || printf 'FRESHDESK_API_KEY=\n' >> /opt/data/.env; \
>    sed -i 's|^FRESHDESK_API_KEY=.*|FRESHDESK_API_KEY=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Freshdesk. Pick the path that matches the account.

### Path A (preferred, Enterprise + EAP) — first-party remote MCP via /hermes-mcp-add

Endpoint: `https://${DOMAIN}.freshdesk.com/mcp`
Auth shape: header `Authorization: <api-key>` — **no `Bearer ` prefix** (Freshworks docs are
explicit on this). Wire it through the base procedure, then patch the header template so the
raw key is sent.

```bash
URL="https://${DOMAIN}.freshdesk.com/mcp"
NAME=freshdesk

# Register with placeholder (the printf answers: use-auth=y, header-name, placeholder value)
printf 'y\nAuthorization\nplaceholder\n' | \
  docker exec -i -u hermes "$AGENT" \
    hermes mcp add "$NAME" \
      --url "$URL" \
      --auth header
```

Hermes' default header template is `Bearer ${MCP_FRESHDESK_API_KEY}`. Freshdesk rejects that —
strip the `Bearer ` so only the raw key is sent:

```bash
docker exec "$AGENT" sh -c \
  "sed -i 's|Authorization: Bearer \${MCP_FRESHDESK_API_KEY}|Authorization: \${MCP_FRESHDESK_API_KEY}|' \
     /opt/data/config.yaml"
```

Inject the real key into `.env` (use `|` as the sed delimiter — base-procedure rule):

```bash
ENV_VAR=MCP_FRESHDESK_API_KEY
docker exec "$AGENT" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
```

Before reloading, sanity-check the MCP endpoint from the host with a `tools/list` probe:

```bash
curl -sS -o /tmp/fd_probe -w "%{http_code}\n" \
  -X POST "https://${DOMAIN}.freshdesk.com/mcp" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "Authorization: ${TOKEN}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

`200` with a JSON-RPC `result` means EAP is live and the key is good. `401` / `403` means EAP
is not granted on this account — switch to Path B. `404` means the subdomain is wrong.

### Path B (fallback, any plan) — Freshdesk v2 REST API as a generic HTTP tool

When EAP is not granted, no other verified MCP server exists for Freshdesk as of 2026-06
(community servers like `effytech/freshdesk_mcp` and `NeuraLegion/freshdesk_mcp` exist but
are local stdio servers, not maintained by Freshworks). Use the REST API directly via the
agent's generic HTTP tool capability:

- **Base URL:** `https://${DOMAIN}.freshdesk.com/api/v2`
- **Auth:** HTTP Basic with API key as username, literal `X` as password
  → header `Authorization: Basic $(printf '%s:X' "$TOKEN" | base64)`
- **Content type:** `Content-Type: application/json`
- **Common endpoints:** `GET /tickets`, `GET /tickets/{id}`, `POST /tickets`,
  `PUT /tickets/{id}`, `GET /tickets/{id}/conversations`, `POST /tickets/{id}/reply`,
  `GET /contacts`, `GET /companies`, `GET /agents`, `GET /search/tickets?query="..."`.
- **Rate limits per plan:** Trial 50/min, Growth 200/min, Pro 400/min, Enterprise 700/min.
  Read `X-RateLimit-Remaining` and back off on `429`.

---

## Step 3 — reload the gateway so the new env / MCP is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new env is
re-read cleanly — same rule as `/hermes-mcp-add`.

```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 8
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending `Authorization: Bearer <key>` to the Freshdesk MCP | Freshworks docs require the raw key, no `Bearer ` prefix. Returns 401. | Patch `config.yaml` to drop `Bearer ` (Step 2 Path A). |
| 2 | Wiring MCP on a non-Enterprise plan or non-EAP account | EAP is gated; endpoint returns 403 or 404. | Confirm Enterprise + EAP grant before Path A; else Path B. |
| 3 | Using a key from an unverified agent | UI hides the API key until the agent is verified. | Verify the agent email first, then mint the key. |
| 4 | API key inherits the agent's role | A restricted-scope agent silently 403s on tickets it cannot see. | Mint from an admin or a dedicated integration agent with the needed scope. |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` or sed. |
| 6 | Hitting per-minute rate limits | Bulk syncs exceed plan cap (50-700/min) or EAP cap (100/min, 5000/month). | Honor `X-RateLimit-Remaining`; back off on `429`; batch via search. |
| 7 | Subdomain typo in URL | `acme.freshdesk.com` vs `acme-help.freshdesk.com` returns 404 / wrong tenant. | Confirm the exact subdomain from the Freshdesk admin URL. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path A only):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*freshdesk" | tail -5
   ```
2. **Real REST call returns data (works regardless of path):** runs inside the container so
   the key comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -u "$FRESHDESK_API_KEY:X" \
       -H "Content-Type: application/json" \
       "https://$FRESHDESK_DOMAIN.freshdesk.com/api/v2/tickets?per_page=1"'
   ```
   `200` = key valid and scoped. `401` = bad/empty key (re-check Step 1). `403` = key valid but
   the agent's role cannot list tickets.
3. **End-to-end from chat:** `@<agent> show me the 3 most recent Freshdesk tickets` should
   return real tickets. An empty-but-valid response is a pass for the wiring.

---

## Definition of done

- [ ] `FRESHDESK_API_KEY` and `FRESHDESK_DOMAIN` are in `/opt/data/.env` with `chmod 600`; neither is in `config.yaml` or chat.
- [ ] Freshdesk is connected via Path A (MCP tools registered, EAP confirmed) or Path B (REST base documented and reachable).
- [ ] If Path A: `config.yaml` sends `Authorization: ${MCP_FRESHDESK_API_KEY}` with **no** `Bearer ` prefix.
- [ ] `GET /api/v2/tickets?per_page=1` from inside the container returns `200`.
- [ ] A chat-driven Freshdesk ticket query returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
