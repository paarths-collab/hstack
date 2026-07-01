---
name: hermes-home
description: Set the durable home channel where Hermes delivers cron results and proactive notifications, over SSH on a remote VPS. Use after a platform (Telegram, Discord, Slack, Mattermost, Matrix) is wired and you need cron/reminder output to land somewhere persistent across restarts. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-home — set the durable home channel (SSH-first)

You are the engineer wiring the **home channel** for a self-hosted Hermes agent on the
user's VPS. The agent (Hermes, Claude Code, Codex, Cursor, Gemini — whichever ran you)
works over SSH as root against the VPS. Every command in this skill runs on the VPS,
not on the local machine.

The home channel is where Hermes delivers cron job output, reminders, and proactive
notifications. Without it, cron fires into the void.

Do everything autonomously; stop only for things a machine cannot do (grab a chat ID,
type `/sethome` in a chat, invite the bot to a channel).

**Honest picture (verified 2026-06):** the runtime `/sethome` slash command exists on
most platforms, but it lives in process memory — **it does NOT survive a gateway
restart**. For durability, the right answer is always the platform-specific
`*_HOME_CHANNEL` env var in `~/.hermes/.env`. This skill sets that env var.

Per-platform quirks you must respect:

- **Telegram** — DMs use a positive chat id; groups and supergroups use negative ids (often `-100…`). Keep the leading `-`.
- **Discord** — channel id is the numeric snowflake (right-click channel → Copy Channel ID with Developer Mode on).
- **Slack** — `SLACK_HOME_CHANNEL` must be a `C…` channel id (NOT `#channel-name`), and the bot must be invited (`/invite @hermes`). The runtime slash command is `/hermes sethome`, NOT bare `/sethome`.
- **Mattermost** — channel id is the 26-char id from the channel's URL or `…/channels/<team>/<channel-name>` → use the id, not the name.
- **Matrix** — room id format `!abcdef:server.tld`.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PLATFORM` | One of: `telegram`, `discord`, `slack`, `mattermost`, `matrix` | Which platform is already wired |
| `$HOME_CHAT_ID` | The chat/channel/room id to use as home | See per-platform quirks above |

Derived from `$PLATFORM`:

| `$PLATFORM` | `$HOME_VAR` |
|-------------|-------------|
| `telegram` | `TELEGRAM_HOME_CHANNEL` |
| `discord` | `DISCORD_HOME_CHANNEL` |
| `slack` | `SLACK_HOME_CHANNEL` |
| `mattermost` | `MATTERMOST_HOME_CHANNEL` |
| `matrix` | `MATRIX_HOME_CHANNEL` |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

Always confirm you are on the VPS host (not inside a container) before configuring.

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  echo "whoami=$(whoami) hostname=$(hostname)"
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`, and `whoami=root` on a readable hostname (not a hex container id).

Also confirm the platform is wired — home channel only works if the platform can deliver:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config show 2>/dev/null | grep -iE '^(${PLATFORM}_BOT_TOKEN|${PLATFORM}_TOKEN|${PLATFORM}_APP_TOKEN)=' >/dev/null" \
  || { echo "ABORT: $PLATFORM is not wired yet. Run /platform-$PLATFORM first."; exit 1; }
```

---

## Step 2 — idempotency check (skip if already set to the same id)

```bash
CURRENT=$(ssh "$VPS_USER@$VPS_IP" "hermes config show 2>/dev/null | sed -n 's/^${HOME_VAR}=//p'" || echo "")
if [ -n "$CURRENT" ] && [ "$CURRENT" = "$HOME_CHAT_ID" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Home channel for $PLATFORM is already set to this id. Set FORCE=1 to rewrite."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write ${HOME_VAR} (length: ${#HOME_CHAT_ID}, prefix: ${HOME_CHAT_ID:0:3}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Reload gateway: hermes gateway stop && hermes gateway run --daemon
  4. Verify in 'hermes config show' that ${HOME_VAR} is set
  5. Smoke test: send a one-shot probe message via 'hermes send' to the home channel

Previous value (if any): ${CURRENT:-<unset>}
New value will NOT be echoed in plaintext beyond the prefix above.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — write the home channel env var (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ${HOME_VAR} '$HOME_CHAT_ID'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^${HOME_VAR}=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: ${HOME_VAR} not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter, since chat ids may contain `-` and other punctuation depending
> on platform — never use `/` as the sed delimiter on user-provided values):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^${HOME_VAR}=' ~/.hermes/.env || printf '${HOME_VAR}=\n' >> ~/.hermes/.env
>   sed -i 's|^${HOME_VAR}=.*|${HOME_VAR}=$HOME_CHAT_ID|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```
>
> Never use `echo "${HOME_VAR}=..." >> ~/.hermes/.env` — if the previous line has
> no trailing newline, your line merges onto it and Hermes silently ignores both.

---

## Step 5 — (no MCP registration — this is a runtime config step)

Home-channel is plain env config, not an MCP server. Skip directly to gateway reload.

If you also want to set the channel at runtime in the live process (does NOT replace
Step 4 — it just shortens the time to first delivery), the user can do it from the chat:

| Platform | Slash command (typed by user in the chat) |
|----------|-------------------------------------------|
| Telegram | `/sethome` |
| Discord  | `/sethome` |
| Matrix   | `/sethome` |
| Mattermost | `/sethome` |
| **Slack** | **`/hermes sethome`** (bare `/sethome` fails on Slack) |

This is a fallback / convenience — the env var written in Step 4 is what survives a
restart.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify the env var was loaded (poll up to 30s)

```bash
LOADED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes config show 2>/dev/null | grep -q '^${HOME_VAR}='"; then
    LOADED=1
    echo "OK: ${HOME_VAR} is loaded in the running gateway."
    break
  fi
  sleep 5
done
[ "$LOADED" = "1" ] || { echo "FAIL: ${HOME_VAR} not visible to gateway after 30s. Rolling back."; rollback; exit 1; }
```

Also confirm logs show the platform reconnecting cleanly (no auth failures after the
restart):

```bash
ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -100" \
  | grep -iE "${PLATFORM}.*(connected|ready|listening)" \
  || echo "WARN: did not see explicit ${PLATFORM} connect line. Continue to smoke test."
```

---

## Step 8 — live smoke test (deliver a probe message to the home channel)

```bash
PROBE="hermes-home probe $(date -u +%Y-%m-%dT%H:%M:%SZ)"
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  hermes send --home '$PROBE' 2>&1 | tail -5
")
case "$HTTP" in
  *delivered*|*sent*|*ok*) echo "OK: probe delivered to ${PLATFORM} home channel." ;;
  *unauthorized*|*401*)    echo "FAIL: platform token rejected. Re-check /platform-$PLATFORM."; rollback; exit 1 ;;
  *not_in_channel*|*403*|*forbidden*) echo "FAIL: bot not in channel. Invite the bot and retry."; exit 1 ;;
  *)                       echo "WARN: ambiguous result: $HTTP. Check the chat manually." ;;
esac
```

If `hermes send --home` doesn't exist on the installed build, fall back to triggering a
one-shot cron job that posts a fixed string and wait for it to land:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes cron run --once 'echo hermes-home probe' --to home" \
  || echo "WARN: could not trigger a probe via cron. Ask the user to confirm a real cron job lands in the home channel."
```

A message appearing in the chat = wired. No message = the env var is set but delivery
is broken — check Pitfalls 2, 5, 6.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ -n "$CURRENT" ]; then
    # Restore the prior value
    ssh "$VPS_USER@$VPS_IP" "hermes config set ${HOME_VAR} '$CURRENT'" 2>/dev/null \
      || ssh "$VPS_USER@$VPS_IP" "sed -i 's|^${HOME_VAR}=.*|${HOME_VAR}=$CURRENT|' ~/.hermes/.env"
  else
    # Wipe the line entirely
    ssh "$VPS_USER@$VPS_IP" "hermes config unset ${HOME_VAR} 2>/dev/null || sed -i '/^${HOME_VAR}=/d' ~/.hermes/.env"
  fi
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. ${HOME_VAR} restored to: ${CURRENT:-<unset>}"
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using `/sethome` (runtime command) and assuming it persists | The runtime command lives in process memory — a `gateway restart` wipes it | Always set the `*_HOME_CHANNEL` env var via Step 4 |
| 2 | Slack: setting `#channel-name` instead of `C…` id | Slack rejects names at the API layer | Use the channel id (right-click → View channel details → bottom shows `C…`) |
| 3 | Slack: bare `/sethome` instead of `/hermes sethome` | Slack routes only namespaced slash commands to the bot | Always `/hermes sethome` on Slack |
| 4 | Slack: bot not invited to the channel | API returns `not_in_channel`; nothing delivered | `/invite @hermes` in the target channel |
| 5 | Telegram: stripping the leading `-` on a group id | `-100…` becomes `100…` and Telegram routes it to a DM that doesn't exist | Keep the `-` exactly as Telegram gave it |
| 6 | Discord: pasting the channel **name** instead of the snowflake id | Discord rejects the call silently | Enable Developer Mode in Discord → right-click channel → Copy Channel ID |
| 7 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 8 | `echo "${HOME_VAR}=..." >> ~/.hermes/.env` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the `sed` fallback in Step 4) |
| 9 | Home channel in `config.yaml` instead of `.env` | `config.yaml` is world-readable in some installs and not always loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 10 | sed with `/` delimiter on the chat id | Some ids contain `/` or `+` | Always use `\|` delimiter |
| 11 | Container vs host confusion when editing `.env` | Skill ran `config set` inside a Docker exec but Hermes runs on the host (or vice versa) | Step 1's `whoami; hostname` check; act on the layer Hermes actually runs on |
| 12 | Platform not wired yet | Setting `*_HOME_CHANNEL` for an unwired platform = silent dead-letter | Step 1 hard-gates on the platform's bot token being present |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x); confirmed on host (not container)
- [ ] `$PLATFORM` is already wired (bot token present in `~/.hermes/.env`)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `${HOME_VAR}` written to `~/.hermes/.env`, file is `chmod 600`
- [ ] `${HOME_VAR}` NOT in `config.yaml` and NOT echoed in chat beyond a short prefix
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] `hermes config show` confirms `${HOME_VAR}` is loaded within 30s
- [ ] Smoke test: a probe message landed in the home channel (or cron probe confirmed)
- [ ] Rollback function defined and tested (re-run with `FORCE=1` rewrites cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and platform delivery failure modes.
