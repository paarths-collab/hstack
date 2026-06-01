---
title: "Deploy Your Own AI Agent in One Command with hstack"
description: "Self-host a Hermes Agent on a VPS in one Claude Code command. hstack automates install, model, Telegram/WhatsApp/Discord, memory, and autostart — and pre-solves the real failures (the OOM leak, 73% token overhead, the no-auth dashboard) that break manual setups."
date: "2026-06-01"
author: "Paarth · Digital Crew"
tags: [hermes-agent, self-hosted-ai, ai-agent, claude-code, telegram-bot, vps, hstack]
canonical: "https://example.com/blog/deploy-ai-agent-one-command-hstack"
image: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80"
image_alt: "Close-up of a circuit board representing a self-hosted AI agent running on your own server hardware"
---

# Deploy Your Own AI Agent in One Command with hstack

![A circuit board, representing a self-hosted AI agent running on your own server.](https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80)
*Your own AI, on your own server — deployed from a single command. Photo: [Unsplash](https://unsplash.com/photos/L4iI59WB4Yw).*

You can deploy a private, self-hosted AI agent — one that texts you on Telegram, remembers your
projects, and runs scheduled work — in a **single command pasted into Claude Code**. [hstack](https://github.com/paarths-collab/hstack)
turns Claude Code into the engineer who installs [Hermes Agent](https://github.com/NousResearch/hermes-agent),
wires your messaging apps, and hardens the deployment for you. You answer about five questions, and the
tooling does the rest.

I built hstack after setting up a Hermes Agent by hand the slow way. **In my experience, that first
manual install took about four hours** — every error was a wall, from Docker networking to a gateway
that kept crashing. But once I handed Claude Code the server access, it did roughly 90% of the work
itself. So hstack is simply that experience, packaged: every wall I hit is now pre-solved, and the parts
Claude can automate, it does.

## Key takeaways

- **One paste, ~5 questions, ~30 minutes** to a live agent on your phone — no terminal expertise needed.
- Self-hosting a Hermes Agent costs roughly **$6–10/month** in model fees versus ~$100/month for hosted
  assistant tiers, per community cost breakdowns.
- The hard part was never the install — it's the **reliability gaps after**: a gateway memory leak that
  OOM-crashes after ~a day ([GitHub #25315](https://github.com/NousResearch/hermes-agent/issues/25315)),
  ~73% fixed token overhead per request ([#4379](https://github.com/NousResearch/hermes-agent/issues/4379)),
  and a dashboard with no built-in authentication.
- hstack pins a **known-good Hermes version (v0.15.0)** and pre-solves each documented failure.
- **Hostinger** is the recommended one-click target; DigitalOcean, Hetzner, and any VPS are supported.

## Why self-host an AI agent at all?

Self-hosting gives you ownership, predictable cost, and privacy that hosted assistants can't match. Your
data stays on your server. You choose the model. And you pay per use instead of a flat monthly premium.
Hermes Agent is built exactly for this. It's an open-source, MIT-licensed agent from Nous Research,
released in February 2026. Because it's so lean, it runs on a $5 VPS or a Raspberry Pi. It also stores
memory as plain files plus one SQLite database you can read with a text editor, and it connects to
roughly 20 messaging platforms.

So if Hermes is this capable, why does anyone need hstack? The answer is setup friction. As one Hacker
News user put it after two weeks of use, *"having a competent agent with constant state has been good… I've
been pretty pleased. Surprised even."* However, getting there by hand meant Docker, model config, platform
tokens, allowlists, and gateway crashes. As a result, the community's own workaround became telling Claude
Code to install Hermes for them. hstack simply productizes that workaround.

## The one command

Deploying with hstack is a single paste into [Claude Code](https://claude.com/claude-code). Open Claude
Code and run:

```
Install hstack: run
  git clone --depth 1 https://github.com/paarths-collab/hstack.git ~/.claude/skills/hstack
  && cd ~/.claude/skills/hstack && ./setup
Then add an "hstack" section to CLAUDE.md, and run /hermes-deploy.
```

That installs the toolkit — a library of small Markdown skills — and `/hermes-deploy` runs the full
setup end to end. It stops only for the handful of actions a machine genuinely cannot perform: minting a
bot token, pasting an API key, scanning a QR code, clicking an OAuth button, and sending the first "hello."

## What `/hermes-deploy` automates

The orchestrator runs eight setup stages in sequence, each hardened against a known failure. You supply
secrets; Claude does the mechanical work.

| Stage | What happens | You provide |
|-------|--------------|-------------|
| Install | Pinned, PATH-safe Hermes install | nothing |
| Model | Frontier model + key, context validated | an API key |
| Platforms | Telegram / Discord / WhatsApp / Slack | a bot token |
| Skills | Curated starter pack installed | nothing |
| Memory | Built-in by default, ceiling explained | nothing |
| Personality | A lean `SOUL.md` written | a name |
| Home channel | Where notifications land | nothing |
| Autostart | Survives reboot, nightly restart | nothing |

After setup, small operational commands stay available for daily life — `/hermes-status`,
`/hermes-restart`, `/hermes-update`, `/hermes-fix`, `/hermes-backup`, and `/hermes-dashboard`.

## Reliability: the real reason hstack exists

Anyone can script `curl | bash`. However, the real value is in pre-solving the failures that the
official wizard doesn't warn you about — failures documented in Hermes' own issue tracker. In our
testing, these are the ones that actually break a manual deployment. The chart below shows the single
most expensive one: fixed overhead on every request.

<svg role="img" aria-label="Bar chart showing roughly 73 percent of each Hermes request is fixed token overhead: 8,759 tokens for tool definitions, 5,176 for the system prompt, and about 5,000 of actual user content out of roughly 19,000 total" viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" style="max-width:100%;height:auto;font-family:system-ui,sans-serif">
  <text x="0" y="20" fill="#e7eaf0" font-size="15" font-weight="700">Where every Hermes request's tokens go (v0.6.0)</text>
  <g font-size="13" fill="#c9d1d9">
    <text x="0" y="62">Tool definitions</text>
    <rect x="150" y="50" width="420" height="18" rx="3" fill="#f87171"/>
    <text x="580" y="64" fill="#f87171" font-weight="700">8,759</text>
    <text x="0" y="102">System prompt</text>
    <rect x="150" y="90" width="248" height="18" rx="3" fill="#fbbf24"/>
    <text x="408" y="104" fill="#fbbf24" font-weight="700">5,176</text>
    <text x="0" y="142">Actual user content</text>
    <rect x="150" y="130" width="240" height="18" rx="3" fill="#5ee2b5"/>
    <text x="400" y="144" fill="#5ee2b5" font-weight="700">~5,000</text>
  </g>
  <text x="0" y="190" fill="#8b949e" font-size="12">~73% of each request is fixed overhead before you type a word.</text>
  <text x="0" y="210" fill="#8b949e" font-size="11">Source: NousResearch/hermes-agent GitHub issue #4379</text>
</svg>

Here are the documented failures hstack handles so you never hit them:

- **Gateway memory leak → OOM crash.** The gateway can grow from ~400 MB to 20–37 GB over 20–35 hours,
  then get killed ([#25315](https://github.com/NousResearch/hermes-agent/issues/25315)). hstack pins a
  version, caps memory, and schedules a nightly restart.
- **73% token overhead → surprise bills.** Around 13,900 of ~19,000 tokens per request are fixed overhead
  ([#4379](https://github.com/NousResearch/hermes-agent/issues/4379)). hstack enables prompt caching and a
  lean prompt, and keeps browser tools off messaging gateways.
- **"Command not found" after a successful install.** The most common beginner dead-end — the shell hasn't
  reloaded PATH. hstack uses absolute paths and prints the reload step.
- **Silent capability degradation.** Vision, web summarization, and compression quietly stop working if a
  provider key is missing — with no error. hstack detects and warns.
- **A dashboard with no built-in auth.** The Hermes dashboard binds to localhost and reads your `.env`
  full of keys. hstack keeps it loopback-bound and never exposes it without auth and HTTPS.

The full catalogue, with issue numbers and fixes, lives in the repo's [`reference/TROUBLESHOOTING.md`](https://github.com/paarths-collab/hstack/blob/main/reference/TROUBLESHOOTING.md).

## Where it deploys: Hostinger, DigitalOcean, Hetzner

hstack runs on any VPS, with **Hostinger as the recommended one-click default** because its one-click
Docker deploy is genuinely the easiest path for non-technical users — no terminal at all. Other providers
work as the advanced, SSH-based path.

- **Hostinger (recommended):** one-click Docker deploy, then paste the hstack command in the web terminal.
- **DigitalOcean:** create an Ubuntu 24.04 Droplet (2 GB+ RAM), SSH in, paste the command.
- **Hetzner / any VPS:** a CX22 (~€4/month) or any Ubuntu box works the same way.

A practical minimum is 1 vCPU and 2 GB of RAM when the model runs via an API; add headroom for browser
automation. Check renewal pricing — cheap intro rates often step up.

## What's actually real (and what's marketing)

Honest framing matters, because the self-hosted-agent space is noisy. Hermes is genuinely strong in some
areas. However, it is overstated in others, and you deserve to know which is which.

**Genuinely good:** persistent memory across projects (the most-praised feature), "it just runs"
reliability, the widest messaging-platform support available, and transparent, cheap self-hosting.

**Overstated:** the "an agent that grows with you / self-improving" framing. In reality, memory is a
**fixed ~1,375-character user profile plus a ~2,200-character agent buffer** — roughly 20 short notes. So
it fills fast. Then the agent spends turns consolidating instead of working
([#32156](https://github.com/NousResearch/hermes-agent/issues/32156)). In short, it's structured
note-taking against a tight budget, not learning. Therefore hstack surfaces that ceiling on the dashboard
instead of hiding it.

## Migrating from OpenClaw

If you're coming from OpenClaw, Hermes ships a built-in migration: `hermes claw migrate` imports your
settings, memory, skills, and API keys. Back up first, and re-verify imported skills — OpenClaw's
marketplace had a documented supply-chain problem with malicious skills. hstack wraps the migration with a
backup and a diff so nothing is overwritten blindly.

## Frequently asked questions

### Do I need to know how to code to use hstack?

No. The entire point is that Claude Code does the terminal work. You paste one command and answer plain
questions like "what should your agent be called?" The Hostinger one-click path requires no terminal at
all. Basic comfort copying a token from Telegram is the only manual skill involved.

### How much does running a self-hosted Hermes Agent cost?

Expect roughly $6–10 per month in model API fees for typical personal use, plus a VPS from about $4–7 per
month. Community cost breakdowns put this well below hosted assistant tiers (~$100/month). Costs scale with
usage, so hstack enables prompt caching and surfaces a cost view to keep them predictable.

### Is the dashboard safe to expose on the internet?

Not by default — the upstream Hermes dashboard has no built-in authentication and can read your secrets.
hstack binds it to localhost and recommends access over an SSH tunnel. If you need remote access, hstack
puts it behind an authenticated HTTPS reverse proxy rather than exposing the raw port.

### Which messaging platform should I start with?

Telegram. It's the only fully headless option — setup is pure token and numeric user ID, with no QR scan
or OAuth. WhatsApp, Discord, Slack, and Mattermost are all supported and can be added afterward.

### What happens when Hermes releases a new version?

hstack pins a known-good version (v0.15.0) so a future release can't silently break your setup. When you
choose to upgrade, `/hermes-update` backs up first, updates, and re-verifies that every platform still
responds.

## Get started

1. Pick a VPS — Hostinger's one-click path is the easiest.
2. Paste the hstack command into Claude Code.
3. Answer the five prompts (token, key, name, platform, first "hello").
4. Say hello to your new agent.

The repo is open-source and MIT-licensed: [github.com/paarths-collab/hstack](https://github.com/paarths-collab/hstack).
Prefer to understand each step first? Read the companion [beginner's setup guide](01-hermes-setup-guide.md).

---

*Written by Paarth · Digital Crew. hstack is independent open-source software; Hermes Agent is a project
of Nous Research. Hostinger is the recommended deploy target, and other VPS providers are fully supported.*

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "BlogPosting",
      "headline": "Deploy Your Own AI Agent in One Command with hstack",
      "description": "Self-host a Hermes Agent on a VPS in one Claude Code command. hstack automates install, model, messaging platforms, memory, and autostart, and pre-solves the real failures that break manual setups.",
      "datePublished": "2026-06-01",
      "dateModified": "2026-06-01",
      "author": { "@type": "Person", "name": "Paarth", "affiliation": { "@type": "Organization", "name": "Digital Crew" } },
      "publisher": { "@type": "Organization", "name": "Digital Crew" },
      "image": "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1200&q=80",
      "mainEntityOfPage": { "@type": "WebPage", "@id": "https://example.com/blog/deploy-ai-agent-one-command-hstack" },
      "keywords": "hermes agent, self-hosted ai, ai agent, claude code, telegram bot, vps, hstack"
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        { "@type": "Question", "name": "Do I need to know how to code to use hstack?",
          "acceptedAnswer": { "@type": "Answer", "text": "No. Claude Code does the terminal work. You paste one command and answer plain questions. The Hostinger one-click path requires no terminal at all; copying a token from Telegram is the only manual skill involved." } },
        { "@type": "Question", "name": "How much does running a self-hosted Hermes Agent cost?",
          "acceptedAnswer": { "@type": "Answer", "text": "Roughly $6-10 per month in model API fees for typical personal use, plus a VPS from about $4-7 per month, per community cost breakdowns. That is well below hosted assistant tiers around $100 per month." } },
        { "@type": "Question", "name": "Is the dashboard safe to expose on the internet?",
          "acceptedAnswer": { "@type": "Answer", "text": "Not by default. The upstream Hermes dashboard has no built-in authentication and can read your secrets. hstack binds it to localhost and recommends access over an SSH tunnel, or an authenticated HTTPS reverse proxy for remote access." } },
        { "@type": "Question", "name": "Which messaging platform should I start with?",
          "acceptedAnswer": { "@type": "Answer", "text": "Telegram, because it is the only fully headless option: setup is pure token and numeric user ID, with no QR scan or OAuth. WhatsApp, Discord, Slack, and Mattermost are supported and can be added afterward." } },
        { "@type": "Question", "name": "What happens when Hermes releases a new version?",
          "acceptedAnswer": { "@type": "Answer", "text": "hstack pins a known-good version (v0.15.0) so a future release cannot silently break your setup. When you choose to upgrade, the update command backs up first, updates, and re-verifies that every platform still responds." } }
      ]
    }
  ]
}
</script>
