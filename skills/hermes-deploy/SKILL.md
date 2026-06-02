---
name: hermes-deploy
description: Deploy a self-hosted Hermes Agent end-to-end. Orchestrates install, model, platforms, skills, memory, personality, home channel, autostart, and verification. Use when the user wants to set up Hermes from scratch on a server or locally.
---

# /hermes-deploy — full end-to-end Hermes Agent deploy

You are the engineer deploying a self-hosted Hermes Agent for the user. Run the 9 steps **in order**.
Do every step you can autonomously; stop and ask the user ONLY for the things a machine cannot do
(mint a token, paste an API key, scan a QR, click OAuth, send the first "hello").

## Before you start — gather the essentials (ask once, together)
1. **Where to deploy?** Default: **Hostinger** (one-click, easiest). Else: another VPS over SSH
   (ask for host/user/key), or local.
2. **Which model/provider?** Recommend a **frontier model** (DeepSeek V4 = cheapest good; Claude
   Sonnet/GPT for quality). NEVER default to a local/small model — they hallucinate tool calls.
3. **Which messaging platform(s)?** Recommend **Telegram first** (fully headless). Others optional.

### Option A — SSH access (fastest path for VPS deploys)

If the user wants to hand off a VPS deploy directly, ask them to confirm SSH is open and provide
access via **one of two methods**:

**Method 1 — throwaway password:**
```
User runs on their VPS:   passwd root        # set a short throwaway password
User tells you:           root@<IP>  +  password
You SSH via Bash:         ssh root@<IP>
```

**Method 2 — verify existing SSH works first:**
```
User runs from their Windows machine:   ssh root@<hostname>
If it connects → they share the hostname/IP and key path (or password)
```

Example: if the user's VPS hostname is `srv1531840.hstgr.cloud`, the check command is:
```
ssh root@srv1531840.hstgr.cloud
```
Once SSH access is confirmed and credentials shared, use the Bash tool to run all install/config
commands remotely — no manual copy-pasting needed.

**Security reminder:** rotate or remove the throwaway password immediately after deploy is done
(`passwd root` again, or `sudo passwd -l root` to lock it).

Announce the plan, then proceed. Use the absolute binary path `~/.local/bin/hermes` everywhere (PATH
is not refreshed in a fresh shell). Pin **Hermes v0.15.2** (the current stable release).

## The 8 steps (delegate to the sub-skills)
1. **Install** → run the `/hermes-install` procedure. Verify `hermes --version` and `hermes -z 'reply OK'` later.
2. **Model** → `/hermes-model`. Ask the user for the API key. Validate ≥64K context. Smoke-test with `hermes -z`.
3. **Skills** → `/hermes-skills`. Install the curated starter pack.
4. **Platforms** → run the relevant `/platform-*` skill(s). Telegram first. The gateway needs one
   restart "nudge" after first setup.
5. **Memory** → `/hermes-memory`. Default: built-in. Show the user the memory-ceiling reality.
6. **Personality** → `/hermes-soul`. Write `~/.hermes/SOUL.md` directly (keep < 1KB; it's injected every message).
7. **Home channel** → `/hermes-home`. Set `*_HOME_CHANNEL` so cron/notifications have a target.
8. **Autostart** → install the gateway as a service so it survives reboot (`/hermes-restart` covers the
   clean-restart + WSL/Docker specifics). Add a nightly `gateway restart` cron (mitigates the OOM leak #25315).
 
## Coming soon
We’re removing the current frontend dashboard for now. hstack will ship **agent plugins** (specialist workers) that boost Hermes with focused workflows (sales, HR, marketing, support, ops/admin, research) — inspired by the Digital Crew “Digital Workers” model.

## Verify (definition of done)
- `hermes --version` prints and exits 0.
- `hermes -z 'reply with the single word OK'` returns OK.
- `hermes gateway status` shows running.
- The user sends a real "hello" on each wired platform and gets a reply (expect to nudge-restart once).
- Autostart confirmed (service enabled / `--restart unless-stopped`).

## Config hygiene (always)
- Secrets → `~/.hermes/.env` via `hermes config set`; `chmod 600 ~/.hermes/.env`. NEVER paste keys in chat.
- Never write secrets to `config.yaml`. Enable `prompt_caching`. Set `skills.guard_agent_created: true`.
- Allowlists are mandatory — no open bots.

## What needs the user (don't try to automate these)
BotFather token, numeric user IDs, provider API key, GitHub token, OAuth/device flows, WhatsApp QR
scan, Discord intents toggle, the first "hello," and VPS provisioning (plan/region/root password).

See `reference/TROUBLESHOOTING.md` for every known failure + fix.
