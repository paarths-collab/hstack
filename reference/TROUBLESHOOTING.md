# hstack — Hermes Agent Troubleshooting Catalogue

Every entry is a real, logged failure with the fix hstack applies. This file grows as new failures are
found — that compounding knowledge is hstack's moat.

## SSH access (VPS hand-off)

Real failure chain from a documented deploy session — in the order they appeared:

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Host key verification failed` | First-ever connect; host key not in `known_hosts` | Add `-o StrictHostKeyChecking=accept-new` — auto-trusts on first connect, subsequent connects verify normally |
| `Permission denied (publickey,password)` immediately after host-key fix | No key installed yet; Bash tool is non-interactive so can't type a password at a prompt; `sshpass` not installed | Generate a keypair (`ssh-keygen -t ed25519 -f ~/.ssh/hermes_vps -N ""`), authorize the public half on the VPS |
| Key added but `Permission denied` persists | Key was added *inside a Docker container* (prompt `dd635306c545%`), not on the host — SSH reads the host's `authorized_keys`, not the container's | Run `whoami; hostname` before adding a key. Hex-string hostname = container. `exit` first, then re-add on the host |
| Key added on the host but still `Permission denied` | Two keys mashed onto one line — `echo >>` appended without a leading newline, merging with the previous key: `...paarth@digitalcrewssh-ed25519 AAAA...` SSH parses one key per line; merged line = invalid, silently ignored | **Always use `printf '\n%s\n' "key"` not `echo "key" >>`**. Fix merged keys: `sed -i 's/\(digitalcrew\)\(ssh-ed25519\)/\1\n\2/' ~/.ssh/authorized_keys` |
| `ssh root@<host>` works from Windows but Bash tool can't reach it | WSL2 network namespace isolation | `ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/hermes_vps root@<host>` from Bash tool; confirm WSL has internet: `curl -s https://example.com` |
| Forgot to rotate throwaway password after deploy | — | `passwd root` (new strong password) or `sudo passwd -l root` (lock root login, use sudo user) |

> **Detection — are keys merged?**
> ```bash
> grep -c "^ssh-" ~/.ssh/authorized_keys   # should equal number of keys you added
> ```
> If count is wrong, keys are on the same line. Use the `sed` fix above.

> **Fastest hand-off:** user runs `ssh root@<hostname>` from their Windows terminal to confirm it works, then shares the hostname + credential. Claude Code's Bash tool then SSHs in and drives everything remotely — no copy-pasting.

> **Remote script pattern** (once key auth works):
> ```bash
> ssh -i ~/.ssh/hermes_vps root@<hostname> 'bash -s' <<'REMOTE'
> # commands here run on the VPS
> REMOTE
> ```

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
| Vision / web-summarization / compression silently stop working | an auxiliary slot overridden to a different provider without its key, OR main model can't do the feature | leave aux on `auto` (reuses main), or wire the override's key; pick a capable main model (e.g. one with vision) |
| `Context length exceeded` on first long chat | misdetected context window | model must be ≥64K; aux/compression model context ≥ main |
| Surprise per-token bill on a subscription | billing-mode silently flipped (`hermes.md` bug) | surface active billing mode; warn before API-credit burn |
| Big per-request token bills | fixed overhead (tool defs + system prompt) on every call; browser tools loaded on text-only platforms | platform-aware tool loading; enable `prompt_caching`; lean SOUL.md |

## Memory
| Symptom | Cause | Fix |
|---------|-------|-----|
| Agent "spends turns consolidating its memory" | built-in memory is a bounded character budget that has filled up | prune old notes; attach an external memory provider (mem0 / Supermemory / Honcho) |
| External provider crashes with `ModuleNotFoundError` | `hermes memory setup` doesn't install the dep (#25086) | `uv pip install --python ~/.hermes/hermes-agent/venv/bin/python <pkg>` |
| `~/.hermes` is multiple GB | ~3,000 session files, no auto-prune | prune sessions; nightly prune cron |

## Platforms
| Symptom | Cause | Fix |
|---------|-------|-----|
| Telegram bot silent | allowlist has `@username` not the numeric ID, or truncated token | use the numeric ID from @userinfobot; copy the full `digits:letters` token |
| Discord bot reads nothing | missing privileged intents | enable Message Content + Server Members intents |
| Slack `/sethome` "app did not respond" | Slack namespaces slash commands | use `/hermes sethome`; `SLACK_HOME_CHANNEL` must be a `C…` id + bot invited |
| Bot ignores everyone | gateway denies all by default | set the allowlist (or DM-pair) |
