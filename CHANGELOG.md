# Changelog

All notable changes to hstack. This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — MAJOR.MINOR.PATCH — with a lenient interpretation for a Markdown skill catalog:

- **MAJOR** — breaking structural change (skill directory renamed or removed, installer flag semantics change, required env var name change).
- **MINOR** — new skill, new tier, new installer capability, new supported IDE, new consent flag.
- **PATCH** — pitfall row added, dry-run wording clarified, endpoint URL corrected, validator rule loosened.

The format is inspired by [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Metrics-only commits (nightly clone-traffic updates) are omitted intentionally — they add noise without changing behavior.

---

## [Unreleased]

- Removed the dedicated GitHub-to-Telegram report packs, their experimental acceptance transaction and associated tests/contracts. Retained the standalone GitHub integration skill; removed GitHub from the brief planner. Refocused the README on setup, connections and operations.

### Changed
- **Plugin package refresh (0.4.0).** Claude, Codex and Cursor metadata now describes the source-verified Hermes 0.22.5 catalogue without blanket live-validation or rollback claims. Added a portable Agent Plugins manifest and explicit Codex repository marketplace, retained host compatibility manifests, corrected Codex listing limits and documented install/update flows. Public directory publication and live host execution are separate from source validation.
- **Complete Hermes 0.22.5 catalogue migration.** All integration batches use native catalog/MCP registration or discoverable native skills, exact host-version gates, private credentials and guarded gateway readiness. Placeholder registrations and inert REST notes are replaced with executable procedures. Native OAuth remains user-approved; vendor live validation is not claimed.
- **Regression hardening.** Restart interruption requires literal opt-in; draining gateways retain their instance identity; legacy recovery rejects unknown runtimes; seven-day scheduled reports handle autumn DST. Installer guidance delegates to the guarded restart skill, the validator recognizes profiled credential writes, and narrowly scoped secret-scan exceptions have positive controls.
- **PowerShell root symlinks.** Relative links directly under the filesystem root (including macOS `/var`) now resolve correctly without an empty parent path. Both installer copies share the regression-tested fix.
- **Multiple workflow instances per Hermes target.** All three packs now coexist; `prepare --instance ID` also creates independent copies of one report with different repositories, chat or daily cutoff. Each instance owns its job, private files, state, lock and rollback. `list` and selected `status` read installation metadata without invoking Hermes. Existing unlabelled installations retain their paths and review format.
- **Focused workflow entrypoint.** README leads with repository activity, requested PR reviews and published releases instead of catalog size. An executed comparison gives the manual Hermes baseline the same runtime code and reports setup actions separately from unmeasured human time.
- **Completion and validation documentation.** README now foregrounds the runnable daily brief, its setup guide and dated validation record. Implementation and local SSH/HTTP checks are complete; real Telegram delivery and the seven-day promotion gate remain pending. Removed stale blanket reliability claims, nightly-restart guidance and the claim that current Hermes lacks native backups.

### Fixed
- **Launcher directory protection.** Installation, execution and rollback refuse a foreign-owned or group/world-writable Hermes home, scripts directory or workflow parent. This prevents another local user replacing a launcher or runtime through a writable parent. Private files and lifecycle locks also reject hard-link aliases.
- **Telegram test command drift.** The Docker-only shim now accepts explicit default-profile commands and models candidate `gateway ensure` without changing the legacy stub/version. Local regression tests execute the skill's actual reachability and reload blocks; live gateway validation remains separate.
- **Publication checks.** Workflow CI includes isolated edits to the migrated install, memory and update skills. Secret scanning retains all default detectors and narrowly permits three exact harmless literals only in their expected files; both repository/history scans and negative controls were checked. CI and the declared minimum use the tested Gitleaks 8.30.1 release instead of the action's older default.
- **Concurrent cron edits and reviewed contracts.** Acceptance apply refuses managed cron changes made after backup, before changing live state. Recorded cron intent stays fixed within a transaction, and caller-supplied contracts are snapshotted so later mutations cannot alter the reviewed plan.
- **Explicit operation confirmation.** Acceptance apply requires the target's reload acknowledgement. Verification requires a confirmed commit; a missing acknowledgement remains unverified and can be retried, including after a lost reply.
- **Deployment persistence and connection evidence.** Deploy refuses failed crontab reads, verifies the installed table, and preserves unrelated jobs. Gateway checks require a successful status command; connection checks require evidence for the selected platform and reject disconnected or failed states.
- **Reviewed helper isolation and operation ordering.** Acceptance helpers are installed atomically under their content digest, and transactions bind every operation and resumed recovery to that reviewed version. Overlapping operations on one transaction instance are rejected before they can corrupt its receipt.
- **Skill permission drift.** Acceptance ownership signatures now include permissions and empty directories, so chmod-only changes fail verification and are preserved on rollback. Older content-only signatures require manual reconciliation.
- **Recoverable skill rollback and deploy checks.** Recovery snapshots publish only after all copies are verified; rollback refuses incomplete or corrupt backups, and restoration failures keep the active snapshot and return an error. Deploy now rejects a failed inference command even when it prints `OK`.
- **PowerShell refusal status.** A destination refused because it points into the source tree now makes both PowerShell installers exit non-zero instead of reporting success.
- **Acceptance safety and recovery.** Applied credentials use a private `.env`; verification checks open-access overrides and configuration drift. Transaction lifecycle checks run under the target lock, and an interrupted backup remains recoverable instead of being mistaken for an untouched target.
- **Skill verification.** Telegram's idempotency check validates the stored access boundary before skipping setup. The model smoke test requires a successful command and the expected reply instead of accepting an error that happens to contain `OK`.
- **Installers run on stock macOS bash 3.2.** `install.sh` used `declare -A`, which aborted `--help` and every run before argument parsing. Tier membership is now a case function, and the `setup-*` scripts are checked under `/bin/bash` 3.2 in CI. Piping into `zsh` prints a one-line error; `zsh install.sh` re-execs under bash.
- **Installers no longer delete files they did not install.** A re-run could `rm -rf` a same-named user skill. Now only hstack's own links and marked copies are replaced. Anything else is moved aside, never deleted, and the exact backup path is printed. A backup that cannot be made leaves the entry untouched and the run exits non-zero.
- **Instruction-file rewrites are atomic.** The hstack block in CLAUDE.md, AGENTS.md or GEMINI.md is replaced between markers via a temp file and verified rename, after a backup. An unterminated start marker is never truncated.
- **Install paths refuse an unusable `HOME`** (exit 2 when unset, empty or relative), and refuse destinations that are, or resolve into, an hstack skills tree. Relative `*_DIR` overrides resolve against the directory the command was run from.
- **Skill validators run on bash 3.2.** `scripts/validate-skills.sh` and `scripts/check-skill-refs.sh` no longer use bash 4 features and run under `/bin/bash` in CI on macOS.
- **Recipe tests find Python 3 portably.** They try `python3`, `python` and `py -3`; `HSTACK_PYTHON` overrides the lookup. Recipe tests run in CI on Linux and macOS.
- **Integration template, Notion and GitHub.** The live credential check is a HARD GATE that runs before the dry run and before any write. Snapshot and rollback restore the exact prior `~/.hermes/.env` and `config.yaml`, not just unset keys. Secrets travel to the VPS over ssh stdin, never in argv or URLs.
- **`/platform-telegram`.** The live token check sends the real token over ssh stdin. A numeric user-ID allowlist is required; an empty allowlist aborts. The allowlist is written before the token. The skill no longer relies on a `TELEGRAM_ENABLED` variable, and it does not set the group-wide `TELEGRAM_GROUP_ALLOWED_CHATS`.
- **`/hermes-deploy` and `/hermes-model`.** Deployment variables are passed explicitly to the VPS (a quoted heredoc had left them empty). Credentials use the key names Hermes reads, such as `OPENROUTER_API_KEY` and `ANTHROPIC_API_KEY`. `/hermes-deploy` prefixes its helpers (`deploy_*`) so delegated skills cannot shadow them.

### Added
- **Pinned native cron integration.** An opt-in disposable Python 3.14.9 harness exercises actual Hermes 0.22.5 cron parsing, job storage, claims, no-agent subprocesses, failure/recovery and scheduler ticks with all three packs. Controlled vendors provide API acknowledgements; full Hermes startup, Linux/systemd and real Telegram delivery remain outside this check.
- **Three ready-to-use GitHub workflow packs.** Activity brief, current requested-review queue and publication-window release watch share private Telegram delivery and native Hermes scheduling. `prepare` generates private configuration/runtime and target instructions; `credentials` captures hidden token input; `preview` fetches the actual selected report before installation. Legacy activity configurations retain their existing shape. Added pack/CLI/comparison checks to the workflow suite and CI.
- **Runnable GitHub-to-private-Telegram brief candidate.** A deterministic collector, private-chat API acknowledgement, native no-agent schedule, reviewed first-install package, canary dispatch and conflict-safe rollback replace the assumption that a generic prompt plus installed skill text is an end-to-end workflow. Private run journals prevent blind retries after uncertain sends. Tests exercise real loopback HTTP with fake credentials; live deployment and recipient observation remain unverified.
- **Explicit Hermes 0.22.5 migration candidate.** A separate contract and pinned source commit prepare native structured cron inspection and supported service operations without promoting the legacy default. Compatibility status and the seven-day live promotion requirement are recorded under `compatibility/`. Source and offline tests are not live deployment proof.
- **Current native maintenance procedures.** Candidate installation verifies an immutable installer digest, updates follow the installation owner's native updater, model configuration uses native commands, memory follows native setup and plugin interfaces, and deployment uses supervised gateway operations without adding a nightly restart. Tagged parser fixtures check the reviewed command syntax offline.
- **Skill-block regression tests.** `tests/skills/` runs the bash blocks of the repaired skills (template, Notion, GitHub, `/platform-telegram`, `/hermes-model`, `/hermes-deploy`) in document order against stub `ssh`, `curl` and `hermes` and asserts ordering (vendor preflight before any write), byte-identical restore on failure, no secret in ssh or curl argv, the PATH export in `remote()`, and hostile-input rejection. The primary `hermes config set` path still exposes values in the remote Hermes process's argv. The tests run offline on Linux and macOS in CI and do not prove behaviour against real Hermes or real vendors.
- **`setup-all` runs all six setup scripts** (`setup`, `setup-codex`, `setup-cursor`, `setup-hermes`, `setup-gemini`, `setup-openclaw`) even when git stores them without the executable bit. It continues past a failure and exits 1 if any script failed.
- **`--pick` accepts menu numbers** (`1` for everything, `2`–`21` for one tier each) as well as tier and integration names.
- **PowerShell installer mirror.** `install.ps1` and `setup.ps1` apply the same ownership and backup rules and always copy skills (no symlinks). `tests/installer/test-install.ps1` runs under `pwsh`; it has been verified on Linux `pwsh` only, not on Windows PowerShell 5.1.
- **Acceptance transaction (experimental).** `packages/acceptance/` wraps the Founder Brief GitHub-to-Telegram workflow in a reversible transaction that writes a secret-free receipt and restores the last working state on rollback. It is verified offline only; a real-server run is still required. See its README.
- **Docs.** README and CONTRIBUTING describe stock bash 3.2 support, re-run and backup behaviour, and how to test the installers. `docs/reference/TROUBLESHOOTING.md` gains rows for the integration, Telegram, deploy and acceptance failures above.

## [0.3.0] — 2026-08-03

### Changed
- **License: MIT → Apache 2.0.** Adds an explicit patent grant — the right fit for infrastructure companies may run in production. `NOTICE` file added; README badge, banner SVG, and blog license mentions updated. (References to *other* projects' licenses — Hermes Agent's MIT under Nous Research — are unchanged.)
- **README hero rewritten around the product's actual magic moment** (the agent's home channel messages you first) instead of catalog size. Counts corrected to reality everywhere: **97 skills = 15 hermes-* + 1 setup-* + 2 blueprint-* + 8 platform-* + 71 integration-***. The count guard keeps README, CLAUDE, installer, and banner copy aligned.
- **Clone-traffic bot commits moved off `main`** to the `metrics-data` branch, so the visible commit history reflects human work instead of daily `[skip ci]` noise.
- **`scripts/check-skill-refs.sh` now also validates the `setup-` prefix.** It shipped covering only `hermes|platform|integration` and therefore passed clean on a tree where all 94 skills referenced a skill that did not exist. Deliberately still an allowlist rather than a general `/[a-z-]+` match: integration skills document vendor REST surfaces, so a broad pattern matches `/customers`, `/chat`, `/invoices` and hundreds more.
- **Docker framing corrected across README and docs/archive/launch-plan.md.** Both described hstack as updating "the Docker config". No skill has ever contained the string `Dockerfile`; Docker appears only as a detection branch (`docker ps | grep hermes`, then `docker exec` to reach the binary). Hermes installs via the upstream install script plus a pinned `pip install`. What the skills actually write: `~/.hermes/.env` (877 references), `config.yaml` (226), `/opt/data/.env` (11). Copy now says that.
- **`CLAUDE.md` tier index corrected against `install.sh`.** It advertised three integrations that do not exist (`confluence`, `s3-compatible`, `matrix`) and omitted nine that do (`railway`, `tally`, `tavily`, `twilio`, `vercel`, `webflow`, `wordpress`, `zoho-crm`, `zoom`); it also claimed 16 `hermes-*` core skills on line 78 while line 18 of the same file said 15. `check-skill-refs.sh` cannot catch this class — these are bare names, not `/slash-refs`.

### Removed
- **`blog/` and every Digital Crew Technology reference.** Both blog posts carried `canonical:` URLs pointing at `digitalcrew.tech`, so the published copies live there and the repo was only holding the source. Removing the directory here does not unpublish them there. Also dropped the credit line from README (hero + footer) and CLAUDE.md, the blog contribution route and its TOC entry from CONTRIBUTING.md, and the Digital Crew maintainer row from the approvers list.

### Added
- **Agent Blueprints.** `/blueprint-saas-founder` composes a safe, reviewable custom agent plan from optional services, delivery, schedules, memory, backups, and approval posture. `/blueprint-install` validates secret-free JSON, re-derives only allowlisted Hermes skills, previews the plan, and delegates selected specialist skills in serial order. Ships SaaS Founder, Personal Chief of Staff, and DevOps On-Call templates. Hermes is the installable v1 target; OpenClaw is supported as an execution host and QM receives a portable intent export until its dedicated adapter ships.
- **`/setup-ssh-keys` — the prerequisite skill every other skill already assumed.** All 94 skills abort with `Run /setup-ssh-keys first` when their SSH reachability check fails. That skill did not exist. Every skill in the catalog dead-ended into a phantom, and `scripts/check-skill-refs.sh` — added one commit earlier to catch exactly this — reported a clean run, because its prefix list was hardcoded to `hermes|platform|integration` and `setup-ssh-keys` starts with `setup-`. The skill now ships: container-vs-host detection, three non-interactive routes for placing the first public key (an AI agent cannot type a password at an `ssh` prompt), merged-key detection and repair, permission repair, optional `HARDEN_SSHD=1` password-auth lockout gated behind a proven key login, and a real rollback.
- **Plugin distribution.** hstack is now installable as a first-class plugin instead of only via `curl | bash`: `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` (Claude Code, and reused by Factory Droid and Copilot CLI), `.codex-plugin/plugin.json` (Codex CLI + App, including the `interface` block for the app listing), `.cursor-plugin/plugin.json` (Cursor), and `gemini-extension.json` + `GEMINI.md` (Gemini CLI). Install with `/plugin marketplace add paarths-collab/hstack` then `/plugin install hstack@hstack`. Verified end-to-end: `claude plugin validate --strict` passes and a real install exposes all 95 skills. The existing `install.sh` / `install.ps1` / `setup-*` scripts are untouched and remain the path for Hermes itself and OpenClaw, which have no plugin registry.
- `GEMINI.md` — compact routing context for Gemini CLI. Deliberately routes ("user says X → read `skills/<name>/SKILL.md`") instead of `@`-referencing all 95 skills, which would be unusable in context.
- `.github/workflows/count-check.yml` — CI guard that fails the build if the README badge counts drift from `ls skills/*/SKILL.md | wc -l` reality again.
- `SECURITY.md` — coordinated vulnerability disclosure policy, six-adversary threat model (curious passer-by / malicious contributor / compromised AI agent / compromised VPS / malicious vendor / compromised messaging platform), secret rotation playbook, four-phase incident response playbook.
- `CONTRIBUTING.md` — full SSH-first skill authoring manual with per-step commentary, review checklist, two-approver rule for installer / workflow / security-doc changes.
- `VERSIONS.txt` — single source of truth for pinned versions (Hermes runtime, MCP packages, SDK versions, CI tool minimums, skill length policy). Referenced by `scripts/validate-skills.sh`.
- `scripts/validate-skills.sh` — validator that enforces the SSH-first template on every `skills/**/SKILL.md`: frontmatter shape, name/dir match, description length, line-count policy, required sections (Before you start → Step 1..6+ → Rollback → Pitfalls → Definition of done), pitfall count minimum, chmod-600 hygiene inside code blocks, no-secret-leak patterns, Hermes-version pin consistency. Supports `--changed` (PR mode), `--json`, `--skill=<name>`, `--quiet`.
- `.github/workflows/validate-skills.yml` — runs `scripts/validate-skills.sh` on every push and PR touching `skills/**`, `VERSIONS.txt`, or the validator itself. Uploads a JSON report artifact for 14 days.

- README rewritten from a 447-line marketing-heavy long-form document to a 109-line scannable reference. Banner SVG removed. Emoji headers dropped. Catalog counts corrected to actual (95 skills, 71 integrations).

## [0.1.0] — 2026-07-02

The first tagged release. Reflects roughly two months of building the SSH-first skill catalog to 95 skills across 6 IDE targets and 8 messaging platforms.

### Added — the universal installer
- **`install.sh` + `install.ps1`** — one command that auto-detects every AI coding agent on the box (`~/.claude/`, `~/.cursor/`, `~/.hermes/`, `~/.agents/`, `~/.openclaw/`, `~/.gemini/`) and symlinks the same 95 skills into each in the format that agent expects (`.md` verbatim, `.mdc` for Cursor, `@-referenceable context` for Gemini CLI). Flags: `--pick` (interactive), `--all`, `--tier=`, `--include=`, `--ide=`, `--branch=`, `--local`, `--help`.
- Non-TTY safe: reads the interactive picker from `/dev/tty` so `curl … | bash` still surfaces the menu.
- Windows fallback to `Copy-Item -Recurse` where symlinks aren't guaranteed without dev-mode.

### Added — 95 hardened skills

**15 hermes-* core** — `/hermes-backup`, `/hermes-cron`, `/hermes-deploy`, `/hermes-fix`, `/hermes-home`, `/hermes-install`, `/hermes-integrate`, `/hermes-mcp-add`, `/hermes-memory`, `/hermes-model`, `/hermes-restart`, `/hermes-skills`, `/hermes-soul`, `/hermes-status`, `/hermes-update`.

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
- `docs/reference/TROUBLESHOOTING.md` — symptom → cause → fix catalog, one row per real failure.
- `templates/SKILL.template.md` — the canonical skeleton every new integration copies.
- `blog/01-hermes-setup-guide.md` — beginner setup walkthrough.
- `blog/deploy-ai-agent-one-command-hstack.md` — one-command deploy narrative.
- `docs/maintainers/image-content-brief.md` — content brief for future banner refreshes.

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
2. Add a bullet under `## [Unreleased]

- Removed the dedicated GitHub-to-Telegram report packs, their experimental acceptance transaction and associated tests/contracts. Retained the standalone GitHub integration skill; removed GitHub from the brief planner. Refocused the README on setup, connections and operations.` in the appropriate subsection (Added / Changed / Deprecated / Removed / Fixed / Security).
3. On release cut, a maintainer:
   - Renames `## [Unreleased]

- Removed the dedicated GitHub-to-Telegram report packs, their experimental acceptance transaction and associated tests/contracts. Retained the standalone GitHub integration skill; removed GitHub from the brief planner. Refocused the README on setup, connections and operations.` to `## [<version>] — <YYYY-MM-DD>`.
   - Creates a fresh empty `## [Unreleased]

- Removed the dedicated GitHub-to-Telegram report packs, their experimental acceptance transaction and associated tests/contracts. Retained the standalone GitHub integration skill; removed GitHub from the brief planner. Refocused the README on setup, connections and operations.` block above it.
   - Tags the release commit: `git tag -a v<version> -m 'v<version>'` and pushes.

## Links to older per-PR notes

Every squash-merged PR carries its own summary + test plan. Read them at:

- <https://github.com/paarths-collab/hstack/pulls?q=is%3Apr+is%3Aclosed>

The PR body is the durable source for "what was in this change" — this changelog is the summary index.
