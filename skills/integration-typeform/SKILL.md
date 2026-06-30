---
name: integration-typeform
description: Connect Typeform (lead forms, surveys, NPS) to a running Hermes agent using a static personal access token. Use when the user wants Hermes to read form responses, list forms, or create webhooks from Typeform.
---

# /integration-typeform — connect Typeform to Hermes

You are the engineer connecting Typeform to a running Hermes agent. Typeform is the agent's
lead-form and survey surface. Work autonomously; stop only for the two things a machine
cannot do: minting the personal access token in the Typeform admin UI and choosing scopes.

**Honest auth picture (verified 2026-06):** Typeform's official APIs (Create, Responses,
Webhooks) use a **static personal access token** (`tfp_...`) sent as `Authorization: Bearer`.
**No first-party Typeform MCP server is verified.** A community stdio MCP exists at
`github.com/dscovr/typeform-mcp` (env var `TYPEFORM_TOKEN`, runs under `uvx`). Hosted
third-party MCPs (Gumloop, viaSocket) exist but require sending your token to a third party,
so they are off the table for a self-hosted agent. Default path here is the REST API; Path B
covers the community stdio MCP if your Hermes build supports stdio.

## Before you start — gather (ask once)

1. **Personal access token** — starts with `tfp_`. Mint it at
   <https://admin.typeform.com/user/tokens> → **Generate a new token** → name it
   `hermes-agent` → check the scopes the agent actually needs (typical: `forms:read`,
   `responses:read`, `webhooks:read`, `webhooks:write`; add `forms:write` only if Hermes will
   create forms). Copy the token once — Typeform will not show it again.
2. **Workspace scope** — the token inherits the minting user's access. Confirm the user owns
   or is a member of the workspace containing the target forms, or calls return `403`.
3. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the token):
```bash
AGENT=<container-name>     # e.g. hermes-agent-mxlc-hermes-agent-1
TOKEN=<tfp_...>            # the personal access token; injected via sed, never echoed
```

---

## Step 1 — store the token in the Hermes runtime .env (chmod 600)

Write the secret to `/opt/data/.env` inside the container. Use `hermes config set` so Hermes
owns the write; never `echo >>` (it can merge onto a prior line) and never put it in
`config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set TYPEFORM_TOKEN "$TOKEN"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the var landed (prints `1`, never the value):
```bash
docker exec "$AGENT" sh -c "grep -c '^TYPEFORM_TOKEN=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (use the `|` delimiter — keeps the base procedure consistent):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^TYPEFORM_TOKEN=' /opt/data/.env || printf 'TYPEFORM_TOKEN=\n' >> /opt/data/.env; \
>    sed -i 's|^TYPEFORM_TOKEN=.*|TYPEFORM_TOKEN=${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect Typeform. Pick the path that matches your Hermes build.

A static token alone does not connect Typeform to the agent — it only stores the credential.
You must give the agent a tool surface. Two verified options:

### Path A (default) — generic HTTP tool against the Typeform REST API

No first-party remote MCP exists for Typeform. Point a generic HTTP/tool capability at the
REST API directly. The API is well-scoped, fast, and matches lead-form / survey use cases:

- **Base URL:** `https://api.typeform.com`
- **Auth header:** `Authorization: Bearer ${TYPEFORM_TOKEN}`
- **Content type:** `Content-Type: application/json`

Common endpoints:

- `GET /forms` — list all forms in the workspace.
- `GET /forms/{form_id}` — read form structure.
- `GET /forms/{form_id}/responses?page_size=50` — fetch submissions; paginate via
  `before` / `after` tokens for incremental sync.
- `PUT /forms/{form_id}/webhooks/{tag}` — register a webhook (lets the agent react to new
  submissions in real time).
- `GET /me` — fast token-validity probe.

> Do **not** wire Gumloop / viaSocket / similar hosted "Typeform MCP" endpoints through
> `/hermes-mcp-add` for production: they require sending your `tfp_` token to a third
> party, which defeats the point of self-hosting.

### Path B — community stdio MCP server (only if your Hermes supports stdio)

If your Hermes build can launch stdio MCP commands, the community server
`github.com/dscovr/typeform-mcp` exposes forms and responses as MCP tools and reads
`TYPEFORM_TOKEN` from env. It is **not first-party** — review the source before adopting it,
and pin a commit SHA rather than tracking `main`.

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add typeform \
    --command "uvx" \
    --args "--from,git+https://github.com/dscovr/typeform-mcp@<commit-sha>,typeform-mcp" \
    --env "TYPEFORM_TOKEN=\${TYPEFORM_TOKEN}"
```

The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
`docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
Use `${TYPEFORM_TOKEN}` indirection so the secret stays only in `/opt/data/.env`.

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
| 1 | Sending token to a hosted third-party "Typeform MCP" | Leaks the `tfp_` token to a vendor; violates self-hosted posture. | Use REST (Path A) or the community stdio MCP (Path B) pinned by SHA. |
| 2 | Token scopes too narrow | Calls return `403 forbidden` on otherwise-valid endpoints. | At mint time check `forms:read`, `responses:read`, plus `webhooks:*` if needed. |
| 3 | Token belongs to a user with no workspace access | `403` even with correct scopes. | Mint the token from a user who owns/joins the target workspace. |
| 4 | Hardcoding form IDs | Form IDs change between staging and prod copies. | Resolve via `GET /forms` then store the ID in Hermes memory or `/opt/data/.env`. |
| 5 | Polling instead of webhooks | Burns rate limit; misses fast submissions. | Register a webhook via `PUT /forms/{id}/webhooks/{tag}` and let Hermes react. |
| 6 | Secret in `config.yaml` or compose `.env` | Wrong file, world-readable or not loaded by runtime. | Only `/opt/data/.env`, `chmod 600`, via `config set` / sed. |
| 7 | Unpinned community MCP | `uvx --from git+...@main` pulls whatever lands; supply-chain risk. | Pin a commit SHA in `--args` and re-audit on bumps. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Tools registered (Path B only):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*typeform" | tail -5
   ```
2. **Token-validity probe (works for both paths):** run inside the container so the token
   comes from the runtime env and is never printed:
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Bearer $TYPEFORM_TOKEN" \
       "https://api.typeform.com/me"'
   ```
   `200` = token valid. `401` = bad/empty token (re-check step 1). `403` = scopes too narrow
   or wrong workspace (pitfall 2 / 3).
3. **List forms returns data:**
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     curl -sS -H "Authorization: Bearer $TYPEFORM_TOKEN" \
       "https://api.typeform.com/forms?page_size=1" | head -c 200'
   ```
   A JSON object with an `items` array is success. Empty `items` with `200` means the token
   works but the workspace has no forms yet.
4. **End-to-end from chat:** `@<agent> list my Typeform forms` should return form titles.

---

## Definition of done

- [ ] `TYPEFORM_TOKEN` is in `/opt/data/.env` with `chmod 600`; it is **not** in `config.yaml` or chat.
- [ ] Token scopes cover the use case (`forms:read`, `responses:read`, plus `webhooks:*` if needed).
- [ ] Typeform is connected via Path A (REST base documented and reachable) or Path B (community stdio MCP pinned by SHA, tools registered).
- [ ] `GET https://api.typeform.com/me` from inside the container returns `200`.
- [ ] A chat-driven `list forms` call returns real (or empty-valid) data.

See `reference/TROUBLESHOOTING.md` for gateway reload and MCP registration failure modes.
