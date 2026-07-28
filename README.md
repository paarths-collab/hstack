# hstack

**Skill files that let your AI coding agent set up self-hosted Hermes for you.**

Each hstack skill is a recipe. Your favorite AI coding agent (Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, or Hermes itself) reads it and does the actual work on your server over SSH — writing credentials to a `chmod 600` env file, registering MCP servers, configuring platforms, verifying every credential against the live vendor API before it writes anything — so Hermes ends up correctly set up. Every skill is SSH-first, idempotent, dry-run-previewable, and rollback-safe. No hstack server in the middle, no daemon operated by hstack, no runtime to install: the skill files are just recipes your AI coding agent follows on your own server.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-22c55e)](LICENSE)
![Skills 95](https://img.shields.io/badge/skills-95-f59e0b)
![Integrations 71](https://img.shields.io/badge/integrations-71-2dd4bf)
![Platforms 8](https://img.shields.io/badge/platforms-8-229ED9)
![Hermes v0.15.2](https://img.shields.io/badge/hermes-v0.15.2%20pinned-9d6bff)

> Built by Paarth.

---

## What it is

Each skill file is a setup superpower your AI coding agent gains. Install hstack once, then in any of your AI coding agents you can:

1. **Deploy a fresh Hermes** to your server with one command — installed and version-pinned, config written, gateway running, verified.
2. **Add external services** — 71 integrations (Notion, Stripe, Postgres, Pinecone, Twilio, and 66 more). Your agent writes the credential to a locked-down env file, tests it against the real vendor API, registers the MCP server, then reloads Hermes cleanly.
3. **Wire messaging channels** — 8 platforms (Telegram, Slack, Discord, WhatsApp, ...) so Hermes can reach out to you first.
4. **Keep the setup healthy** — status checks, safe restarts, backups, failure diagnosis when something breaks.

Every skill is SSH-first, idempotent, dry-run-previewable, and rollback-safe. No new runtime — just Markdown recipes your AI coding agent executes on your own server.

## Quick start

**Claude Code** — install as a plugin:

```bash
/plugin marketplace add paarths-collab/hstack
```

```bash
/plugin install hstack@hstack
```

**Gemini CLI:**

```bash
gemini extensions install https://github.com/paarths-collab/hstack
```

**Codex and Cursor:** search `hstack` in the plugin marketplace.

**Hermes itself, OpenClaw, or every agent on the box at once** — these have no plugin
registry, so install the skills directly:

```bash
# macOS / Linux / Git Bash
curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash

# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
```

Then open your agent and run:

```
/hstack:hermes-deploy      # if you installed the plugin
/hermes-deploy             # if you installed via script
```

Plugin skills are always namespaced (`/hstack:<skill>`); script-installed skills are bare.
Both forms work, and installing both ways is safe — they coexist rather than collide.

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

## How you actually use it

Two ways, both work in every AI coding agent hstack installs into:

### Option A — Just say what you want

Describe the outcome. Your AI coding agent reads its installed skill catalog, matches your intent, and runs the right skills in order — no slash-command memorization required:

- *"Integrate Notion, HubSpot, and Salesforce"* → agent runs `/integration-notion`, then `/integration-hubspot`, then `/integration-salesforce`, one after another.
- *"Deploy Hermes to my server and wire Telegram"* → agent runs `/hermes-deploy`, then `/platform-telegram`.
- *"Something's wrong with the gateway"* → agent runs `/hermes-status`, reads the output, then runs `/hermes-fix` on what it found.

### Option B — Invoke the skill directly

If you know exactly which skill you want, invoke it explicitly. Same 95 skills, six invocation flavors:

| Agent | Invoke like this |
|---|---|
| **Claude Code** | `/hstack:hermes-deploy` · `/hstack:integration-notion` (plugin, slash-autocompletes) — or bare `/hermes-deploy` if script-installed |
| **Codex** | `/hermes-deploy` · `/integration-notion` (slash) |
| **Cursor** | `@hermes-deploy` in composer, or "Manual" mode toggle (rules exposed as Agent Requested) |
| **Gemini CLI** | `@hermes-deploy` context reference (@-autocompletes) |
| **OpenClaw** | `/hermes-deploy` · `/integration-notion` (verbatim Claude Code format) |
| **Hermes itself** | *"Deploy Hermes"* · *"Connect Notion"* (natural language — Hermes reads and self-executes) |

The magical moment either way: type `/hstack:integration-` in your agent and 71 hardened installers autocomplete, or just say "integrate Notion" and your agent grabs the right one. It wires the service into your self-hosted Hermes with SSH-first hardening, live credential pre-flight, and clean rollback. No hstack account, no server in the middle.

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

## Integrations (71)

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
- SSH-first: every action is a reviewable command run on the user's own server, not a hidden daemon operated by hstack.

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

[Apache 2.0](LICENSE). Built by **Paarth**.

<sub>hstack is independent open-source software. Hermes Agent is a project of Nous Research. Not affiliated with or endorsed by Nous Research, Hostinger, or any of the integrated vendors.</sub>
