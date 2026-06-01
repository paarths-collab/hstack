---
title: "Deploy Your Own AI Agent in One Command with hstack"
description: "hstack turns Claude Code into the engineer that sets up a self-hosted Hermes Agent for you — install, model, messaging platforms, memory, autostart, and a dashboard — from a single paste. Here's how it works and why it's reliable."
date: "2026-06-01"
author: "Paarth · Digital Crew"
tags: [hstack, hermes-agent, claude-code, self-hosted-ai, one-command, ai-agent, automation]
canonical: "https://example.com/blog/hermes-one-command-hstack"
---

# Deploy Your Own AI Agent in One Command

Setting up a self-hosted AI agent the manual way works — we wrote [the full beginner's
guide](01-hermes-setup-guide.md) — but it's a lot of steps, and every one has a trap waiting. So here's
the shortcut.

**hstack** turns [Claude Code](https://claude.com/claude-code) into the engineer who does the whole
thing for you. You paste **one command**, answer about **five questions**, and your AI is live on your
phone. Claude does the other 95%.

> The idea came from doing it the hard way. The first manual Hermes setup took ~4 hours. But once
> Claude Code had access to the server, it did ~90% of the work itself — Docker, config, tokens,
> restarts. hstack productizes exactly that.

---

## The one command

Open Claude Code and paste:

```
Install hstack: run
  git clone --depth 1 https://github.com/paarths-collab/hstack.git ~/.claude/skills/hstack
  && cd ~/.claude/skills/hstack && ./setup
Then add an "hstack" section to CLAUDE.md, and run /hermes-deploy.
```

That's it. `/hermes-deploy` runs the entire setup end-to-end.

---

## What it actually does

`/hermes-deploy` runs eight steps in order — the same eight from the [manual guide](01-hermes-setup-guide.md),
but automated and hardened:

1. **Install** Hermes (pinned, PATH-safe, no sudo)
2. **Model** — picks a frontier model, validates the context window
3. **Skills** — installs a curated starter pack
4. **Platforms** — Telegram, Discord, WhatsApp, Slack, Mattermost
5. **Memory** — built-in by default, with the real ceiling explained
6. **Personality** — writes a lean `SOUL.md`
7. **Home channel** — so scheduled tasks have somewhere to deliver
8. **Autostart** — survives reboot, with a nightly restart to dodge the memory leak

It stops to ask you only for the **~5 things a machine can't do**: mint a bot token, paste an API key,
scan a QR code, click an OAuth button, and send the first "hello."

After setup, a library of small commands stays around for daily life: `/hermes-status`,
`/hermes-restart`, `/hermes-update`, `/hermes-fix`, `/hermes-backup`, `/hermes-dashboard`.

---

## Why it's reliable (the whole point)

Anyone can write a script that runs `curl | bash`. hstack's value is that it **already knows every
trap** — knowledge pulled from real GitHub issues and user reports, that the official wizard doesn't
have:

- The **PATH "command not found"** failure that stops most beginners cold → solved.
- The **gateway memory leak** that OOM-crashes the agent after a day → pinned version + nightly restart.
- The **73% token overhead** that runs up surprise bills → prompt caching + a lean prompt.
- **Capabilities that silently die** when a key is missing → detected and warned.
- The **dashboard with no built-in auth** → never exposed without your own auth + HTTPS.

It pins a **known-good Hermes version** so a future release can't break your setup, and it keeps your
agent alive through updates. (Full list: the repo's `reference/TROUBLESHOOTING.md`.)

---

## Where it deploys

hstack works on **any VPS**, with **Hostinger as the one-click default** — genuinely the easiest path
for non-technical users (the one-click Docker deploy means no terminal at all). Other providers are
fully supported as the advanced path:

- **Hostinger** (recommended, one-click) — [setup guide](01-hermes-setup-guide.md#hostinger-recommended--easiest-one-click-)
- **DigitalOcean** (manual) — [setup guide](01-hermes-setup-guide.md#digitalocean-popular-manual)
- **Hetzner / any VPS** (manual) — [setup guide](01-hermes-setup-guide.md#hetzner--any-other-vps-cheapest-manual)

---

## Honest about Hermes

hstack doesn't oversell. Hermes is genuinely good at persistent cross-project memory, the widest
messaging-platform support out there, "it just runs," and **$6–10/mo cost predictability**. It is *not*
a magic "self-improving" brain — memory is structured notes against a tight budget. We'd rather you
know that going in.

---

## Try it

1. Get a VPS ([Hostinger one-click](01-hermes-setup-guide.md#hostinger-recommended--easiest-one-click-) is easiest).
2. Paste the one command into Claude Code.
3. Answer the five prompts.
4. Say "hello" to your new agent.

**Repo:** [github.com/paarths-collab/hstack](https://github.com/paarths-collab/hstack) · MIT licensed ·
Built by Paarth · In collaboration with Digital Crew.

→ Prefer to understand every step first? Read [the manual beginner's guide](01-hermes-setup-guide.md).
