---
name: integration-mailchimp
description: Connect Mailchimp (email marketing — campaigns, audiences, lists, automations) to a running Hermes agent. Wires Mailchimp's official Transactional MCP when transactional sending is needed, and configures the Marketing API REST surface for campaign/audience work. Use when the user wants Hermes to send, schedule, or report on email campaigns and lists.
---

# /integration-mailchimp — connect Mailchimp to Hermes

You are the engineer connecting Mailchimp to a running Hermes agent. Mailchimp is the agent's
email marketing surface: audiences (lists), campaigns, automations, templates, segments, and
reports. Work autonomously; stop only for the two things a machine cannot do: minting the
API key in the Mailchimp UI, and (for transactional) enabling the AI Agents permission group.

**Honest auth picture (verified 2026-06):** Mailchimp ships **one** official hosted remote MCP
server, and it covers **Transactional Messaging only** (the Mandrill product) at
`https://mandrillapp.com/mcp` with bearer auth. There is **no first-party remote MCP for the
Marketing API** (campaigns, audiences, lists, automations) as of 2026-06 — only community
servers (Pipeworx, cyanheads, Apify, Zapier) which are not first-party and are not wired here
by default. For Marketing API work we configure the REST surface directly; the user can
opt-in to a community MCP if they vet it.

## Before you start — gather (ask once)

1. **What does the user actually need?**
   - **Marketing** (campaigns, audiences, subscribers, automations, reports) → Path A below.
   - **Transactional** (one-off API-driven sends via Mandrill) → Path B below.
   - Both → run Path A first, then Path B.
2. **Marketing API key** (Path A) — 32 hex chars + `-` + data center suffix, e.g.
   `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-us21`. Mint at
   <https://admin.mailchimp.com/account/api> → **Create A Key**. The suffix after the `-` is
   the data center (`us21`, `us6`, ...) and is required to build the API base URL.
3. **Transactional API key** (Path B, only if needed) — mint in the Mandrill app under
   **Settings → SMTP & API Info**. If the key is restricted, enable the **AI Agents**
   permission group; Mailchimp's docs require it for the MCP to function.
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log secrets):
```bash
AGENT=<container-name>             # e.g. hermes-agent-mxlc-hermes-agent-1
MC_KEY=<32hex>-<dc>                # marketing key, e.g. abc...def-us21
MC_DC=$(echo "$MC_KEY" | awk -F- '{print $NF}')   # extracts data center, e.g. us21
MANDRILL_KEY=<mandrill-key>        # only for Path B
```

---

## Path A — Marketing API (campaigns, audiences, lists)

### Step A1 — store the key and data center in the Hermes runtime .env

Write both values to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put secrets in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set MAILCHIMP_API_KEY "$MC_KEY"
docker exec -i -u hermes "$AGENT" hermes config set MAILCHIMP_DC "$MC_DC"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify both vars landed (prints `1` twice, never the values):
```bash
docker exec "$AGENT" sh -c "grep -c '^MAILCHIMP_API_KEY=' /opt/data/.env"
docker exec "$AGENT" sh -c "grep -c '^MAILCHIMP_DC=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (the `|` delimiter is mandatory — the key contains `-`):
> ```bash
> docker exec "$AGENT" sh -c "
>   grep -q '^MAILCHIMP_API_KEY=' /opt/data/.env || printf 'MAILCHIMP_API_KEY=\n' >> /opt/data/.env
>   grep -q '^MAILCHIMP_DC=' /opt/data/.env || printf 'MAILCHIMP_DC=\n' >> /opt/data/.env
>   sed -i 's|^MAILCHIMP_API_KEY=.*|MAILCHIMP_API_KEY=${MC_KEY}|' /opt/data/.env
>   sed -i 's|^MAILCHIMP_DC=.*|MAILCHIMP_DC=${MC_DC}|' /opt/data/.env
>   chmod 600 /opt/data/.env"
> ```

### Step A2 — wire the Marketing REST API as a tool surface

No first-party remote MCP exists for the Marketing API (verified 2026-06). Point a generic
HTTP/tool capability at the REST base; the data center is part of the host, so use the var:

- **Base URL:** `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0`
- **Auth header:** `Authorization: Bearer ${MAILCHIMP_API_KEY}` (HTTP Basic also accepted;
  username is anything, password is the full key including suffix)
- **Content type:** `Content-Type: application/json`

Common endpoints:

| Action | Method + path |
|---|---|
| List audiences | `GET /lists` |
| Add subscriber | `POST /lists/{list_id}/members` |
| Update subscriber | `PATCH /lists/{list_id}/members/{subscriber_hash}` |
| List campaigns | `GET /campaigns` |
| Send campaign | `POST /campaigns/{campaign_id}/actions/send` |
| Campaign report | `GET /reports/{campaign_id}` |
| Search members | `GET /search-members?query=...` |

> `subscriber_hash` is the **lowercased MD5** of the email. Mailchimp rejects raw emails on
> member endpoints.

**Opt-in community MCP (only if the user vets it):** community servers exist (Pipeworx,
cyanheads, Apify, Zapier). They are not first-party. If the user explicitly wants one wired,
run `/hermes-mcp-add` against the chosen URL with the user's chosen bearer scheme; do not
assume the auth shape, probe it.

---

## Path B — Transactional (Mandrill) via official remote MCP

This path uses Mailchimp's first-party hosted MCP. Verified URL and shape:

- **URL:** `https://mandrillapp.com/mcp`
- **Auth:** `Authorization: Bearer <Mandrill API key>`
- **Coverage:** transactional only (`call_api`, `diagnose_failed_send`, `build_template`, ...).
  Does **not** see campaigns/audiences/lists.

### Step B1 — wire it via `/hermes-mcp-add`

Follow `/hermes-mcp-add` exactly, with these values:

```bash
URL=https://mandrillapp.com/mcp
NAME=mandrill                  # → env var MCP_MANDRILL_API_KEY
TOKEN=$MANDRILL_KEY            # the Mandrill key from gather step 3
```

Then run the 6-step base procedure (probe → register with placeholder → `sed`-inject real
token using `|` delimiter → `gateway stop` + `gateway run` → verify logs). The whole point of
`/hermes-mcp-add` is to do this safely; do not reinvent it here.

If the Mandrill key is **restricted**, you must enable the **AI Agents** permission group in
the Mandrill UI first or every `tools/call` returns an auth error even though `initialize`
succeeds.

---

## Step C — reload the gateway so the new env is picked up

If you only ran Path A, the gateway still needs a reload because new env vars were added.
Stop + run (not `restart`) — same rule as `/hermes-mcp-add`.

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
| 1 | Using the key without its data center suffix | Marketing API base URL is `https://<dc>.api.mailchimp.com/3.0`; missing `dc` returns DNS failure or 404 | Always split on `-` and store `MAILCHIMP_DC` alongside the key |
| 2 | Expecting the official MCP to cover campaigns | `mandrillapp.com/mcp` is Transactional only; Marketing API has no first-party MCP | Path A uses REST; only use Path B for transactional sends |
| 3 | Passing raw email to `/lists/.../members/{hash}` | Endpoint expects lowercased MD5 of the email | Hash with `md5(lower(email))` before the call |
| 4 | Restricted Mandrill key with no AI Agents permission | `initialize` succeeds, `tools/call` 401s | Toggle **AI Agents** permission group in the Mandrill UI |
| 5 | Secret in `config.yaml` or compose `.env` | Wrong file → world-readable or not loaded by Hermes runtime | Only `/opt/data/.env`, `chmod 600`, via `config set` or sed-inject |
| 6 | Sending campaigns from a non-verified domain | Mailchimp blocks send with cryptic 400 | Verify the sending domain (DKIM/SPF) in Mailchimp before testing send |
| 7 | Rate limits | Marketing API limits at 10 simultaneous connections per account; bursts get `429` | Serialize bulk member adds; use batch operations (`POST /batches`) for >1000 ops |
| 8 | Wiring an unvetted community MCP | Community servers proxy your account key; a bad one exfiltrates the audience | Only wire community MCPs the user explicitly approves; prefer REST until then |

---

## Verify

Confirm the credential and a live call before declaring done.

### Path A (Marketing)

Run inside the container so the key comes from the runtime env and is never printed:

```bash
docker exec -u hermes "$AGENT" sh -c '
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $MAILCHIMP_API_KEY" \
    "https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/ping"'
```

`200` with `"health_status":"Everything's Chimpy!"` (visible via `-o -` if you want) = key
valid and data center correct. `401` = bad/empty key. DNS failure = `MAILCHIMP_DC` wrong or
missing.

Then list audiences to confirm scope:
```bash
docker exec -u hermes "$AGENT" sh -c '
  curl -sS -o /dev/null -w "%{http_code}\n" \
    -H "Authorization: Bearer $MAILCHIMP_API_KEY" \
    "https://${MAILCHIMP_DC}.api.mailchimp.com/3.0/lists?count=1"'
```

### Path B (Transactional)

After `/hermes-mcp-add` finishes:
```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool.*mandrill|MCP server.*mandrill" | tail -5
```

### End-to-end from chat

`@<agent> list my Mailchimp audiences` (Path A) or `@<agent> using mandrill, send a test
transactional email to <addr>` (Path B). An empty-but-valid response is still a pass for the
wiring.

---

## Definition of done

- [ ] `MAILCHIMP_API_KEY` and `MAILCHIMP_DC` are in `/opt/data/.env` with `chmod 600`; not in `config.yaml` or chat (Path A).
- [ ] If Path B: `MCP_MANDRILL_API_KEY` lives in `/opt/data/.env`, `mandrillapp.com/mcp` is registered, `hermes logs` shows `registered N tool(s)` for `mandrill`.
- [ ] `GET /3.0/ping` from inside the container returns `200` (Path A).
- [ ] Gateway reloaded via `gateway stop` + `gateway run`.
- [ ] A chat-driven Mailchimp call returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload, MCP registration, and data-center suffix failure modes.
