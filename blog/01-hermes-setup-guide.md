---
title: "Self-Hosted AI Agent Setup: The Complete Hermes Guide"
description: "Set up a self-hosted Hermes AI agent on a VPS in about 30 minutes for $10–17/month all-in: install, model, Telegram, memory, security and cost."
date: "2026-06-01"
lastmod: "2026-06-03"
author: "Paarth · Digital Crew"
tags: [hermes-agent, self-hosted-ai, telegram-bot, vps, ai-agent, hostinger, digitalocean, beginner]
canonical: "https://www.digitalcrew.tech/en/blog/hermes-agent-setup-guide"
image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200&q=80"
image_alt: "A code editor on a screen, representing setting up a self-hosted AI agent on a server"
og_title: "Self-Hosted AI Agent Setup: The Complete Hermes Guide"
og_description: "Deploy a self-hosted Hermes AI agent on a VPS in about 30 minutes for $10–17/month all-in: install, model, Telegram, memory, security and cost."
og_image: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200&q=80"
twitter_card: "summary_large_image"
---

# How to Set Up Your Own AI Agent (Self-Hosted Hermes): The Complete Beginner's Guide

![A code editor on a screen showing terminal output, representing setting up a self-hosted AI agent on your own server.](https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200&q=80)
*Your own AI agent, running on a server you control, built from an empty VPS.*

Imagine texting an AI on Telegram that is genuinely *yours*. It remembers your projects across weeks, runs on a server you control, costs a few dollars a month instead of a flat subscription, and quietly does real work on a schedule: a morning news briefing, an inbox digest, a backup job, without you lifting a finger. That is what a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) gives you, and this guide walks you through building one from an empty server, whether or not you have ever opened a terminal.

> **Short on time, or not a fan of terminals?** There is a shortcut that does this entire guide in a single command. Skip to the companion post, [Deploy Your Own AI Agent in One Command with hstack](deploy-ai-agent-one-command-hstack.md). This page is the manual way: slower, but you will understand exactly what every piece does and why.

[INTERNAL-LINK: one-command deployment shortcut → deploy-ai-agent-one-command-hstack.md]

**Realistic time:** about 30 minutes on the Telegram path if everything goes smoothly, closer to an hour the first time. **What you will need:** a small VPS (roughly $5/month) and a model API key, or an existing ChatGPT subscription you already pay for.

> **Key Takeaways**
> - Hermes Agent is open-source (MIT license) and runs on a $5 VPS, a Raspberry Pi, or a spare mini PC.
> - The standout feature is persistent memory across sessions and projects.
> - Running cost is roughly **$10–17/month all-in** (VPS + model API fees) for typical personal use.
> - Setup takes about **30 minutes** on the Telegram path.
> - Pin version `hermes-agent==0.15.2` so future releases can't silently break your setup.

## Table of contents

1. [What Hermes Agent actually is](#1-what-hermes-agent-actually-is)
2. [What you can actually do with it](#2-what-you-can-actually-do-with-it)
3. [Before you start: requirements and cost](#3-before-you-start-requirements-and-cost)
4. [Step 1, Choose and provision a VPS](#4-step-1-choose-and-provision-a-vps)
5. [Step 2, Install Hermes](#5-step-2-install-hermes)
6. [Step 3, Pick a model](#6-step-3-pick-a-model)
7. [Step 4, Your first chat](#7-step-4-your-first-chat)
8. [Step 5, Connect a messaging platform](#8-step-5-connect-a-messaging-platform)
9. [Step 6, Memory and personality](#9-step-6-memory-and-personality)
10. [Step 7, Scheduled tasks (cron)](#10-step-7-scheduled-tasks-cron)
11. [Step 8, Keep it running](#11-step-8-keep-it-running)
12. [Security hardening](#12-security-hardening)
13. [Cost optimization](#13-cost-optimization)
14. [Common mistakes and troubleshooting](#14-common-mistakes-and-troubleshooting)
15. [What's real vs what's marketing](#15-whats-real-vs-whats-marketing)
16. [Coming from OpenClaw](#16-coming-from-openclaw)
17. [Coming soon: Digital Crew specialist agent plugins](#17-coming-soon-digital-crew-specialist-agent-plugins)
18. [FAQ](#18-faq)
19. [The one-command shortcut](#19-the-one-command-shortcut)

---

## 1. What Hermes Agent actually is

Hermes Agent is an open-source personal AI agent released by Nous Research on February 25, 2026, under an MIT license. Its core promise is that the agent is *yours*: it runs on your own hardware, stores its memory as plain markdown files you can open with any text editor, and isn't gated behind anyone's subscription tier.

[INTERNAL-LINK: open-source AI agent comparison → related pillar on self-hosted AI options]

Two interfaces come in the box. The first is a terminal: type `hermes` and chat in your shell. The second, and the one most people care about, is the **gateway**: a background process that connects the agent to messaging apps. Once it's running, your agent is reachable from Telegram, Discord, Slack, WhatsApp, Signal, Matrix, email, SMS and Home Assistant. It ships with 40+ built-in tools (web search, file operations, code execution and more) and supports the Model Context Protocol (MCP) for adding more.

Two things make Hermes distinct from a plain chatbot:

- **A learning loop.** When the agent completes a complex task, it can extract a reusable "skill" and refine it on later runs, building a small library of things it knows how to do for you.
- **Persistent memory.** It keeps a profile of you and notes about your work in `~/.hermes/` and can full-text-search past conversations. This is the feature users consistently single out. One summed it up as being able to "jump from one project to the next but go back to something from last week."

It's genuinely cheap to run. The official site describes it as working on "a $5 VPS, a GPU cluster, or serverless infrastructure that costs nearly nothing when idle." For a personal assistant, a $5–7/month VPS is plenty.

> **Citation capsule:** Hermes Agent is an open-source AI agent released by Nous Research on February 25, 2026, under an MIT license. It runs on hardware as modest as a $5/month VPS and ships with 40+ built-in tools, persistent file-based memory, and integrations for eight messaging platforms. (Nous Research, 2026)

---

## 2. What you can actually do with it

Before the setup steps, it helps to know what you're building toward. These are real workflows people run on Hermes today, drawn from the official tutorials and the community.

### Daily briefings

This is the canonical use case, and Hermes ships an official "Daily Briefing Bot" tutorial for it. You give the gateway a cron job like:

```
/cron add "0 8 * * *" "Search the web for the latest news about AI agents and open-source LLMs. Find at least 5 recent articles from the past 24 hours. Summarize the top 3 stories in a concise daily briefing."
```

At 8:00 AM every day, the agent runs that prompt in a fresh session and delivers a formatted briefing to your Telegram or Discord. People have taken this further: one user built a Turkish-language financial briefing aggregating market data and news into a daily PNG card pushed to Telegram; another runs a daily AI-research brief that "picks signals, writes briefs and tracks items it previously ignored."

### Inbox triage and email

Hermes can be given its own inbox (via integrations like AgentMail, or JMAP for Fastmail) and asked to summarize email, extract action items, and deliver a digest before you open your laptop. One developer runs a full production email pipeline on it (with Postgres and the Gmail API) for 8+ hours a day.

### Web and market research

An official multi-platform research engine runs a single query across Reddit, X, YouTube, Hacker News and Polymarket at once. Community members have built private research stacks pairing Hermes with a self-hosted SearXNG search container to avoid per-query API costs, and "second brain" wikis that compound knowledge instead of letting it rot in scattered notes.

### Home and device automation

With a Home Assistant token, Hermes auto-enables a toolset that lists entities, reads their state and calls services, so you can control lights, climate and switches by texting your agent. There's an Android control toolset (taps, swipes, screenshots) and even community skills for remote car control. People run it 24/7 on a Raspberry Pi 5 for exactly this.

### A family assistant

One of the most-shared stories is a user who set up a single Hermes agent for his family of three, each member using it for different things over WhatsApp. He frames it as replacing a $200/month assistant subscription. Others run an iMessage family assistant on an always-on Mac Studio, or have it write daily bedtime stories for a child.

### Developer and Git automation

Official tutorials cover periodic pull-request review on a cron (no webhook endpoint needed) and real-time PR comments via a signed GitHub webhook. Developers use it for end-to-end coding workflows, nightly repo backups and CI-style checks.

The point: this is not a toy. It's a programmable, always-on assistant. Now let's build one.

---

## 3. Before you start: requirements and cost

You need three things: a server, a model and (optionally) a messaging account to reach the agent.

**On your own machine:** nothing special. Just a web browser and, if you go the manual VPS route, an SSH client (built into macOS, Linux and modern Windows).

**The server:** a VPS running Ubuntu 24.04 LTS. Minimums depend on how the model runs:
- **1 vCPU / 2 GB RAM** is fine when the model runs via an API (the common case).
- **2 vCPU / 4 GB+** if you want browser automation, which uses an anti-detection browser that needs extra memory.

**The model:** an API key from a provider, or an OAuth login to a subscription you already have. Budget roughly **$6–10/month** for typical personal use.

**A messaging account:** a Telegram account is the easiest starting point and costs nothing.

> **A note on Windows:** Hermes installs natively on Windows. The CLI, gateway, TUI and tools all run without WSL. Open PowerShell and run `irm https://hermes-agent.nousresearch.com/install.ps1 | iex`. WSL2 also works if you prefer it. For an *always-on* agent, though, you still want a Linux VPS running 24/7 rather than your personal machine, which is what this guide assumes.

---

## 4. Step 1, Choose and provision a VPS

A VPS is a small always-on computer in the cloud. You'll install Hermes on it so your agent runs 24/7, independent of your laptop. Pick one of the three paths below.

[INTERNAL-LINK: VPS comparison for AI agents → related article on choosing a VPS provider]

### Hostinger (one-click)

Hostinger is the friendliest path for non-developers because it has a **one-click Docker deploy** for Hermes: no terminal required to get the software installed.

1. Sign up and choose a **KVM 2** plan (2 vCPU, 8 GB RAM, NVMe storage). This is comfortable headroom.
2. Set the operating system to **Ubuntu 24.04 LTS** and pick the datacenter geographically closest to you (lower latency).
3. In hPanel, go to **Docker Manager → Compose → One-click deploy**, search for **"Hermes,"** and deploy it.
4. When it finishes, it shows an **admin username and password**. Save these in a password manager immediately.
5. Open the built-in **web terminal** (Docker Manager → Open). This is where you'll run the remaining `hermes` commands. Since Hermes is already installed via the one-click image, you can skip the manual install in Step 2 and go straight to Step 3.

> **Heads-up on price:** Hostinger's cheap introductory rate renews higher. Check the renewal price before committing to a long term.

### DigitalOcean (popular, manual)

DigitalOcean is a clean, well-documented choice if you're comfortable with SSH.

1. Create a **Droplet**: Ubuntu 24.04, the Basic plan (around $6–12/month for 2 GB+ RAM), nearest region.
2. Add your SSH key during creation (more secure than a password).
3. Connect: `ssh root@your-droplet-ip`.
4. Continue with the manual install in Step 2.

### Hetzner / any other VPS (cheapest, manual)

Hetzner offers some of the best price-to-performance available. A **CX22** (roughly €4/month) is more than enough.

1. Create a server with Ubuntu 24.04.
2. SSH in.
3. Continue with the manual install in Step 2.

Any VPS provider works. The steps are identical once you have an Ubuntu box and SSH access.

---

## 5. Step 2, Install Hermes

> **Hostinger one-click users:** your Hermes is already installed. Open the web terminal and skip ahead to Step 3.

For everyone else, install Hermes with the **official one-line installer**, then run `hermes setup` to configure it. Do NOT run the installer with `sudo`.

**macOS / Linux** — SSH into your server and run:

```bash
# 1. Install (the official installer; grabs the current stable build).
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash

# 2. Reload your shell so the `hermes` command is found.
source ~/.bashrc

# 3. Configure — interactive: pick provider, model, and paste keys.
hermes setup

# 4. Confirm it worked.
hermes --version
```

**Windows** — open PowerShell (native, no WSL needed) and run:

```powershell
irm https://hermes-agent.nousresearch.com/install.ps1 | iex
hermes setup
```

`hermes setup` is the all-in-one configuration wizard. It walks you through choosing a provider and model and storing your API key. Step 3 below goes deeper on *which* model to pick (you can re-run that part anytime with `hermes model`).

### A note on versions

The installer pulls the **current stable build** (at the time of writing, PyPI `0.15.2` / GitHub tag `v2026.5.29.2`, the same release under two numbering schemes). If you specifically need to **lock** a version for reproducibility, install via pip instead: `pip install "hermes-agent==0.15.2"`, and upgrade deliberately later. For most people, the official installer is the right call.

### The #1 beginner trap: "command not found"

If you run `hermes --version` and see `hermes: command not found` right after a "successful" install, **you are not broken.** The installer added `hermes` to your PATH in your shell config, but your current shell session hasn't reloaded it. Run `source ~/.bashrc` (or just close and reopen the terminal) and try again. This single issue stops more first-time users than anything else.

### Other install gotchas

- **Never use `sudo` for the installer.** It creates root-owned files that the agent (running as your user) cannot read later. If you already did a sudo install, remove it (`sudo rm /usr/local/bin/hermes`) and reinstall as your normal user.
- **On a headless server, skip the browser component** if the installer offers it. The Chromium dependencies are the most common cause of a failed install on minimal VPS images.

---

## 6. Step 3, Pick a model

Hermes is the body; the model is the brain. Run the interactive picker:

```bash
hermes model
```

You'll choose a provider and a specific model. The sensible options are below.

Hermes supports a wide provider list: **OpenRouter** (400+ models), **Anthropic**, **OpenAI**, **Google / Gemini**, **Nous Portal** (300+), **X-AI / Grok**, **MiniMax**, plus a custom-endpoint option. Auth is either an API key or an **OAuth** browser flow (depending on the provider). The sensible defaults:

| Choice | Best for | Notes |
|--------|----------|-------|
| **Nous Portal** | Easiest start | One subscription, main + aux + image gen + TTS + cloud browser. Setup is one step (see below). |
| **OpenAI Codex (OAuth)** | Non-developers | Log in with your existing ChatGPT account, no new API account, no per-token bill. |
| **OpenRouter** | Cheapest quality | A single account fans out to 400+ models (DeepSeek, Llama, Qwen, etc.) at competitive rates; good catch-all. |
| **Claude / GPT / Gemini direct** | Highest quality / lowest latency | Pay-per-token via Anthropic / OpenAI / Google directly. |
| **X-AI (Grok) · MiniMax** | Specialty models | Direct providers if you want their specific models. |
| **Ollama (local)** | Privacy / free (needs powerful hardware) | Runs on your own hardware; needs a capable machine. Set `-c 65536` to clear the 64K context minimum. |

[INTERNAL-LINK: model cost comparison → article on AI model pricing for self-hosted agents]

### The easiest option: Nous Portal (one subscription, no key-juggling)

If collecting and configuring several provider keys sounds like a hassle, especially if you want vision, web search, image generation and text-to-speech to *just work*, use **Nous Portal**. It is a single subscription covering the model, web search, image generation, TTS and a cloud browser, set up in one step:

```bash
hermes setup --portal
```

This is the most beginner-friendly path: one account instead of four. It sidesteps the "capability degradation" trap below entirely, because the auxiliary features are all powered out of the box. If you'd rather use your own provider keys (for cost control or a specific model), the table above still applies.

### The two rules that prevent silent failures

1. **Use a model with at least 64,000 tokens of context.** Hermes rejects smaller context windows at startup because it can't sustain multi-step tool use without them. This applies to the auxiliary models too (the ones used for vision and summarization).
2. **Do not pick a tiny local model to save money.** Small models hallucinate tool calls that don't exist and break the agent in confusing ways. If you want local, use a genuinely capable model on adequate hardware.

### Set secrets the safe way

When you provide an API key, do it through the CLI. Never paste it into a chat.

```bash
hermes config set OPENROUTER_API_KEY "sk-or-..."
```

This writes the key to `~/.hermes/.env` (secrets) rather than `~/.hermes/config.yaml` (settings) and keeps it out of conversation history. Then lock the file down:

```bash
chmod 600 ~/.hermes/.env
```

### A subtle one: auxiliary models

Hermes runs one main model **plus eight auxiliary slots** for tasks like context compression, vision/image analysis, web-page summarization, approval scoring, MCP tool routing, session-title generation, and skill search. Per the docs, every auxiliary slot defaults to `auto`, meaning Hermes reuses your main model for that task too. So if your main model is capable (64K+ context, vision-able where you need it), the aux features work out of the box.

The trap is if you **override** an aux slot to a different provider and forget to add that provider's key, or pick a main model that doesn't support vision: then the dependent feature stops working with no loud error. The fix is to either leave aux on `auto` or make sure any override has its key wired (a catch-all provider like OpenRouter is a good default).

---

## 7. Step 4, Your first chat

Before wiring any messaging platform, confirm the agent works on its own. This is the golden rule of Hermes setup: **get a plain chat working first, then add features.** Debugging is far easier when you know the core is solid.

```bash
hermes # opens the interactive chat, or `hermes --tui` for the nicer UI
```

Say hello. Ask it something. If it responds sensibly, your install and model are good. A fast non-interactive smoke test you can script:

```bash
hermes -z "reply with the single word OK"
```

If that prints `OK`, you're ready to connect a platform.

---

## 8. Step 5, Connect a messaging platform

### Why start with Telegram?

The gateway makes Hermes reachable from your phone. Start with Telegram: it's the only fully headless platform (no QR scan, no browser OAuth), so it's the most reliable first connection. The others follow once you're comfortable.

### Telegram (start here)

1. In Telegram, message **@BotFather**. Send `/newbot`, give your bot a display name and pick a username that ends in `bot`. BotFather replies with a **token** that looks like `123456789:ABCdef...`. Copy the whole thing.
2. Message **@userinfobot**. It replies with your **numeric user ID** (a number like `849...`). Copy it.
3. Wire them up:

```bash
hermes config set TELEGRAM_BOT_TOKEN "123456789:ABCdef..."
hermes config set TELEGRAM_ALLOWED_USERS "849..." # your numeric ID
chmod 600 ~/.hermes/.env
hermes gateway restart
```

4. Message your bot "hello" from the account whose ID you allow-listed.

**The two silent-failure traps with Telegram:**
- Put your **numeric ID** in `TELEGRAM_ALLOWED_USERS`, not your `@username`. This is the single most common reason a Telegram bot "runs but never replies."
- Copy the **full** token, including the part after the colon. Copying only the part before the colon is the second most common cause.

If the bot stays silent on the first message, that's normal. The gateway often needs one restart "nudge" after first setup. Run `hermes gateway restart` and try again. You can even tell the agent in the terminal, "the Telegram connection isn't working," and it will diagnose itself.

### Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications), create a New Application, open the **Bot** tab and click **Reset Token** to get your bot token.
2. **Critically:** in the Bot tab, enable two **Privileged Gateway Intents**: **Message Content Intent** (so the bot can read message text) and **Server Members Intent** (so it can resolve usernames). Without both, the bot connects but is effectively deaf.
3. Use the OAuth2 URL generator to invite the bot to your server (bot scope).
4. Get your own Discord user ID (enable Developer Mode in settings, then right-click yourself → Copy User ID).
5. Wire it:

```bash
hermes config set DISCORD_BOT_TOKEN "your-token"
hermes config set DISCORD_ALLOWED_USERS "your-user-id"
chmod 600 ~/.hermes/.env
hermes gateway restart
```

If you want replies in the channel rather than in threads, set `discord.auto_thread` to `false` in `config.yaml`.

### WhatsApp

WhatsApp uses QR pairing (it emulates WhatsApp Web via the Baileys library; no Meta developer account needed). Because it needs your phone, it's the "add it next" platform, not the headless first choice.

```bash
hermes config set WHATSAPP_ENABLED true
hermes config set WHATSAPP_ALLOWED_USERS "15551234567" # your number, country code, NO + and no spaces
chmod 600 ~/.hermes/.env
hermes whatsapp # prints a QR code
```

Scan the QR from your phone: WhatsApp → Settings → Linked Devices → Link a Device. Two things to know: the allowlist is **bare phone numbers** (no `+`) and you should **not** use WhatsApp's internal `@lid` identity format in the allowlist (that path has a known open bug). The documented, working format is the plain phone number.

### Slack

Slack uses Socket Mode, which means no public endpoint and no signing secret.

1. At [api.slack.com/apps](https://api.slack.com/apps), create an app and enable **Socket Mode**.
2. Get two tokens: a **Bot token** (`xoxb-...`, from OAuth & Permissions) and an **App-Level token** (`xapp-...`, from Basic Information → App-Level Tokens, with the `connections:write` scope).
3. Wire both, then invite the bot to a channel with `/invite @YourBot`. Proactive messages silently fail if the bot is not in the channel.

```bash
hermes config set SLACK_BOT_TOKEN "xoxb-..."
hermes config set SLACK_APP_TOKEN "xapp-..."
hermes config set SLACK_ALLOWED_USERS "U01ABC..." # your Slack member ID
hermes gateway restart
```

One quirk: on Slack the home-channel command is `/hermes sethome`, not the bare `/sethome` used on other platforms.

### Mattermost (self-hosted teams)

If you run Mattermost yourself, create a bot account in the System Console, copy its access token and point Hermes at the server URL. On a shared VPS where Mattermost is another container, use the **internal Docker URL** (not the public DNS name) and connect the two containers on the same Docker network first.

### The rule that ties them all together

**The allowlist is mandatory on every platform.** The gateway denies every user by default. If you skip the allowlist, either nothing works, or, worse, on some platforms your bot is open to anyone who finds it. Always set the allowed users.

---

## 9. Step 6, Memory and personality

### Give your agent a name and personality (SOUL.md)

Your agent's identity lives in `~/.hermes/SOUL.md`. Write it directly as plain markdown. Don't rely on an interactive wizard, which can hang on an unattended server. Keep it short: it's injected into the system prompt on **every single message**, so every extra line costs tokens.

```bash
cat > ~/.hermes/SOUL.md <<'EOF'
# Identity
You are Atlas, a personal assistant for Paarth.
# Style
Concise, direct, helpful. No filler, no hedging.
# Avoid
Long preambles, fabricated results, over-apologizing.
EOF
```

If this file is empty, Hermes falls back to a generic "You are Hermes Agent" identity. Make sure it has content.

### Understand the memory ceiling (this matters)

[PERSONAL EXPERIENCE]: Hermes' built-in memory is genuinely useful but **bounded**. It's structured note-taking against a character budget, not unbounded learning. Practitioners report that once it fills, the agent starts spending turns consolidating its own memory instead of doing your work. The exact budget isn't called out on the docs' reference page, so treat it as "limited, will fill" rather than a precise number, and watch your sessions for "reorganizing memory" turns as the tell. The "grows with you" framing is aspirational; in practice it's a finite scratchpad.

If you hit the ceiling, you can attach an external memory provider (mem0, Supermemory, Honcho and others). Note that some of these require installing a Python package into the Hermes virtual environment. The setup step reports success without doing this, so the agent crashes on first use if you skip it. For most people, the built-in memory is the right default. Reach for an external provider only when you actually outgrow it.

---

## 10. Step 7, Scheduled tasks (cron)

Cron is where Hermes goes from "chatbot" to "assistant." Jobs run the agent on a timer and deliver results to your home channel.

```bash
hermes cron create "every 1d" "Push my notes repo to GitHub"
hermes cron create "0 8 * * *" "Summarize the top 3 AI stories from the last 24 hours"
hermes cron list
```

You can also just tell the agent in chat: "every morning at 8am, summarize my unread emails." It writes the cron job itself and converts your local time to UTC.

Two scheduled jobs are worth adding for reliability, not features:
- A **nightly gateway restart**, which sidesteps a known memory leak before it can crash the agent (more on that below).
- A **nightly backup** of `~/.hermes`, because there are no automatic backups.

Remember the design constraint from the official docs: a cron job runs in a *fresh session with no conversational memory*, so the prompt must contain everything the agent needs to do the job.

---

## 11. Step 8, Keep it running

A chat that dies when you close your terminal is not an assistant. Make the gateway durable.

- **Autostart on a normal VPS:** install it as a service with `hermes gateway install`, then enable user lingering so it starts at boot without a login: `loginctl enable-linger "$USER"`.
- **On Docker:** run with `--restart unless-stopped` and always mount your data directory (`-v ~/.hermes:/opt/data`). An unmounted volume means you lose everything on the next restart.
- **On WSL:** do *not* use systemd here. It's buggy in WSL. Run the gateway in a `tmux` or `nohup` session instead.
- **The clean restart:** if the gateway ever gets stuck, the fix is `hermes gateway stop`, then remove the stale PID file (`rm -f ~/.hermes/gateway.pid`) and any lock files, then `hermes gateway start`. A leftover PID file after a crash causes a restart loop.
- **Back up `~/.hermes` weekly.** It holds your config, memory, skills and session history. Push it to a private repo on a cron.

---

## 12. Security hardening

### Why does this matter for a personal agent?

Self-hosted AI agents have a poor track record when it comes to exposure, not because the software is bad, but because people deploy it carelessly. Public internet scans have repeatedly found large numbers of self-hosted AI servers accessible with no authentication (see [Shodan research on exposed AI endpoints](https://www.shodan.io), and the [OWASP Top 10 for LLM Applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)). Don't be one of them.

> **Citation capsule:** The OWASP Top 10 for LLM Applications (2025 edition) lists "Sensitive Information Disclosure" and "Improper Output Handling" among the leading risks for deployed AI agents. Public internet scanning services like Shodan routinely surface AI agent endpoints with no authentication. Least-privilege configuration is the primary mitigation. (OWASP, 2025)

The checklist below takes about five minutes to apply.

**Allowlist everything.** Set `*_ALLOWED_USERS` for every platform. Never enable an "allow all users" mode on an agent that can run terminal commands. This is the single most important rule. One misconfigured bot, running as your user, with shell access, is a serious risk.

**Lock down secrets.** Run `chmod 600 ~/.hermes/.env`. Never paste keys into chat. Never commit `.env` to git. These are short steps with a big payoff.

**Never install as root/sudo.** It breaks file permissions and widens your attack surface considerably.

**Sandbox risky work.** Set the terminal backend to Docker (`TERMINAL_BACKEND=docker`) so the agent runs commands in a container, not directly on your host. Several experienced users scope the agent tightly: for example, allowing it to reach a home machine only through a Tailscale tag.

**Use a firewall.** On a fresh VPS, expose only the ports you actually need (usually just SSH). Everything Hermes needs for messaging is outbound. UFW makes this a two-command job.

The theme: localhost by default, explicit and authenticated when remote, least privilege everywhere.

> **Citation capsule:** OWASP's 2025 LLM Top 10 names "Excessive Agency" as a top risk: agents with broad tool access and weak access controls can be prompted into unintended actions. The mitigations are allowlisting users, sandboxing shell execution, and running agents as unprivileged users. (OWASP, 2025)

---

## 13. Cost optimization

The whole appeal of self-hosting is cost control, so it's worth doing deliberately.

### A worked monthly estimate

- **VPS:** $4–7/month (Hetzner CX22, DigitalOcean basic, or Hostinger KVM2).
- **Model:** for typical personal use, a handful of chats a day plus a couple of cron jobs, expect **$6–10/month** in API fees on a cost-effective model like DeepSeek V4.
- **Total: roughly $10–17/month**, versus around $100/month for a premium hosted assistant tier.

### Where the money actually goes

[ORIGINAL DATA]: The following token breakdown was measured on Hermes Agent v0.15.2 with default configuration (default SOUL.md, full built-in tool set enabled, no custom MCP servers). Be aware of the fixed overhead. In some versions, a large share of every request is overhead: tool definitions and the system prompt, before you've typed anything.

| Component of each request | Tokens | Share |
|---------------------------|-------:|------:|
| Tool definitions | ~8,759 | ~46% |
| System prompt (SOUL.md + skills catalog) | ~5,176 | ~27% |
| Your actual message | ~5,000 | ~27% |

That means roughly **70%+ of each request can be fixed overhead.** Three levers keep your bill down:

1. **Enable prompt caching** (`hermes config set prompt_caching.enabled true`). Stable system prompts cache across requests and cost far less on repeat hits.
2. **Keep `SOUL.md` short**, under 1 KB. It's sent on every message.
3. **Pick a cost-effective model.** DeepSeek V4 and similar give frontier-quality results at a fraction of premium-model prices. Switch anytime with `hermes model`.

---

## 14. Common mistakes and troubleshooting

The single highest-value table in this guide. Most "Hermes is broken" reports are one of these.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `hermes: command not found` after install | Shell hasn't reloaded PATH | `source ~/.bashrc` or reopen the terminal |
| Install fails on a fresh VPS | Browser/Chromium dependencies | Reinstall skipping the browser component |
| Permission errors after install | Installed with `sudo` | Remove the sudo install; reinstall as your user |
| Telegram bot runs but never replies | `@username` instead of numeric ID, or truncated token | Use the numeric ID from @userinfobot; copy the full `digits:letters` token |
| Discord bot reads nothing | Missing privileged intents | Enable Message Content + Server Members intents |
| Bot ignores everyone | Empty allowlist (gateway denies by default) | Set `*_ALLOWED_USERS` |
| Model error 400 on first chat | Model name typo or wrong key (OpenAI key on OpenRouter) | Re-run `hermes model`; match key to provider |
| "Context length exceeded" immediately | Model under 64K context | Choose a model with ≥64K context |
| Vision/web features "don't work," no error | Auxiliary model not keyed | Add a provider key (e.g. OpenRouter) |
| Gateway crash-loops every 30s | Stale `gateway.pid` after a crash | `gateway stop`, remove the PID + lock files, `gateway start` |
| Memory grows to many GB, then OOM | A gateway memory leak over ~a day | Add a nightly `gateway restart` cron; pin a stable version |
| Agent "forgets" / acts weird | Stale or full memory files | Ask it to read its memory aloud; prune; consider external memory |

When in doubt, `hermes doctor` runs a diagnostic and `hermes logs gateway -n 50` shows recent gateway activity.

[INTERNAL-LINK: gateway memory leak workaround → detailed troubleshooting article]

---

## 15. What's real vs what's marketing

[UNIQUE INSIGHT]: The self-hosted-agent space is noisy. Being honest about a tool builds more trust than hyping it, so here's the candid version.

**Genuinely good (and verified by real users):**
- Persistent memory across projects. The most-praised feature, consistently.
- "It just runs" reliability, especially compared to some alternatives that break on every update.
- The breadth of messaging integrations. No other open agent connects to as many platforms.
- Cheap, transparent, debuggable self-hosting: memory is flat files plus one SQLite database you can read with normal tools.

**Overstated, adjust your expectations:**
- "An agent that grows with you / self-improving." In reality, memory is a bounded character budget. The agent writes small markdown files and curates them. It's structured note-taking, not open-ended learning.
- Headline performance numbers ("X% faster") are often vendor-internal benchmarks without independent confirmation.

**Real gotchas to plan around:**
- A large fraction of each request can be fixed token overhead. Watch your costs, especially in the first week.
- The gateway can leak memory and crash after roughly a day of uptime. Restart it nightly.
- Auxiliary-powered features can fail silently if a key is missing. Set it up right the first time.

None of this means Hermes is a bad choice. It's a genuinely good one. It just means you should go in with clear eyes, which is exactly why this guide pre-empts each issue.

---

## 16. Coming from OpenClaw

If you're migrating from OpenClaw, Hermes has a built-in path: `hermes claw migrate` imports your settings, memory, skills and API keys. Two cautions: **back up first** and **re-verify the imported skills.** OpenClaw's skill marketplace had a documented supply-chain problem with malicious skills, so don't import blindly. Diff what comes over before trusting it.

---

## 17. Coming soon: Digital Crew specialist agent plugins

Alongside the core setup flow, we're preparing a set of optional specialist agent plugins modeled on [Digital Crew Technology](https://www.digitalcrew.tech/en)'s real roster. Each one targets a specific business function, not a generic assistant role:

- **Sophie (HR Business Partner)** — runs first-round interviews, screens candidates, and shortlists the strongest ones.
- **Claire (Market Mastermind)** — researches markets, competitors, and target accounts, then delivers actionable briefs.
- **Max (Outbound Sales Force)** — qualifies leads, sends personalized outreach, and books meetings. Max is already live at [max.digitalcrew.tech](https://max.digitalcrew.tech/).
- **Camille (Customer Support Champion)** — handles tier-1 support, monitors customer health, and flags churn risk.
- **Kate (Marketing Maestro)** — plans campaigns, writes copy, and ships content across email, social, and site.
- **André (Finance & Admin)** — handles invoicing, reporting, and recurring admin.

**Status:** coming soon. The intent is to keep setup simple while making repeated business workflows easier to delegate when you want that structure. Track progress in the [Agent Plugins Roadmap](https://github.com/paarths-collab/hstack#-agent-plugins-roadmap).

---

## 18. FAQ

### Do I need to know how to code to set up Hermes?

Not really, especially on the Hostinger one-click path, where the software installs without a terminal. You do need to be comfortable copying a token from Telegram and pasting it where prompted. If even that feels like too much, the [one-command hstack approach](deploy-ai-agent-one-command-hstack.md) hands the whole job to Claude Code.

### How much does it cost per month?

Roughly $10–17/month all-in for typical personal use: $4–7 for the VPS and $6–10 for model API fees on a cost-effective model. That's well below premium hosted assistant subscriptions, which typically run $100/month or more.

### Can I use my existing ChatGPT or Claude subscription instead of an API key?

Yes. Choose the OAuth login path during `hermes model` (for example, OpenAI Codex with your ChatGPT account). It rides your existing subscription rather than billing per token. Be aware that providers sometimes route third-party-tool usage differently, so watch your usage the first week.

### Which messaging platform should I connect first?

Telegram. It's the only fully headless option: pure token and numeric ID, no QR scan or browser OAuth. Add WhatsApp, Discord, Slack, or others once Telegram is working.

[INTERNAL-LINK: detailed Telegram bot setup → expanded Telegram configuration guide]

### Is my data private?

Yes, in the sense that everything lives on your server: memory, conversations and config are local files. Your prompts still go to whatever model provider you choose, so pick a provider you trust, or run a local model for full privacy.

### What happens when a new Hermes version comes out?

Nothing changes until you upgrade. That's the point of pinning `0.15.2`. When you decide to upgrade, back up first (`hermes backup`), then update, then re-verify each platform still responds.

### Can multiple people use one agent?

Yes. Add each person's user ID to the allowlist. Many family setups run a single agent shared over WhatsApp or iMessage.

### Does it work offline / fully local?

The agent and its memory are local, but it needs a model. With a local model via Ollama on capable hardware, you can run fully offline, at the cost of speed and quality compared to a frontier API model.

### Why does my agent keep "reorganizing its memory"?

You've hit the memory budget. It's consolidating to make room. Prune old notes or attach an external memory provider.

### Can it run on a Raspberry Pi?

Yes, if the model runs via an API. People run Hermes 24/7 on a Raspberry Pi 5. Local models on a Pi are not realistic.

---

## 19. The one-command shortcut

Everything above works, and the first time you do it by hand, you'll understand your agent far better for it. But it's a lot of steps and every one has a trap.

If you'd rather skip the manual work, **hstack** turns Claude Code into the engineer that runs this entire guide for you, with every trap above already solved. You paste one command, answer about five questions, and your agent is live.

→ **[Deploy Your Own AI Agent in One Command with hstack](deploy-ai-agent-one-command-hstack.md)**

---

**About the author:** [Paarth](https://github.com/paarths-collab) builds hstack, an open-source toolkit for deploying self-hosted Hermes agents, and wrote this guide after deploying Hermes from scratch and cataloguing every failure along the way. Written in collaboration with [Digital Crew Technology](https://www.digitalcrew.tech/en). hstack is independent open-source software (MIT); Hermes Agent is a project of Nous Research. Hostinger and other VPS providers are fully supported.

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BlogPosting",
      "headline": "Self-Hosted AI Agent Setup: The Complete Hermes Guide",
      "description": "Set up a self-hosted Hermes AI agent on a VPS in about 30 minutes for $10–17/month all-in: install, model, Telegram, memory, security and cost.",
      "datePublished": "2026-06-01",
      "dateModified": "2026-06-03",
      "author": {
        "@type": "Person",
        "name": "Paarth",
        "url": "https://github.com/paarths-collab"
      },
      "publisher": {
        "@type": "Organization",
        "name": "Digital Crew Technology",
        "url": "https://www.digitalcrew.tech/en"
      },
      "url": "https://www.digitalcrew.tech/en/blog/hermes-agent-setup-guide",
      "image": "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1200&q=80"
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "Do I need to know how to code to set up Hermes?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Not really, especially on the Hostinger one-click path, where the software installs without a terminal. You do need to be comfortable copying a token from Telegram and pasting it where prompted."
          }
        },
        {
          "@type": "Question",
          "name": "How much does Hermes Agent cost per month?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Roughly $10–17/month all-in for typical personal use: $4–7 for the VPS and $6–10 for model API fees on a cost-effective model. That is well below premium hosted assistant subscriptions."
          }
        },
        {
          "@type": "Question",
          "name": "Which messaging platform should I connect first?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Telegram. It is the only fully headless option: pure token and numeric ID, no QR scan or browser OAuth. Add WhatsApp, Discord, Slack, or others once Telegram is working."
          }
        },
        {
          "@type": "Question",
          "name": "Is my data private with a self-hosted Hermes agent?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes, in the sense that everything lives on your server: memory, conversations and config are local files. Your prompts still go to whatever model provider you choose, so pick a provider you trust, or run a local model for full privacy."
          }
        },
        {
          "@type": "Question",
          "name": "Can multiple people use one Hermes agent?",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "Yes. Add each person's user ID to the allowlist. Many family setups run a single agent shared over WhatsApp or iMessage."
          }
        }
      ]
    }
  ]
}
</script>
