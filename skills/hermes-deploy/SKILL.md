---
name: hermes-deploy
description: Deploy a self-hosted Hermes Agent end-to-end. Orchestrates install, model, platforms, skills, memory, personality, home channel, autostart, an optional web dashboard, and verification. Use when the user wants to set up Hermes from scratch on a server or locally.
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

Announce the plan, then proceed. Use the absolute binary path `~/.local/bin/hermes` everywhere (PATH
is not refreshed in a fresh shell). Pin **Hermes v0.15.2** (the current stable release).

## The 9 steps (delegate to the sub-skills)
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
9. **Dashboard (optional, recommended)** → offer the user a web interface. Enable the agent's dashboard
   API (`HERMES_DASHBOARD=1`, bound to localhost), then run the `/dashboard` procedure to stand up Atlas
   and point it at this agent over an SSH tunnel. Skip if the user only wants chat. Its rooms/tiles
   self-populate from the agent's live capabilities, so it stays in sync as you add tools.

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
