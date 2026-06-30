---
name: platform-teams
description: Connect Hermes to Microsoft Teams via an Azure AD app registration and a public HTTPS webhook. Handles the AAD object-ID allowlist. Use when wiring Teams for enterprise chat.
---

# /platform-teams — wire Microsoft Teams (Azure AD + public webhook)

Microsoft Teams is an **officially supported** platform in upstream Hermes Agent (the Teams adapter
ships in v0.15.x and is documented in the Hermes user guide). Unlike Telegram or Slack-socket-mode,
**Teams is not headless-friendly**: it delivers messages by calling a public HTTPS webhook, so the
Hermes instance needs a publicly reachable endpoint with a valid TLS cert (Teams rejects
self-signed certs and will not call `localhost`). Plan for a real domain in production or a dev
tunnel (devtunnel / cloudflared / ngrok) for local testing **before** running this skill.

## Ask the user (the human-only parts)

1. **Azure AD app registration** — easiest path is the Teams CLI (`teams app create --name "Hermes"
   --endpoint "https://<public-host>/api/messages"`). It prints three values:
   - `TEAMS_CLIENT_ID` (Azure AD application/client ID)
   - `TEAMS_CLIENT_SECRET` (treat like a password; rotate periodically)
   - `TEAMS_TENANT_ID` (Azure AD tenant ID)
2. **Allowed users** — comma-separated **AAD object IDs** (GUIDs, not email addresses or UPNs).
   The user can find their own via `teams status --verbose` or in the Azure portal under
   Entra ID → Users → <user> → Object ID.
3. **Public HTTPS endpoint** — the URL the Teams service will POST to (e.g.
   `https://hermes.example.com/api/messages`). Must be reachable from the public internet with a
   valid TLS cert. Decide this **before** registering the app, because the endpoint is baked into
   the app registration.
4. **Webhook port** — defaults to `3978`. Whatever you choose must be the port your reverse
   proxy / tunnel forwards `/api/messages` to.

## Procedure

**HARD GATE: do not enable Teams until the allowlist is set.** The Teams gateway is default-deny
only when `TEAMS_ALLOWED_USERS` holds at least one AAD object ID. With an empty allowlist (or
`TEAMS_ALLOW_ALL_USERS=true`), anyone who can find or install your bot in their Teams tenant can
interact with it — that is the wrong default in an enterprise. Set the allowlist first, then
enable, then reload the gateway.

```bash
HERMES="$HOME/.local/bin/hermes"

# 1. Set the allowlist FIRST — this is the gate. AAD object IDs are GUIDs
#    (e.g. 11111111-2222-3333-4444-555555555555). Comma-separate multiples.
"$HERMES" config set TEAMS_ALLOWED_USERS "$TEAMS_USER_OBJECT_ID"

# 2. Write the Azure AD app credentials and webhook port via `hermes config set`
#    (never in config.yaml, never echo'd to .env, never in chat).
"$HERMES" config set TEAMS_CLIENT_ID     "$TEAMS_CLIENT_ID"
"$HERMES" config set TEAMS_CLIENT_SECRET "$TEAMS_CLIENT_SECRET"
"$HERMES" config set TEAMS_TENANT_ID     "$TEAMS_TENANT_ID"
"$HERMES" config set TEAMS_PORT          "3978"
chmod 600 ~/.hermes/.env

# 3. Refuse to continue if the allowlist is empty (read it back; there is no `config get`).
if ! "$HERMES" config show | grep -qE '^TEAMS_ALLOWED_USERS *[:=] *[0-9a-fA-F]'; then
  echo "ABORT: TEAMS_ALLOWED_USERS is unset/empty — anyone in the tenant could message the agent." >&2
  exit 1
fi

# 4. Only now enable the platform.
"$HERMES" config set TEAMS_ENABLED true
```

New env vars need a clean re-read — use stop + run, not restart:
```bash
"$HERMES" gateway stop
sleep 3
"$HERMES" gateway run
sleep 8
"$HERMES" gateway status
```

Then point the Azure AD app's messaging endpoint at your public HTTPS URL
(`https://<public-host>/api/messages`) — this is configured at app-registration time via the Teams
CLI, but verify the reverse proxy / tunnel actually forwards `/api/messages` to `TEAMS_PORT` on the
Hermes host before testing.

## Pitfalls
- **`TEAMS_ALLOWED_USERS` is a hard gate, not a nicety** — leave it unset/empty (or set
  `TEAMS_ALLOW_ALL_USERS=true`) and **anyone in the Azure tenant who can install or find your bot
  can drive it**, executing skills and tools on their behalf. Never enable Teams before the
  allowlist holds at least one AAD object ID.
- **AAD object IDs are GUIDs, not emails or UPNs** — `mario@digitalcrew.tech` is not a valid
  allowlist value; the GUID from `teams status --verbose` (or the Azure portal) is. Wrong format
  is a common "silent bot" cause.
- **Public HTTPS is mandatory** — Teams will not POST to `localhost`, will not accept self-signed
  certs, and will silently drop messages if the endpoint 5xxs. Confirm `curl -I
  https://<public-host>/api/messages` returns a Hermes response before blaming the bot.
- **Endpoint is baked into the app registration** — changing your public host later requires
  updating the messaging endpoint in Azure AD (or via `teams app update`). Pick the final URL
  before registering.
- **`TEAMS_CLIENT_SECRET` is a credential** — only ever set via `hermes config set` into
  `~/.hermes/.env` (chmod 600). Never paste it in chat, never commit it, rotate periodically.
- **Two `.env` files exist** in Dockerised installs (compose-level vs `/opt/data/.env`); Teams
  vars belong in the Hermes runtime env (`~/.hermes/.env` on bare-metal, `/opt/data/.env` in the
  container), not the compose `.env`.

## Verify
1. `hermes gateway status` reports the gateway running and the `teams` adapter loaded.
2. From the public internet: `curl -sS -o /dev/null -w '%{http_code}\n' https://<public-host>/api/messages`
   returns a Hermes HTTP response (typically `401`/`405` for an unsigned GET — **not** a timeout
   or TLS error).
3. An allowed user (AAD object ID on `TEAMS_ALLOWED_USERS`) DMs the bot in Teams and gets a reply.
4. A user **not** on the allowlist gets no reply (default-deny confirmed).

## Definition of done
- [ ] `TEAMS_ALLOWED_USERS` holds at least one AAD object ID (GUID format), set via `hermes config set`.
- [ ] `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_TENANT_ID`, and `TEAMS_PORT` are set via `hermes config set` (never in `config.yaml`, never in chat), and `~/.hermes/.env` is `chmod 600`.
- [ ] `TEAMS_ENABLED true` was set **only after** the allowlist gate passed (the platform was never enabled with an empty allowlist), and `TEAMS_ALLOW_ALL_USERS` is unset or `false`.
- [ ] A public HTTPS endpoint (`https://<public-host>/api/messages`) with a valid (non-self-signed) TLS cert is reachable from the internet and forwards to `TEAMS_PORT` on the Hermes host; the Azure AD app's messaging endpoint matches it.
- [ ] Gateway was reloaded with `gateway stop` + `gateway run` (not `restart`) and `hermes gateway status` reports it running with the Teams adapter loaded.
- [ ] An allowed AAD user DMs the bot and gets a reply; a non-allowlisted user gets no reply.

See `reference/TROUBLESHOOTING.md` for gateway and platform failure modes.
