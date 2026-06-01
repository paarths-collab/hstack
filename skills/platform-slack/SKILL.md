---
name: platform-slack
description: Connect Hermes to Slack via Socket Mode (no public endpoint, no signing secret). Use when wiring Slack.
---

# /platform-slack — wire Slack (Socket Mode)

## Ask the user (human-only)
1. Create a Slack app → enable **Socket Mode**.
2. **Bot token** `xoxb-…` (Install App; scopes: `chat:write`, `channels:history`, `groups:history`,
   `im:history`, `files:read`).
3. **App token** `xapp-…` (Socket Mode; scope `connections:write`).
4. Their Slack **Member ID(s)** for the allowlist, and the **channel ID** (`C…`) for the home channel.
5. **Invite the bot** to the channel: `/invite @YourBot` — or proactive delivery silently fails.

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" config set SLACK_BOT_TOKEN "$SLACK_BOT_TOKEN"     # xoxb-
"$HERMES" config set SLACK_APP_TOKEN "$SLACK_APP_TOKEN"     # xapp-
"$HERMES" config set SLACK_ALLOWED_USERS "$SLACK_MEMBER_ID"
chmod 600 ~/.hermes/.env
"$HERMES" gateway restart
```

## Pitfalls
- Needs **both** tokens (`xoxb-` and `xapp-`). **No signing secret** (Socket Mode) — don't add one.
- Home channel must be a **channel ID (`C…`), never a `#name`**, and the bot must be invited.
- `/sethome` does NOT work on Slack — it's `/hermes sethome` (Slack namespaces slash commands).

## Verify
User messages the bot in the invited channel and gets a reply.
