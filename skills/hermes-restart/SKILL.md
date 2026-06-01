---
name: hermes-restart
description: Cleanly restart the Hermes gateway, clearing stale locks that cause restart loops. Use when the gateway is stuck, unresponsive, or after config changes.
---

# /hermes-restart — clean gateway restart

A naive restart hits the stale-PID trap (#13655): after a crash/OOM the gateway won't start, looping
with "PID file race lost… Exiting." Always clear locks first.

## Clean-restart sequence
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" gateway stop
rm -f ~/.hermes/gateway.pid
rm -f ~/.local/state/hermes/gateway-locks/*.lock
"$HERMES" gateway start
"$HERMES" gateway status
```

## Autostart (survive reboot) — platform-specific
- **Linux (systemd):** `hermes gateway install` (add `sudo … --system` for boot-without-login) +
  `loginctl enable-linger "$USER"`. Harden the unit with `ExecStartPre=/bin/rm -f %h/.hermes/gateway.pid`.
  Never hardcode the unit name (it varies by version/profile) — query `hermes gateway status`.
- **WSL2:** do NOT use systemd (#18032 — it falsely reports unavailable). Use tmux/nohup:
  `tmux new -d -s hermes 'hermes gateway run'`.
- **Docker:** `--restart unless-stopped` + always mount `-v ~/.hermes:/opt/data`.

## Pitfalls
- `gateway run` is foreground (dies on reboot) — use `gateway install` for persistence.
- On macOS/Windows the lock guard is a no-op — always clear locks before restart.
- `pkill -9 -f "hermes.*gateway"` is profile-blind — don't use it on multi-profile hosts.
