# Changelog

All notable changes to hstack. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — MAJOR.MINOR.PATCH — with a lenient interpretation for a Markdown skill catalog:

- **MAJOR** — breaking structural change (skill directory renamed or removed, installer flag semantics change, required env var name change).
- **MINOR** — new skill, new tier, new installer capability, new supported IDE, new consent flag.
- **PATCH** — pitfall row added, dry-run wording clarified, endpoint URL corrected, validator rule loosened.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Metrics-only commits (nightly clone-traffic updates) are omitted intentionally — they add noise without changing behavior.

---

## [Unreleased]

### Added
- `SECURITY.md` — coordinated vulnerability disclosure policy, six-adversary threat model (curious passer-by / malicious contributor / compromised AI agent / compromised VPS / malicious vendor / compromised messaging platform), secret rotation playbook, four-phase incident response playbook.
- `CONTRIBUTING.md` — full SSH-first skill authoring manual with per-step commentary, review checklist, two-approver rule for installer / workflow / security-doc changes.
- `VERSIONS.txt` — single source of truth for pinned versions (Hermes runtime, MCP packages, SDK versions, CI tool minimums, skill length policy). Referenced by `scripts/validate-skills.sh`.
- `scripts/validate-skills.sh` — validator that enforces the SSH-first template on every `skills/**/SKILL.md`: frontmatter shape, name/dir match, description length, line-count policy, required sections (Before you start → Step 1..6+ → Rollback → Pitfalls → Definition of done), pitfall count minimum, chmod-600 hygiene inside code blocks, no-secret-leak patterns, Hermes-version pin consistency. Supports `--changed` (PR mode), `--json`, `--skill=<name>`, `--quiet`.
- `.github/workflows/validate-skills.yml` — runs `scripts/validate-skills.sh` on every push and PR touching `skills/**`, `VERSIONS.txt`, or the validator itself. Uploads a JSON report artifact for 14 days.

### Changed
- README rewritten from a 447-line marketing-heavy long-form document to a 109-line scannable reference. Banner SVG removed. Emoji headers dropped. Catalog counts corrected to actual (95 skills, 72 integrations).

## [0.1.0] — 2026-07-02

The first tagged release. Reflects roughly two months of building the SSH-first skill catalog to 95 skills across 6 IDE targets and 8 messaging platforms.

### Added — the universal installer
- **`install.sh` + `install.ps1`** — one command that auto-detects every AI coding agent on the box (`~/.claude/`, `~/.cursor/`, `~/.hermes/`, `~/.agents/`, `~/.openclaw/`, `~/.gemini/`) and symlinks the same 95 skills into each in the format that agent expects (`.md` verbatim, `.mdc` for Cursor, `@-referenceable context` for Gemini CLI). Flags: `--pick` (interactive), `--all`, `--tier=`, `--include=`, `--ide=`, `--branch=`, `--local`, `--help`.
- Non-TTY safe: reads the interactive picker from `/dev/tty` so `curl … | bash` still surfaces the menu.
- Windows fallback to `Copy-Item -Recurse` where symlinks aren't guaranteed without dev-mode.

### Added — 95 hardened skills

**16 hermes-* core** — `/hermes-backup`, `/hermes-cron`, `/hermes-deploy`, `/hermes-fix`, `/hermes-home`, `/hermes-install`, `/hermes-integrate`, `/hermes-mcp-add`, `/hermes-memory`, `/hermes-model`, `/hermes-provision`, `/hermes-restart`, `/hermes-skills`, `/hermes-soul`, `/hermes-status`, `/hermes-update`.

**8 platform-*** — `/platform-discord`, `/platform-google-chat`, `/platform-mattermost`, `/platform-signal`, `/platform-slack`, `/platform-teams`, `/platform-telegram`, `/platform-whatsapp`.

**72 integration-*** — organized across 20 tiers. Each skill probes the vendor's real API with the operator's credential before any write, stores secrets in `~/.hermes/.env` with `chmod 600`, registers an MCP or documents a REST surface at `/opt/data/<vendor>-rest.md`, reloads the gateway with `stop && run` (not `restart`), runs a live smoke test from the VPS, and defines a `rollback()` invoked automatically on any failure. All 72 verified against official vendor docs during authoring (2026-05 through 2026-07).

Tier breakdown:

- **memory** — mem0, supermemory
- **database** — supabase, postgres, neon, redis
- **vector** — pinecone, qdrant
- **auth** — auth0, clerk
- **observability** — posthog, sentry, datadog, segment
- **rag** — firecrawl
- **code sandbox** — e2b
- **ai-tools** — openai-tools (DALL-E / Whisper / embeddings / Batch — refuses to wire chat completions because `/hermes-model` covers those), elevenlabs, replicate
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
- **forms & scheduling** — typeform, tally, calendly, zoom
- **search** — brave-search, tavily, exa

### Added — SSH-first hardening template (repo-wide)
Every skill under `skills/` follows the same template documented in [CLAUDE.md](CLAUDE.md):

1. SSH access check (container-vs-host detection, refuses to run inside a container).
2. Verify Hermes v0.15.2 pinned.
3. Idempotency check (exits cleanly if already wired unless `FORCE=1`).
4. **HARD GATE** — consent flag validation AND live vendor pre-flight before any write.
5. DRY_RUN preview showing lengths and 4-char prefixes only; never plaintext.
6. `chmod 600` on `~/.hermes/.env` after every write.
7. Register MCP with `${VAR}` env-var indirection, or document REST surface at `/opt/data/<vendor>-rest.md`.
8. `gateway stop && gateway run` (never `restart` — restart doesn't re-read `.env` reliably).
9. Live smoke test that runs from the VPS so credentials never leave the box.
10. `rollback()` function invoked automatically on failure.

Consent flags added across the catalog: `PROD_ACKNOWLEDGED=1` (Clerk `sk_live_`), `OWNS_VOICE_ACKNOWLEDGED=1` (ElevenLabs voice clone), `LONG_LIVED_ACKNOWLEDGED=1` (E2B session > 15 min), `ALLOW_WRITES=1` (Postgres superuser, Redis admin user), `WRITES_ACKNOWLEDGED=1` (Datadog monitor mutations), `WRITE_ONLY_ACKNOWLEDGED=1` (Segment CDP).

### Added — multi-IDE distribution
Per-IDE distributors: `setup` (Claude Code), `setup-codex`, `setup-cursor` (`.mdc` conversion), `setup-hermes`, `setup-gemini`, `setup-openclaw`, plus `setup-all` that runs them in sequence. Each is idempotent and preserves user customizations.

### Added — CI hardening
- `.github/workflows/shellcheck.yml` — ShellCheck strict + shfmt advisory across every `*.sh` file and the bare `setup` script.
- `.github/workflows/secret-scan.yml` — gitleaks on every push and PR.
- `.github/workflows/clone-traffic.yml` — daily clone-traffic sampling into `metrics/clone-traffic.svg`.

### Added — docs
- `README.md` — 109-line scannable reference (was 447, marketing-heavy).
- `CLAUDE.md` — codebase and user instructions, including the SSH-first template, the `printf '\n%s\n'` vs `echo >>` explanation for `authorized_keys`, and the two-`.env`-file distinction (compose-level vs Hermes-runtime).
- `reference/TROUBLESHOOTING.md` — symptom → cause → fix catalog, one row per real failure.
- `templates/SKILL.template.md` — the canonical skeleton every new integration copies.
- `blog/01-hermes-setup-guide.md` — beginner setup walkthrough.
- `blog/deploy-ai-agent-one-command-hstack.md` — one-command deploy narrative.
- `agents/max.md` — Digital Crew's Max sales-force plugin, wired via `/hermes-mcp-add`.
- `docs/image-content-brief.md` — content brief for future banner refreshes.

### Fixed
- Shell-lint workflow chokes on multi-line file list ([#78](https://github.com/paarths-collab/hstack/pull/78)) — pre-existing latent bug that finally tripped when a second script matched `**.sh`. Fixed by piping `find → xargs → shellcheck` in the same step instead of routing through `$GITHUB_OUTPUT`. Also quoted `TIERS["ai-tools"]` to prevent shfmt from parsing `ai-tools` as arithmetic subtraction inside a bash subscript, and marked shfmt `continue-on-error` since install.sh's aligned case arms pre-date the workflow's opinionated style enforcement.
- Correct Hermes install URLs and PowerShell syntax across all docs.
- Remove stale "no native Windows support" note from README and TROUBLESHOOTING.
- Correct reversed dashboard-bug rationale, pin Hermes v0.15.2.

### Security
- All 72 integration skills refuse to write config until the credential passes a live vendor pre-flight. A bad token aborts cleanly, no half-written state.
- All 8 platform skills refuse to enable themselves with an empty allowlist. Empty-allowlist "public bot" mode is a distinct, explicit consent path.
- `chmod 600 ~/.hermes/.env` enforced by the validator (added in Unreleased) and by convention throughout the catalog.
- Env-var indirection (`${VAR_NAME}`) in `config.yaml`; secrets never inlined.
- SSH keys generated by hstack use `ed25519`; RSA < 3072 and DSA never emitted.
- `printf '\n%s\n'` documented as the safe way to append to `authorized_keys`; the `echo >>` merged-key trap is documented in [CLAUDE.md](CLAUDE.md).

---

## [0.0.x] — 2026-05 through 2026-07 (pre-tag history)

Not tagged; commits captured for provenance. Notable milestones before `0.1.0`:

- **Initial commit set (55 skills)** — brought the catalog from 0 to 55 through daily batches of 1–4 integrations, each authored against official vendor docs. Batches recorded on the PR timeline as `#3` through `#56`.
- **SSH-first hardening template introduced ([#57](https://github.com/paarths-collab/hstack/pull/57))** — established the 10-step template that later batches consistently follow.
- **Platform hardening ([#58](https://github.com/paarths-collab/hstack/pull/58), [#59](https://github.com/paarths-collab/hstack/pull/59))** — brought the 8 platform skills up to template compliance.
- **Integration hardening ([#60](https://github.com/paarths-collab/hstack/pull/60)–[#64](https://github.com/paarths-collab/hstack/pull/64))** — retrofitted the pre-template integration skills.
- **Memory tier + OpenClaw ([#65](https://github.com/paarths-collab/hstack/pull/65))** — added mem0 + supermemory and the OpenClaw IDE target in a single batch.
- **Database, vector, auth, observability, RAG, code-sandbox, AI-tools, storage tiers ([#66](https://github.com/paarths-collab/hstack/pull/66)–[#73](https://github.com/paarths-collab/hstack/pull/73))** — daily tier batches taking the catalog past 68 integrations.
- **Universal installer + README overhaul ([#74](https://github.com/paarths-collab/hstack/pull/74))** — 1-click cross-IDE install command, first README rewrite to name all 6 IDE targets.
- **Repo-wide template rollout ([#75](https://github.com/paarths-collab/hstack/pull/75))** — 45 files touched, +12,144 / −4,276, brought every earlier skill onto the current template.
- **Datadog + Segment observability additions ([#76](https://github.com/paarths-collab/hstack/pull/76))** — filled the infra-APM and CDP-event-pipe gaps.
- **Obsidian docs-tier addition ([#77](https://github.com/paarths-collab/hstack/pull/77))** — added the three-path (vault-file / Local REST + tunnel / mcp-obsidian) integration for a local-only desktop app.
- **README polish ([#79](https://github.com/paarths-collab/hstack/pull/79))** — 447-line marketing-heavy README rewritten to 109-line scannable reference.

---

## Version pinning intent

- `HERMES_VERSION` (currently `0.15.2`) — pinned to a known-good release. Bumped only after the golden-path nightly (planned for a future release) has stayed green for 7+ consecutive days on the target version.
- **MCP package pins** live in [VERSIONS.txt](VERSIONS.txt), not inline in SKILL.md files. Bumping a pin is one edit + a validator run.
- **SDK version pins** listed in VERSIONS.txt are advisory — Hermes itself doesn't consume them; they inform skill authors about which vendor SDK shape a skill was tested against.

## How to add an entry

1. Open your PR against `main`.
2. Add a bullet under `## [Unreleased]` in the appropriate subsection (Added / Changed / Deprecated / Removed / Fixed / Security).
3. On release cut, a maintainer:
   - Renames `## [Unreleased]` to `## [<version>] — <YYYY-MM-DD>`.
   - Creates a fresh empty `## [Unreleased]` block above it.
   - Tags the release commit: `git tag -a v<version> -m 'v<version>'` and pushes.

## Links to older per-PR notes

Every squash-merged PR carries its own summary + test plan. Read them at:

- <https://github.com/paarths-collab/hstack/pulls?q=is%3Apr+is%3Aclosed>

The PR body is the durable source for "what was in this change" — this changelog is the summary index.
