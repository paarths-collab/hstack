<div align="center">

# hstack

**One command. Your own AI agent, deployed.**

hstack turns Claude Code into the engineer who sets up your self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) for you — installs it, picks the model, wires your messaging platforms, hardens it, and keeps it alive. You answer ~5 questions. Claude does the rest.

*Modeled on [gstack](https://github.com/garrytan/gstack). MIT licensed. Built by Paarth · Sponsored by Digital Crew.*

</div>

---

## Why hstack exists

Installing Hermes was never the hard part — it ships its own `curl | bash`. **The pain is everything after**: the gateway that crashes after a day, 73% token overhead that runs up surprise bills, capabilities that silently die when a key is missing, allowlists that lock you out, and a dashboard with no built-in auth.

hstack is **the production layer Hermes is missing** — a self-healing, secured, observable deploy in one Claude Code command, for people who want self-hosting without living in a terminal.

> It took the author ~4 hours to set up Hermes by hand the first time. Once Claude Code had the VPS access, it did ~90% of the work itself. hstack productizes that.

## What you get

- **`/hermes-deploy`** — the whole setup end-to-end: install → model → platforms → skills → memory → personality → home channel → autostart → verify.
- **A library of small commands** for everything after — restart, status, update, fix, backup, dashboard.
- **Reliability baked in** — every known trap pre-solved (PATH breakage, the OOM leak, the stale gateway lock, the OAuth-vs-API-key fork, the WhatsApp LID bug). hstack pins a known-good Hermes version.
- **Secure by default** — localhost-bound, allowlist-enforced, secrets `chmod 600`, no dashboard exposed without auth.

---

## Quick start

> **Requirements:** [Claude Code](https://claude.com/claude-code), Git, and a server to deploy to (a fresh Ubuntu 24.04 VPS works — Hostinger one-click is the easiest; DigitalOcean / Hetzner / any VPS also supported).

Open Claude Code and paste this:

```
Install hstack: run
  git clone --depth 1 https://github.com/paarths-collab/hstack.git ~/.claude/skills/hstack
  && cd ~/.claude/skills/hstack && ./setup
Then add an "hstack" section to CLAUDE.md listing the commands, and run /hermes-deploy.
```

Claude installs the toolkit, then `/hermes-deploy` walks you through the whole thing — stopping only for the ~5 things a machine can't do (mint a bot token, paste an API key, scan a QR, click OAuth, send the first "hello").

**Windows:** install under WSL2 — Hermes has no native Windows support.

---

## Commands

### Orchestrator
| Command | Does |
|---------|------|
| `/hermes-deploy` | Full end-to-end deploy. The one most people run. |

### Setup
| Command | Does |
|---------|------|
| `/hermes-install` | Installs Hermes (local or over SSH), pinned + PATH-safe. |
| `/hermes-model` | Configures provider + model + key. Frontier-default, never local. |
| `/hermes-skills` | Installs a curated starter skill pack. |
| `/hermes-memory` | Built-in (default) or an external provider. |
| `/hermes-soul` | Gives the agent a name + personality (`SOUL.md`). |
| `/hermes-home` | Sets the home channel for cron + notifications. |
| `/hermes-cron` | Adds scheduled tasks in plain language. |

### Platforms
| Command | Does |
|---------|------|
| `/platform-telegram` | Telegram bot (the reliable headless wedge). |
| `/platform-discord` | Discord bot (intents + channel config). |
| `/platform-whatsapp` | WhatsApp via QR pairing. |
| `/platform-slack` | Slack (Socket Mode). |
| `/platform-mattermost` | Mattermost (self-hosted). |

### Operations
| Command | Does |
|---------|------|
| `/hermes-status` | Health check — gateway, platforms, memory, logs. |
| `/hermes-restart` | Clean restart (stop → clear locks → start). |
| `/hermes-update` | Safe update with backup + re-verify. |
| `/hermes-fix` | Diagnose + repair common failures. |
| `/hermes-backup` | Back up config + sessions. |
| `/hermes-dashboard` | Turn on the monitoring dashboard, safely. |

---

## How it works

hstack is a set of Markdown **skills** — instructions Claude Code follows, plus small bash scripts. No new infrastructure, no daemon. Each command is one `skills/<name>/SKILL.md`.

```
You paste one command
        │
        ▼
  ./setup registers the skills + adds an hstack section to CLAUDE.md
        │
        ▼
  /hermes-deploy  ──orchestrates──►  /hermes-install → /hermes-model → platforms →
                                     skills → memory → soul → home → autostart → verify
        │
        └── stops only for secrets/human steps (token, key, QR, OAuth, first hello)
```

### What Claude does vs. what needs you

**Claude does, unattended:** runs the installer, writes every config/secret via `hermes config set`, installs skills, seeds memory + SOUL, creates cron jobs, registers + starts the gateway, runs the smoke test, self-diagnoses.

**Only you can:** mint secrets (bot token, API key, GitHub token), OAuth/device flows, scan the WhatsApp QR, toggle Discord intents, and send the first "hello."

---

## Reliability — what hstack pre-solves

Every item below is a real, logged failure mode hstack handles so you don't hit it:

- **PATH "command not found"** after a "successful" install → PATH-safe absolute paths + explicit reload.
- **Gateway memory leak → OOM crash** ([#25315](https://github.com/NousResearch/hermes-agent/issues/25315)) → pinned version, memory cap, nightly restart, stale-PID clearing.
- **73% token overhead → surprise bills** ([#4379](https://github.com/NousResearch/hermes-agent/issues/4379)) → prompt caching, lean SOUL.md, cost awareness.
- **Silent capability degradation** (vision/web/compression die with no key) → capability-aware wiring + warnings.
- **A provider 429 takes the whole gateway offline** ([#16677](https://github.com/NousResearch/hermes-agent/issues/16677)) → context-window validation, fallback.
- **Tiny invisible memory ceiling** (~1,375 / ~2,200 chars) → surfaced, with one-click external memory.
- **Dashboard has no auth** → localhost-bound by default; never exposed without auth + HTTPS.

See [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md) for the full catalogue.

---

## Deploy targets

hstack works on **any VPS**, with **Hostinger as the recommended one-click default** (genuinely the easiest path for non-technical users). Provider guides:

- [Hostinger (one-click Docker)](blog/01-hermes-setup-guide.md#track-a--one-click-install-non-developers) — recommended
- DigitalOcean / Hetzner / AWS (manual) — [advanced section](blog/01-hermes-setup-guide.md#advanced-other-vps-providers)

## Security defaults

- Localhost binding everywhere; network exposure is an explicit, warned opt-in.
- Allowlists enforced (no open bots); secrets written to `.env` with `chmod 600`, never to `config.yaml` or chat.
- Dashboard is read-only by default; if exposed, hstack ships its own auth + TLS (the upstream dashboard has none).

## Honest positioning

Hermes is genuinely good at: **persistent cross-project memory**, an **unmatched messaging-gateway breadth**, "it just runs," and **$6–10/mo cost predictability**. It is *not* "an agent that grows with you / self-improving" — memory is structured note-taking against a tight character budget. hstack describes things as they are.

## Blog / guides

- [Set up Hermes Agent — beginner's guide](blog/01-hermes-setup-guide.md) (the manual way)
- [One command instead of ten screenshots — hstack](blog/02-hermes-one-command.md)

## License

MIT — see [LICENSE](LICENSE). Built by Paarth. Sponsored by Digital Crew.
