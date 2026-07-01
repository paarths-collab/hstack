# Banner image content brief — FIG.01 / PREMISE and FIG.02–04

This is the copy-and-numbers spec for updating the two engineering-blueprint banner images
after the 68-integration / 6-IDE expansion. Aesthetic stays the same (electric-blue on
off-white grid, mono type, blueprint dimensions and callouts). Only the *content* changes.

## FIG.01 / PREMISE — "empty server → live AI agent"

**Purpose of this image:** the before/after promise. What you get from running one command.

### Left panel — "BEFORE"
Keep the empty-server illustration. Update the label stack to:

- `$ ssh root@your-vps`
- `# hermes: not installed`
- `# skills:  0`
- `# platforms: 0`

### Right panel — "AFTER"
Keep the live-agent illustration. Update the label stack to:

- `$ hermes gateway status`
- `# hermes v0.15.2 — running`
- `# skills:  73  (16 hermes-* / 5 platform-* / 68 integration-*)`
- `# platforms: 8  (telegram, discord, whatsapp, slack, mattermost, teams, matrix, signal)`
- `# IDE targets: 6  (claude code, codex, cursor, gemini cli, openclaw, hermes)`

### Bottom caption strip
Replace whatever the current subtitle says with:

> FIG.01 · PREMISE — one command wires 73 skills into every AI coding agent on the box.
> Self-hosted Hermes v0.15.2. No SaaS in the hot path.

### Numbers to *remove*
Anywhere the old banner says "19 commands" or "4+ chat platforms" or "Claude Code only" —
delete. Those numbers are stale.

---

## FIG.02 / SEQUENCE — "How hstack works"

**Purpose of this image:** the three-step mechanism. Keep the numbered-step layout;
update the copy on each step.

### Step 01 — DISCOVER
- Header: `01 · DISCOVER`
- Body: `curl … | bash` detects which of the 6 AI-coding agents are installed
  (`~/.claude`, `~/.agents`, `~/.cursor`, `~/.hermes`, `~/.gemini`, `~/.openclaw`).
- Callout: `--pick` for interactive tier selection, `--all` for everything.

### Step 02 — WIRE
- Header: `02 · WIRE`
- Body: symlink or format-convert `skills/<name>/SKILL.md` into each detected agent's
  skill dir. Cursor gets `.mdc`, Gemini gets `.md` context files, others get `SKILL.md`
  verbatim.
- Callout: idempotent — re-run any time. Every skill has a `Definition of done` checklist.

### Step 03 — RUN
- Header: `03 · RUN`
- Body: skill hits Hermes over SSH, does the SSH-first hardening (verify Hermes,
  HARD GATE on credential format + live vendor pre-flight, DRY_RUN preview, chmod 600,
  `gateway stop && gateway run`, live smoke test, rollback function).
- Callout: secrets stay in `~/.hermes/.env` on the VPS. Never in chat. Never in git.

### Bottom caption strip
> FIG.02 · SEQUENCE — discover → wire → run.
> Same procedure across all 6 agents. Same procedure across all 68 integrations.

---

## FIG.03 / COMMAND LIBRARY

**Purpose of this image:** the "there's a skill for this" chart. Grid of tier boxes.

### Grid content — 20 tiers, each with a one-line count

| Tier              | Count | Examples                                    |
|-------------------|-------|---------------------------------------------|
| CORE              | 16    | deploy · install · model · memory · skills · mcp-add · status · restart · update · fix · backup · cron · home · soul · integrate · warden |
| PLATFORMS         | 8     | telegram · discord · whatsapp · slack · mattermost · teams · matrix · signal |
| MEMORY            | 2     | mem0 · supermemory                          |
| DATABASE          | 4     | supabase · postgres · neon · redis          |
| VECTOR            | 2     | pinecone · qdrant                           |
| AUTH              | 2     | auth0 · clerk                               |
| OBSERVABILITY     | 2     | posthog · sentry                            |
| RAG               | 1     | firecrawl                                   |
| CODE SANDBOX      | 1     | e2b                                         |
| AI TOOLS          | 3     | openai-tools · elevenlabs · replicate       |
| STORAGE           | 2     | r2 · s3-compatible                          |
| CRM               | 4     | hubspot · salesforce · pipedrive · zoho     |
| DOCS              | 4     | notion · confluence · google-workspace · microsoft-365 |
| DEV               | 3     | github · gitlab · bitbucket                 |
| PM                | 6     | linear · asana · clickup · jira · monday · trello |
| CLOUD             | 8     | aws · gcp · azure · cloudflare · digitalocean · hetzner · netlify · render |
| PAYMENTS          | 3     | stripe · paypal · razorpay                  |
| COMMERCE          | 2     | shopify · woocommerce                       |
| EMAIL             | 4     | sendgrid · mailchimp · postmark · brevo     |
| SUPPORT           | 4     | intercom · zendesk · freshdesk · sendbird   |
| FORMS             | 3     | typeform · calendly · airtable              |
| SEARCH            | 2     | brave-search · exa                          |

**Total to feature prominently:** `73 SKILLS · 68 INTEGRATIONS · 20 TIERS`

### Bottom caption strip
> FIG.03 · COMMAND LIBRARY — pick a tier at install time, or `--pick` and grab the ones you need.

---

## FIG.04 / RELIABILITY

**Purpose of this image:** honest framing of what hstack does *not* fix.

### Copy for the three-row table

| Failure mode | Where hstack helps | Where it doesn't |
|---|---|---|
| Gateway OOM ([#25315](https://github.com/lorenzejay/hermes-agent/issues/25315)) | `/hermes-status`, `/hermes-restart`, backup routine | Runtime memory leak lives in Hermes itself |
| 429 crash cascade ([#16677](https://github.com/lorenzejay/hermes-agent/issues/16677)) | `/hermes-model` fallback routing, exponential backoff notes | Upstream vendor rate limits are theirs |
| Stale PID after crash ([#13655](https://github.com/lorenzejay/hermes-agent/issues/13655)) | `/hermes-fix` clears stale locks, `/hermes-restart` graceful | Root cause is Hermes signal handling |
| No native backup ([#12238](https://github.com/lorenzejay/hermes-agent/issues/12238)) | `/hermes-backup` cron + off-host copy | Restore-in-place still manual |

### Bottom caption strip
> FIG.04 · RELIABILITY — hstack gives you the operational playbook, not a runtime rewrite.
> Hermes v0.15.2 pinned. Every skill has a rollback function.

---

## Style constants (do not change)

- Palette: electric blue (#0A5CFF or brand equivalent) on off-white blueprint grid.
- Type: monospace throughout for numbers and labels; single sans header at top.
- Corner marks: `FIG.0N` top-left, page number top-right, caption strip bottom.
- All numbers left-aligned, right-padded to column width.
- No emoji, no gradients, no shadow.

## Old numbers to purge everywhere

- ❌ `19 commands` → ✅ `73 skills`
- ❌ `4+ chat platforms` → ✅ `8 messaging platforms`
- ❌ `Claude Code` (singular) → ✅ `6 AI coding agents`
- ❌ any mention of "50 integrations" → ✅ `68 integrations`
