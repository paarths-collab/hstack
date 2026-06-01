---
name: hermes-backup
description: Back up the Hermes config, secrets, memory, and sessions. Use before risky changes and on a schedule (there are no automatic backups).
---

# /hermes-backup — back up everything

Hermes has **no automatic backups**. Back up `~/.hermes` before any risky change and on a nightly cron.

```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" backup -o ~/hermes-backups/                 # built-in compressed archive
# or a plain tarball of the whole data dir:
tar czf ~/hermes-backups/hermes-$(date +%F).tgz -C ~ .hermes
```

Restore: `hermes import <zipfile>`.

## Recommended: nightly off-box backup
Add a cron (see `/hermes-cron`) that pushes `~/.hermes` to a **private** GitHub repo. Ensure `.env` is
either excluded or the repo is private — it contains secrets.

## Pitfalls
- `~/.hermes` can grow to multiple GB (~3,000 session files); prune sessions before backing up if huge.
- The archive contains secrets — store it somewhere private.
