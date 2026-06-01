---
title: "Deploy Your Own AI Agent in One Command with hstack"
description: "Deploy a self-hosted Hermes AI agent on a VPS in one Claude Code command: hstack automates install, model, messaging, memory and security for you."
date: "2026-06-01"
lastmod: "2026-06-01"
author: "Paarth · Digital Crew"
tags: [hermes-agent, self-hosted-ai, ai-agent, claude-code, telegram-bot, vps, hstack, one-command]
# TODO: replace with your real self-referential canonical URL before publishing
canonical: "https://YOUR-DOMAIN.example/blog/deploy-ai-agent-one-command-hstack"
image: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80"
image_alt: "Close-up of a circuit board representing a self-hosted AI agent running on your own server"
og_title: "Deploy Your Own AI Agent in One Command with hstack"
og_description: "Self-host a Hermes AI agent on a VPS in one Claude Code command. hstack automates install, model, messaging, memory, autostart and security."
og_image: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80"
twitter_card: "summary_large_image"
---

# Deploy Your Own AI Agent in One Command with hstack

![A circuit board, representing a self-hosted AI agent running on your own server.](https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80)
*Your own AI, on your own server, deployed from a single command.*

You can deploy a private, self-hosted AI agent, one that texts you on Telegram, remembers your projects and quietly does scheduled work, by pasting **one command into Claude Code**. No four-hour setup, no Docker debugging, no chasing cryptic errors. [hstack](https://github.com/paarths-collab/hstack) turns Claude Code into the engineer who installs [Hermes Agent](https://github.com/NousResearch/hermes-agent), configures the model, wires your messaging apps and hardens the whole deployment for you. You answer about five questions; the tooling does the other 95%.

This guide explains exactly what that command does, why it is reliable where manual setups break and what you can build once your agent is live. If you would rather do it the manual way to understand every moving part first, read the companion post: [How to Set Up Your Own AI Agent (the manual guide)](01-hermes-setup-guide.md).

## Key takeaways

- **One paste, ~5 questions, ~30 minutes** to a live agent on your phone, no terminal expertise required.
- **hstack pre-solves the failures that break manual setups:** the PATH "command not found" trap, a gateway memory leak that crashes the agent after a day, ~73% fixed token overhead, silent capability failures and a dashboard with no authentication.
- **It pins a known-good Hermes version (v0.15.2, the current stable release)** so a future release cannot silently break your setup.
- **Secure by default:** localhost-bound, allowlist-enforced, secrets written to `.env` with `chmod 600`, dashboard never exposed without auth.
- **Multi-VPS with Hostinger as the one-click default;** DigitalOcean, Hetzner and any VPS are supported.
- **Running cost is roughly $10–17/month** all-in, versus ~$100/month for a premium hosted assistant.

## Table of contents

1. [The problem: setup was never the hard part](#1-the-problem-setup-was-never-the-hard-part)
2. [The one command](#2-the-one-command)
3. [What you'll need and how to get each](#3-what-youll-need-and-how-to-get-each)
4. [What `/hermes-deploy` actually does](#4-what-hermes-deploy-actually-does)
5. [The reliability layer: what hstack pre-solves](#5-the-reliability-layer-what-hstack-pre-solves)
6. [The command library](#6-the-command-library)
7. [The dashboard](#7-the-dashboard)
8. [What you'll actually do with your agent](#8-what-youll-actually-do-with-your-agent)
9. [Manual vs one-command](#9-manual-vs-one-command)
10. [Where it deploys](#10-where-it-deploys)
11. [Security defaults](#11-security-defaults)
12. [What's real vs what's marketing](#12-whats-real-vs-whats-marketing)
13. [Migrating from OpenClaw](#13-migrating-from-openclaw)
14. [FAQ](#14-faq)
15. [Get started](#15-get-started)

---

## 1. The problem: setup was never the hard part

Here is the uncomfortable truth about self-hosting an AI agent: installing it is easy. Hermes ships its own one-line installer. You can have the binary on a server in two minutes. The hard part, the part that eats your afternoon and makes people give up, is *everything after the install*.

The author of hstack learned this firsthand. The first manual Hermes setup took about four hours. Every error was a wall: Docker networking that would not cooperate, a gateway that crashed and refused to restart, a WhatsApp allowlist that silently rejected the right number, a model that hit a context-window error on the first long message. None of these are exotic. They are the *normal* experience of setting up Hermes by hand and they are all documented in the project's own issue tracker.

But something interesting happened during that four-hour slog. Once Claude Code had access to the server, it did roughly 90% of the work itself, it ran the installer, wrote the config, set the tokens, restarted the gateway and diagnosed failures. The human's job shrank to "paste the things a machine cannot mint": a bot token, an API key, a QR scan.

hstack productizes exactly that. It is the accumulated knowledge of every wall worth hitting, packaged so Claude Code can walk the whole path for you and stop only where a human is genuinely required. It is, in short, **the production layer that Hermes is missing**, for people who want a self-hosted agent without living in a terminal.

There is a natural pattern here and it is the one hstack is built on: once a capable coding agent can reach your server, "just have Claude Code do it for you" is a remarkably effective way to install Hermes. hstack takes that pattern and makes it repeatable and reliable, instead of something you reinvent from scratch each time.

### Why a command, not a hosted service?

It is worth being clear about what hstack is *not*. It is not a SaaS that runs your agent for you, takes your keys and charges a monthly fee. There are plenty of "managed Hermes hosting" pitches out there, and they trade the entire point of self-hosting (ownership, privacy, low cost) for convenience.

hstack keeps the ownership and adds the convenience. Your agent runs on *your* server, under *your* keys, with its memory in plain files *you* can read. hstack is just the installer-and-operator layer, delivered as open-source Markdown skills that run inside the Claude Code you already use. There is no hstack account, no hstack server in the middle and nothing to cancel. If hstack vanished tomorrow, your agent would keep running exactly as it is.

That is the philosophy: a command, not a middleman. You get the "it just works" experience of a hosted product while keeping everything that makes self-hosting worth doing in the first place.

---

## 2. The one command

Open [Claude Code](https://claude.com/claude-code) and paste this single command:

```
Install hstack: run
 git clone --depth 1 https://github.com/paarths-collab/hstack.git ~/.claude/skills/hstack
 && cd ~/.claude/skills/hstack && ./setup
Then add an "hstack" section to CLAUDE.md listing the commands and run /hermes-deploy.
```

That is the entire install. Claude clones the toolkit (a library of small Markdown skills), runs the setup script to register them as slash commands and adds a short section to your `CLAUDE.md` so it knows the command set. Then `/hermes-deploy` runs the full end-to-end setup.

You do not need to prepare anything in advance. The deploy command is conversational: it asks where to deploy, which model to use and which messaging platforms you want, then it does each step and pauses only when it needs something from you.

> **On Windows:** Hermes now runs natively, the CLI, gateway, TUI and tools all install without WSL (`iex (irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1)` in PowerShell). WSL2 is optional. But for an agent that answers 24/7 you still want it on an always-on Linux VPS rather than your laptop, which is the recommended target.

---

## 3. What you'll need and how to get each

You will not be asked to gather these ahead of time. During `/hermes-deploy`, **Claude pauses at each step and tells you exactly where to click and what to copy.** This table is just a reference for what it will ask for.

| You provide | Where to get it (Claude walks you through it) | Needed for |
|-------------|-----------------------------------------------|------------|
| **Server access** | **Hostinger:** hPanel → Docker Manager → Compose → one-click deploy → search "Hermes". **Other VPS:** your SSH host, user and password/key. | Install |
| **Model API key** | **Nous Portal (simplest):** one subscription covers the model, web search, image generation and TTS, Claude sets it up with `hermes setup --portal`, no separate keys to collect. **Or OpenRouter:** [openrouter.ai](https://openrouter.ai) → Keys → Create Key → copy `sk-or-...`. **Or OpenAI:** [platform.openai.com/api-keys](https://platform.openai.com/api-keys). **Or** log in with your existing ChatGPT account via OAuth. | Model |
| **Telegram bot token** | In Telegram, message **@BotFather** → `/newbot` → name it → username ends in `bot` → copy the token. | Telegram |
| **Your Telegram user ID** | In Telegram, message **@userinfobot** → it replies with your numeric ID. | Telegram allowlist |
| **Discord bot token + intents** | [discord.com/developers](https://discord.com/developers/applications) → New Application → Bot → Reset Token. Enable **Message Content** + **Server Members** intents. Invite via the OAuth2 URL. | Discord |
| **Your phone (WhatsApp)** | Scan the QR Claude shows: WhatsApp → Settings → Linked Devices → Link a Device. Allowlist = your number, country code, no `+`. | WhatsApp |
| **Slack tokens** | [api.slack.com/apps](https://api.slack.com/apps) → create app → enable Socket Mode → copy the Bot token (`xoxb-`) and App token (`xapp-`). | Slack |
| **Google AI key** *(optional)* | Free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), only for image/audio features. | Extras |

Claude never asks you to leave secrets lying around in the chat. It writes each one to `~/.hermes/.env` via `hermes config set` and `chmod 600`s the file, so your keys stay out of logs and history.

---

## 4. What `/hermes-deploy` actually does

The orchestrator runs eight stages in order. Each one is hardened against a specific, documented failure, that hardening is the whole value and it is covered in detail in the next section. Here is what each stage does and what (if anything) it needs from you.

### Stage 1, Install

Claude installs Hermes on the target, pinned to a known-good version and made PATH-safe so the dreaded "command not found" never appears. It verifies the binary runs before moving on. On Hostinger's one-click image, Hermes is already present, so this stage just confirms it. **You provide:** nothing (or SSH access for a non-Hostinger VPS).

### Stage 2, Model

Claude configures your provider and model, validates that the model meets the 64,000-token context minimum (smaller ones are rejected at startup), enables prompt caching to control cost and runs a smoke test that proves the agent can actually answer. If you would rather not juggle keys, Claude can set up **Nous Portal** (`hermes setup --portal`), one subscription that covers the model plus web search, image generation and TTS in a single step. **You provide:** an API key, an OAuth login, or a Nous Portal subscription.

### Stage 3, Platforms

Claude wires the messaging platforms you choose, handling the per-platform gotchas (Telegram's numeric-ID allowlist, Discord's two required intents, WhatsApp's QR pairing). It restarts the gateway with the "nudge" it needs after first setup. **You provide:** a bot token per platform and a QR scan for WhatsApp.

### Stage 4, Skills

Claude installs a curated starter pack of skills from pre-trusted registries, resolving canonical names first so nothing fails on a version-dependent name. **You provide:** nothing.

### Stage 5, Memory

Claude confirms built-in memory (always on) and explains its real ceiling so you are not surprised later. It only configures an external provider if you ask. **You provide:** nothing by default.

### Stage 6, Personality

Claude writes a lean `SOUL.md`, your agent's name and style, directly to disk (not via an interactive wizard that could hang), kept small because it is injected on every message. **You provide:** a name and any style preference.

### Stage 7, Home channel

Claude sets the home channel so scheduled tasks and notifications have somewhere durable to land. **You provide:** nothing (it uses the platform you already wired).

### Stage 8, Autostart

Claude installs the gateway as a service so it survives reboots, enables lingering where needed and adds a nightly restart cron to sidestep the memory leak. Then it runs a final verification: send a test, confirm a reply. **You provide:** the first "hello" from your phone.

The result: an empty server becomes an AI replying on your phone, with the only human steps being the handful of secrets and clicks a machine genuinely cannot perform.

### See it work: a real deploy walkthrough

It is easier to picture if you see the shape of the conversation. A typical `/hermes-deploy` run reads like this (abridged):

```
You: /hermes-deploy

Claude: Where should I deploy your agent?
 1) Hostinger (one-click, easiest) 2) Another VPS over SSH 3) Local
You: 1, Hostinger

Claude: Open hPanel → Docker Manager → Compose → one-click deploy, search "Hermes" and deploy it. It'll show an admin username and password, paste them here,
 then open the web terminal (Docker Manager → Open).
You: Done, here are the admin credentials.

Claude: Connected to the web terminal. Hermes is already installed by the one-click
 image, confirming version... `hermes --version` → 0.15.2. ✓
 Which model? I recommend DeepSeek V4 (cheapest quality) or your ChatGPT login.
You: DeepSeek V4

Claude: Paste your OpenRouter key (get one at openrouter.ai → Keys). It goes straight
 to ~/.hermes/.env, not the chat history.
You: sk-or-...

Claude: Key saved, chmod 600 applied. Context window OK (>=64K). Smoke test: agent
 replied "OK". ✓
 Which platforms? (Telegram is easiest, pure token, no QR.)
You: Telegram

Claude: In Telegram, message @BotFather → /newbot → copy the token. Then @userinfobot
 for your numeric ID. Paste both here.
You: [token] [numeric id]

Claude: Wired. Restarting the gateway (it needs one nudge after first setup)...
 Now message your bot "hello" from your phone.
You: It replied! "Hi, I'm Atlas, how can I help?"

Claude: Setting up autostart so it survives reboots, adding a nightly restart to
 avoid the known memory leak and a nightly backup. Done.
 ✅ Your agent is live. Try /hermes-status anytime.
```

The whole thing is a guided conversation. You are never staring at a blank terminal wondering what to type next, Claude tells you the next move at every step.

---

## 5. The reliability layer: what hstack pre-solves

This is the heart of the project. Anyone can script `curl | bash`. The value is in pre-solving the failures that the official wizard does not warn you about, every one of which is documented in Hermes' own issue tracker or its FAQ. Here is the catalogue and how hstack handles each.

### PATH "command not found" after a successful install

The single highest-churn failure. The installer adds `hermes` to your PATH in a shell config file, but the live shell and background services like systemd and launchd, inherit a minimal PATH that does not include it. The result is a "command not found" right after a "success" message and most beginners assume the install failed. **hstack** uses the absolute binary path everywhere and prints the exact reload step, so this never blocks you.

### Gateway memory leak → out-of-memory crash

A documented leak (issue #25315) causes the gateway to grow from a few hundred megabytes to tens of gigabytes over roughly 20–35 hours of uptime, then get killed by the OS. A naive `Restart=always` service turns this into a crash loop. **hstack** pins a stable version, runs the gateway with sane limits, schedules a nightly restart as a mitigation and clears the stale PID file on startup so a crash does not wedge the next launch.

### 73% token overhead → surprise bills

Issue #4379 documents that a large fraction of every request is fixed overhead, tool definitions and the system prompt, before you type a word. On messaging gateways this is worse, because browser tools that are useless on Telegram still get loaded. **hstack** enables prompt caching, keeps `SOUL.md` lean and avoids loading irrelevant tools, all of which directly lower the per-request token cost that drives your bill.

### Silent capability degradation

Vision, web summarization and compression are powered by auxiliary models. If the provider that powers them is not keyed, those features do not throw an error, they quietly stop working, which is maddening to debug. **hstack** computes which capabilities will degrade given the keys you provided and warns you up front, rather than letting you discover it weeks later. (The cleanest way to avoid this class of problem entirely is **Nous Portal**, which powers the model and all the auxiliary capabilities from a single subscription, hstack will offer it during the model stage.)

### A provider error taking the whole gateway offline

Issue #16677 shows that a model 429 (rate limit), 401 (auth), or timeout can crash the entire gateway process, taking every messaging bot offline with no user-facing error. **hstack** validates context-window minimums at setup, warns about provider/model combinations known to crash-loop and configures fallbacks so one provider hiccup does not silence your agent.

### The tiny, invisible memory ceiling

Built-in memory caps at roughly 1,375 characters for the user profile and 2,200 for agent memory (issue #32156). When full, the agent burns turns consolidating instead of working and nothing surfaces this to you. **hstack** explains the ceiling during setup and makes it a one-step move to attach an external memory provider (correctly installing its dependency, which the stock setup forgets to do).

### A dashboard with no authentication

The Hermes dashboard binds to localhost and reads your `.env` full of keys, but it has no built-in password. Bind it to `0.0.0.0` and anyone can read your credentials and security firms have found hundreds of thousands of self-hosted AI servers exposed exactly this way. **hstack** keeps the dashboard loopback-bound by default and never exposes it without its own authentication and HTTPS in front.

### Platform and host-specific traps

hstack also bakes in the smaller, version-specific landmines: it avoids Docker image tags with a known UID-permissions regression, uses `tmux`/`nohup` instead of systemd on WSL (where the service install is buggy), enforces allowlists so no bot is left open and pins a known-good, dashboard-working version so a later release cannot silently change behavior under you.

The full, continuously-updated catalogue with issue numbers lives in the repo's [`reference/TROUBLESHOOTING.md`](https://github.com/paarths-collab/hstack/blob/main/reference/TROUBLESHOOTING.md). This accumulated knowledge, not the install script, is what hstack really is.

### If something still goes wrong

hstack pre-solves these during deploy, but if you are debugging an existing setup, this quick map covers the most common symptoms. (Running `/hermes-fix` applies these automatically.)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `hermes: command not found` | Shell hasn't reloaded PATH | `source ~/.bashrc`; use the absolute binary path |
| Bot runs but never replies | Allowlist has `@username` not the numeric ID | Use the numeric ID; check the full token |
| Discord bot reads nothing | Missing privileged intents | Enable Message Content + Server Members |
| Gateway crash-loops | Stale `gateway.pid` after a crash | `/hermes-restart` (clears the lock) |
| Memory balloons, then OOM | The gateway leak over ~a day | Nightly restart cron (hstack adds this) |
| Vision/web "doesn't work," no error | Auxiliary model not keyed | Add a provider key |
| Dashboard reloads in a loop / won't load | v0.15.0's loopback-mode dashboard bug | Pin v0.15.2 (fixed in v0.15.1), hstack's default |

When in doubt, `/hermes-status` shows the current state and `/hermes-fix` repairs it.

---

## 6. The command library

`/hermes-deploy` is the orchestrator, but hstack ships a library of small commands you keep using long after setup. Each is a Markdown skill: clear instructions plus a short script, no new infrastructure.

### Orchestrator

- **`/hermes-deploy`**, the full end-to-end deploy. The command most people run first.

### Setup

- **`/hermes-install`**, installs Hermes (local or over SSH), pinned and PATH-safe.
- **`/hermes-model`**, configures provider, model and key; frontier-default, capability-aware.
- **`/hermes-skills`**, installs a curated starter skill pack.
- **`/hermes-memory`**, built-in by default, or attaches an external provider correctly.
- **`/hermes-soul`**, writes the agent's name and personality to `SOUL.md`.
- **`/hermes-home`**, sets the home channel for notifications and cron.
- **`/hermes-cron`**, adds scheduled tasks in plain language.

### Platforms

- **`/platform-telegram`**, the reliable headless wedge.
- **`/platform-discord`**, token plus the two required intents.
- **`/platform-whatsapp`**, QR pairing, phone-number allowlist.
- **`/platform-slack`**, Socket Mode, both tokens.
- **`/platform-mattermost`**, self-hosted teams.

### Operations (the part that keeps your agent alive)

- **`/hermes-status`**, health check: gateway, platforms, memory, logs.
- **`/hermes-restart`**, clean restart that clears stale locks.
- **`/hermes-update`**, safe update with backup and re-verify.
- **`/hermes-fix`**, diagnose and repair common failures.
- **`/hermes-backup`**, back up config and sessions.
- **`/hermes-dashboard`**, turn the dashboard on, safely.

This is the difference between a one-time install script and a tool you live with. When something needs attention months later, you do not re-learn Hermes internals, you run `/hermes-status` or `/hermes-fix` and let Claude handle it.

---

## 7. The dashboard

Hermes ships a built-in web dashboard on port 9119 with a full read-only JSON API, status, conversations, scheduled tasks, logs and cost. `/hermes-dashboard` turns it on the safe way.

Because the upstream dashboard has no built-in authentication, hstack binds it to localhost and gives you access over an SSH tunnel:

```bash
ssh -L 9119:127.0.0.1:9119 user@your-vps # then open http://127.0.0.1:9119
```

If you want remote, always-on access, hstack puts an authenticated HTTPS reverse proxy in front rather than exposing the raw port. The API contract for building a custom frontend on top of it lives in [`reference/api-endpoints.md`](https://github.com/paarths-collab/hstack/blob/main/reference/api-endpoints.md).

---

## 8. What you'll actually do with your agent

Once it is live, the question becomes "what should it do for me?" These are real workflows people run on Hermes today.

### A morning briefing

The classic. A cron job at 8 AM searches the web and delivers a summarized briefing to Telegram. People have extended this into localized financial briefings rendered as daily image cards and AI-research digests that track which signals they ignored last time.

### Inbox triage

Give the agent its own inbox and have it summarize email, pull out action items and send you a digest before you open your laptop. Developers run full production email pipelines on it.

### Research that compounds

Run one query across Reddit, X, YouTube, Hacker News and prediction markets at once. Pair it with a self-hosted search container to avoid per-query costs, or build a "second brain" wiki that accumulates knowledge instead of letting notes rot.

### Home and device control

With a Home Assistant token, control lights, climate and switches by texting your agent. There are community skills for Android control and even remote car start and EV battery checks. People run this 24/7 on a Raspberry Pi.

### A family assistant

One shared agent for the whole household over WhatsApp or iMessage, each person uses it differently. One user frames his family setup as replacing a $200/month subscription; another has it write daily bedtime stories for his daughter.

### Developer automation

Periodic pull-request review on a cron (no webhook needed), real-time PR comments via webhook, nightly repo backups and end-to-end coding workflows. This is the deepest category in the community.

The common thread: this is a programmable, always-on assistant that reaches you where you already are. hstack just gets you to that starting line in one command instead of an afternoon.

### Recipes to try in your first week

You set these up by just telling your agent in plain language, it writes the cron job itself and converts your local time to UTC. A few to start with:

- *"Every weekday at 8am, summarize the top 5 AI stories from the last 24 hours and send them here."*
- *"Every night at midnight, commit and push my notes repo to GitHub."*
- *"Every Monday at 9am, give me a short summary of my open GitHub pull requests."*
- *"Every hour, check if my website is up; only message me if it's down."*
- *"Every evening, list anything I told you to remember today so I can confirm it."*

Start with one. The value compounds as you add more and as the agent's memory of your preferences fills in.

### Day-2 operations: living with your agent

Setup is day one. The reason hstack ships a command library is day two and beyond, the small, recurring things that otherwise mean re-learning Hermes internals each time.

- **Check on it:** `/hermes-status` reports gateway state, connected platforms, memory usage against the ceiling and recent errors, in plain language.
- **Add a platform later:** decided you want Discord too? Run `/platform-discord`, it walks you through the token and intents without touching anything else.
- **Something acting up:** `/hermes-fix` runs the diagnostics and applies the catalogued fix for whatever it finds (a stuck gateway, a silent capability, a permission issue).
- **Upgrade safely:** `/hermes-update` backs up first, bumps the pinned version and re-verifies every platform still responds before declaring success.
- **Before anything risky:** `/hermes-backup` snapshots your config, memory and sessions so you can always roll back.

This is the difference between a script you run once and a tool you actually keep. You are not maintaining Hermes by hand; you are asking Claude to, with hstack's hard-won knowledge behind it.

---

## 9. Manual vs one-command

Both paths end at the same place, a working, self-hosted agent. The difference is how you spend your time and which mistakes you make.

| | Manual setup | hstack (one command) |
|---|---|---|
| Time | ~30–60 min, longer with errors | ~30 min, mostly waiting |
| Terminal skill needed | Moderate | Minimal |
| Traps you hit | All of them, the hard way | Pre-solved |
| Version safety | You choose (and might pick a broken one) | Pinned to a known-good build |
| Security defaults | Up to you | Localhost, allowlists, `chmod 600` by default |
| Ongoing operations | Re-learn Hermes each time | `/hermes-status`, `/hermes-fix`, etc. |
| Understanding gained | Deep | Shallower (but the docs are there) |

The honest recommendation: if you enjoy understanding your tools, do it manually once with the [companion guide](01-hermes-setup-guide.md), you will be a better operator for it. If you just want a reliable agent, or you are setting one up for someone non-technical, use hstack.

### Who hstack is for (and who it isn't)

**A great fit if you are:**
- A non-technical person who wants their own AI on WhatsApp or Telegram without learning Docker.
- A developer who *could* do it manually but would rather not re-debug the same five traps.
- Someone setting up an agent for a family member, a small team, or a client.
- An OpenClaw user migrating who wants the move handled safely.

**Probably not for you if you are:**
- Building something deeply custom that needs you to understand every internal, start with the manual guide instead, then automate.
- Unwilling to use a model API or a subscription at all (Hermes needs a model regardless of how you install it).
- On a platform with no Linux/WSL2 path available.

hstack does not lock you in. It is plain Markdown skills plus a small script; everything it does, you could do by hand. It just means you do not *have* to.

---

## 10. Where it deploys

hstack runs on any VPS, with **Hostinger as the recommended one-click default** because its one-click Docker deploy is genuinely the easiest path for a non-technical user, no terminal at all. Other providers work as the advanced, SSH-based path.

- **Hostinger (recommended):** one-click Docker deploy, then paste the hstack command in the web terminal. KVM 2 (2 vCPU / 8 GB) is comfortable.
- **DigitalOcean:** an Ubuntu 24.04 Droplet (2 GB+ RAM, ~$6–12/month), SSH in, paste the command.
- **Hetzner / any VPS:** a CX22 (~€4/month) or any Ubuntu box works identically.

A practical minimum is 1 vCPU and 2 GB of RAM when the model runs via an API; add headroom for browser automation. Always check renewal pricing, cheap intro rates often step up.

---

## 11. Security defaults

hstack is secure by default because the ecosystem's default is not. Out of the box:

- **Localhost binding.** Nothing is exposed to the network unless you explicitly, knowingly opt in.
- **Allowlists enforced.** No open bots, every platform requires an allowed-users list.
- **Secrets locked down.** Keys go to `~/.hermes/.env` with `chmod 600`, never to `config.yaml` and never into chat.
- **Dashboard never exposed raw.** Loopback-bound; remote access only behind authenticated HTTPS.
- **No sudo installs.** Avoids the root-owned-file permission failures and the wider attack surface.
- **Sandbox-friendly.** Encourages running the agent's terminal work in a container rather than directly on the host.

This matters because self-hosted AI servers are routinely found exposed to the internet with no protection at all. hstack turning "secure" into the default, rather than an optional afterthought, is one of its most valuable features.

---

## 12. What's real vs what's marketing

hstack does not oversell Hermes and neither should you. Here is the candid version.

**Genuinely good:** persistent memory across projects (the most-praised feature), "it just runs" reliability, the widest messaging-platform support of any open agent and cheap, transparent self-hosting where memory is plain files you can read.

**Overstated:** the "agent that grows with you / self-improving" framing. In reality, memory is a fixed ~1,375 / ~2,200 character budget, the agent writes small markdown files. It is structured note-taking against a tight budget, not open-ended learning. Headline performance numbers are usually vendor-internal.

**Real gotchas (all handled by hstack):** large fixed token overhead per request, a gateway memory leak over ~a day, silently-degrading auxiliary features and a no-auth dashboard.

Why the honesty? Because the self-hosted-agent space has a credibility problem, inflated claims and a flood of near-identical marketing posts. A tool that tells you the truth about its own foundation is one you can actually trust to run your agent.

---

## 13. Migrating from OpenClaw

If you are coming from OpenClaw, Hermes has a built-in migration that imports your settings, memory, skills and API keys (`hermes claw migrate`). hstack wraps this with two safeguards: it **backs up first** and it helps you **re-verify imported skills** before trusting them, OpenClaw's marketplace had a documented supply-chain problem with malicious skills, so importing blindly is a real risk. The migration is also a major reason people are moving to Hermes in the first place: a string of security issues on the other side, against Hermes' "it just runs" reputation.

---

## 14. FAQ

### Do I really only need one command?

To install hstack and kick off the deploy, yes, one paste. The deploy itself is then conversational: it asks a handful of questions and pauses for the secrets only you can provide (a token, a key, a QR scan, the first "hello"). Everything mechanical is automated.

### Do I need to know how to code?

No. Claude Code does the terminal work. You answer plain questions like "what should your agent be called?" and copy a token from Telegram when asked. The Hostinger one-click path needs no terminal at all.

### How is this different from just running Hermes' own installer?

The installer puts the binary on your machine, that part was never hard. hstack handles everything after: model and capability wiring, platform gotchas, memory, autostart, security and the dozen documented failure modes that the official wizard does not warn you about. It is the production layer, not a re-skinned installer.

### How much does it cost to run?

Roughly $10–17/month all-in: $4–7 for the VPS and $6–10 for model API fees on a cost-effective model like DeepSeek V4. That is well below premium hosted assistant tiers around $100/month.

### Is it safe? What about the dashboard?

hstack is secure by default: localhost binding, enforced allowlists, locked-down secrets. The dashboard, which has no built-in authentication upstream, is kept loopback-bound and accessed over an SSH tunnel, or put behind authenticated HTTPS for remote use. It is never exposed raw.

### Which model should I use?

For the best cost-to-quality ratio, DeepSeek V4 via OpenRouter. For maximum quality, Claude Sonnet or GPT. For zero new accounts, log in with your existing ChatGPT subscription. Any choice must support at least 64K context. You can switch anytime with `/hermes-model`.

### Which messaging platform should I start with?

Telegram, it is the only fully headless option (pure token and numeric ID, no QR or OAuth). Add WhatsApp, Discord, Slack, or Mattermost afterward.

### What happens when Hermes releases a new version?

Nothing breaks, because hstack pins a known-good version (v0.15.2, the current stable release). When you choose to upgrade past it, `/hermes-update` backs up first, updates and re-verifies that every platform still responds.

### Can I move my agent to a different server later?

Yes. Back up `~/.hermes` with `/hermes-backup`, move the archive and restore it. All your config, memory and skills travel with it.

### What if something breaks weeks later?

Run `/hermes-status` to see what is wrong, or `/hermes-fix` to diagnose and repair. The operational commands mean you do not have to re-learn Hermes internals to keep your agent healthy.

### Is hstack affiliated with Nous Research or Hostinger?

No. hstack is independent, open-source (MIT) software. Hermes Agent is a project of Nous Research; Hostinger is simply the recommended (and easiest) deploy target. Other VPS providers are fully supported.

### Can I run more than one agent?

Yes. Each Hermes profile is independent, with its own config, memory and gateway. You can run separate agents, say, a personal one and a work one, on the same server or on different servers and deploy each with hstack. Just keep their data directories and ports distinct.

### Will it work with a local model instead of an API?

Yes, via Ollama, if your hardware can run a genuinely capable model (small models hallucinate tool calls and break the agent). The trade-off is speed and quality versus a frontier API model. Most people use an API for quality and keep costs down with caching and a cost-effective model.

### How long does the whole deploy take?

About 30 minutes end to end and most of that is waiting, for the install to finish, for the gateway to start, for you to create a bot token. The actual hands-on time is a few minutes of answering questions.

### What does hstack install on my own machine?

Only the Claude Code skills: a folder of Markdown files under `~/.claude/skills/hstack` and a short section appended to your `CLAUDE.md`. It does not install Hermes locally (Hermes runs on your server) and it does not run anything as a background process on your laptop.

### Is my data sent anywhere I don't control?

Your agent's memory, conversations and config live on your server as local files. The only data that leaves is what you send to your chosen model provider (and to messaging platforms you connect). Pick a provider you trust, or run a local model for full privacy.

### Can I uninstall or undo it?

Yes. The skills are just files, delete the `~/.claude/skills/hstack` folder and remove the hstack section from `CLAUDE.md`. On the server, Hermes is a normal install you can remove. Nothing is hidden or locked.

### What if I get stuck mid-deploy?

`/hermes-deploy` is resumable in practice, each stage writes real config, so you can re-run it or run the individual command for the stage that failed (for example, `/hermes-model` or `/platform-telegram`). And because Claude is driving, you can simply tell it what went wrong and it will diagnose from the live state.

### Does hstack cost anything?

No. hstack itself is free and MIT-licensed. Your only costs are the VPS and the model API fees, the same costs you would have setting Hermes up manually. hstack does not add a fee, a subscription, or a markup.

### Can I customize what the deploy sets up?

Yes. The skills are plain Markdown, you can fork the repo and edit any `SKILL.md` to change defaults (a different starter model, an extra cron job, a custom `SOUL.md` template). Because there is no compiled binary, "customizing hstack" is just editing text files.

### What model context size do I actually need?

At least 64,000 tokens. Hermes rejects smaller windows at startup because multi-step tool use needs the headroom. hstack validates this for you during the model stage, including for the auxiliary models used for vision and summarization.

### How do I add a second messaging platform after setup?

Run the relevant platform command on its own, `/platform-discord`, `/platform-whatsapp`, `/platform-slack`, or `/platform-mattermost`. It wires only that platform and restarts the gateway, leaving everything else untouched.

### Will my agent keep running if I close my laptop?

Yes. The agent runs on your server, not your laptop. hstack installs the gateway as a service that survives reboots, so your laptop can be off entirely and the agent keeps answering on your phone.

---

## 15. Get started

After the deploy finishes, you will have:

- A self-hosted Hermes Agent running 24/7 on your own server.
- It replying to you on at least one messaging platform (Telegram and any others you added).
- A pinned, known-good version that will not break under you.
- Autostart on reboot, a nightly restart to dodge the memory leak and a nightly backup.
- Secure defaults: localhost-bound dashboard, enforced allowlists, locked-down secrets.
- A library of commands (`/hermes-status`, `/hermes-fix`, `/hermes-update`, …) for everything after.

To get there:

1. Pick a VPS, [Hostinger's one-click path](01-hermes-setup-guide.md#hostinger-recommended-easiest-one-click) is the easiest.
2. Paste the hstack command into Claude Code.
3. Answer the five prompts (token, key, name, platform, first "hello").
4. Say hello to your new agent.

The repo is open-source and MIT-licensed: **[github.com/paarths-collab/hstack](https://github.com/paarths-collab/hstack)**. Prefer to understand each step first? Read the companion [beginner's setup guide](01-hermes-setup-guide.md).

---

**About the author:** Paarth is the author of [hstack](https://github.com/paarths-collab/hstack) and built it after a four-hour manual Hermes deployment turned every documented failure mode into a lesson worth automating. Written in collaboration with Digital Crew. hstack is independent open-source software; Hermes Agent is a project of Nous Research. Hostinger is the recommended deploy target and other VPS providers are fully supported.

<!-- SEO schema (BlogPosting + FAQPage JSON-LD) is in deploy-ai-agent-one-command-hstack.schema.json, inject it into the page <head> at publish time, not into the rendered body. -->
