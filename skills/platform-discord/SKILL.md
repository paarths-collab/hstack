---
name: platform-discord
description: Connect Hermes to Discord — bot token, the two required privileged intents, and channel behavior. Use when wiring Discord.
---

# /platform-discord — wire Discord

## Ask the user (human-only)
1. **Bot token:** Discord Developer Portal → New Application → Bot → copy token.
2. **Enable two Privileged Gateway Intents** (Portal → Bot → Privileged Gateway Intents):
   **Message Content Intent** (read text) AND **Server Members Intent** (resolve usernames). The bot
   is mute without them.
3. **Invite the bot** to their server (OAuth2 URL with bot scope).
4. Their **Discord user ID** for the allowlist (enable Developer Mode → right-click self → Copy ID).

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" config set DISCORD_BOT_TOKEN "$DISCORD_BOT_TOKEN"           # .env only
"$HERMES" config set DISCORD_ALLOWED_USERS "$DISCORD_USER_ID"        # comma-separated for multiple
chmod 600 ~/.hermes/.env
# config.yaml behavior keys (optional): discord.auto_thread, discord.require_mention
"$HERMES" gateway restart
"$HERMES" gateway status
```

## Pitfalls
- Without **both** intents the bot connects but never reads messages.
- `DISCORD_ALLOW_BOTS` is a no-op unless the bot's own ID is also in `DISCORD_ALLOWED_USERS`.
- `auto_thread: true` makes replies land in a thread, not the channel — set `false` if the user wants
  in-channel replies.

## Verify
User mentions/DMs the bot from the allowed account and gets a reply.
