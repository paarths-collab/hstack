---
name: hermes-integrate
description: Wire one or many integrations into a running Hermes agent. Presents the full catalog by category, collects one API key per chosen integration, and runs each /integration-<name> skill in sequence. Use when the user wants to connect several apps at once rather than one at a time.
---

# /hermes-integrate — connect apps to Hermes with just an API key

You are the engineer connecting the user's apps to their Hermes agent. Each integration has its
own skill (`/integration-<name>`) that knows the exact endpoint, auth shape, and wiring steps.
Your job here: present the full catalog, let the user pick, then run each skill in sequence.

Do everything autonomously; stop only for the tokens themselves — a machine cannot mint them.

## Before you start — gather (ask once)

1. **Deployment target** — is this the hstack Docker box or a local / SSH Hermes install?
   ```bash
   docker ps --format '{{.Names}}' | grep -i hermes || echo "no hermes container — assume local"
   ```
2. **Which integrations** — show the catalog below and ask the user to pick by name or category.
   Nobody connects all 50; most people pick 3–5.

## Step 1 — present the catalog by category

Show the user the table below and ask which services they want to connect. One row per category
keeps it scannable; they can say "all CRM" or just "notion, github, stripe".

| Category | Available integrations |
|----------|----------------------|
| CRM | hubspot · salesforce · pipedrive · zoho-crm |
| Docs & Notes | notion · google-workspace · microsoft-365 |
| Dev | github · gitlab · bitbucket |
| Project mgmt | jira · linear · asana · clickup · monday · trello · airtable |
| Cloud infra | aws · gcp · azure · digitalocean · hetzner · cloudflare · vercel · netlify · railway · render |
| Payments | stripe · paypal · razorpay |
| Commerce | shopify · woocommerce · webflow · wordpress |
| Email & marketing | mailchimp · brevo · sendgrid · postmark |
| Comms & support | twilio · sendbird · intercom · zendesk · freshdesk |
| Forms & scheduling | typeform · tally · calendly · zoom |
| Search & AI | brave-search · tavily · exa |

## Step 2 — run each integration skill

For each integration the user chose, invoke its skill (`/integration-<name>`). Each skill will:
1. Tell you exactly what token it needs and where to mint one.
2. Write the secret to `/opt/data/.env` (container) or `~/.hermes/.env` (local) via `hermes config set`.
3. Register the MCP server and reload the gateway with `gateway stop` + `gateway run`.
4. Verify registration in `hermes logs`.

Run skills in series (one integration at a time) so gateway reloads do not interleave:

```bash
# Example — you would invoke the actual skill, not this shell loop
# for name in notion github stripe; do
#   run /integration-$name
# done
```

## Step 3 — final end-to-end smoke test

After all chosen skills complete, send one message per integration that exercises a real tool:

```
"Using Notion, list my shared pages."
"Using GitHub, list my repos."
```

An empty-but-valid result (no error, no 401) is a pass.

Check logs once at the end:

```bash
# container
docker exec -u hermes hstack-hermes hermes logs 2>&1 | grep -iE "registered.*tool|MCP server" | tail -30
# local
hermes logs 2>&1 | grep -iE "registered.*tool|MCP server" | tail -30
```

## Pitfalls

- **Run skills in series** — each skill does a `gateway stop` + `gateway run`. Running two in
  parallel means one's stop races the other's run and leaves the gateway in an undefined state.
- **Two `.env` files** — secrets go in the Hermes runtime `.env` (`/opt/data/.env` in the
  container, `~/.hermes/.env` locally). The compose-level `.env` is for Docker variables only.
- **Token scope** — each skill documents the required scopes. A 401 in logs = wrong token or
  missing scope, not wrong wiring.
- **OAuth-flagged services** — google-workspace, microsoft-365, salesforce, gcp, azure require
  creating an app/service account first (the skill walks you through it). They are not blocked
  by a single-key gate; they just have one extra setup step.

## Verify

For every integration the user chose:
- `hermes logs` shows `registered N tool(s)` for that service.
- A live tool call from the chat interface returns a result (even an empty list is a pass).

## Definition of done

- [ ] The user confirmed which integrations they want; no extra integrations were wired.
- [ ] Each chosen integration's `/integration-<name>` skill ran to completion.
- [ ] Every token was written to the runtime `.env` via `hermes config set`; none pasted into chat or written to `config.yaml`.
- [ ] All chosen integrations show `registered N tool(s)` in `hermes logs`.
- [ ] At least one wired integration returned a real (or empty-but-valid) result from a live tool call.

See `reference/TROUBLESHOOTING.md` for gateway and MCP failure modes.
