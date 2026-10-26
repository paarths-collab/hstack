<div align="center">

# hstack

**Set up your own Hermes assistant. Give your coding agent the steps.**

[![Skills](https://img.shields.io/badge/skills-97-0ea5e9)](skills/)
[![Integrations](https://img.shields.io/badge/integrations-71-14b8a6)](skills/)
[![Platforms](https://img.shields.io/badge/platforms-8-8b5cf6)](skills/)

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-22c55e)](LICENSE)
[![Hermes target](https://img.shields.io/badge/Hermes-0.22.5-8b5cf6)](compatibility/README.md)
[![Validation](https://img.shields.io/badge/validation-source_checked-0ea5e9)](compatibility/VALIDATION.md)

[Get started](#get-started) · [Use cases](#make-it-yours) · [Documentation](docs/README.md) · [Compatibility](compatibility/README.md)

</div>

---

hstack is a collection of step-by-step skills that a coding agent follows over
SSH to install, connect and maintain **Hermes on your server**. Use it with Claude
Code, Codex, Cursor or another supported agent.

Ask for an outcome, review the plan, and let your agent follow the relevant
procedures. You provide the server, access and credentials. No hstack account or
hosted relay is required.

> “Set up Hermes on my server and connect Telegram.”
>
> “Help me connect GitHub and Notion.”
>
> “Check why my Hermes gateway is offline.”

## What you get

| | Included |
|---|---|
| **Setup & operations** | Installation, model configuration, health checks, native gateway restart, backups and recovery procedures |
| **Integrations** | 71 service guides, including GitHub, Notion, Linear, Postgres and Supabase |
| **Chat platforms** | Telegram, Slack, Discord, WhatsApp, Teams, Signal, Google Chat and Mattermost |
| **Browser planner** | A local composer that builds a reviewable plan without collecting credentials |

**Why use it with Hermes?** Hermes provides the assistant and its native tools.
hstack supplies reusable setup procedures and reviewable plans, so you have less
configuration to assemble yourself. It prefers Hermes's
native connectors, scheduling and lifecycle commands. Setup-time savings have not been measured.

## Get started

Choose **one** installation route. Installing skills makes them available to your
coding agent; it does not deploy Hermes or activate a workflow.

### Claude Code

Run inside Claude Code:

```text
/plugin marketplace add paarths-collab/hstack
/plugin install hstack@hstack
```

Start a new session, then ask for help or invoke `/hstack:hermes-status`.

### Codex

```bash
codex plugin marketplace add paarths-collab/hstack --ref main
```

Open `/plugins`, select the **hstack** marketplace and install **hstack**. Start a
new session afterwards. See the [plugin guide](docs/plugins.md#codex) for CLI
installation and updates.

### Cursor

Follow the [local or team plugin setup](docs/plugins.md#cursor), then reload Cursor.
A repository manifest does not mean hstack is listed in the public marketplace.

<details>
<summary><strong>Other agents, Windows and selective installation</strong></summary>

Clone the repository and use the installer to choose your agents and skills:

```bash
git clone https://github.com/paarths-collab/hstack.git
cd hstack
bash install.sh --pick
```

The installer supports Claude Code, Codex, Cursor, Gemini CLI, OpenClaw and Hermes.
Stock macOS Bash 3.2 and Linux are supported. On Windows, run `./install.ps1` from
PowerShell; native Windows validation remains pending.

```bash
bash install.sh --ide=claude,codex
bash install.sh --tier=memory,database
bash install.sh --include=notion,github
bash install.sh --help
```

Reinstallation replaces hstack-owned files. Conflicting user files and edited
copies are backed up rather than deleted; the installer prints their locations.

</details>

After installation, ask your agent to find the relevant hstack skill and explain
its plan before making changes. Browse the [skill catalogue](skills/) or read the
[plugin installation and update guide](docs/plugins.md).

## Make it yours

Start with a useful outcome and let your agent prepare the steps:

| You want… | Start here |
|---|---|
| **An assistant in your chat app** | Install Hermes, choose a model and connect Telegram; review other platform procedures for an existing installation |
| **Help with your notes and work** | Connect Notion, Obsidian or Linear with the access you choose |
| **A clear setup plan** | Use the browser planner or an editable blueprint to review connections and required credentials |
| **A healthier server assistant** | Check gateway health, diagnose failures and use native backup/update procedures |

These are guided setups, not pre-connected services. Your agent follows the
selected skills; you review access and provide credentials in your environment.

## Plan in the browser

The [Composer](apps/composer/README.md) lets you select sources and a destination,
review access requirements and export a plan. It runs locally and does not ask for
credentials. Deployment happens separately on your server.

## Current status

**Target: Hermes 0.22.5. Source-verified; live validation is still pending.**

| Checked | Still needed |
|---|---|
| Skill structure, source interfaces and regression tests | Live verification of vendor connections and chat platforms |
| Plugin metadata, Claude validation and Codex discovery | Loading the refreshed plugin in Cursor and execution across all hosts |
| Cross-platform installer checks | Native Windows validation |

The deploy procedure currently supports **Telegram on an exclusive default-profile Linux target**. The seven-day live
reliability gate has not started. Offline checks do not establish production
readiness. See the [validation evidence](compatibility/VALIDATION.md) and
[compatibility policy](compatibility/README.md) before deployment.

Keep credentials in private files, not in chat or the repository. Review access
and commands before execution. Recovery cannot recall sent messages or undo
arbitrary external side effects.

## Explore & contribute

- [Documentation index](docs/README.md) — guides and reference material
- [Repository structure](docs/architecture.md) — where each component lives
- [Tests](tests/README.md) — checks, commands and evidence limits
- [Troubleshooting](docs/reference/TROUBLESHOOTING.md) — known symptoms and fixes
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Verified fixes and reproducible integration failures are especially useful
contributions. Use the [skill template](templates/SKILL.template.md) when adding
a procedure.

---

[Apache 2.0](LICENSE) · Built by **Paarth**

<sub>Independent open-source project. Not affiliated with or endorsed by Nous Research or the integrated vendors.</sub>
