# hstack — AI-coding-agent instructions

This repo is **hstack**: a portable skill catalog for deploying and operating self-hosted
Hermes agents. Built by Paarth.

**Multi-IDE, multi-agent by design.** The `skills/<name>/SKILL.md` files are the canonical
source. Per-IDE `setup-*` scripts symlink (or, on Windows, copy) or convert them into the format each agent expects:

| Agent / IDE          | Install dir                | Format             |
|----------------------|----------------------------|--------------------|
| Claude Code          | `~/.claude/skills/`        | `SKILL.md` verbatim |
| Codex                | `~/.agents/skills/`        | `SKILL.md` verbatim |
| Cursor               | `~/.cursor/rules/`         | Converted to `.mdc` |
| Hermes (self-hosted) | `~/.hermes/skills/`        | `SKILL.md` verbatim |
| Gemini CLI           | `~/.gemini/context/hstack/`| `.md` context files |
| OpenClaw / VS Code   | `~/.openclaw/skills/`      | `SKILL.md` verbatim |

The catalog: **97 skills** (15 hermes-* core + 1 setup-* prerequisite + 8 platform-* + 71 integration-* connectors + 2 blueprint-* composition skills),
targeting **8 messaging platforms** in the catalog. The skills target Hermes **v0.22.5** only (`HERMES_VERSION` in `VERSIONS.txt`): source-verified against the tagged
source, live validation pending. The promotion policy in `compatibility/hermes.json` governs any "live-verified"
claim. Hermes **v0.15.2** (`HERMES_LEGACY_FIXTURE_VERSION`) survives only in the legacy offline acceptance contract and its
fixtures. Current compatibility and live-validation status are recorded in `compatibility/hermes.json` and
`compatibility/VALIDATION.md`.

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
- **Tier → integrations** is the `tier_members` case function in `install.sh` (stock macOS bash 3.2 has no associative arrays) and a hash in `install.ps1`. Keep both in sync; `tests/installer/fixtures/tiers.expected` is checked against each.
- **Ownership:** hstack replaces only what it installed (its own symlinks, copies whose `.hstack-managed` checksum still matches, generated files whose signed marker line still matches). Anything else at a destination is moved aside, never deleted: skill dirs to `<skills-parent>/.hstack-backups/<stamp>/<name>`, files to `<file>.hstack-backup-<stamp>`. A destination that is, or resolves into, an hstack skills tree is refused. If a backup cannot be made, the entry is left untouched and the run exits non-zero.
- **Instruction files** (CLAUDE.md / AGENTS.md / GEMINI.md, written only by `setup`, `setup-codex`, `setup-gemini` and `setup-openclaw`; never by `install.sh`): only the block between `<!-- hstack:start -->` and `<!-- hstack:end -->` is replaced, atomically (temp file + verified rename, mode kept), after a backup. A start marker without an end marker leaves the file untouched with a warning.
- **Windows fallback:** symlinks aren't guaranteed on Windows without dev mode, so `install.ps1` and `setup.ps1` always copy (`Copy-Item -Recurse`).
- **Tests:** `bash tests/installer/test-install.sh` (any bash ≥ 3.2; run it under `/bin/bash` on macOS too) and `pwsh -NoProfile -File tests/installer/test-install.ps1` (PowerShell 7 tested on macOS; Linux is covered by CI; native Windows remains unverified). Both are offline and use a throwaway HOME. The ownership blocks must stay byte-identical across the copies; the test enforces it.

---

## Repo layout

The complete directory map and placement rules are in [docs/architecture.md](docs/architecture.md). Validation commands are in [tests/README.md](tests/README.md).

```
install.sh, install.ps1  — 1-click universal installers (all 6 IDEs, interactive picker)
skills/<name>/SKILL.md   — one skill per folder; frontmatter + procedure + pitfalls + verify
setup, setup-codex, setup-cursor, setup-hermes, setup-gemini, setup-openclaw
                          — per-IDE distributors (symlink or format-convert)
setup-all                — runs every setup-* in sequence
docs/reference/TROUBLESHOOTING.md — symptom → cause → fix catalogue (grows with every deploy)
metrics/                 — clone traffic tracking (update-clone-traffic.mjs + clone-traffic.svg)
.github/workflows/       — clone-traffic.yml (daily), shellcheck, secret-scan
acceptance/              — acceptance contract(s) for the reversible transaction
packages/acceptance/     — acceptance transaction (JS core, target-side script, receipt schema)
packages/founder-brief/  — activity/review/release packs, private prepare/preview, native schedule and delivery journal
scripts/                 — skill validators; bash 3.2 compatible (stock macOS)
tests/                   — recipe tests (tests/recipes), acceptance tests (tests/acceptance, Docker-gated), skill-block tests (tests/skills: run the repaired SKILL.md bash blocks against stub ssh/curl/hermes), installer tests (tests/installer)
tests/founder-brief/     — pack/CLI/report comparison, loopback HTTP and disposable SSH workflow checks
```

## Integration tier catalog (71 connectors, 20 tiers)

Do not re-implement anything Hermes already does natively. `/hermes-model` covers
chat completion for OpenAI / Anthropic / Groq / Mistral / etc. — do **not** ship an
integration skill that wires `/chat/completions`. `integration-openai-tools` codifies this
as an explicit refusal (DALL-E, Whisper, embeddings, Batch API only).

Tier index (mirrored by `install.sh` for `--tier=` and `--pick`):

This list is generated from `install.sh` and must stay identical to it. It once drifted
badly enough to advertise three integrations that do not exist (`confluence`,
`s3-compatible`, `matrix`) while omitting nine that do. `scripts/check-skill-refs.sh`
cannot catch that class of error, because these are bare names, not `/slash-refs`. If you
edit a tier, edit `install.sh` first and mirror it here.

- **core** — hermes-* deploy/ops (15) + setup-ssh-keys (1) + blueprint-install, blueprint-saas-founder (2)
- **platforms** — telegram, discord, whatsapp, slack, mattermost, teams, google-chat, signal
- **memory** — mem0, supermemory (pick one; wiring both duplicates recall context)
- **database** — supabase, postgres, neon, redis
- **vector** — pinecone, qdrant
- **auth** — auth0, clerk
- **observability** — posthog, sentry, datadog (infra/APM), segment (CDP event pipe)
- **rag** — firecrawl (RAG feeder)
- **code** — e2b (code sandbox)
- **ai-tools** — openai-tools (image/audio/embeddings/batch), elevenlabs (TTS), replicate
- **storage** — r2
- **crm** — hubspot, salesforce, pipedrive, zoho-crm
- **docs** — notion, google-workspace, microsoft-365, obsidian
- **dev** — github, gitlab, bitbucket
- **pm** — jira, linear, asana, clickup, monday, trello, airtable
- **cloud** — aws, gcp, azure, digitalocean, hetzner, cloudflare, vercel, netlify, railway, render
- **payments** — stripe, paypal, razorpay
- **commerce** — shopify, woocommerce, webflow, wordpress
- **email** — mailchimp, brevo, sendgrid, postmark
- **support** — twilio, sendbird, intercom, zendesk, freshdesk
- **forms** — typeform, tally, calendly, zoom
- **search** — brave-search, tavily, exa

## Integration skill template

The SSH-first hardening template every `integration-*/SKILL.md` follows:

1. **SSH access check** — verify we're on the VPS host, not a container (`whoami; hostname`).
2. **Verify Hermes** — abort unless `hermes --version` names the `HERMES_VERSION` target (0.22.5, `VERSIONS.txt`), check the procedure's supported scope, gateway and private credential files. Source verification is not live compatibility evidence; each skill states its vendor and runtime validation limits.
3. **Idempotency check** — abort if the integration is already wired and green.
4. **HARD GATE (Step 3)** — local format check, then a live read-only vendor call from the VPS with the secret passed as an ssh-stdin curl config. Runs BEFORE the dry run and BEFORE `snapshot`; a failure means `ABORT … Nothing was written.`
5. **DRY_RUN preview** — print secret length + prefix only, never plaintext.
6. **Write secrets** — `~/.hermes/.env` with `chmod 600`, `${VAR}` indirection in config.yaml.
7. **Register native MCP or install a native skill** — use the pinned Hermes catalog or `mcp add`; when a suitable MCP is unavailable, install a discoverable skill with an executable vendor client and scoped rollback. Do not leave inert REST notes under `/opt/data/`.
8. **Gateway lifecycle** — use the selected release's supported service interface. Skills use the shared `gw_reload` / `gw_ready` helpers: `hermes -p default gateway restart --detach`, then `gateway ensure --json --timeout 60` must exit 0 with `"state":"ready"` and a new `instance_id`. `gateway run` is the foreground command; `--daemon` does not exist; `gateway status` text is never a health check.
9. **Verify in logs + live smoke test** — call a real vendor endpoint through Hermes.
10. **Step 0 helpers `snapshot`/`rollback`/`finish`**, defined before anything can fail. `snapshot` runs just before the first write and refuses to run over a leftover snapshot; every later failure is `rollback; exit 1`, and rollback RESTORES the pre-skill `~/.hermes/.env` and `config.yaml` byte for byte (never just unsets keys). There is no second `rollback()` at the bottom.

- Bash fences run on the agent's local machine (possibly macOS bash 3.2) and reach the VPS via `remote()`, which exports `~/.local/bin` on PATH. Secrets reach the VPS over ssh stdin only — never in the local ssh argv, a URL or a single-quoted remote string. On the VPS, `hermes config set KEY "$v"` does put the value in the remote `hermes` process argv for a moment (readable via `/proc` by anyone on that host); the stdin-fed `.env` upsert avoids even that. Smoke tests read the value back from `~/.hermes/.env`, never `$TOKEN`.

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
Deviating from it causes the failure chain documented in `docs/reference/TROUBLESHOOTING.md`.

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
...operator@example-hostssh-ed25519 AAAA...claude-code-hermes-deploy
```

SSH parses `authorized_keys` one key per line — the merged line is silently invalid.
`printf '\n%s\n'` forces separation regardless of prior file state.

**Detection:** `grep -c "^ssh-" ~/.ssh/authorized_keys` should equal the number of keys.
If it's low, keys are merged. Fix: `sed -i 's/\(example-host\)\(ssh-ed25519\)/\1\n\2/' ~/.ssh/authorized_keys`

### Running remote commands once SSH works

Bare `hermes` calls in the block below run via remote(), which sets PATH.

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
3. **Native registration** — prefer `hermes mcp install NAME` (catalog) or `mcp add NAME --url U --auth header` with `MCP_<NAME>_API_KEY` already in `~/.hermes/.env` (Hermes then skips the token prompt and stores `Authorization: Bearer ${MCP_<NAME>_API_KEY}`); feed the prompts on stdin and verify with `mcp list` and `mcp test`, because `mcp add` exits 0 even when it saved nothing.
4. **Never put the secret in config.yaml or on the local command line** — only `${VAR}` references go in `config.yaml`; shapes `mcp add` cannot express use `config set mcp_servers.<name>.…` with a `${VAR}` reference.
5. **Supported gateway lifecycle** — reload with `gw_reload` (restart, then `gateway ensure --json` ready); a restarted gateway re-reads `.env` (`gateway/run.py:1583-1585`, v0.22.5). Do not copy legacy `run --daemon` commands onto current Hermes.
6. **Two `.env` files** — compose `.env` (container-level) vs `/opt/data/.env` (Hermes runtime). MCP secrets go in the Hermes one.

---

## If you are an AI agent opening a PR against this repo

Stop and read this before you write anything.

hstack is a security-sensitive catalog: every skill writes credentials to someone's
server over SSH. A plausible-looking skill that ships a wrong endpoint, a missing
`chmod 600`, or an unverified credential path does real damage on a real box. That
makes agent-generated slop more expensive here than in most repos.

Before opening a PR you MUST:

1. **Have hit the problem for real.** If your human partner asked you to "contribute
   something" or "add some integrations" without a specific failure they experienced,
   push back and ask what actually broke. Speculative additions get closed.
2. **Verify against the live vendor.** Every `integration-*` skill claims its endpoint,
   auth shape, and MCP availability were tested. If you did not actually call the
   vendor's API, say so explicitly in the PR. Do not present documentation-derived
   guesses as verified behavior.
3. **Run the full local gate:** `scripts/validate-skills.sh`, `scripts/check-skill-refs.sh`,
   and `scripts/lint-md-bash.sh`. A PR that fails these was not reviewed.
4. **Disclose what produced the change** — model, harness, harness version. Work grounded
   in a real deploy session is weighted differently from work reasoned out of docs, and
   reviewers need to know which they are reading.
5. **Show your human partner the complete diff** and get explicit approval before opening.

If any of these fail, do not open the PR. Explain to your human partner why it would be
rejected. Saving them a closed PR is more helpful than submitting one.

## Acceptance transaction

`packages/acceptance/` wraps one workflow (a read-only GitHub source delivering to one private Telegram destination, on one Linux target, Hermes v0.15.2) in a versioned contract (`acceptance/founder-brief-github-telegram.contract.json`) and a transaction with nine states (plus `start`). A run writes a secret-free receipt, keeps a private backup of the previous secret values, and rolls back by restoring them; rollback stops on conflict instead of overwriting. Managed skill dirs carry ownership markers (`.hstack-acceptance`).

It is verified only offline: a sandbox transport, a stub `hermes`, golden SSH command fixtures, and a Docker sshd target gated by `HSTACK_DOCKER=1 node --test tests/acceptance/docker/`. The repo does not claim a real-server run (real Hermes, bot token, chat, GitHub token); that is user-required. A `verified` result also needs an injected delivery observer.

Hermes v0.15.2 was released under historical tag `v2026.5.29.2`. Do not promote the
baseline from source or offline checks alone; the policy requires seven consecutive
real-target golden-path days and explicit review.

The runnable candidate is `packages/founder-brief/`, a separate reviewed deployment
with three repository-scoped report packs and multiple named instances per target,
private preparation/preview, a native no-agent script schedule, private
Telegram API acknowledgements and rollback. Its local SSH/HTTP tests pass; a real
Hermes target and Telegram recipient remain unverified. The acceptance transaction
above is experimental control-plane coverage, not the runnable packs. Use the dated
validation record for completion claims and never equate API acknowledgement with
human recipient observation.

The opt-in `tests/founder-brief/real-native.test.mjs` runs exact candidate cron
source on its pinned Python with loopback vendors. It verifies parsing, storage,
claims, subprocesses, failure/recovery and ticks; it bypasses systemd readiness
and full bootstrap. See `tests/founder-brief/REAL_NATIVE.md` before rerunning it.

Each named instance owns `.hstack/workflows/ID/`, its launcher/job, credentials,
journal, lock and rollback. Omitted `--instance` selects only the legacy
`.hstack/founder-brief/` slot; never infer or bulk-select a named instance.

## Branch / PR conventions

- Branch from `main`: `<type>/<short-description>` (e.g. `feat/hermes-mcp-add`, `fix/ssh-key-merge`)
- Commit messages: `<type>(<scope>): <what> — <why>` (conventional commits)
- Every skill addition needs a `Definition of done` checklist in the skill file
- `docs/reference/TROUBLESHOOTING.md` grows after every real failure — add the row, don't skip it

## Secrets hygiene

- Never commit tokens, passwords, or API keys
- `.env` files → `chmod 600`; add to `.gitignore` if local
- `TRAFFIC_TOKEN` secret is set in GitHub Actions secrets (not in any file)
- Rotate tokens shared in chat immediately after use
