# hstack

One command deploys your own self-hosted Hermes AI Agent, then wires it into any of 72 external services on request. Works from every major AI coding agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e)](LICENSE)
![Skills 95](https://img.shields.io/badge/skills-95-f59e0b)
![Integrations 72](https://img.shields.io/badge/integrations-72-2dd4bf)
![Platforms 8](https://img.shields.io/badge/platforms-8-229ED9)
![Hermes v0.15.2](https://img.shields.io/badge/hermes-v0.15.2%20pinned-9d6bff)

> Built by Paarth · in collaboration with [Digital Crew Technology](https://www.digitalcrew.tech/en?utm_source=github&utm_medium=repo&utm_campaign=hstack).

---

## What it is

hstack is a portable skill catalog for AI coding agents. You install it once, and your agent — Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, or Hermes itself — gains the ability to:

1. **Deploy a self-hosted Hermes Agent** on your VPS with one command.
2. **Wire external services** into it on request (Notion, Stripe, Postgres, Pinecone, Twilio, and 67 more).

Every skill is SSH-first, idempotent, dry-run-previewable, and rollback-safe. No new runtime, no daemon — just Markdown instructions that AI agents execute.

## Quick start

Install the skills into every AI agent detected on your machine:

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash

# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
```

Then open your agent and run:

```
/hermes-deploy
```

It handles install → model → platform → memory → personality → autostart → verify. Stops only for things a machine can't do (bot tokens, WhatsApp QR, the first "hello").

### Picking what to install

```bash
bash install.sh --pick                        # interactive menu
bash install.sh --tier=memory,database        # tiers only
bash install.sh --include=notion,stripe,mem0  # specific integrations
bash install.sh --ide=claude,codex            # only wire specific agents
bash install.sh --all                         # everything, non-interactive
bash install.sh --help                        # full flag reference
```

## Commands

### Deploy & orchestrate

| Command | What it does |
|---|---|
| `/hermes-deploy` | Full end-to-end deploy. Most people only run this. |
| `/hermes-integrate` | Wire many integrations at once via a picker. |
| `/hermes-mcp-add` | The generic MCP-wiring primitive. |

### Setup

| Command | What it does |
|---|---|
| `/hermes-install` | Install Hermes (local or over SSH), pinned + PATH-safe. |
| `/hermes-model` | Configure provider + main/aux models. Covers OpenAI, Anthropic, OpenRouter, Google, Groq, Mistral, Together, Cohere. |
| `/hermes-skills` | Install a curated starter skill pack. |
| `/hermes-memory` | Built-in or an external memory provider. |
| `/hermes-soul` | Give the agent a name + personality (`SOUL.md`). |
| `/hermes-home` | Set the home channel for cron + notifications. |
| `/hermes-cron` | Schedule tasks in plain language. |

### Platforms

`/platform-telegram` · `/platform-discord` · `/platform-whatsapp` · `/platform-slack` · `/platform-mattermost` · `/platform-signal` · `/platform-google-chat` · `/platform-teams`

### Operations

| Command | What it does |
|---|---|
| `/hermes-status` | Health check across gateway, platforms, memory, logs. |
| `/hermes-restart` | Clean restart (stop → clear locks → start). |
| `/hermes-update` | Safe update with backup + re-verify. |
| `/hermes-fix` | Diagnose and repair common failures. |
| `/hermes-backup` | Back up config, secrets, memory, sessions. |

## Integrations (72)

Every skill probes the vendor's API with your credentials before writing anything, writes secrets to `~/.hermes/.env` with `chmod 600`, registers an MCP server or documents the REST surface, reloads the gateway, and rolls back cleanly on any failure.

**AI-agent-native**

| Tier | Skills |
|---|---|
| Memory | `mem0`, `supermemory` |
| Vector DB | `pinecone`, `qdrant` |
| RAG feeder | `firecrawl` |
| Code sandbox | `e2b` |
| AI tools | `openai-tools` (DALL-E / Whisper / embeddings / Batch), `elevenlabs`, `replicate` |

**Infra, auth, observability**

| Tier | Skills |
|---|---|
| Database | `supabase`, `postgres`, `neon`, `redis` |
| Auth | `auth0`, `clerk` |
| Observability | `posthog`, `sentry`, `datadog`, `segment` |
| Storage | `r2` |
| Cloud | `aws`, `gcp`, `azure`, `digitalocean`, `hetzner`, `cloudflare`, `vercel`, `netlify`, `railway`, `render` |

**Business SaaS**

| Tier | Skills |
|---|---|
| CRM | `hubspot`, `salesforce`, `pipedrive`, `zoho-crm` |
| Docs & notes | `notion`, `google-workspace`, `microsoft-365`, `obsidian` |
| Dev | `github`, `gitlab`, `bitbucket` |
| Project mgmt | `jira`, `linear`, `asana`, `clickup`, `monday`, `trello`, `airtable` |
| Payments | `stripe`, `paypal`, `razorpay` |
| Commerce | `shopify`, `woocommerce`, `webflow`, `wordpress` |
| Email | `mailchimp`, `brevo`, `sendgrid`, `postmark` |
| Support | `twilio`, `sendbird`, `intercom`, `zendesk`, `freshdesk` |
| Forms & scheduling | `typeform`, `tally`, `calendly`, `zoom` |
| Search | `brave-search`, `tavily`, `exa` |

Each skill lives at `skills/integration-<name>/SKILL.md`.

## Reliability

Every failure mode below is a real, logged trap that hstack pre-solves so you don't hit it:

- **PATH "command not found"** after install → absolute paths + explicit reload.
- **Gateway memory leak → OOM** ([#25315](https://github.com/NousResearch/hermes-agent/issues/25315)) → pinned version, memory cap, nightly restart, stale-PID clearing.
- **Provider 429 taking the whole gateway offline** ([#16677](https://github.com/NousResearch/hermes-agent/issues/16677)) → context-window validation and fallback.
- **Stale PID after crash → systemd restart loop** ([#13655](https://github.com/NousResearch/hermes-agent/issues/13655)) → PID validity check + auto-clear.
- **No built-in backup** ([#12238](https://github.com/NousResearch/hermes-agent/issues/12238)) → `/hermes-backup`.
- **Auxiliary-capability drop** (aux model swapped without its key silently kills vision / web / compression) → capability-aware wiring, `auto` defaults, warnings.
- **Vendor-specific integration traps** (Zendesk `/token` email suffix, Sendbird `Api-Token` header, Notion OAuth-only hosted MCP, R2 `region=auto`, Datadog wrong-site 403) — encoded in each skill's Pitfalls table.

Full catalogue: [reference/TROUBLESHOOTING.md](reference/TROUBLESHOOTING.md).

## Security defaults

- Localhost binding everywhere. Network exposure is an explicit, warned opt-in.
- Allowlists enforced. Every platform skill (WhatsApp, Slack, Signal, Teams, Google Chat) refuses to start with an empty allowlist.
- Secrets in `~/.hermes/.env` with `chmod 600`, referenced by env-var indirection from `config.yaml`. Never in chat or logs.
- Live credential verification against the vendor API happens **before** any write. Bad key → clean abort, no half-written state.
- SSH-first: every action is a reviewable command run on the user's VPS, not a hidden daemon.

## How it works

Each command is a single `skills/<name>/SKILL.md`. `install.sh` symlinks (or copies, on Windows) the same files into each detected agent's skill directory, converting to `.mdc` for Cursor and `@-referenceable context` for Gemini CLI.

The agent does everything unattended: runs the installer, writes secrets, seeds memory + SOUL, registers the gateway, runs smoke tests, wires integrations. It stops only for things you must do: minting tokens, OAuth flows, the WhatsApp QR, and the first "hello."

## Contributing

The value here is the accumulated knowledge of what breaks and what works. **New Hermes failure mode + fix, or a verified new integration** — those are the highest-leverage contributions.

1. Fork and branch.
2. Add or update `skills/<name>/SKILL.md`, or add a row to [reference/TROUBLESHOOTING.md](reference/TROUBLESHOOTING.md) (symptom → cause → fix, GitHub issue # if any).
3. New integrations follow the SSH-first template in [CLAUDE.md](CLAUDE.md) and [templates/SKILL.template.md](templates/SKILL.template.md): SSH check → verify Hermes → idempotency → HARD GATE (format + live pre-flight) → dry-run → `chmod 600` write → MCP or REST doc → `gateway stop && gateway run` → live smoke test → `rollback()`.
4. Open a PR.

## License

[MIT](LICENSE). Built by **Paarth**, in collaboration with **[Digital Crew Technology](https://www.digitalcrew.tech/en?utm_source=github&utm_medium=repo&utm_campaign=hstack)**.

<sub>hstack is independent open-source software. Hermes Agent is a project of Nous Research. Not affiliated with or endorsed by Nous Research, Hostinger, or any of the integrated vendors.</sub>
