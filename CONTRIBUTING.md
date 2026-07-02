# Contributing to hstack

Welcome. hstack's real moat is **accumulated knowledge of what breaks** — every skill that survived contact with a real deploy encodes fixes for traps we hit so the next operator doesn't. That knowledge grows via contributions.

This guide covers:

- [What kinds of contributions we want](#what-kinds-of-contributions-we-want)
- [Getting your environment ready](#getting-your-environment-ready)
- [Branch, commit, PR conventions](#branch-commit-pr-conventions)
- [Authoring a new skill — the SSH-first template, explained](#authoring-a-new-skill--the-ssh-first-template-explained)
- [Authoring an integration skill — the extra bar](#authoring-an-integration-skill--the-extra-bar)
- [Authoring a platform skill — the extra bar](#authoring-a-platform-skill--the-extra-bar)
- [Editing an existing skill](#editing-an-existing-skill)
- [Contributing to TROUBLESHOOTING.md](#contributing-to-troubleshootingmd)
- [Contributing to the blog](#contributing-to-the-blog)
- [Review checklist](#review-checklist)
- [Governance](#governance)

---

## What kinds of contributions we want

In rough priority order:

1. **New Hermes failure mode + fix**, added as a row in [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md) with the GitHub issue # if there is one. Two lines of markdown that save the next person an hour.
2. **A new `/integration-<vendor>`** covering a vendor Hermes doesn't already handle natively. Follow the [Authoring an integration skill](#authoring-an-integration-skill--the-extra-bar) section — the bar is genuinely high, but the template does most of the work.
3. **A new `/platform-<name>`** for a messaging surface we don't yet cover (matrix, teams-bot-only, discord-forum-only, etc.).
4. **A hardening PR** on an existing skill — pitfalls table row we forgot, an idempotency bug, a rollback path that leaves detritus.
5. **A validator or CI improvement** — new structural rule enforced in [`scripts/validate-skills.sh`](scripts/validate-skills.sh), a new golden-path test.
6. **A blog post** for [`blog/`](blog/) — either a beginner deploy walkthrough or a deep dive on a Hermes failure mode. Follow existing posts as templates.

We politely decline:

- **Chat-completion providers as new integrations.** `/hermes-model` covers OpenAI, Anthropic, OpenRouter, Google, Groq, Mistral, Together, Cohere. Wrapping any of them as `/integration-<provider>` duplicates that surface. If the vendor has a **non-chat** capability (embeddings, TTS, images, code sandboxing, moderation), that's fair game — see `/integration-openai-tools` as the pattern.
- **Silent capability additions** — every skill that can spend money, mutate production, or send messages must have an explicit consent flag (see [Authoring an integration skill](#authoring-an-integration-skill--the-extra-bar) → "Consent flags").
- **Cosmetic refactors without a fix** — reorganizing files, renaming variables, updating tone. If the change is only "read nicer," please just open an issue with the suggestion.

## Getting your environment ready

You need:

- **A Unix-ish shell.** macOS or Linux native. On Windows: WSL2 or Git Bash. PowerShell works for `install.ps1` testing only.
- **`bash` 4+**, `shellcheck` ≥ 0.9, `shfmt` ≥ 3.8 for lint checks locally. Install via your package manager (`brew install shellcheck shfmt`, `apt install shellcheck && GO111MODULE=on go install mvdan.cc/sh/v3/cmd/shfmt@latest`, etc.).
- **`gh` CLI** for opening PRs from the terminal (optional; the GitHub web UI works too).
- **A test VPS.** Any $4–7/mo Linux box works. Hetzner CX22, DigitalOcean $6 droplet, and Hostinger's KVM tier are the three we test on. Don't test destructive skills on your production Hermes.

Fork the repo, clone your fork, add upstream as a remote:

```bash
git clone https://github.com/<you>/hstack.git
cd hstack
git remote add upstream https://github.com/paarths-collab/hstack.git
```

Confirm your local tools:

```bash
bash --version | head -1     # need 4+
shellcheck --version | head -2
shfmt --version              # need 3.8+
bash scripts/validate-skills.sh --quiet  # should print "N passed, 0 failed"
```

If `validate-skills.sh` fails on `main`, that's a bug — please file an issue with the output before you continue.

## Branch, commit, PR conventions

**Branch off `main`:**

```bash
git fetch upstream
git switch -c <type>/<short-slug> upstream/main
```

Where `<type>` is one of `feat`, `fix`, `docs`, `refactor`, `chore`, `test`. Examples that landed recently:

- `feat/integration-datadog`
- `fix/shell-lint-workflow-multiline`
- `docs/readme-cleanup`

**Commit messages:** Conventional Commits. Subject line under 72 chars, imperative mood, no trailing period. Body wraps at 80.

```
feat(skills): add integration-datadog to observability tier (SSH-first)

Datadog site-scoped REST API (six-site allowlist) authenticates via
DD-API-KEY + DD-APPLICATION-KEY, not Bearer. Distinct from Sentry
(errors) and PostHog (product analytics).

Follows the SSH-first template: SSH check -> ...
```

Do **not** amend a landed commit unless we ask. Prefer new commits + squash-on-merge; that keeps the reviewer's mental model of what changed intact.

**PR title and body:** the PR title should match your primary commit's subject. The body should have a **Summary** (2-5 bullets on what changed and why) and a **Test plan** (checkboxes for what you actually verified). Look at [#77](https://github.com/paarths-collab/hstack/pull/77) or [#76](https://github.com/paarths-collab/hstack/pull/76) for the shape.

**We squash-merge** — your PR becomes one commit on main, so PR title / body become that commit's message. Write them accordingly.

## Authoring a new skill — the SSH-first template, explained

Every skill lives at `skills/<name>/SKILL.md`. There is no other place. This section walks the template top to bottom and explains why each part exists.

### Frontmatter

```markdown
---
name: <exact-same-as-directory>
description: One long sentence covering (a) what it wires, (b) how the auth works, (c) that it's SSH-first and rollback-safe, (d) which AI coding agents it works from.
---
```

**Enforced.** [`scripts/validate-skills.sh`](scripts/validate-skills.sh) asserts:

- `name` in frontmatter matches directory name.
- `description` is a single line, ≥ 40 characters.
- The `---` closes within the first 20 lines.

The description is what the AI agent's slash-command picker shows the operator. Write it like a search result snippet: what does invoking this actually do?

### Title + one-paragraph intro

```markdown
# /<name> — <short human title> (SSH-first)

You are the engineer connecting <thing> to a self-hosted Hermes agent on the
user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. Every command in this
skill runs on the VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do —
<specific list of the one to three things>.
```

The intro sets the reader (an AI agent) into the right mental frame. Do not mistake it for marketing copy. Skip metaphors. Name the SSH boundary and name the human-only steps explicitly.

### "Honest auth picture" section

```markdown
**Honest picture (verified YYYY-MM):** <vendor> ships <what MCP or REST
they actually have>. Auth is <exact header pattern, verbatim from their
docs>. <Any known trap — wrong-region 403s, self-signed certs, session
window rules, quirks in their SDK vs their REST spec>.
```

**This is the section reviewers scrutinize hardest.** The "honest auth picture" is a promise that you read the vendor's docs recently and are willing to be corrected on record. Cite the vendor documentation URL you verified against. If the vendor changes their surface next month, the "verified YYYY-MM" tag tells us how stale the skill is.

### "Before you start — gather" table

```markdown
| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$VENDOR_KEY` | <format, prefix, any specific length or hex> | <exact click-path in vendor console> |
| `$CONSENT_FLAG` | Set to `1` to confirm <the specific dangerous behavior> | Consent gate |
```

Every variable the skill uses **must** appear here. Every dangerous capability the skill exercises **must** be gated by a `<CAPABILITY>_ACKNOWLEDGED=1` flag. Grep any existing integration skill for `ACKNOWLEDGED` to see the shape.

Immediately after the table, verify SSH:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

### Step 1 — verify Hermes is reachable

Copy this verbatim from any recent integration skill. It handles the host-vs-container check and the two Hermes install shapes (native binary + Docker).

### Step 2 — idempotency check

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^<PRIMARY_KEY>=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "<Vendor> is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

Every skill must exit cleanly on re-run. `FORCE=1` is the override for intentional rewire.

### Step 3 — HARD GATE

Two sub-parts, both required.

**3a. Consent flag(s) must be `1`.** Print a clear abort message that names what the flag protects. Example from `/integration-datadog`:

```bash
[ "${WRITES_ACKNOWLEDGED:-0}" = "1" ] || {
  echo "ABORT: WRITES_ACKNOWLEDGED=1 required. Monitor mutations page on-call. Set the Application key's scope narrowly if you don't want that."; exit 1;
}
```

**3b. Live vendor pre-flight.** Call the cheapest read-only endpoint the vendor has (validate, whoami, list-with-limit-1). Map response codes to actionable messages:

```bash
HTTP=$(curl -sS -o /tmp/preflight.json -w "%{http_code}" \
  -H "Authorization: Bearer $VENDOR_KEY" \
  "https://api.vendor.com/v1/whoami")
case "$HTTP" in
  200) echo "OK: credential valid." ;;
  401) echo "ABORT: 401 — key rejected. <where to regenerate>."; rm -f /tmp/preflight.json; exit 1 ;;
  403) echo "ABORT: 403 — <specific scope missing>."; rm -f /tmp/preflight.json; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/preflight.json; rm -f /tmp/preflight.json; exit 1 ;;
esac
rm -f /tmp/preflight.json
```

**Never write anything until 3a and 3b both pass.**

### Step 4 — DRY_RUN preview

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write <KEYS> to ~/.hermes/.env (length ${#VAR}, prefix ${VAR:0:4}...)
  2. chmod 600 ~/.hermes/.env
  3. <MCP registration or REST doc creation>
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify env loaded: env | grep -c '^<PREFIX>_' inside the gateway
  6. Smoke test: <exact endpoint + expected code>

Secrets are NEVER printed in plaintext.
EOF
```

**Only length and prefix (4 chars max) of secrets are shown. Ever.** The validator does not currently check this because printing `${VAR:0:20}` looks the same to grep as `${VAR:0:4}` — reviewers do this by eye. Please don't cut this corner.

### Step 5 — write the secrets

Canonical path is `hermes config set`:

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes config set VENDOR_KEY '$VENDOR_KEY'
  chmod 600 ~/.hermes/.env
"
```

Always followed by a length check that returns `1`, not the value:

```bash
for K in VENDOR_KEY; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$K=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $K not written. Rolling back."; rollback; exit 1; }
done
```

If the target Hermes build has no `config set`, provide a **safe sed fallback** using the `|` delimiter:

```bash
sed -i "s|^VENDOR_KEY=.*|VENDOR_KEY=$VENDOR_KEY|" ~/.hermes/.env
```

**Never** `echo "KEY=value" >> ~/.hermes/.env` — read [CLAUDE.md](CLAUDE.md#why-printf-n-s-n-and-not-echo-) for why.

### Step 6 — MCP register OR REST document

Two exclusive paths.

**Path A (preferred if a real MCP exists):**

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add <vendor-slug> \
    --command <npx|uvx> \
    --args '<pinned-package-from-VERSIONS.txt>' \
    --env 'VENDOR_KEY=\${VENDOR_KEY}'
"
```

Use `${VENDOR_KEY}` env-var **indirection**, never the literal value. Warm the runner cache once inside the same step (`docker exec ... npx --help >/dev/null 2>&1 || true`) to avoid a first-call timeout.

**Path B (when the vendor has REST but no MCP):**

```bash
ssh "$VPS_USER@$VPS_IP" "mkdir -p /opt/data && cat > /opt/data/<vendor>-rest.md" <<'DOC'
# <Vendor> REST surface (wired via Hermes generic HTTP tool)

**Base URL:** https://api.vendor.com/v1
**Auth:** <exact header>

## <Capability> — <what it does>
`<METHOD> /path`
...
DOC
```

The doc file is what makes the vendor's surface useful without an MCP wrapper.

### Step 7 — reload the gateway

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

**Never** `gateway restart`. Restart does not reliably re-read `.env`.

### Step 8 — verify env is loaded

```bash
LOADED=$(ssh "$VPS_USER@$VPS_IP" '
  AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
  if [ -n "$AGENT" ]; then
    docker exec "$AGENT" env | grep -c "^VENDOR_"
  else
    hermes gateway env 2>/dev/null | grep -c "^VENDOR_"
  fi
')
[ "$LOADED" = "N" ] || { echo "FAIL: expected N vars, saw $LOADED. Rolling back."; rollback; exit 1; }
```

Where `N` = the exact count of vars this skill writes. Off-by-one here is the most common failure I catch in review.

### Step 9 — live smoke test

The smoke test **runs from the VPS** so the token never leaves the box:

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $VENDOR_KEY" \
    "https://api.vendor.com/v1/whoami"
')
```

Choose an endpoint with **zero side effects**. `GET /me`, `GET /account`, `GET /whoami`. Never a POST that costs money. Never a DELETE. If the vendor has no cheap read-only endpoint, list with `?limit=1`.

### Rollback

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    for K in VENDOR_KEY; do
      hermes config unset \$K 2>/dev/null || sed -i \"/^\$K=/d\" ~/.hermes/.env
    done
    hermes mcp remove <vendor-slug> 2>/dev/null || true
    rm -f /opt/data/<vendor>-rest.md
    hermes gateway stop; sleep 2; hermes gateway run --daemon
  "
  echo "Rolled back. <Vendor> is no longer wired."
}
```

**Never delete user data in rollback.** `/integration-obsidian`'s rollback leaves the vault directory in place because the user's notes live there.

### Pitfalls table

Minimum 6 rows enforced by the validator. Typical shape:

```markdown
| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Bearer instead of <the actual header> | Vendor rejects Bearer, returns 401 | Use `<exact-header>` case-sensitive |
| 2 | Wrong region endpoint | 403 with a misleading error message | Read region from `<where>`; store `VENDOR_REGION` |
| 3 | ... |
```

Every row must be a **real trap you or someone hit**, not a theoretical one. If you're padding, delete the row.

### Definition of done

Minimum 6 checkboxes. Every one an assertion the skill validated during its run.

```markdown
- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] `WRITES_ACKNOWLEDGED=1` consent gate passed
- [ ] Live pre-flight returned 200
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Secret in `~/.hermes/.env`, `chmod 600`
- [ ] Gateway reloaded with `stop` + `run`
- [ ] Env verified: N `VENDOR_*` vars in gateway
- [ ] Live smoke test succeeded
- [ ] Rollback function defined and proven
```

## Authoring an integration skill — the extra bar

Everything above, plus:

- **Cite the vendor's official docs URL** for every auth claim you make.
- **Test against a real vendor account.** Sandbox accounts if the vendor provides them; the free tier otherwise. If the vendor requires a paid account with no free tier, coordinate with a maintainer to test using our test accounts.
- **Consent flags for every dangerous capability.** Cost gates (`OWNS_VOICE_ACKNOWLEDGED` for ElevenLabs cloning), scope gates (`ALLOW_WRITES` for Postgres superuser), reachability gates (`LONG_LIVED_ACKNOWLEDGED` for E2B > 15 min sessions). Pattern-match existing skills for the exact wording style.
- **Pin the MCP or SDK package version in `VERSIONS.txt`**, not inline in the SKILL.md. Reference the pin from the skill.
- **File a row in `reference/TROUBLESHOOTING.md`** for every failure mode you hit while authoring. That row is often more valuable than the skill itself.

## Authoring a platform skill — the extra bar

Platform skills wire an inbound messaging surface. Extra rules:

- **Allowlist required.** The skill refuses to start with an empty allowlist. An empty-allowlist "public bot" mode is a distinct, explicit consent flag; even then, print a red-flagged warning.
- **Webhook signature verification is not optional.** Slack signing secret, Discord public key, Meta WhatsApp `X-Hub-Signature-256`, Telegram token in the URL — whichever the platform uses. Skills that skip this get NAK'd in review.
- **Rate-limit posture.** Document the platform's inbound rate limits and Hermes' outbound rate posture. Point-of-failure section in the skill body.
- **First-message rules.** WhatsApp session windows, Signal linked-device pairing — document what the operator must do first, before the bot can send a free-text reply.

## Editing an existing skill

- Small changes (a pitfalls row, a wording fix, a version bump reference) — direct edit, single commit, ordinary PR. Note in the PR body which real deploy revealed the change.
- Structural changes (adding a step, changing the step order, changing which vendor endpoint the pre-flight hits) — file an issue first, propose the change, wait for a maintainer 👍 before opening the PR. Cross-skill consistency matters.
- Renaming the skill directory — never. If a vendor rebrands, add a new skill and mark the old one deprecated in its frontmatter description. Reason: many external installs symlink to the exact directory name.

## Contributing to TROUBLESHOOTING.md

The catalog lives at [`reference/TROUBLESHOOTING.md`](reference/TROUBLESHOOTING.md). Every row is:

```
| Symptom | Cause | Fix | Issue # (if any) |
```

Rules:

- **Symptom** is what the operator sees. Copy the actual error string if there is one.
- **Cause** is the root cause we identified. Not "something's wrong" — the actual mechanism.
- **Fix** is a copy-pasteable command or a link to the fixing skill.
- **Issue #** links either an hstack issue or a Hermes upstream issue that tracks the root cause.

Rows arrive out of order and get reorganized periodically by a maintainer. Don't worry about placement.

## Contributing to the blog

The blog under `blog/` is not a marketing surface — it's teaching material we point new operators at from README, and it's SEO-indexable long-tail search coverage for people hitting failures. Two post types:

- **Walkthroughs** — end-to-end setup on a specific host / for a specific outcome (see `blog/01-hermes-setup-guide.md`).
- **Deep dives** — one failure mode, one fix, the reproduction steps, and the rationale.

Blog posts include a `.schema.json` sibling with JSON-LD Article schema. If you're not comfortable authoring the schema, open a PR with just the markdown and a maintainer will add the schema.

## Review checklist

What a reviewer looks for, in the order they look for it:

1. **Frontmatter valid, name matches directory.** Fast to check; skips most drift PRs.
2. **`bash scripts/validate-skills.sh --changed` passes locally and in CI.** If you can't run it locally, our workflow will, but running it yourself saves round-trip time.
3. **Every bash block is well-formed** — no unquoted `$var` where word splitting hurts, no `rm -rf` without a trailing `--`, no eval on untrusted input.
4. **HARD GATE actually gates.** A reviewer's most common finding: pre-flight is there but returns success on the "wrong" 200. Rebuild your mental model of what "the wrong 200" looks like for the vendor you're wiring.
5. **DRY_RUN discloses only length + short prefix** of every secret variable.
6. **`chmod 600` present** after any `~/.hermes/.env` write.
7. **`gateway stop && gateway run`** — never `restart`.
8. **Rollback is a real inverse** — undoes exactly what the skill created, no more (leave user data), no less (don't leave the MCP registered).
9. **Pitfalls rows are real**, not theoretical. Reviewers may ask you to remove theoretical ones.
10. **Definition of done matches the skill body.** Every checkbox corresponds to an assertion Step made.
11. **`shellcheck --severity=warning` passes** on any standalone `.sh` file the PR adds. (Skill body blocks aren't linted by default — the intention is the block is read and executed by a human via an AI agent, not run standalone.)
12. **No secret string patterns** — validator's `assert_no_literal_secret_leaks` catches `sk_live_`, `AKIA`, `ghp_`, etc. Reviewer double-checks.
13. **Rebased on latest `main`.** We squash-merge, so a linear history isn't critical — but merges from stale branches often silently drop template changes.

Reviewers try to give first feedback within 3 business days. Complex PRs (installer changes, new template rules, new platform skills) may take longer.

## Governance

hstack is currently maintained by:

- **Paarth** — repo owner, final approver on installer + template changes.
- **Digital Crew Technology maintainers** — approvers on integration and platform skills.

Two-approver rule for anything touching:

- `install.sh` / `install.ps1`
- `.github/workflows/**`
- `SECURITY.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `LICENSE`
- `templates/**`

One-approver is fine for:

- A new `/integration-<vendor>` following the template.
- A new pitfalls row in an existing skill.
- A TROUBLESHOOTING.md addition.
- Blog posts.

We do **not** self-approve merges on the two-approver categories, ever. If you are a maintainer and you author a change in one of those, another maintainer merges.

### Decision-making

Small changes: reviewer's call.
Contested changes: open a Discussion, describe both sides, gather input for at least 72 hours before a decision.
Anything that affects the security posture (new consent flag, new HARD GATE variant, new secret storage location): must go through a Discussion first, no exceptions.

### Code of conduct

Be technical, be kind, be brief. Assume the reviewer / author is doing their best under time pressure. Disagreements about approach are normal and useful; personal jabs are not. If a maintainer flags a comment as out-of-line, edit it — no explanation required.

We do not have a formal CoC document because the whole community is small enough that this paragraph works. If the community grows to a point where we need a longer document, we'll adopt the Contributor Covenant unchanged rather than write our own.

---

**Thank you.** Every fix, every pitfall row, every "here's the auth quirk I hit yesterday" makes the next operator's deploy 15 minutes shorter. That compounds.
