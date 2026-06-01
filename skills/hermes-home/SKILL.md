---
name: hermes-home
description: Set the home channel so cron jobs and proactive notifications are delivered somewhere durable. Use after a platform is wired.
---

# /hermes-home — set the home channel

The home channel is where Hermes delivers cron results, reminders, and notifications. Persist it via
env var (the runtime `/sethome` command does NOT survive a restart).

## Procedure (Telegram example)
```bash
HERMES="$HOME/.local/bin/hermes"
# DM = positive chat id; group/supergroup = negative (e.g. -100123456789).
"$HERMES" config set TELEGRAM_HOME_CHANNEL "$TG_HOME_CHAT_ID"
```
Other platforms: `DISCORD_HOME_CHANNEL`, `SLACK_HOME_CHANNEL` (a `C…` id, bot must be invited),
`MATTERMOST_HOME_CHANNEL`.

Runtime designation (interactive, per-platform):
- Telegram / Discord / Matrix / Mattermost → type `/sethome` in the chat.
- **Slack → `/hermes sethome`** (bare `/sethome` fails on Slack).

## Pitfalls
- `/sethome` is runtime-only — for durability across restarts, set the `*_HOME_CHANNEL` env var.
- Don't strip the leading `-` on Telegram group IDs. `SLACK_HOME_CHANNEL` must be a `C…` id, never `#name`.

## Verify
`hermes config show | grep -i home_channel`; a cron job's output arrives in that channel.
