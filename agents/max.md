# Max — Outbound Sales Force

Max is an open-source AI sales rep built by [Digital Crew Technology](https://www.digitalcrew.tech/en).
It handles prospecting, personalised email outreach, LinkedIn follow-ups, objection handling, and
meeting booking — 24/7, no hiring required. It exposes a full MCP server with 91 tools, so your
Hermes agent can call any Max action directly from chat.

> If hstack is saving you time, a ⭐ on [paarths-collab/hstack](https://github.com/paarths-collab/hstack) goes a long way — it helps others find it.

---

## Why Max

Most outbound sales work is repetitive and time-sensitive: writing personalised emails, following up at the right moment, handling objections, logging replies, booking meetings. Done manually, it eats hours. Done with a junior hire, it's inconsistent. Max handles the whole loop autonomously — and because it's wired into Hermes via MCP, you can drive it from any messaging platform you already use (Telegram, Slack, Mattermost, Discord).

**What this unlocks in practice:**

- **Delegate a campaign from chat** — "Max, start a 3-step email sequence for leads in the SaaS space" → Max creates it, enrols leads, and reports back.
- **Ask for a status update from anywhere** — "How did last week's outreach perform?" → Max pulls metrics and summarises them.
- **Let Hermes hand off to Max automatically** — Hermes can detect sales-related intent in conversation and route directly to Max tools without you having to switch context.
- **No separate dashboard tab** — everything Max can do is accessible as a natural-language command through your Hermes agent.

Max advances through five experience levels (Rookie → Autonomous) as it handles more campaigns, improving its personalisation and objection-handling over time.

---

## Quick facts

| | |
|---|---|
| **Dashboard & API tokens** | [max.digitalcrew.tech](https://max.digitalcrew.tech/) |
| **MCP endpoint** | `https://max-mcp.digitalcrew.tech/mcp` |
| **Auth** | `Authorization: Bearer <token>` |
| **Tools exposed** | 91 — campaigns, leads, sequences, outreach, analytics, reporting |
| **Pricing** | Open-source MIT (self-host free) · Hosted ~$20/meeting booked |

---

## What Max can do (tool categories)

| Category | What you can ask | Example tools |
|---|---|---|
| **Campaigns** | Create, update, pause, or archive outreach campaigns | `list_campaigns`, `create_campaign`, `update_campaign` |
| **Leads** | Add prospects, update status, check where a lead is in the funnel | `list_leads`, `add_lead`, `get_lead_status` |
| **Sequences** | Build multi-step email/LinkedIn sequences; enrol or pause leads | `list_sequences`, `enroll_lead`, `pause_sequence` |
| **Outreach** | Send emails, schedule follow-ups, log replies and objections | `send_email`, `schedule_followup`, `log_reply` |
| **Meetings** | Check booked meetings, cancel or reschedule | `list_meetings`, `book_meeting`, `cancel_meeting` |
| **Reporting** | Weekly performance summaries, campaign metrics, conversion rates | `get_weekly_report`, `get_campaign_metrics` |

---

## Getting your API token

1. Go to **[max.digitalcrew.tech](https://max.digitalcrew.tech/)** and sign in.
2. Navigate to **Settings → API Tokens**.
3. Create a new token — copy it immediately, it won't be shown again.
4. Keep it in your `.env`; never paste it in chat or commit it to git.

---

## Wire Max into your Hermes agent

Uses the `hermes-mcp-add` skill. Run `/hermes-mcp-add` and supply these three values when prompted:

```
URL:   https://max-mcp.digitalcrew.tech/mcp
Token: <your token from max.digitalcrew.tech → Settings → API Tokens>
Name:  max-mcp
```

What happens under the hood:

1. **Probe** — curl matrix confirms `Authorization: Bearer` is the correct auth shape.
2. **Register** — `hermes mcp add max-mcp --url ... --auth header` writes the config block with `${MCP_MAX_MCP_API_KEY}` placeholder.
3. **Inject token** — `sed` writes the real token into `/opt/data/.env` with `chmod 600`.
4. **Reload** — `hermes gateway stop` + `hermes gateway run` so the running process picks up the new env.
5. **Verify** — logs confirm `registered 91 tool(s)` for `max-mcp`.

Full procedure with footguns and copy-paste commands: [`skills/hermes-mcp-add/SKILL.md`](../skills/hermes-mcp-add/SKILL.md).

---

## Verify it's working

After wiring, send this from your connected chat platform:

```
using max-mcp, list my campaigns
```

An empty list (`{"data":[],"count":0}`) is a **pass** — every layer worked. A "Bearer token missing"
error means the token didn't land; re-run step 3 of `hermes-mcp-add`.

---

*Built by [Digital Crew Technology](https://www.digitalcrew.tech/en) · Integrated with hstack by Paarth*

*If this saved you time → ⭐ [star hstack](https://github.com/paarths-collab/hstack)*
