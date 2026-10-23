# hstack — workflows for self-hosted Hermes agents

**Ready-to-use GitHub reports for your own Hermes server.**

hstack packages three deterministic GitHub-to-private-Telegram workflows: repository activity, requested PR reviews and published releases. Select a pack and generate its private configuration and worker without writing source code or JSON. Hermes supplies native scheduling. The repository also includes 97 setup and integration procedures.

Install it once, then say what you want:

> *"Deploy Hermes to my server and connect Notion, GitLab and Telegram."*

Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, or Hermes itself can read the procedures and prepare the selected setup. Prefer native Hermes setup and connectors where they cover the task; custom deployment steps and verification should address a concrete remaining need.

**Compatibility:** the default acceptance contract is a legacy 0.15.2 fixture baseline. Hermes 0.22.5 is an explicit, unpromoted candidate with source and offline checks. These checks do not establish live operation, and the catalog has not been re-verified against every vendor. Read [compatibility and promotion](compatibility/README.md) before deployment.

Your server. Your data. No hstack-hosted service. Each pack installs a reviewed Python worker on your existing Hermes target.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-22c55e)](LICENSE)
![Superpowers 97](https://img.shields.io/badge/superpowers-97-f59e0b)
![Integrations 71](https://img.shields.io/badge/integrations-71-2dd4bf)
![Platforms 8](https://img.shields.io/badge/platforms-8-229ED9)
![Hermes compatibility candidate 0.22.5](https://img.shields.io/badge/hermes-0.22.5%20candidate-9d6bff)

> Built by Paarth.

---

## Three workflows you can prepare now

| Pack | What arrives in Telegram |
|---|---|
| `activity-brief` | Default-branch commits and issues/PRs updated in your reporting window |
| `review-queue` | Current open, non-draft PRs with explicit review requests, oldest first |
| `release-watch` | Versions published in your reporting window, with prereleases labelled |

Choose repositories, a private chat and a daily cutoff. Preparation builds the
runtime and writes private configuration locally. Hidden terminal prompts capture
credentials. Preview fetches the actual report before installation or sending.

```bash
mkdir -p -m 700 "$HOME/.hstack-prepared"
python3 -I -B packages/founder-brief/prepare.py \
  --workflow review-queue --repository octo-org/example \
  --chat-id 123456789 --at 09:00 --timezone Asia/Kolkata \
  --output "$HOME/.hstack-prepared/review-queue"
```

Follow the generated `NEXT_STEPS.md` to transfer, preview, review, install and run
the canary. One selected pack is supported per exclusive default-profile Linux
target with the exact Hermes 0.22.5 candidate. Setup does not provision that target.
Reports are bounded and refuse incomplete data; open-PR and release-history
volume limits are described in the [pack guide](packages/founder-brief/README.md).

The worker validates the private chat, records the Telegram API acknowledgement,
avoids blind retries after uncertain sends, and supports owned rollback.

| Part | Current status |
|---|---|
| Three reports, private preparation, preview, installation, schedule, canary and rollback | Implemented |
| Combined local suite, including all three comparisons and real loopback SSH/HTTP | **48 top-level tests passed; no failures or skips** |
| Real Hermes 0.22.5 target and real Telegram delivery | **Pending target and private credential files** |
| Seven-day live reliability gate | Not started; candidate remains unpromoted |

**Why use it over Hermes alone?** Use a native Hermes scheduled prompt when a
flexible AI summary is enough. Use a pack when you want these exact reports and
their tested configuration, delivery and removal behavior supplied together.
The [executed setup comparison](packages/founder-brief/COMPARISON.md) grants the
manual baseline the same runtime code: both need three setup invocations, while
the pack generates the configuration and worker integration. Human setup-time
savings have not been measured.

Start with the [pack guide](packages/founder-brief/README.md). The skill installer
below installs procedures; it does not deploy these workers or supply credentials.

## What a superpower is

A superpower is one Markdown file: a procedure your AI coding agent reads and executes on your server. Review its commands, required credentials, supported runtime and recovery limits before it touches your box.

Install hstack once and your coding agent gains all 97:

1. **Prepare a self-hosted Hermes deployment** — installation, configuration, gateway and verification procedures. The current candidate deploy path supports Telegram on one exclusive default-profile target.
2. **Find integration guidance for 71 services** — including Notion, Stripe, Postgres, Supabase, Pinecone, GitHub, Twilio and Salesforce. Prefer current native Hermes connectors or plugins where available; the entire catalog has not been re-verified against current vendors.
3. **Find procedures for 8 messaging platforms** — Telegram, Slack, Discord, WhatsApp, Teams, Signal, Google Chat and Mattermost. The other seven platform recipes remain outside the current-Hermes migration.
4. **Operate and recover** — health checks, supported gateway lifecycle commands, backups and failure diagnosis, subject to each procedure's runtime scope.

The procedures follow an SSH-first template with preflight, preview and recovery
steps. Read their scope and validation limits; recovery cannot recall messages or
undo arbitrary external side effects.

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
registry, so install the superpowers directly:

```bash
# macOS (the stock /bin/bash 3.2 is supported) or Linux
curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash

# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
```

Then open your agent and run:

```
/hstack:hermes-deploy      # if you installed the plugin
/hermes-deploy             # if you installed via script
```

Plugin superpowers are always namespaced (`/hstack:<name>`); script-installed ones are bare.
Both forms work, and installing both ways is safe — they coexist rather than collide.

The current `/hermes-deploy` candidate composes installation, model, Telegram,
memory, personality, supervised startup and checks. It requires explicit candidate
selection and the relevant credentials. Other platform paths are refused before SSH.

### Picking what to install

```bash
bash install.sh --pick                        # interactive menu
bash install.sh --tier=memory,database        # tiers only
bash install.sh --include=notion,stripe,mem0  # specific integrations
bash install.sh --ide=claude,codex            # only wire specific agents
bash install.sh --all                         # everything, non-interactive
bash install.sh --help                        # full flag reference
```

The `--pick` prompt accepts menu numbers (`1` for everything, `2`–`21` for one tier each) as well as tier and integration names.

**Re-running and backups.** Re-running the installer is safe and replaces only what hstack
installed before (its own links and marked copies). Anything else already at a destination,
such as your own skill with the same name or an edited copy, is moved aside and never deleted:
skill folders go to `<skills-parent>/.hstack-backups/<timestamp>/`, files to
`<name>.hstack-backup-<timestamp>`. The warning prints the exact path. `install.sh` never
edits instruction files. `setup`, `setup-codex`, `setup-gemini` and `setup-openclaw` update their
agent's instruction file only between `<!-- hstack:start -->` and `<!-- hstack:end -->` markers, with a backup.

## How you actually use it

Two ways, both work in every AI coding agent hstack installs into:

### Option A — Just say what you want

Describe the outcome. Your AI coding agent reads its installed superpower catalog, matches your intent, and runs the right ones in order — no slash-command memorization required:

- *"Integrate Notion, HubSpot, and Salesforce"* → agent runs `/integration-notion`, then `/integration-hubspot`, then `/integration-salesforce`, one after another.
- *"Deploy Hermes to my server and wire Telegram"* → agent runs `/hermes-deploy`, then `/platform-telegram`.
- *"Something's wrong with the gateway"* → agent runs `/hermes-status`, reads the output, then runs `/hermes-fix` on what it found.

### Option B — Invoke the superpower directly

If you know exactly which one you want, invoke it explicitly. Same 97 superpowers, six invocation flavors:

| Agent | Invoke like this |
|---|---|
| **Claude Code** | `/hstack:hermes-deploy` · `/hstack:integration-notion` (plugin, slash-autocompletes) — or bare `/hermes-deploy` if script-installed |
| **Codex** | `/hermes-deploy` · `/integration-notion` (slash) |
| **Cursor** | `@hermes-deploy` in composer, or "Manual" mode toggle (rules exposed as Agent Requested) |
| **Gemini CLI** | `@hermes-deploy` context reference (@-autocompletes) |
| **OpenClaw** | `/hermes-deploy` · `/integration-notion` (invokes hstack skills against a Hermes target) |
| **Hermes itself** | *"Deploy Hermes"* · *"Connect Notion"* (natural language — Hermes reads and self-executes) |

Type `/hstack:integration-` to browse the integration procedures, or ask your agent
to find the appropriate setup. Review the native Hermes option and the procedure's
current compatibility before applying it. No hstack account or hosted relay is required.

## Commands

### Deploy & orchestrate

| Command | What it does |
|---|---|
| `/hermes-deploy` | Opt-in current-Hermes deployment procedure; Telegram-only candidate scope. |
| `/hermes-integrate` | Wire many integrations at once via a picker. |
| `/hermes-mcp-add` | The generic MCP-wiring primitive. |

### Agent Blueprints

Build a custom agent from a reviewed outcome, not a hard-coded “agent type.” The
Agent Blueprints ship three editable starting points—SaaS Founder, Personal Chief
of Staff, and DevOps On-Call—and every channel, integration, automation,
memory, and backup remains optional.

| Command | What it does |
|---|---|
| `/blueprint-saas-founder` | Asks one focused batch of questions, proposes a minimal read-only founder stack, and prepares a reviewable plan. |
| `/blueprint-install --plan <file>.hstack-blueprint.json` | Validates JSON, re-derives the safe allowlisted skill order, previews access and credentials-to-prepare, then invokes selected specialist skills in series. |

The current runtime routes are intentionally explicit:

- **Hermes** is the supported installable target for blueprint schema v1.
- **OpenClaw** is a supported hstack execution host: it can invoke hstack skills
  against Hermes, but hstack does not treat it as a Hermes-compatible target.
- **QM** currently receives a zero-secret `hstack-agent-intent.v1` export from
  the Builder. Use QM’s own deployment repository and generated deployment
  skill to map native scopes, connectors, credentials, and verification; hstack
  does not remap Hermes integrations into QM.

### Setup

| Command | What it does |
|---|---|
| `/hermes-install` | Install the opt-in candidate using its immutable official installer, checksum and source commit. |
| `/hermes-model` | Configure native model/provider settings; the migrated four-provider paths have offline checks, not live provider proof. |
| `/hermes-skills` | Install a curated starter pack of Hermes's own skills (distinct from hstack superpowers). |
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
| `/hermes-update` | Review the installation owner's native stable update, back up, apply and re-verify. |
| `/hermes-fix` | Diagnose and repair common failures. |
| `/hermes-backup` | Back up config, secrets, memory, sessions. |

## Integrations — 71 services your AI agent can reach

Integration procedures describe credential preflight, private environment files, MCP or REST setup, gateway reload and recovery. Current Hermes connectors and plugins should be preferred where they meet the need. The repaired subset has offline regression coverage; that is not a claim that every integration works against today's vendor API.

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

## Reliability and recovery

The repaired paths check concrete failure modes and preserve recovery evidence:

- **Runtime/profile mismatch:** explicit default-profile selection and exact candidate readiness checks.
- **Credential or configuration drift:** private files and reviewed artifact hashes checked before dispatch.
- **Old messages counted as new delivery:** successful current dispatch and fresh run correlation required by test observers.
- **Lost send responses:** durable unknown outcomes, with reconciliation required before another attempt for that logical window.
- **Interrupted install or rollback:** private recovery receipts, kernel locks and ownership checks; user edits cause refusal.
- **Incomplete source data:** collection failures and pagination limits cannot become a healthy no-activity message.

Current Hermes provides native backup and update facilities. The candidate uses
supported service commands and does not add an unconditional nightly restart.
Historical symptoms in [reference/TROUBLESHOOTING.md](reference/TROUBLESHOOTING.md)
must be checked against the installed release before applying an older workaround.

## Acceptance transaction (experimental)

The runnable packs are in [`packages/founder-brief/`](packages/founder-brief/README.md): selected GitHub repositories become an activity report, requested-review queue or release digest, with native Hermes scheduling, a checked private Telegram chat, durable API acknowledgements and recovery. They use a deterministic no-agent worker and private, reviewed configuration. Local HTTP integration tests do not prove real recipient delivery; the Hermes 0.22.5 candidate remains unpromoted.

[`packages/acceptance/`](packages/acceptance/README.md) remains the experimental control-plane transaction and legacy fixture baseline. Installing skill text and creating a generic prompt there is not a complete daily-brief deployment. See [compatibility and promotion](compatibility/README.md) before real-server use.

## Security defaults

- Each pack accepts only a positive private-chat ID and checks its type through Telegram's API before sending.
- Credentials and configuration are private files under the owned workflow directory. Skill procedures commonly use a private `~/.hermes/.env`; never place real credentials in chat, logs or the repository.
- Installation reviews and stores the payload; the canary performs the actual GitHub and Telegram checks. Installation alone does not prove credential validity or delivery.
- Native jobs and reviewed files must still match the installation before the worker performs HTTP or dispatches a canary.
- Commands run on the user's target. hstack does not operate a hosted daemon, relay or credential service.

## How it works

Each command is a single `skills/<name>/SKILL.md`. `install.sh` symlinks the same files into each detected agent's skill directory, and falls back to marked copies where symlinks are unavailable; `install.ps1` always copies. Cursor gets converted `.mdc` rules and Gemini CLI gets `@-referenceable` context files.

Agents can execute the selected procedures within their stated scope. Credentials,
OAuth, destination selection and actual delivery observation still require operator
input. The report packs share a separate reviewed Python runtime; see their setup guide.

## Contributing

The value here is the accumulated knowledge of what breaks and what works. **New Hermes failure mode + fix, or a verified new integration** — those are the highest-leverage contributions.

1. Fork and branch.
2. Add or update `skills/<name>/SKILL.md`, or add a row to [reference/TROUBLESHOOTING.md](reference/TROUBLESHOOTING.md) (symptom → cause → fix, GitHub issue # if any).
3. New integrations follow the SSH-first template in [CLAUDE.md](CLAUDE.md) and [templates/SKILL.template.md](templates/SKILL.template.md): SSH check → verify supported Hermes → idempotency → credential preflight → preview → private write → native connector or reviewed setup → supported gateway lifecycle → live smoke test → recovery.
4. Open a PR.

## License

[Apache 2.0](LICENSE). Built by **Paarth**.

<sub>hstack is independent open-source software. Hermes Agent is a project of Nous Research. Not affiliated with or endorsed by Nous Research, Hostinger, or any of the integrated vendors.</sub>
