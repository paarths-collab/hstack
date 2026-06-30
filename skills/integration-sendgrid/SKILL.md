---
name: integration-sendgrid
description: Connect SendGrid (transactional email) to a running Hermes agent using a static v3 API key. Use when the user wants Hermes to send transactional or notification emails through SendGrid.
---

# /integration-sendgrid — connect SendGrid to Hermes

You are the engineer connecting SendGrid to a running Hermes agent. SendGrid is the
agent's transactional email channel — order confirmations, alerts, password resets,
notifications. Work autonomously; stop only for the two things a machine cannot do:
minting the API key in the SendGrid UI and verifying the sender identity (domain or
single-sender) which requires a DNS or inbox click.

**Honest auth picture (verified 2026-06):** **No first-party SendGrid or Twilio remote
MCP server is verified to exist.** Twilio publishes a build-your-own tutorial
(<https://www.twilio.com/en-us/blog/developers/community/build-a-sendgrid-mcp-server-for-ai-email-workflows>)
and there are several community stdio MCP servers (e.g. `Garoth/sendgrid-mcp`,
`deyikong/sendgrid-mcp`), but nothing first-party and hosted with bearer auth. The
clean, headless path for a self-hosted agent is the SendGrid v3 REST API directly with
a static `SG.`-prefixed API key — documented at
<https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/authentication>.

## Before you start — gather (ask once)

1. **SendGrid API key** — starts with `SG.`. Mint at
   <https://app.sendgrid.com/settings/api_keys> → **Create API Key** → choose
   **Restricted Access** and grant at minimum **Mail Send: Full Access** (add
   **Marketing, Stats, Template Engine** only if the agent needs them). Copy the key
   once — SendGrid never shows it again.
2. **Verified sender** — SendGrid rejects `mail/send` unless the `from` address is
   verified. Either complete **Domain Authentication**
   (<https://app.sendgrid.com/settings/sender_auth/domains>) or **Single Sender
   Verification** (<https://app.sendgrid.com/settings/sender_auth/senders>). Confirm
   this is done before testing or every send returns `403 The from address does not
   match a verified Sender Identity`.
3. **Default from address** — the verified address the agent will send as
   (e.g. `noreply@yourdomain.com`).
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the key):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<SG....>                  # the API key; injected via sed, never echoed
FROM=<verified-from-address>    # e.g. noreply@yourdomain.com
```

---

## Step 1 — store the API key and default sender in the Hermes runtime .env (chmod 600)

Write both values to `/opt/data/.env` inside the container. Use `hermes config set` so
Hermes owns the write; never `echo >>` (it can merge onto a prior line) and never put
the key in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set SENDGRID_API_KEY "$TOKEN"
docker exec -i -u hermes "$AGENT" hermes config set SENDGRID_FROM "$FROM"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify both vars landed (prints `1` each, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^SENDGRID_API_KEY=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^SENDGRID_FROM=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed
> pattern from `/hermes-mcp-add`. Use `|` as the delimiter — SendGrid keys contain
> `.`, `_`, and `-`, and `|` stays consistent with the base procedure:
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^SENDGRID_API_KEY=' /opt/data/.env || printf 'SENDGRID_API_KEY=\n' >> /opt/data/.env; \
>    sed -i 's|^SENDGRID_API_KEY=.*|SENDGRID_API_KEY=${TOKEN}|' /opt/data/.env; \
>    grep -q '^SENDGRID_FROM=' /opt/data/.env || printf 'SENDGRID_FROM=\n' >> /opt/data/.env; \
>    sed -i 's|^SENDGRID_FROM=.*|SENDGRID_FROM=${FROM}|' /opt/data/.env; \
>    chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect SendGrid. Pick the path that matches your Hermes build.

A static key alone does **not** give the agent a send capability — it only stores the
credential. You must give the agent a tool surface. Two honest options:

### Path A (preferred) — generic HTTP tool against the SendGrid v3 REST API

No first-party remote MCP exists, so the most reliable headless path is the REST API.
Point a generic HTTP/tool capability at SendGrid v3 directly:

- **Base URL:** `https://api.sendgrid.com/v3`
- **Auth header:** `Authorization: Bearer ${SENDGRID_API_KEY}`
- **Content type:** `Content-Type: application/json`
- **Send endpoint:** `POST /v3/mail/send`
- **Other common endpoints:** `GET /v3/scopes` (key validation), `GET /v3/stats`
  (volume/opens/clicks), `GET /v3/templates` (dynamic templates),
  `POST /v3/marketing/contacts` (lists), `GET /v3/suppression/bounces` (deliverability).

Minimal send body (the agent fills `to`, `subject`, `text`/`html`; `from` defaults to
`${SENDGRID_FROM}`):
```json
{
  "personalizations": [{"to": [{"email": "user@example.com"}]}],
  "from": {"email": "noreply@yourdomain.com"},
  "subject": "Hello from Hermes",
  "content": [{"type": "text/plain", "value": "Test send."}]
}
```

A successful send returns **HTTP 202** with an empty body and an `X-Message-Id`
response header. Anything else is a failure — see the pitfalls table.

### Path B — community stdio MCP server (if your Hermes supports stdio MCP)

If your Hermes build can launch stdio MCP servers and you want a tool surface instead
of raw REST, register a community server. Example using `Garoth/sendgrid-mcp`
(unofficial — review the source before trusting it with a Full Access key):

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add sendgrid \
    --command "npx" \
    --args "-y,@garoth/sendgrid-mcp" \
    --env "SENDGRID_API_KEY=\${SENDGRID_API_KEY}"
```

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio
> syntax. Use `${SENDGRID_API_KEY}` indirection so the secret stays only in
> `/opt/data/.env`.
>
> Do **not** try to register a SendGrid URL through `/hermes-mcp-add` with a bearer
> token — there is no verified first-party HTTP MCP endpoint to register.

---

## Step 3 — reload the gateway so the new env / MCP is picked up

The gateway reads `.env` once at startup. Use stop + run (not `restart`) so the new
env is re-read cleanly — same rule as `/hermes-mcp-add`.

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
| 1 | Wiring a "SendGrid remote MCP" with a bearer token | No first-party hosted MCP is verified to exist. URLs from aggregators are third-party proxies. | Use Path A (REST) or Path B (community stdio with source review). |
| 2 | `403 from address does not match a verified Sender Identity` | The `from` address is not domain-authenticated or single-sender verified. | Complete Domain Auth or Single Sender Verification before testing. |
| 3 | Sandbox / paused account | New accounts and free tiers can be paused pending compliance review. Sends return `403` with a compliance message. | Check <https://app.sendgrid.com/> banner; complete account review. |
| 4 | Full Access key for a single-purpose agent | Lost key = full account compromise (templates, contacts, stats). | Mint a **Restricted Access** key with only **Mail Send** scope. |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file: world-readable or not loaded by the Hermes runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` / sed-inject. |
| 6 | Missing `Content-Type: application/json` | SendGrid returns an opaque `400` instead of a parse error. | Always send `Content-Type: application/json` on `POST` calls. |
| 7 | Treating empty 202 body as a failure | `mail/send` success is 202 with no body; the message ID is in headers. | Check status code, not body; capture `X-Message-Id` for tracing. |
| 8 | Hitting rate limits silently | SendGrid throttles per plan; bursts return `429` with `X-RateLimit-Reset`. | Backoff on `429`; respect `X-RateLimit-Remaining`. |

---

## Verify

Confirm the credential, sender identity, and a live send before declaring done.

1. **Key is valid and scoped** (runs inside the container so the key never prints):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $SENDGRID_API_KEY" \
       https://api.sendgrid.com/v3/scopes'
   ```
   `200` = key valid. `401` = bad/empty key (re-check step 1). `403` = key is valid
   but missing the `mail.send` scope.

2. **Real send returns 202** (replace `you@yourdomain.com` with a deliverable inbox):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -X POST "https://api.sendgrid.com/v3/mail/send" \
       -H "Authorization: Bearer $SENDGRID_API_KEY" \
       -H "Content-Type: application/json" \
       -d "{\"personalizations\":[{\"to\":[{\"email\":\"you@yourdomain.com\"}]}],\"from\":{\"email\":\"$SENDGRID_FROM\"},\"subject\":\"Hermes test\",\"content\":[{\"type\":\"text/plain\",\"value\":\"hello\"}]}"'
   ```
   `202` = accepted and queued. `403` = sender not verified (pitfall 2). `400` =
   malformed body or unverified `from`.

3. **End-to-end from chat:** `@<agent> send a test email to you@yourdomain.com via
   SendGrid` should land in the inbox within seconds. Check the SendGrid Activity
   Feed (<https://app.sendgrid.com/email_activity>) if it does not.

---

## Definition of done

- [ ] `SENDGRID_API_KEY` and `SENDGRID_FROM` are in `/opt/data/.env` with `chmod 600`; neither is in `config.yaml` or chat.
- [ ] The `from` address is verified (Domain Auth or Single Sender Verification).
- [ ] `GET /v3/scopes` from inside the container returns `200`.
- [ ] `POST /v3/mail/send` from inside the container returns `202`.
- [ ] A chat-driven send lands in a real inbox (or appears as `delivered` in the SendGrid Activity Feed).

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
