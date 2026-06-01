---
name: platform-telegram
description: Connect Hermes to Telegram (the most reliable headless platform). Handles the BotFather token, the numeric user-ID allowlist, and the post-setup gateway nudge. Use when wiring Telegram.
---

# /platform-telegram — wire Telegram (the reliable headless wedge)

Telegram is the best first platform: pure env-var setup, no QR, no OAuth.

## Ask the user (the human-only parts)
1. **Bot token:** in Telegram, message **@BotFather** → `/newbot` → name it → username must end in `bot`
   → copy the token. (It may not echo when pasted — that's normal.)
2. **Their numeric user ID:** message **@userinfobot** → it replies with a number. This is the allowlist.

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" config set TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"     # from BotFather
"$HERMES" config set TELEGRAM_ALLOWED_USERS "$TG_USER_ID"        # numeric, from @userinfobot
chmod 600 ~/.hermes/.env
"$HERMES" gateway restart     # the "nudge" — the gateway often needs one restart after first setup
"$HERMES" gateway status
```

## Pitfalls (pre-solve)
- **The gateway DENIES all users by default** — an empty allowlist = nothing works. The numeric ID is
  mandatory. (DM pairing via `hermes pairing approve telegram <CODE>` is the alternative.)
- **Numeric ID, not @username** — the #1 "silent bot" cause. Validate the value is all digits.
- **Token copy errors** — the full token is `digits:letters`. Don't copy only the part before the colon.
- The bot often does nothing on the very first message until one `gateway restart`. Expect it.
- For groups: set the home/allowed chat IDs (group IDs are negative, e.g. `-100…`).

## Verify
User sends "hello" to the bot from the allowed account and gets a reply. If silent: `hermes gateway
status`, check the ID is numeric, then `/hermes-restart`.
