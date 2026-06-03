# Max — Outbound Sales Force

Max is an open-source, self-hosted AI sales rep built by [Digital Crew Technology](https://www.digitalcrew.tech/en).
It handles prospecting, personalised email outreach, LinkedIn follow-ups, objection handling, and
meeting booking — 24/7, no hiring required. It exposes a full MCP server with 91 tools, so your
Hermes agent can call any Max action directly from chat.

---

## Quick facts

| | |
|---|---|
| **Dashboard & API tokens** | [max.digitalcrew.tech](https://max.digitalcrew.tech/) |
| **MCP endpoint** | `https://max-mcp.digitalcrew.tech/mcp` |
| **Auth** | `Authorization: Bearer <token>` |
| **Tools exposed** | 91 — campaigns, leads, sequences, outreach, analytics, reporting |
| **Pricing** | Open-source MIT (self-host free) · Hosted ~$20/meeting booked |
| **Self-host install** | ~2 min via `git clone` + `npm install` + `.env` + `npm run dev` |

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

## What Max can do (tool categories)

| Category | Example tools |
|---|---|
| Campaigns | `list_campaigns`, `get_campaign`, `create_campaign`, `update_campaign` |
| Leads | `list_leads`, `add_lead`, `update_lead`, `get_lead_status` |
| Sequences | `list_sequences`, `enroll_lead`, `pause_sequence` |
| Outreach | `send_email`, `schedule_followup`, `log_reply` |
| Meetings | `list_meetings`, `book_meeting`, `cancel_meeting` |
| Reporting | `get_weekly_report`, `get_campaign_metrics` |

Full list of all 91 tools appears in your Hermes logs after registration:
```bash
docker exec -u hermes <agent-container> hermes logs 2>&1 \
  | grep "registered.*tool" | tail -3
```

---

## Self-hosting Max (optional)

If you want Max on your own infrastructure instead of the hosted platform:

```bash
git clone https://github.com/digital-crew/max   # check exact repo at max.digitalcrew.tech
cd max
npm install
cp .env.example .env
# Fill in .env: AI provider key (OpenRouter/Claude/GPT), email credentials, CRM config
npm run dev   # runs on localhost:3006
```

Point the MCP URL to your own instance instead of `max-mcp.digitalcrew.tech`.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `404` on `/mcp/<token>` | Token-in-path is not the right auth form for this server | Use `Authorization: Bearer` header instead |
| `initialize` succeeds but tool calls fail with "Bearer token missing" | Auth is only enforced on `tools/call`, not `initialize` | Confirm token is set: `docker exec <agent> sh -c 'grep MCP_MAX /opt/data/.env'` |
| Token set but gateway still uses old value | Gateway read `.env` at start and still has the old value in memory | `hermes gateway stop` + `hermes gateway run` (not `restart`) |
| `Permission denied` writing `.env` | Container user mismatch | Run the `sed` command without `-u hermes`: `docker exec <agent> sh -c 'sed -i ...'` |

See [`reference/TROUBLESHOOTING.md`](../reference/TROUBLESHOOTING.md) for gateway and platform failures.
