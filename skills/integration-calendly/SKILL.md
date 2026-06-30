---
name: integration-calendly
description: Connect Calendly (event types, scheduled events, invitees, availability) to a running Hermes agent using a static personal access token. Use when the user wants Hermes to read Calendly events, list invitees, generate one-off scheduling links, or check availability.
---

# /integration-calendly — connect Calendly to Hermes

You are the engineer connecting Calendly to a running Hermes agent. Calendly is the agent's
scheduling surface: event types, booked events, invitee details, one-off links, and
availability windows. Work autonomously; stop only for the one thing a machine cannot do —
minting the personal access token in the Calendly UI.

**Honest auth picture (verified 2026-06):** Calendly ships an official hosted remote MCP
server at `https://mcp.calendly.com`, but it is **OAuth-only** — Calendly's own docs state
the server uses Dynamic Client Registration (RFC 7591) with OAuth 2.1 Authorization Code +
PKCE, and explicitly list "Non-OAuth bearer tokens (e.g. personal access tokens)" under
**Not Supported Today**. Self-hosting is also "not supported." That kills the one-click
headless path for a server-side agent, so we do **not** wire the hosted MCP via
`/hermes-mcp-add`. **No first-party static-token MCP server verified as of 2026-06.** Use
the REST API with a personal access token instead — that is the supported headless mode.

See <https://developer.calendly.com/calendly-mcp-server> (MCP auth model) and
<https://developer.calendly.com/how-to-authenticate-with-personal-access-tokens> (PAT flow).

## Before you start — gather (ask once)

1. **Personal access token (PAT)** — mint it at
   <https://calendly.com/integrations/api_webhooks> → **Personal access tokens** →
   **Generate new token** → name it (e.g. `hermes-agent`) → **Copy token**. Calendly does
   **not** store or redisplay the token; if lost, revoke and mint a new one.
2. **Your Calendly user URI** — needed for most list calls. After step 1 you can fetch it
   with `GET https://api.calendly.com/users/me`; cache the `resource.uri` value (looks like
   `https://api.calendly.com/users/AAAAAAAAAAAAAAAA`).
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<calendly-pat>       # opaque bearer; injected via sed, never echoed
```

---

## Step 1 — store the token in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set CALENDLY_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^CALENDLY_TOKEN=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (note the `|` delimiter — Calendly PATs are opaque and may contain
> `.`, `_`, `-`, `=`):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^CALENDLY_TOKEN=' /opt/data/.env || printf 'CALENDLY_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^CALENDLY_TOKEN=.*|CALENDLY_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — wire Calendly via the REST API (the supported headless path)

A static token alone does **not** connect Calendly to the agent — it only stores the
credential. Point a generic HTTP/tool capability at the Calendly v2 REST API:

- **Base URL:** `https://api.calendly.com`
- **Auth header:** `Authorization: Bearer ${CALENDLY_TOKEN}`
- **Content type:** `Content-Type: application/json`

Common endpoints the agent will need:

| Verb | Path | Purpose |
|------|------|---------|
| GET  | `/users/me` | resolve the current user URI (cache it) |
| GET  | `/event_types?user=<user_uri>` | list bookable event types |
| GET  | `/scheduled_events?user=<user_uri>&min_start_time=<ISO>&status=active` | upcoming meetings |
| GET  | `/scheduled_events/{uuid}/invitees` | invitee email, name, answers |
| POST | `/scheduling_links` | mint a one-off booking link for an event type |
| GET  | `/user_availability_schedules?user=<user_uri>` | working hours |
| GET  | `/event_type_available_times?event_type=<uri>&start_time=<ISO>&end_time=<ISO>` | open slots (max 7-day window) |

> Do **not** try to register `https://mcp.calendly.com` through `/hermes-mcp-add` with a PAT
> as a bearer token — it returns an auth error because that endpoint accepts only OAuth 2.1
> with DCR + PKCE.

If/when a community static-token MCP server for Calendly is verified, wire it via
`/hermes-mcp-add` using the bearer auth shape and the env var `MCP_CALENDLY_API_KEY`. Until
then, the REST path above is the contract.

---

## Step 3 — reload the gateway so the new env is picked up

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
| 1 | Wiring `mcp.calendly.com` with a PAT | The hosted MCP is **OAuth-only** (DCR + PKCE); bearer tokens are rejected. No headless path. | Use the REST API (step 2). |
| 2 | Lost the token | Calendly does not store or redisplay PATs after generation. | Save it to `/opt/data/.env` immediately; if lost, revoke and remint. |
| 3 | Calls fail with `403` on listing endpoints | Many list endpoints require a `user` (or `organization`) URI query param. | Always pass `?user=<uri>` resolved from `/users/me`. |
| 4 | `event_type_available_times` returns `400` | The window is capped at 7 days and times must be ISO 8601 UTC. | Send `start_time`/`end_time` as `YYYY-MM-DDTHH:MM:SS.000000Z`, ≤7 days apart. |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` or sed. |
| 6 | Rate limits | Calendly throttles per-token; bursts get `429` with `Retry-After`. | Backoff on `429`; honor `Retry-After`. |
| 7 | Token has narrower scope than expected | PATs inherit the minting user's plan and role; Teams/Enterprise endpoints fail on Free. | Confirm plan tier matches the endpoint you need (e.g. organization scope needs Teams+). |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Token resolves to a user (works for any plan):** run inside the container so the token
   comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $CALENDLY_TOKEN" \
       -H "Content-Type: application/json" \
       "https://api.calendly.com/users/me"'
   ```
   `200` = token valid. `401` = bad/empty token (re-check step 1).

2. **Listing scheduled events works end-to-end:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     USER_URI=$(curl -sS \
       -H "Authorization: Bearer $CALENDLY_TOKEN" \
       "https://api.calendly.com/users/me" \
       | sed -n "s/.*\"uri\":\"\\([^\"]*\\)\".*/\\1/p" | head -1);
     curl -sS -o /dev/null -w "scheduled_events=%{http_code}\n" \
       -H "Authorization: Bearer $CALENDLY_TOKEN" \
       "https://api.calendly.com/scheduled_events?user=$USER_URI&status=active&count=1"'
   ```
   `200` with a `collection` array (empty is fine) = the agent can read Calendly.

3. **End-to-end from chat:** `@<agent> what's on my Calendly this week?` should list real
   meetings or report an empty week. An empty-but-valid response is still a pass for the
   wiring.

---

## Definition of done

- [ ] `CALENDLY_TOKEN` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] Calendly is wired via the REST base `https://api.calendly.com` with `Authorization: Bearer ${CALENDLY_TOKEN}`.
- [ ] `GET /users/me` from inside the container returns `200` and a usable `uri`.
- [ ] `GET /scheduled_events?user=<uri>&status=active` returns `200` (empty `collection` is valid).
- [ ] Gateway has been reloaded with `stop` + `run` (not `restart`).
- [ ] A chat-driven Calendly query returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload and HTTP tool wiring failure modes.
