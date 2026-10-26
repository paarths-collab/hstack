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
| Windows install fails | Execution policy blocks the script | Run `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser` then retry. Full Windows install: `iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)` — installs to `%LOCALAPPDATA%\hermes`; WSL2 also works |

## Gateway / autostart
| Symptom | Cause | Fix |
|---------|-------|-----|
| Restart loop, "PID file race lost… Exiting" | stale `~/.hermes/gateway.pid` after crash/OOM (#13655) | `hermes -p default gateway restart --detach` then `gateway ensure --json --timeout 60` (native stop/ensure handle stale pid/lock files; do not delete them by hand) |
| RSS grows to 20–37 GB then OOM-kill after ~a day | gateway memory leak (#25315: `_evict_cached_agent` never releases clients on `/new`,`/model`) | pin a version, cap container memory, cap container memory (Hermes v0.22.5 refuses cron jobs that restart or stop the gateway: `cron/lifecycle_guard.py:30-67`) |
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

## Integration skills (SSH helpers, secrets, rollback)
| Symptom | Cause | Fix |
|---------|-------|-----|
| `hermes: command not found` over ssh although Hermes is installed | non-login ssh shells lack `~/.local/bin` on PATH | run commands through the shared `remote()` helper, which exports PATH on every call; never bypass it with a raw `ssh` |
| A smoke test returns 401 right after a successful write, then the working token disappears | the test used `$TOKEN` in a non-interactive ssh shell that never loaded `~/.hermes/.env` (empty header), and the old rollback deleted keys | smoke tests read the value from `~/.hermes/.env` on the VPS; the live vendor preflight now runs BEFORE any write |
| `config.yaml` has an empty or plaintext secret where `${VAR}` should be | sed placeholder injection with `'"$VAR"'` expanded an unset remote variable | use the remote-literal `\${VAR}` and the leak check in the skill |
| `rollback: command not found`, or "Rolling back" prints but nothing is restored | `rollback()` was defined after its first call, or run via `bash <(declare -f rollback)` in a child shell, or the harness uses a fresh shell per command | Step 0 defines `snapshot`/`rollback`/`finish` first; re-run Step 0 in any new shell |
| A `FORCE=1` re-run failed and the previously working key is gone | the old rollback unset keys instead of restoring them | rollback restores `~/.hermes/.hstack-backup/<skill>/` byte for byte; for a finished run, move `<skill>.prev` back and run rollback |
| `snapshot: … exists — a previous <skill> run did not finish`, then `ABORT: snapshot failed … Nothing was written` | an earlier run crashed after its snapshot | load Step 0, run `rollback`, then re-run |
| `/platform-telegram` always aborts "rejected the token" even with a good token | the old preflight sent a literal `$TELEGRAM_BOT_TOKEN` in a single-quoted remote URL and ran before the token was written | the preflight now passes the token over ssh stdin as a curl config; update the skill |
| Telegram bot answers anyone; `TELEGRAM_ALLOW_ALL_USERS` or `GATEWAY_ALLOW_ALL_USERS` is set, or the allowlist contains `*` | open-access switch present in `.env` | the skills now refuse to continue; remove the switch and set numeric `TELEGRAM_ALLOWED_USERS` |
| Deploy used empty model/platform/home-channel values; `.env` contains `telegram_TOKEN` or `anthropic_API_KEY` | a quoted heredoc referenced local variables, and invented key names are read by nothing | hermes-deploy validates locally, passes the values explicitly (`printf %q` env prefix) and delegates credential writing to `/hermes-model` and `/platform-<name>`; delete the stray lowercase keys |
| Status check passes while the gateway is down; a count shows `0` on two lines | `grep -c … \|\| echo 0` prints two lines, and `grep -c 'running'` matches "not running" | use `\|\| true` and test negatives first |
| `hermes config set KEY -- "$v"` fails "unrecognized arguments" for values starting with `-` (negative Telegram group ids) | option parsing treats the value as a flag | put `--` before the value (unverified against upstream; marked in the skills) |
| A `[[ … =~ … ]]` regex with a large repetition count (e.g. `{16,300}`) errors in a bash block on macOS | the regex engine in stock macOS bash 3.2 rejects repetition counts above 255 (`{16,255}` works) | keep repetition counts ≤ 255 |
| `rollback: files restored, but the gateway did NOT come back` | after restoring files the rollback runs `gw_reload`: `gateway restart --detach`, then `gateway ensure --json` must report `ready` with a NEW `instance_id`; one of those failed (restart refused, ensure exit 3/4/5/6/7, or the instance did not change) | look at `hermes -p default gateway ensure --json --timeout 60` (exit codes: `hermes_cli/gateway_runtime_cli.py:8-14`) and `hermes -p default logs gateway`, fix the fault, run `rollback` again; the snapshot is kept until it succeeds |
| `gw_reload: gateway restart failed or was refused` | live sessions exist and there is no terminal, so `gateway restart` exits 1 (`hermes_cli/gateway_lifecycle_guards.py:97-129`) | retry with `GW_INTERRUPT=1` (adds `-y`) only if interrupting live chats is acceptable |
| `unrecognized arguments: --daemon` (exit 2) from `hermes gateway run --daemon` | the flag never existed (`hermes_cli/subcommands/gateway.py:70-119` lists the `gateway run` flags); `gateway run` is the foreground command | use `gateway restart --detach` + `gateway ensure --json` (the skills' `gw_reload`) |
| a health check says the gateway is fine while it is stopped | `gateway status` prints `✗ Gateway is not running` (`hermes_cli/gateway.py:5636`), which contains the word `running` | never grep status text; use `gateway ensure --json` exit 0 + `"state":"ready"` |
| `gateway restart` over ssh hangs forever | with no installed service, restart runs the replacement gateway in the foreground of the calling shell (`hermes_cli/gateway_supervised_restart.py:140-151`) | pass `--detach` (the skills' `gw_reload` does) |

## Hermes v0.22.5 skills (source-verified; none of this has run against a live host)
Rows written from the v0.22.5 source while modernizing the skills; file:line cites are in each skill's "Verified against Hermes v0.22.5" section.
| Symptom | Cause | Fix |
|---------|-------|-----|
| `gateway ensure` exits 3/4/5/6/7 | 3 incompatible, 4 authorization or profile mismatch, 5 deadline, 6 draining or update-paused, 7 conflicting supervisor or the started gateway died (`hermes_cli/gateway_runtime_cli.py:8-14`) | read the JSON `reason_code`/`detail` and `hermes -p default logs gateway`, then follow /hermes-restart |
| `gateway restart` exits 0 but nothing changed | a failed systemd user-service restart without linger prints a warning and returns 0 (`hermes_cli/gateway.py:5499-5512`) | `gw_reload` also demands a NEW `instance_id`; run `loginctl enable-linger <user>` and retry; never delete pid/lock files by hand |
| `hermes doctor` exits 1 right after a fresh install | it exits non-zero while any issue remains, e.g. no provider key yet (`hermes_cli/doctor.py:171-194`); exit 0 does not mean the gateway runs | record it, configure the key with /hermes-model; `doctor --fix` also edits `.env`/`config.yaml`/`state.db`, so ask first |
| Bot silent right after setup or restart (Telegram) | on a cold boot Hermes discards updates queued while it was offline (`platforms.telegram.extra.drop_pending_on_cold_boot`, default true) | wait for `Connected to Telegram (polling mode)` in the gateway log, then send again; a second restart does not help |
| Telegram log shows `Conflict` / `polling bootstrap conflict` | another process polls the same bot token | stop the other consumer or use a separate bot |
| Unknown sender receives a pairing code | no allowlist for that platform, so Hermes uses pairing; pairing approvals also authorize users and are not in the hstack snapshot | set the allowlist with the platform skill; review `hermes -p default pairing list` |
| `-z` exits 2 with empty stdout or `Gateway could not start` | at v0.22.5 `-z` goes through the profile gateway | check `gateway ensure --json --timeout 60` and `logs gateway`, then re-test |
| Anthropic returns 401 with a pasted key | the key is a Claude Code OAuth token (`sk-ant-oat...`), not an API key | create an API key in the Anthropic Console and re-run /hermes-model |
| `hermes mcp add` exits 0 but the server is missing from `mcp list` | `mcp add` is interactive; closed stdin answers "cancel" at the tool-selection prompt (`hermes_cli/mcp_config.py:586-601`) | feed answers on stdin (`printf 'y\n' \|` for stdio, `'y\ny\n'` with `--auth header`) and always check `mcp list` and `mcp test` |
| `mcp add ... --auth-header/--auth-scheme` fails with exit 2 | those flags do not exist; only `--auth oauth\|header` does | pre-write `MCP_<NAME>_API_KEY` to `.env` and use `--url U --auth header` |
| `mcp add notion --args '-y,@notionhq/...'` runs a bogus package | `--args` is REMAINDER (must be last) and takes the remaining words | `--env K='${VAR}' --command npx --args -y <pkg>` |
| Notion catalog install finishes but no tools | `mcp install notion` is OAuth and a headless VPS cannot finish the login | use the token + stdio path, or `ssh -t` and `mcp login notion`, then `mcp test notion` |
| Discord online but `discord_intents_required` in the gateway log | Message Content Intent off in the Developer Portal (`plugins/platforms/discord/adapter.py:1659-1668`) | enable it, then `gw_reload` |
| Discord silent in channels, fine in DMs | `discord.require_mention` defaults to true | @mention the bot or `hermes -p default config set discord.require_mention false` |
| Platform token in `.env` but the platform never starts | an explicit `platforms.<name>.enabled: false` beats env credentials (`gateway/config_env.py:84-109,192-194`); a `platforms.<name>.extra.*` block can also shadow env values | `config set platforms.<name>.enabled true`; `config unset` the shadowing extra keys; reload |
| Slack `[Slack] SLACK_APP_TOKEN not set` / `invalid_auth` on `apps.connections.open` | only the bot token was written, or the app-level token lacks `connections:write` / Socket Mode is off | write the `xapp-` token; regenerate it with the scope |
| Mattermost `failed to authenticate` | wrong URL/token, deactivated bot, or the VPS cannot reach the server | from the VPS call `/api/v4/users/me` with the token |
| Teams log `MISSING_SDK` / Google Chat `missing_deps` | the `teams` / `google-chat` extras are not in the default install and lazy installs are blocked | allow `security.allow_lazy_installs` (or install the extra) and reload |
| Teams silent, log shows `"UNKNOWN / HTTP/1.0" 400` | the proxy forwards HTTPS to Hermes' plain-HTTP listener | terminate TLS at the proxy and forward HTTP to 127.0.0.1:3978 |
| Google Chat connected but nothing arrives | `chat-api-push@system.gserviceaccount.com` lacks Pub/Sub Publisher on the topic, or `subscription_permission` / `subscription_not_found` at start | grant Publisher on the topic and Subscriber + Viewer on the subscription |
| Signal: nothing arrives / `SIGNAL_ENABLED=true` has no effect | there is no such variable; `SIGNAL_HTTP_URL` + `SIGNAL_ACCOUNT` enable it and the account must be the number the daemon serves | write those two, set `platforms.signal.enabled true`; group IDs go in `SIGNAL_GROUP_ALLOWED_USERS` |
| `hermes whatsapp` says it needs an interactive terminal | the pairing wizard refuses to run without a TTY | run it with `ssh -t`; the QR scan is a human step |
| WhatsApp log says connected but nothing arrives | the adapter proceeds after 30 s even if the bridge is not linked | check the bridge `/health` for `"status":"connected"`; re-pair; set `WHATSAPP_DM_POLICY=allowlist` so strangers get no pairing codes |
| `hermes plugins enable honcho` does not make honcho the memory provider | `plugins enable` cannot activate a memory provider | attended `hermes memory setup honcho`, or `plugins install honcho --enable` |
| `hermes plugins install X` over ssh fails with a dependency-consent message | no terminal, so it is refused without `--yes-deps` | review the manifest, then `--yes-deps --no-enable` |
| `hermes import` refuses: "Drain and stop the gateway" | a running gateway owns the home | stop the gateway (add `-y` only if interrupting chats is acceptable), then import |
| Other skills abort "source-verified for Hermes 0.22.5 only" after /hermes-update | stable moved past 0.22.5 | expected; the update is reported unverified for hstack until the skills are re-verified |

## Migration regression checks (Hermes 0.22.5)

| Symptom | Cause | Recovery |
|---|---|---|
| Restart refuses with active chats | Interrupting requires explicit consent | Leave `GW_INTERRUPT` unset to preserve chats; only literal `GW_INTERRUPT=1` opts in. Values `0` and `false` do not. |
| PowerShell installer fails under a root-level relative symlink | `Split-Path` can return an empty parent for `/var` on Unix | Current installers resolve relative link targets against the filesystem root using the path API. |
