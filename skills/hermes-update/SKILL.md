---
name: hermes-update
description: Safely update Hermes — back up first, update, then re-verify platform wiring. Use when upgrading versions.
---

# /hermes-update — safe update

```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" backup                          # back up config + sessions FIRST
# Pinned (recommended): bump the pin deliberately, e.g.
#   pip install "hermes-agent==<new-version>"
# Or use the built-in updater: "$HERMES" update --backup
# Or re-run the official installer: curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-setup
"$HERMES" --version
"$HERMES" gateway restart                 # clean restart (see /hermes-restart)
"$HERMES" -z 'reply with OK' | grep -qi OK && echo "OK after update"
```

## Pitfalls
- The curl/`update` path tracks moving `main` — prefer bumping the **pinned** pip version for reproducibility.
- After updating, **re-verify each platform** still responds (config keys can change between versions).
- Avoid Docker image `v2026.4.23` (UID perms regression). Pin a known-good release — `v0.15.2` is the current stable default.
- Re-check `hermes <cmd> --help` if a command behaves differently — flags evolve.
