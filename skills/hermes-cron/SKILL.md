---
name: hermes-cron
description: Add, list, and manage scheduled tasks (cron) for the Hermes agent in plain language. Use when the user wants recurring jobs like a daily briefing or backup.
---

# /hermes-cron — scheduled tasks

Cron jobs run the agent on a timer and deliver results to the home channel.

## Procedure
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" cron create "every 1d" "Push changes to the backup GitHub repo"
"$HERMES" cron create "every 1d" "Summarize my unread emails and send a briefing"
"$HERMES" cron list
```
Schedules: one-shot (`30m`, `2h`), intervals (`every 30m`, `every 2h`, `every 1d`), cron expressions
(`0 9 * * 1-5`), or ISO timestamps. Manage: `cron pause|resume|run|remove <id>`.

You can also just tell the agent in chat: *"every morning at 8am, summarize my unread emails"* — it
writes the cron itself and converts to UTC.

## Recommended default crons (reliability)
- **Nightly gateway restart** — mitigates the memory leak / OOM (#25315) before it crashes.
- **Nightly backup** — push `~/.hermes` to a private repo (no automatic backups exist).
- **Weekly session prune** — `~/.hermes` bloats to multi-GB with ~3,000 session files over time.

## Pitfalls
- Cron-run sessions can't recursively create crons. Each runs in a fresh session. Scripts live in `~/.hermes/scripts/`.
