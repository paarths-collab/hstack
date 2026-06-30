---
name: integration-twilio
description: Connect Twilio (SMS, voice, WhatsApp infrastructure) to a running Hermes agent using Account SID + Auth Token against the REST API. Use when the user wants Hermes to send SMS, place calls, or drive Twilio-hosted WhatsApp from chat or skills.
---

# /integration-twilio — connect Twilio to Hermes

You are the engineer connecting Twilio to a running Hermes agent. Twilio is the agent's
outbound comms infrastructure: SMS, voice, and the carrier side of WhatsApp Business. Work
autonomously; stop only for things a machine cannot do: minting the credentials in the Twilio
Console and (for WhatsApp) approving the WhatsApp Sender.

**Honest auth picture (verified 2026-06):** Twilio ships an official hosted MCP server at
`https://mcp.twilio.com/docs`, but per Twilio's own docs it is **documentation-only and
read-only** — "the server provides API search and documentation retrieval. It does not execute
API calls on your behalf." So it cannot send an SMS. The `twilio-labs/mcp` repo (npm package
`@twilio-alpha/mcp`) is a **local stdio** server, not a remote HTTP endpoint, and uses
`ACCOUNT_SID/API_KEY:API_SECRET`. The reliable, headless path for a self-hosted Hermes is the
**REST API** with Basic Auth, which is what this skill wires.

## Before you start — gather (ask once)

1. **Account SID** — starts with `AC`, 34 chars. Find it in the Twilio Console dashboard
   <https://console.twilio.com/>. Not secret on its own, but treat as sensitive.
2. **Auth Token** — 32 hex chars, shown next to the Account SID in the Console. Prefer an
   **API Key SID (`SK...`) + Secret** pair for production
   (<https://console.twilio.com/us1/account/keys-credentials/api-keys>) — same Basic Auth
   shape, revocable without rotating the account-wide token.
3. **From number / Messaging Service SID** — the E.164 sender (`+15551234567`) or a Messaging
   Service SID (`MG...`). For WhatsApp use `whatsapp:+14155238886` (sandbox) or your approved
   WhatsApp Sender.
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the secrets):
```bash
AGENT=<container-name>            # e.g. hermes-agent-mxlc-hermes-agent-1
TWILIO_SID=<AC...>                # Account SID
TWILIO_TOKEN=<auth-token-or-SK-secret>
TWILIO_KEY=<SK... or same as TWILIO_SID if using Auth Token>
TWILIO_FROM=<+15551234567 or MG... or whatsapp:+...>
```

If using an API Key, the Basic Auth username is the **API Key SID (`SK...`)** and the password
is the secret. If using the Auth Token, the username is the **Account SID** and the password
is the Auth Token. Pick one pair and stick with it.

---

## Step 1 — store the credentials in the Hermes runtime .env (chmod 600)

Write to `/opt/data/.env` inside the container via `hermes config set` so Hermes owns the
write. Never `echo >>` (it can merge onto a prior line) and never put credentials in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set TWILIO_ACCOUNT_SID "$TWILIO_SID"
docker exec -i -u hermes "$AGENT" hermes config set TWILIO_API_KEY     "$TWILIO_KEY"
docker exec -i -u hermes "$AGENT" hermes config set TWILIO_AUTH_TOKEN  "$TWILIO_TOKEN"
docker exec -i -u hermes "$AGENT" hermes config set TWILIO_FROM        "$TWILIO_FROM"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints counts, never values):
```bash
docker exec "$AGENT" sh -c \
  "for v in TWILIO_ACCOUNT_SID TWILIO_API_KEY TWILIO_AUTH_TOKEN TWILIO_FROM; do \
     printf '%s=%s\n' \"\$v\" \"\$(grep -c \"^\$v=\" /opt/data/.env)\"; \
   done"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (use the `|` delimiter — Twilio secrets are alnum but stay
> consistent with the base procedure):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^TWILIO_AUTH_TOKEN=' /opt/data/.env || printf 'TWILIO_AUTH_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^TWILIO_AUTH_TOKEN=.*|TWILIO_AUTH_TOKEN=${TWILIO_TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Twilio. Pick the path that matches your Hermes build.

A static credential alone does not give the agent a tool surface. Twilio has **no verified
first-party remote MCP server that executes API calls** as of 2026-06 (the hosted
`mcp.twilio.com/docs` is documentation-only). Two honest options:

### Path A (preferred) — generic HTTP tool against the Twilio REST API

This is the supported, headless, production-shape. Point a generic HTTP/tool capability at:

- **Base URL:** `https://api.twilio.com/2010-04-01`
  (EU residency: `https://api.dublin.ie1.twilio.com/2010-04-01`)
- **Auth:** HTTP Basic. Username = `TWILIO_API_KEY` (or `TWILIO_ACCOUNT_SID`), password =
  `TWILIO_AUTH_TOKEN`.
- **Content type:** `application/x-www-form-urlencoded` (Twilio uses form bodies, not JSON).

Common endpoints:

| Action | Method + path |
|---|---|
| Send SMS | `POST /Accounts/{AccountSid}/Messages.json` body `To=...&From=...&Body=...` |
| Send WhatsApp | same as SMS with `From=whatsapp:+...` and `To=whatsapp:+...` |
| Place call | `POST /Accounts/{AccountSid}/Calls.json` body `To=...&From=...&Url=<TwiML URL>` |
| Lookup number | `GET https://lookups.twilio.com/v2/PhoneNumbers/{E.164}` |
| List messages | `GET /Accounts/{AccountSid}/Messages.json?PageSize=20` |

Note `lookups.twilio.com` is a separate host (v2 API), not under `api.twilio.com`.

### Path B — local stdio MCP via `@twilio-alpha/mcp`

The `twilio-labs/mcp` repo publishes `@twilio-alpha/mcp` (npm) as a **stdio** server. It
authenticates with `ACCOUNT_SID/API_KEY:API_SECRET`. Register it only if your Hermes supports
stdio MCP servers (the HTTP probe flow in `/hermes-mcp-add` does not apply — that is for
remote HTTP endpoints):

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add twilio \
    --command "npx" \
    --args "-y,@twilio-alpha/mcp,\${TWILIO_ACCOUNT_SID}/\${TWILIO_API_KEY}:\${TWILIO_AUTH_TOKEN}" \
    --env "TWILIO_ACCOUNT_SID=\${TWILIO_ACCOUNT_SID},TWILIO_API_KEY=\${TWILIO_API_KEY},TWILIO_AUTH_TOKEN=\${TWILIO_AUTH_TOKEN}"
```

The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
`docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax. If
your build is HTTP-MCP-only and cannot launch a stdio command, use Path A.

### Path C (do not use) — wiring `mcp.twilio.com/docs` via `/hermes-mcp-add`

It will register, but every call returns docs/search hits rather than executing the API. The
agent cannot send an SMS through it. Skip.

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
| 1 | Wiring `mcp.twilio.com/docs` and expecting SMS to send | It is documentation-only; cannot execute API calls. | Use Path A (REST) or Path B (stdio). |
| 2 | Sending JSON body to `/Messages.json` | Twilio expects `application/x-www-form-urlencoded`; JSON returns 400. | Use form-encoded bodies. |
| 3 | `To` / `From` not in E.164 | Twilio rejects with 21211/21212. | Always `+<country><number>`; for WhatsApp prefix `whatsapp:`. |
| 4 | Auth Token used in dev, never rotated | Account-wide compromise if leaked. | Use API Key SID (`SK...`) + Secret per environment; revocable. |
| 5 | WhatsApp from a non-approved sender | Twilio returns 63007/63016 outside the sandbox. | Use sandbox `+14155238886` for tests; approved Sender for prod. |
| 6 | EU customer using `api.twilio.com` | Data residency violation. | Use `api.dublin.ie1.twilio.com` for IE1 region. |
| 7 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 8 | Trial account sending to unverified numbers | Returns 21608 / silent drop. | Verify destination numbers in Console, or upgrade. |

---

## Verify

Confirm the credentials and a live call before declaring done.

1. **Vars present (no value leak):**
   ```bash
   docker exec "$AGENT" sh -c \
     "grep -c '^TWILIO_ACCOUNT_SID=' /opt/data/.env; \
      grep -c '^TWILIO_AUTH_TOKEN=' /opt/data/.env"
   ```
   Both should print `1`.

2. **Read-only API ping returns 200** (lists last message; no side effects):
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -u "$TWILIO_API_KEY:$TWILIO_AUTH_TOKEN" \
       "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json?PageSize=1"'
   ```
   `200` = creds valid. `401` = bad SID/token. `404` = wrong Account SID in the path.

3. **Send a test SMS to a verified number:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -u "$TWILIO_API_KEY:$TWILIO_AUTH_TOKEN" \
       -X POST \
       --data-urlencode "To=+15555550123" \
       --data-urlencode "From=$TWILIO_FROM" \
       --data-urlencode "Body=hermes wiring check" \
       "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Messages.json"'
   ```
   `201` = queued. Replace `+15555550123` with a real verified destination.

4. **End-to-end from chat:** `@<agent> send a Twilio SMS to <verified-number> saying "ping"`
   should return a Twilio `MessageSid` (`SM...`) and the phone should receive it.

---

## Definition of done

- [ ] `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY` (or matching SID), `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` are in `/opt/data/.env` with `chmod 600`; none of them are in `config.yaml` or chat.
- [ ] Twilio is wired via Path A (REST base + Basic Auth documented and reachable) or Path B (stdio MCP tools registered). Path C (docs-only MCP) is not used for execution.
- [ ] Read-only call to `Messages.json?PageSize=1` from inside the container returns `200`.
- [ ] A test SMS POST returns `201` and the destination receives the message (or a chat-driven send returns a `MessageSid`).
- [ ] For WhatsApp: sender is the sandbox number or an approved Twilio WhatsApp Sender; recipient has joined the sandbox if applicable.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
