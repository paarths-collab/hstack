---
title: "How to Set Up Your Own AI Agent (Self-Hosted Hermes) — A Beginner's Guide"
description: "A friendly, step-by-step guide to deploying Hermes Agent on a VPS and connecting it to Telegram — for developers and non-developers. Includes Hostinger, DigitalOcean and Hetzner paths, common mistakes, and an honest look at what's real vs marketing."
date: "2026-06-01"
author: "Paarth · Digital Crew"
tags: [hermes-agent, self-hosted-ai, telegram-bot, vps, ai-agent, hostinger, beginner]
canonical: "https://example.com/blog/hermes-agent-setup-guide"
---

# How to Set Up Your Own AI Agent (Self-Hosted Hermes)

Imagine texting an AI on Telegram that's *yours* — it remembers your projects, runs on your own
server, has no monthly SaaS fee, and can do real work on a schedule. That's [Hermes
Agent](https://github.com/NousResearch/hermes-agent), an open-source self-hosted AI agent from Nous
Research. This guide gets you there, whether or not you've used a terminal before.

> **In a hurry, or not a fan of terminals?** There's a shortcut that does this entire guide in **one
> command** — skip to [Deploy Hermes in one command with hstack](02-hermes-one-command.md). This page
> is the manual way, so you understand what's happening.

**Time:** ~30 minutes on the Telegram path. **You'll need:** a credit card for a small VPS (~$5/mo)
and a model API key (or an existing ChatGPT subscription).

---

## Step 1 — Get a server (a VPS)

A VPS is a small always-on computer in the cloud. Pick one:

### Hostinger (recommended — easiest, one-click) ⭐
Hostinger has a **one-click Docker deploy** for Hermes — the friendliest path for non-developers.
1. Get a **KVM 2** plan (2 vCPU / 8 GB RAM), OS **Ubuntu 24.04 LTS**, datacenter nearest you.
2. In hPanel → **Docker Manager → Compose → One-click deploy** → search **"Hermes"** → deploy.
3. Save the admin username + password it shows you.
→ *Full Hostinger walkthrough: [hostinger.com/tutorials/how-to-set-up-hermes-agent](https://www.hostinger.com/tutorials/how-to-set-up-hermes-agent)*

### DigitalOcean (popular, manual)
1. Create a **Droplet**, Ubuntu 24.04, Basic plan ($6–12/mo, 2 GB+ RAM), nearest region.
2. SSH in: `ssh root@your-droplet-ip`.
3. Continue at **Step 2 (manual install)** below.
→ *DigitalOcean's Droplet quickstart: [docs.digitalocean.com/products/droplets/quickstart](https://docs.digitalocean.com/products/droplets/quickstart/)*

### Hetzner / any other VPS (cheapest, manual)
A Hetzner CX22 (~€4/mo) or any Ubuntu 24.04 box works. SSH in and continue at Step 2.

> **Minimums:** 1 vCPU / 2 GB if your model runs via an API; 2 GB+ extra if you want browser
> automation. Heads-up: cheap intro prices often renew higher — check before you commit.

---

## Step 2 — Install Hermes

**Hostinger one-click users:** Hermes is already installed — open the web terminal (Docker Manager →
Open) and skip to Step 3.

**Everyone else (manual):**
```bash
# install prerequisites (do NOT use sudo for the Hermes installer itself)
sudo apt-get update && sudo apt-get install -y git curl ca-certificates
# install a known-good, pinned version
pip install "hermes-agent==0.15.0" && hermes postinstall
source ~/.bashrc      # IMPORTANT: makes the `hermes` command available
hermes --version      # should print a version
```

> **The #1 beginner trap:** if you see `hermes: command not found` right after a "successful" install,
> the shell just hasn't reloaded. Run `source ~/.bashrc` (or restart the terminal). You're not broken.

---

## Step 3 — Pick a model (the brain)

Run `hermes model` and choose a provider. Options:
- **Easiest for non-devs:** choose **OpenAI Codex** and log in with your **existing ChatGPT account**
  (an OAuth screen opens). *No new API account, no per-token billing.*
- **Cheapest good option:** **DeepSeek V4** via OpenRouter (paste an OpenRouter API key).
- **Highest quality:** Claude Sonnet / GPT.

> **Rule:** use a real frontier model with **at least 64,000 tokens of context** — Hermes rejects
> smaller ones. Don't pick a tiny local model; they hallucinate and break tool use.

---

## Step 4 — Connect Telegram

Telegram is the easiest platform to wire (no QR, no OAuth).
1. In Telegram, message **@BotFather** → `/newbot` → name it → username ends in `bot` → **copy the token**.
2. Message **@userinfobot** → it sends your **numeric ID**.
3. Paste both into Hermes when prompted (or `hermes gateway setup`). The numeric ID is your *allowlist*
   — it means only you can talk to your bot.
4. Send "hello" to your bot. If silent, tell the Hermes terminal *"the Telegram connection isn't
   working"* — it self-diagnoses and restarts.

> **Two silent-failure traps:** paste the **numeric ID**, not your @username. And copy the **full**
> token (`digits:letters`), not just the part before the colon.

---

## Step 5 — Keep it safe and running

- **Allowlist is mandatory** — without it your bot is public.
- **Never paste API keys into chat** — use `hermes config set KEY value` (it saves to `~/.hermes/.env`).
- **Never expose the dashboard to the internet without a password + HTTPS** (more below).
- **Autostart:** Docker handles it with `--restart unless-stopped`; on a bare VPS run `hermes gateway
  install`. On WSL, use `tmux`, not systemd.
- **Back up `~/.hermes` weekly** — there are no automatic backups.

---

## Optional — the dashboard

Hermes has a built-in web dashboard (port `9119`, enable with `HERMES_DASHBOARD=1`) showing status,
conversations, scheduled tasks, logs, and cost. **Open it safely over an SSH tunnel** — never bind it
to the open internet, because it has no built-in password and can read your keys:
```bash
ssh -L 9119:127.0.0.1:9119 user@your-vps      # then open http://127.0.0.1:9119
```

---

## Common mistakes (the checklist that saves you an hour)

- ❌ Pasting API keys into chat → ✅ `hermes config set`
- ❌ Forgetting `source ~/.bashrc` → "command not found"
- ❌ @username instead of the numeric Telegram ID → silent bot
- ❌ A model under 64K context → rejected at startup
- ❌ Running the installer with `sudo` → permission errors later
- ❌ No backups → back up `~/.hermes`

---

## What's actually real (and what's marketing)

Being honest builds more trust than hype:
- **Genuinely great:** persistent memory across projects, "it just runs," the huge messaging-platform
  support, cheap transparent self-hosting.
- **Overstated:** "an agent that grows with you / self-improving." Reality — memory is a **fixed
  ~1,375-char profile + ~2,200-char buffer** (≈20 short notes). It fills fast. It's structured
  note-taking, not learning.
- **Real gotchas:** ~73% of each request can be fixed token overhead (watch your costs); the gateway
  can leak memory and crash after a day (restart it nightly); features like vision can *silently* stop
  working if a key is missing.

---

## Coming from OpenClaw?

Hermes has a built-in migration: `hermes claw migrate` imports your settings, memory, skills, and keys.
**Back up first** and re-verify imported skills (OpenClaw's marketplace had a malware problem).

---

## The shortcut: do all of this in one command

If the steps above felt like a lot — they are, and you don't have to do them by hand. **hstack** turns
Claude Code into the engineer that runs this entire guide for you, with every trap above already solved.

→ **[Deploy Hermes Agent in one command with hstack](02-hermes-one-command.md)**

---

*Guide by Paarth · Digital Crew. hstack is open-source (MIT). Hostinger is the recommended deploy
target; other VPS providers are fully supported.*
