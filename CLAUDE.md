# hstack — AI-coding-agent instructions

This repo is **hstack**: a portable skill catalog for deploying and operating self-hosted
Hermes agents. Built by Paarth, in collaboration with Digital Crew Technology.

**Multi-IDE, multi-agent by design.** The `skills/<name>/SKILL.md` files are the canonical
source. Per-IDE `setup-*` scripts symlink or convert them into the format each agent expects:

| Agent / IDE          | Install dir                | Format             |
|----------------------|----------------------------|--------------------|
| Claude Code          | `~/.claude/skills/`        | `SKILL.md` verbatim |
| Codex                | `~/.agents/skills/`        | `SKILL.md` verbatim |
| Cursor               | `~/.cursor/rules/`         | Converted to `.mdc` |
| Hermes (self-hosted) | `~/.hermes/skills/`        | `SKILL.md` verbatim |
| Gemini CLI           | `~/.gemini/context/hstack/`| `.md` context files |
| OpenClaw / VS Code   | `~/.openclaw/skills/`      | `SKILL.md` verbatim |

The catalog: **73 skills** (16 hermes-* core + 5 platform-* + 68 integration-* connectors),
targeting **8 messaging platforms**, pinning Hermes **v0.15.2**.

## Universal installer (`install.sh` / `install.ps1`)

One command wires the chosen tier of skills into every AI coding agent detected on the box.

```bash
# Interactive picker (default when TTY present)
curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash

# Non-interactive — install everything into every detected IDE (curl-pipe safe default)
curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash -s -- --all

# Cherry-pick tiers or specific integrations, or restrict to certain IDEs
bash install.sh --tier=memory,database --ide=claude,hermes
bash install.sh --include=notion,stripe,linear
```

Windows / PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
```

Design notes for anyone touching the installer:
- **IDE auto-detection** by directory presence (`~/.claude`, `~/.agents`, `~/.cursor`,
  `~/.hermes`, `~/.gemini`, `~/.openclaw`). Nothing runs against an IDE that isn't there.
- **Interactive picker reads from `/dev/tty`** so it survives being piped through `curl`.
  Falls back to `--all` when no TTY is attached (safe default for scripted use).
- **Tier → integrations** is one bash associative array (`install.sh`) or hash
  (`install.ps1`). Add new integrations there once; both entry points pick them up.
- **Windows fallback:** symlinks aren't guaranteed on Windows without dev mode, so
  `install.ps1` and the setup-* scripts use `Copy-Item -Recurse` there.

---

## Repo layout

```
install.sh, install.ps1  — 1-click universal installers (all 6 IDEs, interactive picker)
skills/<name>/SKILL.md   — one skill per folder; frontmatter + procedure + pitfalls + verify
setup, setup-codex, setup-cursor, setup-hermes, setup-gemini, setup-openclaw
                          — per-IDE distributors (symlink or format-convert)
setup-all                — runs every setup-* in sequence
reference/TROUBLESHOOTING.md — symptom → cause → fix catalogue (grows with every deploy)
blog/                    — published guides (.md + .schema.json for JSON-LD)
metrics/                 — clone traffic tracking (update-clone-traffic.mjs + clone-traffic.svg)
.github/workflows/       — clone-traffic.yml (daily), shellcheck, secret-scan
```

## Integration tier catalog (68 connectors, 20 tiers)

Do not re-implement anything Hermes already does natively. `/hermes-model` covers
chat completion for OpenAI / Anthropic / Groq / Mistral / etc. — do **not** ship an
integration skill that wires `/chat/completions`. `integration-openai-tools` codifies this
as an explicit refusal (DALL-E, Whisper, embeddings, Batch API only).

Tier index (mirrored by `install.sh` for `--tier=` and `--pick`):

- **core** — hermes-* deploy/ops (16)
- **platforms** — telegram, discord, whatsapp, slack, mattermost, teams, matrix, signal
- **memory** — mem0, supermemory (pick one; wiring both duplicates recall context)
- **database** — supabase, postgres, neon, redis
- **vector** — pinecone, qdrant
- **auth** — auth0, clerk
- **observability** — posthog, sentry, datadog (infra/APM), segment (CDP event pipe)
- **rag** — firecrawl (RAG feeder)
- **code** — e2b (code sandbox)
- **ai-tools** — openai-tools (image/audio/embeddings/batch), elevenlabs (TTS), replicate
- **storage** — r2, s3-compatible
- **crm** — hubspot, salesforce, pipedrive, zoho
- **docs** — notion, confluence, google-workspace, microsoft-365, obsidian
- **dev** — github, gitlab, bitbucket
- **pm** — linear, asana, clickup, jira, monday, trello
- **cloud** — aws, gcp, azure, cloudflare, digitalocean, hetzner, netlify, render
- **payments** — stripe, paypal, razorpay
- **commerce** — shopify, woocommerce
- **email** — sendgrid, mailchimp, postmark, brevo
- **support** — intercom, zendesk, freshdesk, sendbird
- **forms** — typeform, calendly, airtable
- **search** — brave-search, exa

## Every integration skill guarantees the same shape

The SSH-first hardening template every `integration-*/SKILL.md` follows:

1. **SSH access check** — verify we're on the VPS host, not a container (`whoami; hostname`).
2. **Verify Hermes** — pinned `v0.15.2`, gateway reachable, `~/.hermes/.env` chmod 600.
3. **Idempotency check** — abort if the integration is already wired and green.
4. **HARD GATE** — validate credential format AND live vendor API pre-flight before writing.
   No config lands on disk unless the credential works against the real vendor endpoint.
5. **DRY_RUN preview** — print secret length + prefix only, never plaintext.
6. **Write secrets** — `~/.hermes/.env` with `chmod 600`, `${VAR}` indirection in config.yaml.
7. **Register MCP or document REST** — MCP endpoint when the vendor ships one, otherwise
   a first-class REST doc under `/opt/data/`.
8. **Gateway reload** — `hermes gateway stop && hermes gateway run` (never `restart`).
9. **Verify in logs + live smoke test** — call a real vendor endpoint through Hermes.
10. **Rollback function** — every skill defines its own `rollback()` (revert `.env`, restore
    prior config.yaml, restart gateway).

Consent / cost gates you'll see across skills:
`PROD_ACKNOWLEDGED=1` (Clerk `sk_live_`), `OWNS_VOICE_ACKNOWLEDGED=1` (ElevenLabs voice
clone), `LONG_LIVED_ACKNOWLEDGED=1` (E2B keep-alive > 15 min), `ALLOW_WRITES=1` (Postgres
superuser, Redis admin user).

## Skill format (always follow this when adding or editing a skill)

```markdown
---
name: hermes-<verb>
description: One sentence. When to use it.
---

# /<name> — short title

You are the engineer doing X for the user. Do everything autonomously; stop only for
things a machine cannot do (tokens, QR scans, first "hello").

## Before you start — gather (ask once)
## Step 1 …
## Step N …
## Definition of done
- [ ] …
```

Secrets always go in `~/.hermes/.env` or `/opt/data/.env` (inside container), never in
`config.yaml` and never in chat. Use `chmod 600` after writing.

---

## SSH access to a VPS — the right procedure

When a user hands off a VPS for remote work, follow this exact sequence.
Deviating from it causes the failure chain documented in `reference/TROUBLESHOOTING.md`.

### Before touching anything — confirm you're on the host, not a container

```bash
whoami; hostname
```

- `root@<readable-name>` → you are on the **VPS host** ✅
- `root@<hex-string>` (e.g. `root@dd635306c545`) → you are **inside a Docker container** ❌
  Type `exit` first, then re-run the check.

SSH keys added inside a container are invisible to the host's sshd. This is the #1 source
of "I added the key but still get Permission denied."

### Setting up key-based auth (Bash tool is non-interactive — can't type passwords)

```bash
# 1. Generate keypair
ssh-keygen -t ed25519 -f ~/.ssh/hermes_vps -N "" -C "claude-code-hermes-deploy"

# 2. Add public key on the VPS host — ALWAYS use printf, never echo >>
#    echo >> appends without a leading newline; if the file's last line has no trailing
#    newline the new key glues onto the previous one and SSH ignores both.
printf '\n%s\n' "$(cat ~/.ssh/hermes_vps.pub)" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# 3. First connect — auto-trust the host key (normal on first connect)
ssh -i ~/.ssh/hermes_vps -o StrictHostKeyChecking=accept-new root@<hostname>
```

### Why `printf '\n%s\n'` and not `echo >>`

`echo "key" >> authorized_keys` appends without a guaranteed leading newline. If the previous
line lacked a trailing newline, the result is two keys on one line:

```
...paarth@digitalcrewssh-ed25519 AAAA...claude-code-hermes-deploy
```

SSH parses `authorized_keys` one key per line — the merged line is silently invalid.
`printf '\n%s\n'` forces separation regardless of prior file state.

**Detection:** `grep -c "^ssh-" ~/.ssh/authorized_keys` should equal the number of keys.
If it's low, keys are merged. Fix: `sed -i 's/\(digitalcrew\)\(ssh-ed25519\)/\1\n\2/' ~/.ssh/authorized_keys`

### Running remote commands once SSH works

```bash
ssh -i ~/.ssh/hermes_vps root@<hostname> 'bash -s' <<'REMOTE'
# everything here runs on the VPS
hermes --version
hermes gateway status
REMOTE
```

This is the pattern for all remote install/config/fix steps. No copy-pasting needed.

### Common SSH failure chain (in the order they appear)

| Error | Cause | Fix |
|-------|-------|-----|
| `Host key verification failed` | First connect; key not in known_hosts | Add `-o StrictHostKeyChecking=accept-new` |
| `Permission denied (publickey,password)` | Bash tool is non-interactive; can't type password | Use key-based auth (steps above) |
| Key added but still `Permission denied` | Key was added inside a container | `whoami; hostname` check; exit container; re-add on host |
| Key added on host but still denied | `echo >>` merged two keys onto one line | Use `printf '\n%s\n'`; fix merged keys with `sed` |
| SSH works but Bash tool can't reach VPS | WSL2 network isolation | Use `-o StrictHostKeyChecking=accept-new -i ~/.ssh/hermes_vps` in Bash tool |

---

## Wiring an HTTP MCP server into Hermes

Full procedure is in `skills/hermes-mcp-add/SKILL.md`. Key rules:

1. **Probe before configuring** — never trust supplied URL forms; run the 5-variant curl matrix.
2. **Initialize ≠ auth** — probe `tools/list` without auth; the error message is the spec.
3. **Placeholder token in CLI** — pipe `placeholder` through `printf | docker exec`; inject real value with `sed`.
4. **`|` delimiter in sed** — tokens contain `/+= `; use `sed 's|...|...|'` not `sed 's/.../.../'`.
5. **`gateway stop` + `gateway run`** — not `restart`; env changes need a clean re-read.
6. **Two `.env` files** — compose `.env` (container-level) vs `/opt/data/.env` (Hermes runtime). MCP secrets go in the Hermes one.

---

## Branch / PR conventions

- Branch from `main`: `<type>/<short-description>` (e.g. `feat/hermes-mcp-add`, `fix/ssh-key-merge`)
- Commit messages: `<type>(<scope>): <what> — <why>` (conventional commits)
- Every skill addition needs a `Definition of done` checklist in the skill file
- `reference/TROUBLESHOOTING.md` grows after every real failure — add the row, don't skip it

## Secrets hygiene

- Never commit tokens, passwords, or API keys
- `.env` files → `chmod 600`; add to `.gitignore` if local
- `TRAFFIC_TOKEN` secret is set in GitHub Actions secrets (not in any file)
- Rotate tokens shared in chat immediately after use
