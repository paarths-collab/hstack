---
name: integration-postmark
description: Connect Postmark (transactional email) to a running Hermes agent using a static Server API token. Use when the user wants Hermes to send transactional emails, dispatch template emails, list templates, or pull delivery stats.
---

# /integration-postmark — connect Postmark to Hermes

You are the engineer connecting Postmark to a running Hermes agent. Postmark is the agent's
transactional email sender (single sends, templated sends, delivery stats). Work autonomously;
stop only for the two things a machine cannot do: minting the Server API token in the
Postmark dashboard, and confirming the From address is a verified Sender Signature or sits on
a verified domain.

**Honest auth picture (verified 2026-06):** Postmark Labs (ActiveCampaign) ships an official
**stdio** MCP server at `@activecampaign/postmark-mcp`
(<https://github.com/ActiveCampaign/postmark-mcp>). There is **no hosted/remote HTTP MCP
endpoint** for Postmark. Auth is a static **Server API token** passed to the process via the
`POSTMARK_SERVER_TOKEN` env var; every REST call carries it as the
`X-Postmark-Server-Token` header. That makes it a clean fit for a self-hosted agent — no
OAuth dance, no user redirect.

## Before you start — gather (ask once)

1. **Postmark Server API token** — a single Server-scoped token (not the Account token, not
   an SMTP token). Mint it in the Postmark dashboard:
   <https://account.postmarkapp.com/servers> → pick the Server you want the agent to send
   from → **API Tokens** tab → copy the token. One token per Server isolates blast radius.
2. **Verified From address** — Postmark will not deliver mail from an unverified sender. Use
   a Sender Signature (single address) or any address on a verified Domain. Confirm before
   the first send or every call returns `ErrorCode 400` / `422`.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<postmark-server-token>   # the Server API token; injected via sed, never echoed
FROM=<verified-from-address>    # e.g. agent@yourdomain.com
```

---

## Step 1 — store the token in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set POSTMARK_SERVER_TOKEN "$TOKEN"
docker exec -i -u hermes "$AGENT" hermes config set POSTMARK_FROM_ADDRESS "$FROM"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `1` per var, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^POSTMARK_SERVER_TOKEN=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^POSTMARK_FROM_ADDRESS=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (note the `|` delimiter — Postmark tokens are UUID-shaped but stay
> consistent with the base procedure):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^POSTMARK_SERVER_TOKEN=' /opt/data/.env || printf 'POSTMARK_SERVER_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^POSTMARK_SERVER_TOKEN=.*|POSTMARK_SERVER_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Postmark. Pick the path that matches your Hermes build.

A static token alone does **not** connect Postmark to the agent — it only stores the
credential. You must give the agent a tool surface. Two verified options:

### Path A (preferred) — official stdio MCP server

The official server `@activecampaign/postmark-mcp` reads `POSTMARK_SERVER_TOKEN` and exposes
`send_email`, `send_email_with_template`, `list_templates`, and `get_delivery_stats` as MCP
tools. It is a **local stdio** server (run with `npx`), so it is added to Hermes as a
command-based MCP, **not** via the HTTP `/hermes-mcp-add` probe flow (that flow is for remote
HTTP endpoints — Postmark does not have one). Register it if your Hermes supports stdio MCP
servers:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add postmark \
    --command "npx" \
    --args "-y,@activecampaign/postmark-mcp" \
    --env "POSTMARK_SERVER_TOKEN=\${POSTMARK_SERVER_TOKEN}" \
    --env "DEFAULT_SENDER_EMAIL=\${POSTMARK_FROM_ADDRESS}" \
    --env "DEFAULT_MESSAGE_STREAM=outbound"
```

`DEFAULT_MESSAGE_STREAM` should be `outbound` for transactional traffic; use
`broadcast` only if this Server is configured for broadcast streams. Use `${POSTMARK_SERVER_TOKEN}`
indirection so the secret stays only in `/opt/data/.env`.

> The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
> `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
> If your build is HTTP-MCP-only and cannot launch a stdio command, use Path B.

### Path B — generic HTTP tool against the Postmark REST API

No remote MCP exists for Postmark. If you cannot run the stdio server, point a generic
HTTP/tool capability at the REST API directly:

- **Base URL:** `https://api.postmarkapp.com`
- **Auth header:** `X-Postmark-Server-Token: ${POSTMARK_SERVER_TOKEN}` (case-insensitive)
- **Accept:** `application/json`
- **Content-Type:** `application/json`

Common endpoints:

- `POST /email` — single transactional send (body needs `From`, `To`, `Subject`,
  `TextBody` and/or `HtmlBody`, optional `MessageStream`).
- `POST /email/withTemplate` — templated send (body needs `From`, `To`,
  `TemplateId` or `TemplateAlias`, and `TemplateModel`).
- `POST /email/batch` — up to 500 messages in one call.
- `GET  /templates` — list templates on the Server.
- `GET  /stats/outbound` — delivery stats (supports `fromdate`, `todate`, `tag`).

> Do **not** swap in `Authorization: Bearer ...` — Postmark rejects it. The token goes in
> `X-Postmark-Server-Token` and **only** there.

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
| 1 | Using the Account API token instead of the Server token | Account tokens authenticate `/servers`, `/domains`, etc. — they get `401` on `/email`. | Mint the token under a specific Server → API Tokens tab. |
| 2 | Sending from an unverified address | Postmark blocks the send with `ErrorCode 400`/`422`; nothing reaches the inbox. | Verify a Sender Signature or a Domain before first send; use that address as `FROM`. |
| 3 | Wrong message stream | A token scoped to an `outbound` Server sending on a `broadcast` stream (or vice versa) returns `422`. | Set `DEFAULT_MESSAGE_STREAM=outbound` for transactional; only use `broadcast` if the Server is broadcast-configured. |
| 4 | Trying to wire a remote MCP URL | None exists for Postmark; people invent `mcp.postmarkapp.com` and `/hermes-mcp-add` fails with DNS / 404. | Use the stdio server (Path A) or REST (Path B). |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` / sed. |
| 6 | Hard rate ceiling on sandbox accounts | Unconfirmed Postmark accounts cap at 100 emails total and only to the signup address. | Confirm the account and verify a Sender Signature before agent goes live. |
| 7 | Sending HTML without a `TextBody` fallback | Some providers junk HTML-only mail; deliverability drops. | Always include `TextBody` (or both) on `/email` calls. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path A):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*postmark" | tail -5
   ```
2. **Token is valid (cheap, no send):** list templates from inside the container so the
   token comes from runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Accept: application/json" \
       -H "X-Postmark-Server-Token: $POSTMARK_SERVER_TOKEN" \
       "https://api.postmarkapp.com/templates?count=1&offset=0"'
   ```
   `200` = token valid and scoped. `401` = bad/empty token (re-check step 1). `422` with
   `ErrorCode 10` also means the token is wrong.
3. **Real send (use a throwaway recipient you control):**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -X POST "https://api.postmarkapp.com/email" \
       -H "Accept: application/json" \
       -H "Content-Type: application/json" \
       -H "X-Postmark-Server-Token: $POSTMARK_SERVER_TOKEN" \
       -d "{\"From\":\"$POSTMARK_FROM_ADDRESS\",\"To\":\"$POSTMARK_FROM_ADDRESS\",\"Subject\":\"hermes wiring check\",\"TextBody\":\"ok\",\"MessageStream\":\"outbound\"}"'
   ```
   Expect `"ErrorCode":0` and a `MessageID`. Anything else — read `Message` for the cause.
4. **End-to-end from chat:** `@<agent> send a test email to <you> via Postmark` should
   deliver, with a `MessageID` echoed back.

---

## Definition of done

- [ ] `POSTMARK_SERVER_TOKEN` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] The configured From address is a verified Sender Signature or sits on a verified Domain.
- [ ] Postmark is connected via Path A (stdio MCP tools registered) or Path B (REST base + `X-Postmark-Server-Token` documented and reachable).
- [ ] `GET /templates` from inside the container returns `200`.
- [ ] A real `POST /email` returns `ErrorCode: 0` with a `MessageID`, or a chat-driven send delivers.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
