---
name: hermes-deploy
description: Deploy a self-hosted Hermes Agent end-to-end over SSH. Orchestrates install, model, platforms, skills, memory, personality, home channel, autostart, and verification — idempotent, dry-run-first, rollback-safe. Works from any AI agent (Claude Code, Codex, Cursor, Gemini CLI, or Hermes itself).
---

# /hermes-deploy — full end-to-end Hermes Agent deploy (SSH-first)

You are the engineer deploying a self-hosted Hermes Agent for the user. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to
a remote VPS over SSH as root. **Every command in this skill runs on the VPS, not
on the local machine.** Local mode is supported but considered the exception.

Do everything autonomously; stop and ask the user ONLY for the things a machine
cannot do (mint a token, paste an API key, scan a QR, click OAuth, send the first
"hello," provision the VPS plan/region).

**Honest deploy picture (verified 2026-06):** Hermes is pinned to **v0.15.2** (the
current stable). Use the absolute binary path `~/.local/bin/hermes` everywhere —
PATH is not refreshed in a fresh non-login shell. The gateway has a known memory
leak (#25315) → a nightly `gateway restart` cron is part of the deploy. NEVER
default to a local/small model; frontier models only (DeepSeek V4 cheapest good,
Claude Sonnet / GPT for quality).

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP/hostname of the target VPS | Hostinger / DigitalOcean / Hetzner dashboard. Default recommendation: **Hostinger** (one-click). |
| `$VPS_USER` | SSH user (typically `root`) | Hosting dashboard |
| `$MODEL_PROVIDER` | `deepseek` \| `anthropic` \| `openai` | User choice; recommend DeepSeek V4 for cost or Claude Sonnet for quality |
| `$MODEL_API_KEY` | API key for the chosen provider | Provider dashboard |
| `$PLATFORM` | `telegram` (recommended first), `discord`, `whatsapp`, `slack`, `mattermost` | User choice; **Telegram first — fully headless** |
| `$PLATFORM_TOKEN` | BotFather token / Discord token / etc. | Platform-specific mint flow |
| `$HOME_CHANNEL_ID` | Numeric ID of the home channel for cron + notifications | Platform admin UI |

The user must also provide (cannot be automated):
- BotFather token / numeric user IDs / Discord intents toggle / WhatsApp QR scan
- Provider API key, GitHub token, OAuth/device flow approvals
- First "hello" on each wired platform
- VPS provisioning (plan/region/root password)

### Confirm SSH access before doing anything

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

If SSH is not yet set up, follow the keypair flow:

```bash
# Generate keypair locally (skip if already present)
[ -f ~/.ssh/hermes_vps ] || ssh-keygen -t ed25519 -f ~/.ssh/hermes_vps -N "" -C "hermes-deploy"

# User adds the public key on the VPS — ALWAYS use printf, never echo >>
# (echo >> can merge a key onto the previous line if the file lacks a trailing newline,
# silently invalidating both keys).
printf '\n%s\n' "$(cat ~/.ssh/hermes_vps.pub)"
# → user appends the output to ~/.ssh/authorized_keys on the VPS, then chmod 600

# First connect — auto-trust host key
ssh -i ~/.ssh/hermes_vps -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" "echo ok"
```

Verify you are on the host, not a container, before adding any key:

```bash
ssh "$VPS_USER@$VPS_IP" "whoami; hostname"
# root@<readable-name> → host ✅
# root@<hex-string>    → inside a container ❌  exit first
```

Security reminder: rotate or remove the throwaway root password immediately after
deploy (`passwd root` or `sudo passwd -l root`).

---

## Step 1 — verify the VPS is reachable and clean

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  whoami; hostname
  uname -a
  df -h / | tail -1
  free -h | head -2
' || { echo "ABORT: cannot read basic state from $VPS_USER@$VPS_IP."; exit 1; }
```

Expected: a real hostname (not a container hex), ≥5 GB free, ≥2 GB RAM.

---

## Step 2 — idempotency check (skip if Hermes is already deployed)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "
  ~/.local/bin/hermes --version 2>/dev/null | grep -c '^hermes ' || \
  command -v hermes >/dev/null 2>&1 && hermes --version 2>/dev/null | grep -c '^hermes '
" 2>/dev/null || echo 0)

if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Hermes is already deployed on $VPS_IP. Set FORCE=1 to redeploy, or run /hermes-status."
  ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes --version; ~/.local/bin/hermes gateway status"
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:

  1. Install Hermes v0.15.2 via /hermes-install
  2. Configure model: $MODEL_PROVIDER (API key length: ${#MODEL_API_KEY}, prefix: ${MODEL_API_KEY:0:4}...)
  3. Install curated starter skills via /hermes-skills
  4. Wire platform: $PLATFORM (token length: ${#PLATFORM_TOKEN}, prefix: ${PLATFORM_TOKEN:0:4}...)
  5. Configure memory (built-in default) via /hermes-memory
  6. Write personality to ~/.hermes/SOUL.md (< 1 KB) via /hermes-soul
  7. Set home channel: $HOME_CHANNEL_ID via /hermes-home
  8. Install autostart + nightly gateway restart cron via /hermes-cron

Verification after each step:
  - hermes --version exits 0
  - hermes -z 'reply OK' returns OK
  - hermes gateway status shows running
  - First "hello" on $PLATFORM returns a reply

All secrets written via 'hermes config set' (NEVER echo >>), file chmod 600,
NEVER printed in chat or logged.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — install Hermes (delegate to /hermes-install)

```bash
ssh "$VPS_USER@$VPS_IP" 'bash -s' <<'REMOTE'
  set -e
  # /hermes-install pins v0.15.2 and writes ~/.local/bin/hermes
  curl -fsSL https://hermes.run/install.sh | HERMES_VERSION=v0.15.2 bash
  ~/.local/bin/hermes --version
REMOTE
```

Verify (don't trust the installer — check):

```bash
INSTALLED=$(ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes --version 2>/dev/null | grep -c '0.15.2'" || echo 0)
[ "$INSTALLED" = "1" ] || { echo "FAIL: Hermes v0.15.2 not installed. Rolling back."; rollback; exit 1; }
```

---

## Step 5 — write all secrets (chmod 600, no echo, no logging)

Always use `hermes config set` — never `echo >>`. The `config set` subcommand
guarantees newline separation and atomic writes; `echo >>` can mash a value onto
the previous line if `.env` lacks a trailing newline.

```bash
ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes config set ${MODEL_PROVIDER}_API_KEY '$MODEL_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes config set ${PLATFORM}_TOKEN '$PLATFORM_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes config set ${PLATFORM}_HOME_CHANNEL '$HOME_CHANNEL_ID'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns counts, NEVER the values):

```bash
ssh "$VPS_USER@$VPS_IP" "
  grep -c '^${MODEL_PROVIDER}_API_KEY=' ~/.hermes/.env
  grep -c '^${PLATFORM}_TOKEN=' ~/.hermes/.env
  grep -c '^${PLATFORM}_HOME_CHANNEL=' ~/.hermes/.env
" | awk '{ if ($1 != 1) { print "FAIL: missing secret"; exit 1 } }' \
  || { echo "FAIL: one or more secrets not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, fall back to safe sed
> (pipe delimiter — provider/platform tokens often contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^${MODEL_PROVIDER}_API_KEY=' ~/.hermes/.env || printf '%s_API_KEY=\n' '${MODEL_PROVIDER}' >> ~/.hermes/.env
>   sed -i 's|^${MODEL_PROVIDER}_API_KEY=.*|${MODEL_PROVIDER}_API_KEY=${MODEL_API_KEY}|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

NEVER write secrets to `config.yaml`. Only `~/.hermes/.env`, `chmod 600`.

---

## Step 6 — install model, skills, platform, memory, soul, home (delegate to sub-skills)

Each sub-skill is its own SSH-first procedure. Run them in order; abort on any
non-zero exit:

```bash
ssh "$VPS_USER@$VPS_IP" 'bash -s' <<'REMOTE'
  set -e
  H=~/.local/bin/hermes

  # 6a. Model — validates ≥64K context; smoke-tests with hermes -z
  "$H" model use "$MODEL_PROVIDER" || exit 1
  "$H" -z 'reply with the single word OK' | grep -q OK || { echo "FAIL: model smoke test"; exit 1; }

  # 6b. Skills — curated starter pack
  "$H" skills install --starter

  # 6c. Platform — Telegram first, fully headless
  "$H" platform enable "$PLATFORM"

  # 6d. Memory — built-in default (sub-skill /hermes-memory)
  "$H" memory init --backend builtin

  # 6e. Personality — < 1 KB SOUL.md (injected every message)
  test -f ~/.hermes/SOUL.md || cat > ~/.hermes/SOUL.md <<'SOUL'
You are a helpful, terse, accurate self-hosted agent. Prefer doing over explaining.
SOUL
  test "$(wc -c < ~/.hermes/SOUL.md)" -lt 1024 || { echo "FAIL: SOUL.md > 1 KB"; exit 1; }

  # 6f. Home channel
  "$H" home set "$PLATFORM" "$HOME_CHANNEL_ID"
REMOTE
```

The gateway needs **one restart "nudge"** after first platform setup — handled in Step 7.

---

## Step 7 — reload the gateway (stop + run, NOT restart) + install autostart

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes gateway run --daemon"
sleep 5
```

Install autostart so the gateway survives reboot, plus the nightly OOM-leak
mitigation cron:

```bash
ssh "$VPS_USER@$VPS_IP" 'bash -s' <<'REMOTE'
  set -e
  H=~/.local/bin/hermes

  # Autostart as systemd service (or --restart unless-stopped if containerized)
  "$H" service install || true

  # Nightly gateway restart at 03:30 — mitigates leak #25315
  ( crontab -l 2>/dev/null | grep -v 'hermes gateway restart'; \
    echo '30 3 * * * ~/.local/bin/hermes gateway restart >/dev/null 2>&1' \
  ) | crontab -
REMOTE
```

---

## Step 8 — verify in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes logs 2>&1 | tail -200" \
       | grep -qiE "gateway.*ready|platform.*${PLATFORM}.*(ok|connected)|registered.*tool"; then
    REGISTERED=1
    echo "OK: gateway up, $PLATFORM connected, tools registered."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gateway/platform not visible in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live end-to-end smoke test

```bash
# 9a. Model smoke test
OK=$(ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes -z 'reply with the single word OK' 2>/dev/null" | tr -d '[:space:]')
case "$OK" in
  OK) echo "OK: model reachable and returning text." ;;
  "") echo "FAIL: empty response — check model API key. Rolling back."; rollback; exit 1 ;;
  *)  echo "WARN: unexpected response '$OK' — check provider/model config." ;;
esac

# 9b. Gateway status
HTTP=$(ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes gateway status 2>&1 | grep -ciE 'running|ready'" || echo 0)
case "$HTTP" in
  0)  echo "FAIL: gateway not running. Rolling back."; rollback; exit 1 ;;
  *)  echo "OK: gateway status reports running." ;;
esac

# 9c. First "hello" on $PLATFORM — USER step (cannot be automated)
echo "ACTION REQUIRED: send a real 'hello' on $PLATFORM and confirm Hermes replies."
echo "(Expect to nudge-restart the gateway once if the first message hangs.)"
```

`200`-equivalent on all three = wired. Empty/`401`/non-running = rollback.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes gateway stop 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "~/.local/bin/hermes platform disable $PLATFORM 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    ~/.local/bin/hermes config unset ${MODEL_PROVIDER}_API_KEY 2>/dev/null || \
      sed -i '/^${MODEL_PROVIDER}_API_KEY=/d' ~/.hermes/.env
    ~/.local/bin/hermes config unset ${PLATFORM}_TOKEN 2>/dev/null || \
      sed -i '/^${PLATFORM}_TOKEN=/d' ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "crontab -l 2>/dev/null | grep -v 'hermes gateway restart' | crontab -"
  echo "Rolled back. Hermes deploy partially reversed; re-run with FORCE=1 to retry."
}
```

A full uninstall (remove `~/.local/bin/hermes`, `~/.hermes/`) is intentionally NOT
part of rollback — the user may want to inspect state. See `/hermes-fix` for
deeper recovery.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 2 | `echo >> .env` instead of `config set` | Mashes value onto prior line if no trailing newline | Always `hermes config set` |
| 3 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 4 | sed with `/` delimiter on tokens | Provider/platform tokens contain `/+=` | Use `\|` delimiter |
| 5 | SSH key added inside a container | Host sshd never reads container `authorized_keys` | `whoami; hostname` check first; exit container |
| 6 | `echo >>` on `authorized_keys` merging keys | Two keys on one line → SSH silently rejects both | Always `printf '\n%s\n'` |
| 7 | Default local/small model | Hallucinates tool calls — breaks every skill | Frontier model only (DeepSeek V4 / Sonnet / GPT) |
| 8 | PATH missing `~/.local/bin` in fresh shell | `hermes` not found in non-login SSH | Always use absolute `~/.local/bin/hermes` |
| 9 | Wrong Hermes version | Skills assume v0.15.2 surface | Pin `HERMES_VERSION=v0.15.2` in install |
| 10 | Gateway OOM after days of uptime | Known leak #25315 | Nightly `gateway restart` cron (Step 7) |
| 11 | First platform message hangs forever | Gateway needs one "nudge" restart after first platform setup | Stop+run after Step 6, document the nudge to the user |
| 12 | Throwaway root password left enabled | Brute-force surface area | `passwd -l root` after deploy, or rotate |
| 13 | Allowlists missing → open bot | Anyone who finds the bot can talk to it | Allowlists are mandatory; verify per-platform skill enforces |
| 14 | `prompt_caching` left off | 10x cost in production | Enable in `config.yaml` |
| 15 | `skills.guard_agent_created` left false | Agent-authored skills can run unreviewed | Set `guard_agent_created: true` |

---

## Coming soon

The current frontend dashboard is being removed. hstack will ship **agent
plugins** (specialist workers) that boost Hermes with focused workflows (sales,
HR, marketing, support, ops/admin, research) — inspired by the Digital Crew
"Digital Workers" model.

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working (on host, not container)
- [ ] Hermes v0.15.2 installed at `~/.local/bin/hermes`; `--version` exits 0
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All secrets written via `hermes config set` to `~/.hermes/.env`; file is `chmod 600`
- [ ] No secret in `config.yaml`; nothing echoed in chat
- [ ] Model configured; `hermes -z 'reply OK'` returns OK
- [ ] Curated starter skills installed
- [ ] `$PLATFORM` enabled with allowlist enforced
- [ ] Memory backend initialized; SOUL.md < 1 KB; home channel set
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Autostart service installed; nightly `gateway restart` cron added
- [ ] Logs show gateway ready, platform connected, tools registered within 30s
- [ ] Live smoke test: `hermes -z` returns OK; `gateway status` shows running
- [ ] User sent first "hello" on `$PLATFORM` and Hermes replied
- [ ] Rollback function defined and proven
- [ ] Throwaway root password rotated/locked

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
MCP, SSH-key, and platform failure modes.
