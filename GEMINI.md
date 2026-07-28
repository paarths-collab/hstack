# hstack — self-hosted Hermes setup skills

hstack is a catalog of **94 skill files**. Each one is a recipe you (the AI coding agent)
read and execute on the user's own server over SSH, so their self-hosted Hermes agent ends
up correctly set up.

You do the work. The user just says what they want.

## How to pick the right skill

Read `skills/<name>/SKILL.md` and follow it step by step. Do not improvise the procedure —
each file encodes vendor-specific traps that are not inferable.

| User says something like | Read this skill |
|---|---|
| "deploy Hermes", "set it up on my server" | `skills/hermes-deploy/SKILL.md` |
| "connect <service>", "integrate Notion / Stripe / Postgres" | `skills/integration-<service>/SKILL.md` |
| "connect several apps at once" | `skills/hermes-integrate/SKILL.md` |
| "put it on Telegram / Slack / Discord / WhatsApp" | `skills/platform-<name>/SKILL.md` |
| "message me every morning", "schedule it" | `skills/hermes-cron/SKILL.md` (needs `hermes-home` first) |
| "where should it message me" | `skills/hermes-home/SKILL.md` |
| "give it a name / personality" | `skills/hermes-soul/SKILL.md` |
| "is it healthy?", "something's wrong" | `skills/hermes-status/SKILL.md`, then `skills/hermes-fix/SKILL.md` |
| "back it up", "update it", "restart it" | `skills/hermes-backup`, `hermes-update`, `hermes-restart` |
| "wire an MCP server" | `skills/hermes-mcp-add/SKILL.md` |

Full index: `ls skills/`. Families are `hermes-*` (15 core), `platform-*` (8), and
`integration-*` (71).

## Rules that apply to every skill

- **SSH-first.** Confirm you are on the VPS host, not inside a container (`whoami; hostname`
  — a hex hostname means you are in Docker; `exit` first).
- **Verify before writing.** Every integration validates the credential against the live
  vendor API before anything lands on disk. Never skip the hard gate.
- **Secrets go in `~/.hermes/.env` with `chmod 600`**, referenced from `config.yaml` by
  `${VAR}` indirection. Never in `config.yaml`, never in a cron prompt, never in chat.
- **Reload with `hermes gateway stop` then `hermes gateway run`.** Never `gateway restart` —
  it does not reliably re-read the environment.
- **Every skill has a rollback.** Run it on any failure rather than leaving half-written state.
- **Hermes is pinned to v0.15.2.** See `VERSIONS.txt` for every other pin.

Do everything autonomously. Stop only for what a machine cannot do: minting a token,
scanning a QR code, sending the first "hello".
