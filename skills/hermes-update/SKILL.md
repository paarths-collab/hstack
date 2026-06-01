---
name: hermes-update
description: Safely update Hermes — back up first, update, then re-verify platform wiring. Use when upgrading versions.
---

# /hermes-update — safe update

```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" backup                          # back up config + sessions FIRST
# Pinned (recommended): bump the pin deliberately, e.g.
#   pip install "hermes-agent==<new-version>" && hermes postinstall
# Or: "$HERMES" update --backup
"$HERMES" --version
"$HERMES" gateway restart                 # clean restart (see /hermes-restart)
"$HERMES" -z 'reply with OK' | grep -qi OK && echo "OK after update"
```

## Pitfalls
- The curl/`update` path tracks moving `main` — prefer bumping the **pinned** pip version for reproducibility.
- After updating, **re-verify each platform** still responds (config keys can change between versions).
- Avoid Docker image `v2026.4.23` (UID perms regression) and `v0.15.2` if you use the dashboard (#34701).
- Re-check `hermes <cmd> --help` if a command behaves differently — flags evolve.
