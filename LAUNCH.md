# hstack launch plan — v2 (reviewed, auto-decided, then stress-tested)

Status: APPROVED-PENDING-STEP-0 · updated 2026-07-28 (VPS/pricing specifics stripped from README + launch copy)
Design doc: `~/.gstack/projects/paarths-collab-hstack/2026-07-27-paarth-hook-repositioning-design-launch-plan-v2.md`
v1 was reviewed via /autoplan (2026-07-14); v2 adds the four fixes from /office-hours (2026-07-27).

---

## The premise (live data, not vibes)

- Product quality: ~8/10. Skills are hardened (HARD GATE, restricted-keys-only,
  rollback, chmod 600, SECURITY.md, TROUBLESHOOTING.md).
- Discovery: ~0/10. GitHub 14d: **4 unique human views**. 13 stars. Clone count
  (1,366) is self-inflated bot traffic.
- Conclusion: **the bottleneck is positioning + distribution, not features.**

## The hook (verified, survived adversarial review)

> **I never open a chat with my AI. Every morning, it opens one with me.**
> hstack is a catalog of skill files — recipes your AI coding agent (Claude
> Code, Cursor, Codex, etc.) reads and executes to set up self-hosted Hermes
> for you. This particular result used two of them: /hermes-home wired a chat
> channel; /hermes-cron scheduled a morning briefing. Your IDE does the Docker
> work, you just say what you want. Hermes ends up running on your own server,
> messaging you first.

Anchors (verbatim on disk):
- `skills/hermes-home/SKILL.md:14` — "Without it, cron fires into the void."
- `skills/hermes-cron/SKILL.md:158-164` — self-care crons
- `blog/deploy-ai-agent-one-command-hstack.md:72` — "If hstack vanished tomorrow, your agent would keep running exactly as it is."
- `skills/integration-stripe/SKILL.md:99-100` — hard-aborts on `sk_` keys (HN angle)

## The demo (two clips, 25 seconds)

- **Clip A (~15s):** real phone, real morning, real timestamp. Empty lock
  screen → *ding* → notification → tap → agent's morning message. No cuts,
  no music. Film 3 mornings, pick the most natural. Emotional hook.
- **Clip B (~10s):** Claude Code open. You type `/integration-` slowly.
  Autocomplete menu explodes with 72 options. You pick `/integration-notion`,
  hardened install flow starts. Depth proof — one keystroke reveals the catalog.

Edited together: ~25s. Both clips must be unfakeable.

## Do-not-cross lines (binding)

- Never "no daemon / no server" — the Hermes gateway IS a daemon. Say "no
  hstack server in the middle; the installer isn't in the data path."
- Never "free" — model API is bring-your-own-key; real ongoing cost is not zero. Don't quote a specific number in public copy.
- Say "chat channel," never "phone number / SMS."

---

## Execution order

### Step 0 (NEW) — The 5-person pre-launch check (~2 hours)
Message 5 specific real humans (not categories):
- 1-2 running their own server (cloud host or home lab)
- 1-2 building with Claude Code / Cursor / Codex who post publicly
- 1 recent r/selfhosted poster
- Bonus: 1 Digital Crew engineer not already in on hstack

Send each exactly:
```
Hey — quick check, no meeting, no pitch.

"I never open a chat with my AI. Every morning, it opens one with me."

[25-second video]

Would you install this on your server tomorrow? Yes or no is fine.
```

**Scoring:**
- 3+ yes → hook validated. Ask those 3 to upvote at HN post t+0. Proceed.
- 0-2 yes → hook not landing. Ask what would make them yes. Rewrite. Try 5
  new people. Do NOT proceed to Step 4 until validated.

### Step 1 — Fix the repo (branch: feat/hook-repositioning) — ~1 session
1. README hero → the hook. Catalog table moves below the fold; counts become
   proof, not pitch.
2. **NEW — "How you actually use it"** section immediately after the hook.
   Show the per-connector `/command` pattern:
   ```
   /hermes-deploy        ← full agent, one command
   /integration-notion   ← wire Notion
   /integration-stripe   ← wire Stripe (refuses live keys)
   /platform-telegram    ← wire the Telegram bot
   ...and 90 more
   ```
   Plus one screenshot of the Claude Code `/integration-` autocomplete menu.
3. **Reconcile counts** — the truth is **94 skills = 15 hermes + 8 platform + 71 integration**
   (SKILL.md file count). README badges (94/71/8) are correct. Fix the stragglers:
   - CLAUDE.md line 18 says 73/68/5 → change to 15/8/71 = 94
   - docs/image-content-brief.md lines 4, 24, 67, 102, 141 → 68/73/5 all stale
   - CHANGELOG.md — historical refs (line 29 etc) are accurate at time-of-writing,
     leave alone; only fix present-tense refs if any drift
   - CI guard `.github/workflows/count-check.yml` already exists and passes; extend
     scope to also grep `docs/image-content-brief.md` so it can't drift again
4. **Fix `skills/integration-launchdarkly/`** — empty dir (no SKILL.md), created
   2026-07-01 and never finished. Either (a) complete the skill and bump to 72
   integrations + update all counts, or (b) `rm -rf` the empty dir. Pre-launch
   decision required — a dead dir in a public catalog is a red flag on inspection.
5. Metrics bot → orphan branch (last 12+ main commits are bot noise; repo
   looks dead).
6. Apache 2.0 sweep: LICENSE, NOTICE, README badge already staged. Remaining
   files reviewed — assets/banner-blueprint.svg already says Apache 2.0,
   blog/01-hermes-setup-guide.md MIT refs describe upstream Hermes Agent (Nous
   Research) and are correct-as-written. No further edits needed here.
7. Publish GitHub Release v1.0.0 from CHANGELOG.

### Step 2 — Repo metadata (2 minutes, `gh api`)
- Description: `Self-hosted AI agent in one command. Deploy Hermes on your
  own server and wire it into 70+ services from Claude Code, Codex, Cursor,
  Gemini, or Hermes itself. SSH-first, rollback-safe, your keys.`
- Topics: `ai-agent, self-hosted, selfhosted, hermes, claude-code, mcp, llm,
  ai-agents, telegram-bot, automation, devops, cli, codex, cursor, ai-employee`

### Step 3 — The proof asset (blocker: a real end-to-end deploy on your own server)
Film Clip A + Clip B per rules in "The demo" above. Export as one 25s
GIF/webm at top of README. Without this, the hook is unverifiable; with it,
the README is the reel.

### Step 4 — Launch (one platform per day; never all at once)

**Day 1: Show HN**
- Title: `Show HN: A self-hosted AI agent that refuses your Stripe secret key`
- First comment (post immediately after): 1 paragraph, honest — why built,
  what the installer won't do, link to `skills/integration-stripe/SKILL.md:99-100`.
- Reply to every comment within 30 minutes.
- Step-0 friends upvote at t+0.
- **Account warning:** if HN account is <1yr and low karma, borrow a friend's.
  Fresh accounts routinely die on Show HN.

**Day 2: r/selfhosted — RE-ANGLED**
- Old title ("rm -rf the installer") is dev-tool humor; wrong community.
- New title: `I built a self-hosted AI agent that DMs me on Telegram every
  morning — here's how`
- Structure: morning notification screenshot → what it does (3 bullets) →
  what it runs on (any server you already have; keep exact pricing and
  provider names OUT of the post copy — commenters will ask, answer honestly
  in replies) → install command → GitHub link → `/integration-` autocomplete
  screenshot.
- Close: "Happy to answer setup questions." Nothing salesy.

**Day 3: X (Twitter)**
- Post = hook line + 25s video. No tags, no ask.
- Quote-repost at t+6h if traction is slow, with one specific detail.

**All 3 days:** reply to every comment within 30 minutes. Comments carry
the launch, not the post.

---

## Decision audit trail

| # | Decision | Call | Principle |
|---|----------|------|-----------|
| 1 | Build more skills vs fix positioning | Positioning | Bias to action on the real bottleneck |
| 2 | Lead hook | "It opens the chat with me" | Only claim that inverts universal behavior |
| 3 | Counts | 95 everywhere + CI guard | One number, machine-enforced |
| 4 | Metrics bot commits | Orphan branch | Repo must not look bot-run |
| 5 | Launch sequencing | Repo fix → proof asset → posts | Never drive traffic to an unfinished landing pad |
| 6 | Platform order | HN → Reddit → X | Match angle to audience |
| 7 | Buying stars / astroturf | Never | ToS violation; audiences detect it |
| 8 | **v2:** Insert 5-person check as Step 0 | Yes | De-risks the whole launch; also produces first-hour HN upvoters |
| 9 | **v2:** Add `/integration-<name>` teaching + autocomplete demo | Yes | Discoverability leak + visible-depth asset |
| 10 | **v2:** Re-angle r/selfhosted post | Yes | Old "rm -rf" line is dev-tool humor, wrong register |
| 11 | **v2:** HN-account-age warning | Yes | Fresh accounts routinely die on Show HN |
| 12 | **v2:** Bulletproof-video rules (3 mornings, no cuts) | Yes | Only unfakeable demos survive skeptical threads |
| 13 | **v2:** Add OpenClaw / other agent-runtime skills before launch | No — defer to v1.1 | Hook is a moment, not a category; portability is proven by v1.1 shipping in 3 weeks, not by v1.0 tagline; scope expansion delays launch by months for zero discovery-signal gain |
| 14 | **v2:** Digital Crew website URLs in README | Remove (per user) | Founder call; text credit preserved, promo URL stripped from both hero and footer |
| 15 | **v2:** Max (Digital Crew sales agent) | Remove entirely from repo | Founder call ("remove max for now"); deleted agents/max.md + agents/ dir + 1 blog bullet + 1 CHANGELOG line + do-not-cross rule. Reversible via git. |

## Deferred (explicitly NOT now)

- New integrations/skills — after launch
- Website / dashboard / blog-site — separate repo concern
- Cleaning ~18k untracked local files — hygiene, not launch-critical
- Scratch files at repo root (agent-plan.js, app.js, index.html,
  tweaks-*.jsx, v1-clean.html, frontend/, blog-site/, screenshots/,
  docs/warden-specs/) — separate cleanup pass

## Assignment

**Do this first, before anything else:** Step 0 (the 5-person check). Everything
in Steps 1-4 is conditional on the hook landing.

If Step 0 confirms (3+ yes), the next concrete action is Step 1.3 (count
reconciliation), because the CI guard depends on it and the README rewrite
depends on the guard.

Handed off to `/spec` for the concrete task backlog.
