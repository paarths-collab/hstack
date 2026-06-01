---
name: hermes-status
description: Health-check a Hermes Agent — gateway, platforms, memory, recent logs. Use when the user asks "is my agent ok?" or to diagnose.
---

# /hermes-status — health check

```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" --version
"$HERMES" gateway status                 # running? which unit?
"$HERMES" status --deep                   # overall
"$HERMES" memory status                   # memory backend + usage
"$HERMES" logs gateway -n 30              # recent gateway log
"$HERMES" -z 'reply with OK' | grep -qi OK && echo "end-to-end: OK" || echo "end-to-end: FAILED"
```

Report in plain language: online/offline, which platforms are live, memory usage vs the ceiling,
RSS/uptime (watch for the OOM leak — if RSS is many GB after a day, restart), and any errors in the log.
