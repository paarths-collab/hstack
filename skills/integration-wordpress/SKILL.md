---
name: integration-wordpress
description: Connect WordPress (self-hosted or .com) to a running Hermes agent for content and site automation — publish posts, manage media, edit pages, query users. Use when the user wants Hermes to read or write WordPress content.
---

# /integration-wordpress — connect WordPress to Hermes

You are the engineer connecting WordPress to a running Hermes agent. WordPress is the
agent's CMS surface: posts, pages, media, taxonomies, users. Work autonomously; stop only
for the things a machine cannot do: minting the application password inside wp-admin and
(for the MCP path) installing the MCP Adapter plugin on the target site.

**Honest auth picture (verified 2026-06):**
- **Self-hosted WordPress core** (5.6+) ships **Application Passwords** — a static
  per-app credential used over HTTPS Basic Auth against `/wp-json/wp/v2/*`. Perfect for a
  server-side agent. See <https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/>.
- A first-party **MCP Adapter** plugin (`WordPress/mcp-adapter`, replaces the archived
  `Automattic/wordpress-mcp`) exposes WordPress as MCP tools at
  `/wp-json/mcp/mcp-adapter-default-server`. The companion `Automattic/mcp-wordpress-remote`
  proxy is a **local stdio** server, not a remote HTTP MCP — its default auth is OAuth 2.1
  with PKCE, with optional JWT or Application Passwords for headless use.
- **WordPress.com hosted MCP** at `https://public-api.wordpress.com/wpcom/v2/mcp/v1` is
  **OAuth-only** (PKCE, dynamic client registration). Bearer-token / headless agents are
  not supported. Do **not** wire it via `/hermes-mcp-add`.

The path that actually works headless on a self-hosted site is the REST API plus
Application Passwords. The MCP plugin is optional polish on top.

## Before you start — gather (ask once)

1. **Site URL** — full origin, HTTPS required: `https://example.com` (no trailing slash).
   Application Passwords refuse to authenticate over plain HTTP.
2. **WordPress username** — the account the agent will act as. Editor or Administrator role
   so REST writes (posts, media) are not blocked by capability checks.
3. **Application Password** — mint at
   `https://example.com/wp-admin/profile.php` → scroll to **Application Passwords** →
   name it `hermes-agent` → **Add New Application Password** → copy the 24-character
   secret (shown once, spaces are cosmetic, keep or strip them — both work).
   Docs: <https://developer.wordpress.org/rest-api/reference/application-passwords/>.
4. **(Optional, MCP path only)** Install and activate the `mcp-adapter` plugin on the
   target site. Without it, `/wp-json/mcp/...` returns 404 and only the REST path works.
5. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (never log the password):
```bash
AGENT=<container-name>          # e.g. hermes-agent-mxlc-hermes-agent-1
WP_URL=https://example.com      # no trailing slash
WP_USER=<wp-username>
WP_APP_PASSWORD=<24-char-app-password>
```

---

## Step 1 — store credentials in the Hermes runtime .env (chmod 600)

Write the secrets to `/opt/data/.env` inside the container. Use `hermes config set` so
Hermes owns the write. Never `echo >>` (it can merge onto a prior line) and never put
secrets in `config.yaml`.

```bash
docker exec -i -u hermes "$AGENT" hermes config set WP_URL "$WP_URL"
docker exec -i -u hermes "$AGENT" hermes config set WP_USERNAME "$WP_USER"
docker exec -i -u hermes "$AGENT" hermes config set WP_APP_PASSWORD "$WP_APP_PASSWORD"
docker exec "$AGENT" sh -c "chmod 600 /opt/data/.env"
```

Verify the vars landed (prints `3`, never the values):
```bash
docker exec "$AGENT" sh -c "grep -cE '^(WP_URL|WP_USERNAME|WP_APP_PASSWORD)=' /opt/data/.env"
```

> If your Hermes build has no `config set` subcommand, inject directly with the sed pattern
> from `/hermes-mcp-add` (use `|` delimiter — app passwords contain spaces and `/`):
> ```bash
> docker exec "$AGENT" sh -c \
>   "grep -q '^WP_APP_PASSWORD=' /opt/data/.env || printf 'WP_APP_PASSWORD=\n' >> /opt/data/.env; \
>    sed -i 's|^WP_APP_PASSWORD=.*|WP_APP_PASSWORD=${WP_APP_PASSWORD}|' /opt/data/.env && chmod 600 /opt/data/.env"
> ```

---

## Step 2 — connect WordPress. Pick the path that matches your Hermes build.

A stored credential alone does not connect WordPress to the agent — it only stores the
secret. You must give the agent a tool surface. Two verified options:

### Path A (preferred for self-hosted) — generic HTTP tool against the WordPress REST API

This is the headless-friendly path. No plugin required, works on any WordPress 5.6+ site.

- **Base URL:** `${WP_URL}/wp-json/wp/v2`
- **Auth header:** HTTP Basic — `Authorization: Basic $(printf '%s:%s' "$WP_USERNAME" "$WP_APP_PASSWORD" | base64 -w0)`
- **Content type:** `Content-Type: application/json`

Common endpoints:
- `GET  /wp-json/wp/v2/posts` (list / search), `POST /wp-json/wp/v2/posts` (create)
- `GET  /wp-json/wp/v2/posts/{id}`, `POST /wp-json/wp/v2/posts/{id}` (update),
  `DELETE /wp-json/wp/v2/posts/{id}` (trash; add `?force=true` to hard-delete)
- `GET  /wp-json/wp/v2/pages`, `POST /wp-json/wp/v2/pages`
- `POST /wp-json/wp/v2/media` (upload — multipart, send `Content-Disposition: attachment; filename="..."`)
- `GET  /wp-json/wp/v2/users/me` (auth probe — use this in Step 4)

Full reference: <https://developer.wordpress.org/rest-api/reference/>.

### Path B — stdio MCP server via `Automattic/mcp-wordpress-remote`

Exposes WordPress actions as MCP tools (posts, media, users, comments, taxonomies). It is
a **local stdio** server (Node), so it is added to Hermes as a command-based MCP, not via
the HTTP `/hermes-mcp-add` probe flow. Register it if your Hermes build supports stdio MCP
servers and the target site has the `mcp-adapter` plugin installed:

```bash
docker exec -i -u hermes "$AGENT" \
  hermes mcp add wordpress \
    --command "npx" \
    --args "-y,@automattic/mcp-wordpress-remote" \
    --env "WP_API_URL=${WP_URL}/wp-json/mcp/mcp-adapter-default-server,WP_API_USERNAME=\${WP_USERNAME},WP_API_PASSWORD=\${WP_APP_PASSWORD}"
```

Notes:
- `WP_API_USERNAME` + `WP_API_PASSWORD` selects the legacy Application Passwords mode of
  the proxy — the only mode that works headless. OAuth 2.1 (the default) requires a
  browser and is wrong for a server-side agent.
- The flag names (`--command` / `--args` / `--env`) vary by Hermes version. Run
  `docker exec -u hermes "$AGENT" hermes mcp add --help` first and match its stdio syntax.
- If the target site is **WordPress.com** (hosted), there is no headless path: the hosted
  MCP at `public-api.wordpress.com/wpcom/v2/mcp/v1` is OAuth-only. Use Path A against the
  WordPress.com REST API (`/wp/v2/sites/{site}/...`) with a WordPress.com OAuth token
  instead, or move the agent to a self-hosted install.

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
| 1 | Trying to wire the WordPress.com MCP with a bearer token | Hosted endpoint is OAuth 2.1 / PKCE only; bearer rejected. | Use Path A REST + app password on self-hosted, or accept OAuth-only on .com. |
| 2 | HTTP instead of HTTPS | Application Passwords refuse plain HTTP; auth silently fails. | `WP_URL` must be `https://`. |
| 3 | App password copied with spaces stripped wrong | Spaces are cosmetic but the full 24 chars matter. | Copy raw value, store as-is. Both `abcd efgh ...` and `abcdefgh...` authenticate. |
| 4 | Wrong user role | Subscriber/Contributor cannot publish; writes 401/403. | Use Editor or Administrator. |
| 5 | Pretty permalinks disabled | `/wp-json/...` 404s when permalinks are default. | wp-admin → Settings → Permalinks → set to anything other than `Plain` and save. |
| 6 | Security plugins blocking REST | Wordfence/iThemes can block REST or strip `Authorization` header. | Allowlist `/wp-json/*`; confirm `Authorization` is not stripped by host. |
| 7 | Secret in `config.yaml` or compose `.env` | Wrong file → not loaded by runtime, may be world-readable. | Only `/opt/data/.env`, `chmod 600`, via `config set`/sed. |
| 8 | Two-factor on the WP user | App passwords bypass 2FA but some 2FA plugins also block REST writes. | Test with the auth probe in Step 4; if it 401s, check the 2FA plugin's REST settings. |

---

## Verify

Confirm the credential and a live call before declaring done.

1. **Auth probe (works for both paths):** run inside the container so the secret comes
   from the runtime env and is never printed.
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     AUTH=$(printf "%s:%s" "$WP_USERNAME" "$WP_APP_PASSWORD" | base64 -w0)
     curl -sS -o /dev/null -w "%{http_code}\n" \
       -H "Authorization: Basic $AUTH" \
       "$WP_URL/wp-json/wp/v2/users/me"'
   ```
   `200` = credential valid and scoped. `401` = bad user/password. `403` = role too low.
   `404` = pretty permalinks off or REST disabled (pitfall 5/6).

2. **Write probe (Path A, optional):** create a draft post, then trash it.
   ```bash
   docker exec -u hermes "$AGENT" sh -c '
     AUTH=$(printf "%s:%s" "$WP_USERNAME" "$WP_APP_PASSWORD" | base64 -w0)
     ID=$(curl -sS -X POST "$WP_URL/wp-json/wp/v2/posts" \
       -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
       -d "{\"title\":\"hermes-probe\",\"status\":\"draft\"}" \
       | sed -n "s/.*\"id\":\([0-9]*\).*/\1/p" | head -1)
     echo "created id=$ID"
     curl -sS -o /dev/null -w "delete=%{http_code}\n" \
       -X DELETE "$WP_URL/wp-json/wp/v2/posts/$ID?force=true" \
       -H "Authorization: Basic $AUTH"'
   ```

3. **Tools registered (Path B):**
   ```bash
   docker exec -u hermes "$AGENT" hermes logs 2>&1 \
     | grep -iE "registered.*tool|MCP server.*wordpress" | tail -5
   ```

4. **End-to-end from chat:** `@<agent> list my last 3 WordPress posts` should return real
   titles. An empty-but-valid response means the credential works but the site has no
   posts the user can see.

---

## Definition of done

- [ ] `WP_URL`, `WP_USERNAME`, `WP_APP_PASSWORD` are in `/opt/data/.env` with `chmod 600`; not in `config.yaml` or chat.
- [ ] Auth probe against `/wp-json/wp/v2/users/me` returns `200`.
- [ ] WordPress is connected via Path A (REST documented and reachable) or Path B (stdio MCP tools registered).
- [ ] Gateway reloaded with `stop` + `run` (not `restart`); new env is live.
- [ ] A chat-driven WordPress read or write returns real data.

See `reference/TROUBLESHOOTING.md` for gateway reload, REST 401/404, and MCP registration failure modes.
