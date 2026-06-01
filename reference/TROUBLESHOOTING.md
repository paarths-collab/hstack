# hstack — Hermes Agent Troubleshooting Catalogue

Every entry is a real, logged failure with the fix hstack applies. This file grows as new failures are
found — that compounding knowledge is hstack's moat.

## Install
| Symptom | Cause | Fix |
|---------|-------|-----|
| `hermes: command not found` after a successful install | rc-file PATH edit didn't reach the live shell; login/systemd/launchd inherit minimal PATH | `export PATH="$HOME/.local/bin:$PATH"`; use the absolute `~/.local/bin/hermes`; `source ~/.bashrc` |
| Install fails on a headless VPS | Chromium/Playwright system libs (#1 headless failure) | install with `--skip-browser` |
| Permission errors during/after install | a prior `sudo` install left root-owned files | `sudo rm /usr/local/bin/hermes`; reinstall **without** sudo |
| Windows install fails | no native Windows support | use WSL2 |

## Gateway / autostart
| Symptom | Cause | Fix |
|---------|-------|-----|
| Restart loop, "PID file race lost… Exiting" | stale `~/.hermes/gateway.pid` after crash/OOM (#13655) | `gateway stop` → `rm gateway.pid` + clear `~/.local/state/hermes/gateway-locks/*.lock` → `gateway start` |
| RSS grows to 20–37 GB then OOM-kill after ~a day | gateway memory leak (#25315: `_evict_cached_agent` never releases clients on `/new`,`/model`) | pin a version, cap container memory, add a **nightly `gateway restart` cron** |
| Gateway dies when WSL terminal closes / "systemd not available" | #18032 — `is_wsl()` short-circuits | use tmux/nohup, not systemd; or set `systemd=true` in `/etc/wsl.conf` + `wsl --shutdown` |
| Service doesn't start at boot (user systemd) | no lingering | `loginctl enable-linger "$USER"` (or `--system` install) |
| Docker `chown … Operation not permitted` / `PermissionError` on `gateway_state.json` | UID mismatch (#15865 v2026.4.23; #32559 s6-overlay UID-99) | pin a tagged image (avoid `v2026.4.23`, avoid `main`/`latest` on NAS); honor `HERMES_UID`/`HERMES_GID`; run CLI + gateway as same UID |

## Model / cost
| Symptom | Cause | Fix |
|---------|-------|-----|
| Whole gateway + all bots go offline on a provider error | 429/401/timeout → exit 75/TEMPFAIL → restart loop (#16677) | validate context windows; circuit-breaker/fallback; avoid known crash-loop combos |
| Vision / web-summarization / compression silently stop working | auxiliary model not keyed (no error) | add the provider key (e.g. OpenRouter); show capability health |
| `Context length exceeded` on first long chat | misdetected context window | model must be ≥64K; aux/compression model context ≥ main |
| Surprise per-token bill on a subscription | billing-mode silently flipped (`hermes.md` bug) | surface active billing mode; warn before API-credit burn |
| ~73% of every request is overhead → big bills | 31 tool defs incl. browser tools on messaging gateways (#4379) | platform-aware tool loading; enable `prompt_caching`; lean SOUL.md |

## Memory
| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent "spends turns consolidating" / "memory at 1,361/1,375 chars" | tiny fixed ceiling (~1,375 user / ~2,200 agent) | surface the meter; offer an external provider |
| External provider crashes with `ModuleNotFoundError` | `hermes memory setup` doesn't install the dep (#25086) | `uv pip install --python ~/.hermes/hermes-agent/venv/bin/python <pkg>` |
| `~/.hermes` is multiple GB | ~3,000 session files, no auto-prune | prune sessions; nightly prune cron |

## Platforms
| Symptom | Cause | Fix |
|---------|-------|-----|
| Telegram bot silent | allowlist has `@username` not the numeric ID, or truncated token | use the numeric ID from @userinfobot; copy the full `digits:letters` token |
| Discord bot reads nothing | missing privileged intents | enable Message Content + Server Members intents |
| Slack `/sethome` "app did not respond" | Slack namespaces slash commands | use `/hermes sethome`; `SLACK_HOME_CHANNEL` must be a `C…` id + bot invited |
| Bot ignores everyone | gateway denies all by default | set the allowlist (or DM-pair) |

## Dashboard
| Symptom | Cause | Fix |
|---------|-------|-----|
| Dashboard reloads in a loop (loopback mode) | v0.15.0's stale-token reload guard treated the 401 identity probe as a rotated session | upgrade to `v0.15.2` (fixed in v0.15.1) |
| Credentials exposed | dashboard has no auth, bound `0.0.0.0` | bind `127.0.0.1`; SSH tunnel or HTTPS+password proxy; patch Starlette ≥1.0.1 (BadHost) |
