---
name: platform-mattermost
description: Connect Hermes to a self-hosted Mattermost — bot token, server URL, and Docker networking on a shared VPS. Use when wiring Mattermost.
---

# /platform-mattermost — wire Mattermost (self-hosted)

## Ask the user (human-only)
1. In Mattermost: System Console → Integrations → Bot Accounts → create a bot → copy its **access token**.
2. The Mattermost **server URL**.

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
# On a shared VPS where Mattermost is another container, use the INTERNAL Docker URL, not public DNS,
# and connect the containers on the same network first:
#   docker network connect <mattermost-network> <hermes-container>
"$HERMES" config set MATTERMOST_URL "http://mattermost-container:8065"   # https + no trailing slash if public
"$HERMES" config set MATTERMOST_TOKEN "$MATTERMOST_TOKEN"               # bot access token
"$HERMES" config set MATTERMOST_ALLOWED_USERS "$MM_USER_ID"            # 26-char user ID
chmod 600 ~/.hermes/.env
"$HERMES" gateway restart
# If it uses the pairing flow: hermes pairing approve mattermost <CODE>
```

## Pitfalls
- On a shared VPS, public DNS for Mattermost may point elsewhere (e.g. a CDN) — the container can't
  resolve it. Use the **internal Docker URL** and `docker network connect`.
- URL has no trailing slash. Token is shown once — save it.

## Verify
User messages the bot and gets a reply; approve pairing if prompted.
