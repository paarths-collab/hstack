# Security policy

hstack ships instructions that AI coding agents execute against **your** VPS, holding **your** credentials for third-party vendors. This document covers:

- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Scope](#scope)
- [Threat model](#threat-model)
- [What every skill guarantees, at the security layer](#what-every-skill-guarantees-at-the-security-layer)
- [Secret handling: rules the whole catalog obeys](#secret-handling-rules-the-whole-catalog-obeys)
- [Secret rotation playbook](#secret-rotation-playbook)
- [Incident response playbook](#incident-response-playbook)
- [Supply-chain hygiene for skill authors](#supply-chain-hygiene-for-skill-authors)
- [Cryptography and TLS](#cryptography-and-tls)
- [Known non-goals and residual risk](#known-non-goals-and-residual-risk)
- [Hall of thanks](#hall-of-thanks)

---

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.** GitHub search is indexed the moment you press Submit.

Use one of these instead, in order of preference:

1. **GitHub's private security advisory flow** — `Security → Report a vulnerability` on <https://github.com/paarths-collab/hstack>. This is the primary channel; it creates a private draft advisory that only maintainers see.
2. **Encrypted email** — `security@digitalcrew.tech`, PGP fingerprint published at <https://www.digitalcrew.tech/en/.well-known/security.txt>. Please encrypt anything containing a proof-of-concept token, a real API key, or a customer identifier.
3. **Signal** — request the number from either channel above; we don't publish it inline because number-scraping is real.

We aim for the following response SLAs, from the timestamp of the first message we can decrypt and read:

| Milestone | Target |
|---|---|
| Acknowledgement of receipt | 48 hours |
| Initial severity assessment | 5 business days |
| Fix landed or mitigation documented | 14 days (High/Critical), 30 days (Medium), 90 days (Low) |
| Public advisory + CVE if applicable | Within 7 days after the fix ships |
| Credit to reporter (with your permission) | On the advisory and in the [Hall of thanks](#hall-of-thanks) |

When you report, if you can, include:

- **Component** — which skill file, script, workflow, or installer path.
- **Reproduction** — the minimum SKILL.md invocation or shell command that demonstrates the issue.
- **Impact** — what the exploit gets: read the VPS filesystem, exfil a vendor token, RCE on the gateway, lateral movement to a vendor account, etc.
- **Affected versions** — either an hstack commit SHA / tag, or "main as of `<date>`".
- **Environment context** — IDE (Claude Code / Codex / Cursor / etc.), host OS, whether Hermes ran on the same host or a VPS over SSH.

We treat the report as confidential until we agree publicly with you that it's ready to disclose. **Coordinated disclosure is our default; we will not weaponize your report or attribute it to you without explicit consent.**

## Scope

**In scope:**

- Any skill under `skills/**/SKILL.md` — the Markdown that AI coding agents execute.
- The universal installer (`install.sh`, `install.ps1`) and the per-IDE distributors (`setup`, `setup-codex`, `setup-cursor`, `setup-hermes`, `setup-gemini`, `setup-openclaw`).
- CI workflows under `.github/workflows/**`.
- Any tool script under `scripts/**` (currently: `validate-skills.sh`, `lint-md-bash.sh`).
- Blog posts, `reference/**`, and `templates/**` — because they contain runnable examples that people paste into terminals.

**Out of scope for hstack itself, but happy to route:**

- **Hermes Agent runtime** — report at <https://github.com/NousResearch/hermes-agent/issues> (or private channel if the maintainers publish one). Cross-reference the hstack version so we can add a mitigation skill.
- **Third-party vendor APIs** hstack wires into — report to that vendor. If the disclosure needs hstack to hide the sharp edge in the meantime, tell us and we'll ship a workaround in the relevant integration skill.
- **User-authored SOUL/personality files** — user data, not our surface.
- **Deliberate testing / CTF frameworks** the user opts into (`ALLOW_WRITES=1`, `LONG_LIVED_ACKNOWLEDGED=1`, `PROD_ACKNOWLEDGED=1`). Those flags are explicit consent for dangerous capability.

**Explicitly out of scope, not eligible for advisory or bounty:**

- Missing rate-limit protection on **your** VPS (you own the network + firewall).
- Social-engineering an operator into typing `AUTO_APPROVE=1` without reading the dry-run.
- Vulnerabilities in operating systems, VPS providers, or SSH itself that we don't wrap.
- Denial-of-service via an operator asking their AI agent to run a skill in a tight loop.

## Threat model

We reason about hstack under six adversary types. For each, we state the assumed capabilities, the classes of attack we defend against, and what we accept as residual risk.

### T1 — Curious internet passer-by

**Capability.** Discovers the public hstack repo. Reads every file. Can open issues, PRs, and clone.

**Defends against.**
- Reading a secret from the repo → we run [gitleaks in CI](.github/workflows/) on every push and block merges that leak.
- Learning production endpoints from example configs → skill examples use placeholder domains and never real customer identifiers.
- Discovering a vendor bug by reading our SKILL.md → skills describe vendor auth as documented publicly; anything not-yet-documented we push to the vendor before publishing.

**Residual risk.** The repo describes real vendor auth flows in detail. Adversaries can use that to attack vendors more efficiently — but the same information exists in vendor docs.

### T2 — Malicious contributor

**Capability.** Opens a PR with malicious `SKILL.md`, install-script, or CI change. Tries to social-engineer maintainers.

**Defends against.**
- Malicious Markdown that executes on paste → we require reviewers to skim every bash block, and [`scripts/validate-skills.sh`](scripts/validate-skills.sh) enforces structural rules that make injection stand out. See [CONTRIBUTING.md](CONTRIBUTING.md) → "Review checklist".
- Compromised CI supply-chain → workflows pin action versions by SHA where feasible; secrets used in workflows are minimal (`TRAFFIC_TOKEN` and gitleaks only).
- Backdoor via a "helpful" new integration → every integration skill must reference public vendor docs and pass a live smoke test in a documented sandbox account before merge.

**Residual risk.** A determined attacker with a plausible identity could pass code review. We rely on the two-maintainer approval rule for anything touching the installer or `.github/workflows/`.

### T3 — Compromised AI coding agent

**Capability.** The agent (Claude Code, Codex, Cursor, etc.) is fed prompt injection via a malicious page, tool result, or repo file. It attempts to run skills the operator didn't request.

**Defends against.**
- **Dry-run gate.** Every dangerous skill prints a DRY-RUN block first. `AUTO_APPROVE=1` is opt-in per invocation, never a persistent setting.
- **Consent flags.** `ALLOW_WRITES=1`, `PROD_ACKNOWLEDGED=1`, `OWNS_VOICE_ACKNOWLEDGED=1`, `LONG_LIVED_ACKNOWLEDGED=1`, `WRITES_ACKNOWLEDGED=1`, `WRITE_ONLY_ACKNOWLEDGED=1` — each names a specific dangerous capability the operator must acknowledge, per skill. An injected agent can't set them silently; they have to be present in the shell environment the operator granted to the agent.
- **HARD GATE with live pre-flight.** No skill writes config until it can prove the supplied credential works against the real vendor endpoint. A bad-faith injection gets a 401 and clean exit, not partial state.
- **Rollback function.** Every skill defines `rollback()`; the harness calls it on any assertion failure, so a half-way abort doesn't leave a lingering MCP registration or `.env` line.

**Residual risk.** An agent already running in an interactive shell with `AUTO_APPROVE=1` can be steered. We tell operators in every skill: `AUTO_APPROVE=1` is per-command, not per-session. The agent-warden daemon (external project) is our long-term answer for supervising agent actions.

### T4 — Compromised VPS host

**Capability.** Attacker has root on the VPS where Hermes runs. Reads `~/.hermes/.env`, tampers with cron, snapshots memory.

**Defends against.**
- We don't. **The VPS root is our root of trust.** Every credential Hermes uses is by design decryptable from `~/.hermes/.env` because Hermes reads it at gateway start.
- We do minimize blast radius: `chmod 600 ~/.hermes/.env`, secrets never in `config.yaml` (world-readable), never in shell history (no `echo $TOKEN`), never in chat.

**Residual risk.** If root is compromised, every vendor token in `.env` is stolen. Mitigation is process: nightly `/hermes-backup` off-host, immediate rotation (see [Secret rotation playbook](#secret-rotation-playbook)) on any suspicion.

### T5 — Malicious vendor

**Capability.** A vendor whose integration we ship compromises their API and starts issuing malicious MCP responses, requests unusual scopes, or exfiltrates the token.

**Defends against.**
- **Least-privilege token creation.** Every integration skill tells the operator the minimum scopes needed (e.g., Datadog: `metrics_read, monitors_read, monitors_write, events_write, logs_write`). We do not ask for "all scopes."
- **Vendor-specific pitfalls table.** Every skill documents the vendor's known auth quirks so operators can spot deviation (Zendesk `/token` suffix, Sendbird `Api-Token` header, Notion OAuth-only hosted MCP, R2 `region=auto`).
- **Idempotency + rollback.** If a vendor changes their surface, re-running the skill converges cleanly rather than accumulating detritus.

**Residual risk.** MCP servers we spawn run inside the Hermes container and can execute arbitrary code. We pin package versions in `VERSIONS.txt` and refuse to auto-update; a supply-chain attack on a pinned npm/pypi package is caught only by [Supply-chain hygiene for skill authors](#supply-chain-hygiene-for-skill-authors).

### T6 — Compromised messaging platform

**Capability.** Discord/Telegram/Slack pushes a malicious message to the Hermes gateway.

**Defends against.**
- **Allowlist required.** Every platform skill refuses to enable itself with an empty allowlist. Random inbound messages are dropped before reaching the agent. Empty-allowlist consent (opting into "public bot" mode) is a distinct, explicit flag.
- **Platform-specific hardening.** WhatsApp LID handling, Slack signing-secret validation, Signal device-linking scoped to a single number.

**Residual risk.** An allowlisted account being taken over. We recommend 2FA / hardware keys on the messaging accounts you allowlist.

## What every skill guarantees, at the security layer

Every SKILL.md that this validator gates on:

1. **SSH access check first.** Skills refuse to run when they detect they're inside a Docker container (via `whoami; hostname` returning a hex hostname). Container root does not equal host root; secret writes inside a container are invisible to sshd on the host.
2. **Idempotency check.** If the integration is already wired and the pre-flight passes, the skill exits without changes. Re-runs are safe.
3. **HARD GATE with live pre-flight.** No secret lands on disk until the credential is proven valid against the vendor's real endpoint. A bad key aborts cleanly.
4. **DRY_RUN preview.** Before any write, the skill prints exactly what will happen. Only lengths and prefixes of secrets are shown — the full value is never echoed.
5. **`chmod 600 ~/.hermes/.env` after every write.** Enforced by [`scripts/validate-skills.sh`](scripts/validate-skills.sh).
6. **Env-var indirection in `config.yaml`.** Configs reference `${VAR_NAME}`, never inline the secret.
7. **`gateway stop && gateway run` for env changes.** Never `restart` — restart doesn't reliably re-read `.env`.
8. **Verification in gateway logs.** Skills poll for the "registered" line before returning success.
9. **Live smoke test inside the VPS.** The smoke test runs from the VPS, so the token never leaves the box.
10. **`rollback()` function.** Auto-invoked on any assertion failure; unsets env, removes MCP registration, restores the prior `config.yaml`, and restarts the gateway.

Auditing this list on your own deploy: `bash scripts/validate-skills.sh --skill=<name>`.

## Secret handling: rules the whole catalog obeys

### Where secrets live

- **On the VPS**, at `~/.hermes/.env`, `chmod 600`, one per line. Owned by root.
- **Never** in `config.yaml` (world-readable), in `.git`, in chat logs, in CI logs, in issue bodies, or in commit messages.
- Container-runtime `.env` (Compose-level) exists separately at `/opt/data/.env` inside the container. **MCP secrets go in the Hermes-runtime `.env`, not the compose one.** Skills that get this wrong result in "config written, gateway can't see it."

### How they get there

- `hermes config set KEY 'value'` — canonical.
- Fallback for Hermes builds without `config set`: `sed -i 's|^KEY=.*|KEY=value|' ~/.hermes/.env` using **the `|` delimiter, not `/`** (tokens contain `/+= `).
- **Never** `echo "KEY=value" >> ~/.hermes/.env`. If the previous line lacks a trailing newline, the write merges onto the previous line and both keys become invalid — the exact same failure mode as the `authorized_keys` merged-key trap documented in [CLAUDE.md](CLAUDE.md#why-printf-n-s-n-and-not-echo-).

### How they get read

- `hermes config get KEY` for interactive lookup on the VPS.
- `set -a; . ~/.hermes/.env; set +a` in a smoke-test script — after which the `env` is discarded when the shell exits.
- **Never** `curl ... --header "Authorization: Bearer $(cat ~/.hermes/.env | grep KEY)"` — that logs the token into shell history.

### How they get deleted

- `hermes config unset KEY` or `sed -i '/^KEY=/d' ~/.hermes/.env`.
- After deletion: `gateway stop && gateway run` (never restart).

### Length + prefix disclosure in dry-runs

Every dry-run prints `length ${#TOKEN}, prefix ${TOKEN:0:4}...`. Never the full value. If you catch a skill printing the full token, that's a reportable bug — file it via the [Reporting a vulnerability](#reporting-a-vulnerability) channels.

## Secret rotation playbook

Rotate credentials **immediately** when any of these are true:

- A token was pasted into a chat window (yours or someone else's).
- A token appears in a CI log, a screen recording, or a screenshot.
- The VPS was accessed by anyone who should no longer have access (former teammate, dismissed contractor, sold hardware).
- A vendor emails you that a specific token was involved in a breach.
- `git log -p` or `git blob` search finds the token in repo history (rotate first, then rewrite history — history rewrite alone does not un-leak).
- More than 90 days have passed since last rotation on a token holding write scope.

### The rotation procedure per skill class

**Vendor with a "revoke + reissue" dashboard flow (most common: Stripe, GitHub, Notion, Datadog, Slack, Discord, OpenAI):**

1. Log in to the vendor console. Create a **new** token with the same scopes as the old one. Copy it once.
2. On the VPS: `hermes config set <KEY> '<new-value>'`.
3. `hermes gateway stop && sleep 2 && hermes gateway run --daemon` — never `restart`.
4. Confirm the smoke test in that skill's Step 9 passes.
5. In the vendor console, revoke the **old** token.
6. Grep VPS logs for the old token prefix: `grep -r '<old-prefix>' /var/log ~/.hermes 2>/dev/null`. If it appears anywhere, purge that log file.

**Vendor with a "rotate via API only" flow (Auth0 M2M client secret, Salesforce Connected App, AWS IAM access key):**

1. Read the vendor's own rotation guide first — every one of these has vendor-specific side effects.
2. Follow the skill's own `rollback()` inverse — most `/integration-*` skills define a `rotate()` alongside `rollback()` for exactly this case.
3. Verify with `env | grep -c '^<PREFIX>_'` inside the gateway.

**Vendor without server-side rotation (rare — some legacy webhooks):**

1. Delete the resource (webhook, integration, service account).
2. Recreate it. Copy the new signing secret / URL.
3. Follow the standard `hermes config set → stop → run` cycle.

**After rotation, always:**

- Update `~/hermes-backups/<timestamp>.tar.gz` with a fresh `/hermes-backup` — old archives still contain the old (now revoked) token, which is fine, but the newest archive should be recoverable to a working state.
- If the leak was to a public repository or public chat, assume the token was scraped within minutes. Rotate everything wired via that same vendor account, not just the specific token.

### SSH-key rotation

hstack's own SSH key (`~/.ssh/hermes_vps`) unlocks every deploy. Rotate it:

- If the operator's workstation is ever unattended in a hostile environment (customs, unlocked laptop at a conference).
- Annually as a hygiene default.
- Immediately if `~/.ssh/hermes_vps.pub` appears in a repo, a screenshot, or a chat log — the private key alone is worthless without the public key on `authorized_keys`, so leaked-pubkey is low but non-zero risk (it enables targeted phishing).

Procedure: generate new keypair → `printf '\n%s\n' "$(cat ~/.ssh/hermes_vps.pub)" >> ~/.ssh/authorized_keys` on the VPS → test SSH with the new key → remove the old key line from `authorized_keys`.

## Incident response playbook

Use this the moment you suspect a compromise. Move fast; explain later.

### Phase 0 — decide if it's real (5 min)

- What signal made you suspect? (Vendor breach email, unfamiliar activity in a vendor dashboard, unexplained log lines, agent behaving strangely.)
- Is the signal from a vendor you actually integrated? Cross-check against `~/.hermes/.env` on the VPS.
- If unsure, **assume real** until you can prove otherwise. False positives cost minutes; false negatives cost months.

### Phase 1 — contain (30 min)

1. **Cut network access to the VPS at the provider firewall level.** Not iptables inside the host — a compromised host can rewrite iptables. Use the hosting provider's console to block inbound and outbound.
2. **Kill the Hermes gateway.** `ssh root@vps 'hermes gateway stop'` (may need password if SSH was rotated). If SSH is compromised, use the provider's out-of-band console.
3. **Rotate credentials in this order:** highest-blast-radius first. Payments (Stripe live keys) → email (SendGrid, Postmark can send phishing) → cloud (AWS, GCP, Cloudflare) → messaging (Slack, Discord, Telegram) → everything else. See [Secret rotation playbook](#secret-rotation-playbook) per vendor.

### Phase 2 — investigate (2-6 hours)

1. **Snapshot the VPS disk** (provider console). Forensics on a snapshot; do not touch the live disk beyond what's required for rotation.
2. **Pull `/var/log/auth.log`, `/var/log/syslog`, `~/.hermes/logs/`.** Look for: unfamiliar SSH source IPs, unexpected `hermes config set` invocations, MCP registrations you didn't authorize, cron entries you didn't add.
3. **Check `~/.ssh/authorized_keys`.** Grep for `^ssh-` and count — number should match the number of keys you expect. Merged-line traps (see [CLAUDE.md](CLAUDE.md#why-printf-n-s-n-and-not-echo-)) hide extra keys.
4. **Check every integrated vendor's audit log.** Which tokens were used, from what IP, for what actions. Vendors have wildly varying retention — Stripe keeps 60 days, Datadog 15, some keep zero. Pull whatever you can while you can.

### Phase 3 — recover (1-3 days)

1. **New VPS, clean image.** Provision from scratch, not from the compromised snapshot.
2. **Restore from a `/hermes-backup` archive taken before the earliest suspicious activity.** If you can't be sure when the compromise started, restore from the oldest archive and re-wire integrations by re-running `/integration-*` skills with freshly-rotated tokens.
3. **Bring up the gateway. Run `/hermes-status`.** Verify every wired integration.
4. **Re-enable network access** at the firewall level, ideally with a narrower allowlist than before if you can identify one.

### Phase 4 — disclose (within 7 days)

1. **Notify anyone affected.** Users whose messages the compromised gateway had access to, vendors whose tokens were exposed, any downstream service whose data flowed through the gateway.
2. **File a private security advisory** on the hstack repo describing what allowed the compromise, so we can ship a preventive skill or rule. Even if it turns out to be VPS-provider-level and not hstack's fault, we may be able to detect and warn.
3. **Post-mortem to yourself and your team.** What signal would have caught this earlier? Add an alerting rule (`/integration-datadog`, `/integration-sentry`, or `/integration-posthog` can each carry that alert).

## Supply-chain hygiene for skill authors

hstack skills run `npx`, `uvx`, `curl | bash`, and `docker run` against the internet. That's leverage and risk. Rules for authoring:

- **Pin versions in `VERSIONS.txt`, not in every skill.** Bumping a version is one edit + a validator run, and the validator catches drift.
- **Never `curl | bash`** to install anything hstack does not explicitly own. If a vendor requires a curl-pipe installer, wrap it in a docker container so the blast radius is contained.
- **Prefer official vendor MCP servers** (namespace-owned org, e.g. `@notionhq/`, `@stripe/`, `@brave/`) over community wrappers. When only a community wrapper exists, name the maintainer in the skill's "Honest auth picture" section so operators can evaluate trust.
- **Refuse to wire capabilities Hermes already provides.** `integration-openai-tools` explicitly refuses to wire `/chat/completions` because `/hermes-model` covers it. Duplication multiplies attack surface.
- **Every third-party install step must be logged.** No skill silently runs `pip install`, `npm i -g`, or `curl | sh` in a hook.
- **Diff-review upstream releases before bumping.** Read the release notes, skim the changed files, look for new outbound network calls or new env-var reads. If you can't do this, don't bump; wait until someone can.

## Cryptography and TLS

- All vendor calls are HTTPS. Skills that curl vendor APIs use system CAs; we do not ship an alternate trust store.
- The Obsidian Local REST API plugin ships a self-signed cert by default. `integration-obsidian` documents `OBSIDIAN_TLS_MODE=insecure` (curl `-k`) and `strict` (only if the operator installed the plugin's CA). We default to `insecure` because the connection travels a private tunnel (Tailscale / Cloudflare Tunnel), where TLS is defense-in-depth rather than the primary trust boundary.
- SSH keys generated by hstack skills are `ed25519`, never `rsa < 3072`, never `dsa`.
- We do not implement our own crypto anywhere. Every hash, MAC, encryption, or key derivation is delegated to OpenSSH, curl (OpenSSL), or the vendor's own library.

## Known non-goals and residual risk

hstack does **not**:

- Provide runtime intrusion detection on the VPS. That's the operator's job (fail2ban, OS-level IDS, cloud-provider guardrails). If you want IDS-adjacent, wire `/integration-datadog` or `/integration-sentry` and set an alert.
- Enforce token expiry. Vendors that support short-lived tokens (Auth0 M2M, Salesforce OAuth client-credentials) are used with re-mint-per-call, but many vendors only offer long-lived tokens. The rotation playbook above is your protection.
- Guard against a malicious operator. If someone with `AUTO_APPROVE=1` and root SSH intentionally wires a hostile integration, hstack helps them do it faster, not stop them.
- Sandbox skills from each other. Every skill runs with the same privilege as the AI agent invoking it — which is whatever privilege the operator granted.

If any of these become in-scope for your deployment, the agent-warden project (external) is our supervisor layer. hstack itself stays as a catalog.

## Hall of thanks

Reporters who improved hstack's security posture — with their permission, listed here after the fix ships:

<!-- append entries: - YYYY-MM-DD — Reporter Name (Handle) — one-line summary -->

*(empty; be the first.)*

---

**Last reviewed:** every entry in this document is reviewed on a rolling 6-month cadence, and immediately after every incident or advisory.
