---
name: blueprint-saas-founder
description: Compose a safe, reviewable SaaS Founder agent blueprint from optional hstack capabilities, then hand it to the validated Hermes-only installer.
---

# SaaS Founder Blueprint

Turn a founder’s desired operating rhythm into a small, reviewable plan—not a
pile of credentials, shell snippets, or autonomous promises. The outcome is a
local `.hstack-blueprint.json` that can be checked by `/blueprint-install` and
then applied one specialist skill at a time.

This shortcut is deliberately a **composer**. It does not duplicate deployment,
platform, integration, credential, or cron logic from the specialist skills.
Hermes is the only installable runtime in blueprint schema v1. OpenClaw may run
hstack skills as an execution host for a Hermes target; it is not a compatible
target configuration. QM requests receive a portable intent export from the
Agent Builder until a dedicated QM adapter exists.

## Before you start

Gather one batch of answers before changing anything. Keep the choices small;
all integrations, channels, automations, memory, and backups are optional.

1. What operating outcome matters most: daily snapshot, weekly review, an
   incident-aware founder view, or a different cadence?
2. Is the target an existing Hermes agent or a new Hermes deployment? For a new
   deployment, confirm the user can complete the normal SSH/server flow.
3. Which delivery channel, if any, should receive the result: Telegram, Slack,
   Discord, or terminal only?
4. Which sources should be considered: Stripe, PostHog, Sentry, GitHub, Notion,
   Linear, HubSpot, Google Workspace, or another installed hstack integration?
5. Which optional behavior is desired: scheduled brief, periodic error/revenue
   check, weekly review, long-term memory, backups, time zone, and approval
   posture?

Never ask for or paste a token, password, webhook secret, database URL, or
OAuth client secret into the blueprint. The approved specialist skill will ask
for and validate credentials only when that capability is actually selected.

## Step 1 — Choose the runtime route

Confirm the distinction between target runtime and the agent that invokes this
skill:

| User choice | Supported route | What to do |
|---|---|---|
| Hermes target | Full v1 blueprint | Continue with this skill. |
| OpenClaw as host | Hermes target remains required | Continue, noting that OpenClaw invokes hstack skills against Hermes. |
| OpenClaw as target | Not supported by this blueprint | Do not coerce Hermes skills into OpenClaw configuration. Explain the boundary. |
| QM target | Intent export only | Use the Agent Builder’s QM export; do not run `/blueprint-install`. |

If the user chooses Hermes, state the deployment mode explicitly:

- `existing_agent` is the safe default and permits terminal-only, on-demand use.
- `deploy_if_missing` requires at least one delivery channel because the current
  `/hermes-deploy` flow establishes the first platform/home channel itself.

Do not run a platform skill for that first channel after `/hermes-deploy`.
Additional selected channels may be handled later by their respective skills.

## Step 2 — Recommend a minimal starting stack

Explain the recommendation before adding it. For a standard founder operating
view, recommend only these read-only sources:

| Source | Why it is suggested | Default access | Official capability |
|---|---|---|---|
| Stripe | Revenue, subscriptions, and failed-payment movement | `read_only` | `/integration-stripe` |
| PostHog | Activation, usage, and retention context | `read_only` | `/integration-posthog` |
| Sentry | Error and release health evidence | `read_only` | `/integration-sentry` |
| GitHub | Pull requests and deployment context | `read_only` | `/integration-github` |

Offer, but do not enable by default, Notion, Linear, HubSpot, Google Workspace,
Datadog, AWS, Calendly, long-term memory, and backups. If the user declines all
sources, the blueprint remains valid: it is simply a manual or scheduled Hermes
agent with no hstack integrations selected.

For any access that supports writing, keep `read_only` unless the user explains
the write use case and explicitly approves it. `safe_operations: automatic`
never relaxes approval for external messages or destructive actions.

## Step 3 — Resolve delivery and automation safely

Map the user’s delivery choice before composing the plan:

| Delivery choice | Blueprint value | Result |
|---|---|---|
| Telegram, Slack, or Discord | `mode: platforms` with selected channel IDs | The installer resolves the approved platform skills. |
| More than one channel | Multiple channel IDs | The first is owned by `/hermes-deploy` for a new deployment; extras are resolved later. |
| Terminal only | `mode: terminal`, empty `channels` | Remove every scheduled automation; this is on-demand only. |

The founder automations are optional and are all reviewable scheduled checks,
not incoming webhooks or instant alert guarantees:

| Automation | Cadence label | Evidence it benefits from |
|---|---|---|
| Morning briefing | Weekdays, chosen time | Stripe, PostHog, Sentry, GitHub |
| Revenue change check | Periodic polling | Stripe |
| Error scan | Periodic polling | Sentry, Datadog |
| Weekly founder review | Weekly | Stripe, PostHog, GitHub |

Only retain an automation the user selects. If no delivery channel remains,
remove all automation objects instead of asking `/hermes-cron` to create a task
with nowhere safe to deliver it.

## Step 4 — Compose the declarative blueprint

Create a JSON file in a location the user can review, for example
`founder-radar.hstack-blueprint.json`. Use the Agent Builder’s reviewed JSON
when available. Otherwise compose only the following allowlisted fields:

```json
{
  "schema_version": 1,
  "name": "founder-radar",
  "description": "A daily founder operating view.",
  "source_blueprints": ["saas-founder"],
  "runtime": {
    "agent": "hermes",
    "installation": "existing_agent"
  },
  "delivery": {
    "mode": "platforms",
    "channels": ["telegram"]
  },
  "integrations": [],
  "automations": [],
  "behaviors": {
    "long_term_memory": false,
    "automatic_backups": false
  },
  "policies": {
    "external_messages": "approval_required",
    "destructive_actions": "approval_required",
    "safe_operations": "approval_required"
  },
  "credential_requirements": [],
  "resolved_skills": []
}
```

Fill the selected integrations with their exact allowlisted IDs, official skill
names, and selected access mode. Fill credential requirements with a **label and
recommended scope only**, never a credential value. Derive `resolved_skills` in
the deterministic order runtime → extra channels → integrations → home → backup
→ cron. For a new deployment, `/hermes-deploy` owns the first selected channel.

Prefer the bundled sample at `blueprints/saas-founder.hstack-blueprint.json` as
a shape reference. It is a reviewable sample, not an instruction to enable all
of its services for every founder.

## Step 5 — Validate and review before any configuration

From the hstack repository, validate the exact file the user will hand off:

```bash
py skills/blueprint-install/scripts/validate_blueprint.py founder-radar.hstack-blueprint.json --summary
```

If the validator reports any error, stop. Correct the declarative plan and
rerun it. Do not bypass it by manually calling a skill from a hand-edited
`resolved_skills` list.

Present this review in plain language:

1. target runtime and whether deployment is new or existing;
2. selected channels and which one becomes the Hermes home channel;
3. each selected integration and requested access;
4. credentials that will be requested later by specialist skills, without
   asking the user to disclose them now;
5. scheduled checks, cadence, and delivery channel;
6. resolved hstack skills in their exact serial order; and
7. the fixed approval policy for external and destructive actions.

Wait for approval to apply the reviewed plan. If the user only asked to design
or export it, stop after validation and provide the path.

## Step 6 — Hand off to the single installer

After the user approves, invoke the one installer skill with the reviewed path:

```text
/blueprint-install --plan founder-radar.hstack-blueprint.json
```

The installer must revalidate the file, re-derive the approved skill list, show
the plan again, and run selected specialist skills **in series**. It owns the
credential handoff and does not accept executable commands, URLs, or arbitrary
skill names from the blueprint.

Keep a concise execution record: exact plan path, selected services, completed
specialist skills, home channel, any created cron IDs, and the first failed
owner if the run stops. Do not claim completion merely because the plan was
exported.

---

## Rollback

This shortcut has nothing to roll back before the installer begins: it produces
only a local declarative JSON file. Deleting a local exported plan is optional
and does not affect Hermes.

After handoff, rollback belongs to the specialist skill that created the state:

| Failure point | Rollback owner | Safe response |
|---|---|---|
| Hermes deployment | `/hermes-deploy` | Let its own rollback finish; do not rerun primary platform setup. |
| Additional platform | Corresponding `/platform-*` skill | Preserve existing channels and repair only the failed one. |
| Integration | Corresponding `/integration-*` skill | Allow its scoped rollback, then stop the sequence. |
| Home channel | `/hermes-home` | Restore only the prior home setting if this run changed it. |
| Scheduled check | `/hermes-cron` | Remove only the task ID created during this run after review. |
| Backup | `/hermes-backup` | Remove only the partial archive; never delete `~/.hermes`. |

If ownership is unclear, stop and use `/hermes-status` or `/hermes-fix`. Never
delete an entire Hermes configuration based only on the blueprint’s selections.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---|---|---|
| 1 | Treating the shortcut as a second installer | It can drift from the hardened specialist flows | Validate and hand off only to `/blueprint-install`. |
| 2 | Sending a token in the plan | Plans are meant to be copied and downloaded | Keep credentials in protected specialist-skill prompts only. |
| 3 | Selecting OpenClaw as a Hermes replacement | Its config and permissions are not Hermes-compatible | Treat it only as an optional execution host. |
| 4 | Remapping Hermes integrations to QM | QM has its own deployment, scope, policy, and connector model | Export intent only until a QM adapter exists. |
| 5 | Enabling everything by default | It makes review, scope, and failure recovery worse | Start with the minimum read-only stack and make every source optional. |
| 6 | Calling periodic polling an instant alert | No webhook/event wiring is created by this blueprint | Label revenue and error checks accurately. |
| 7 | Scheduling terminal-only output | Hermes has no home channel to deliver the result | Remove automations with all channels deselected. |
| 8 | Re-running a primary platform after deploy | `/hermes-deploy` already owns the first one | Let deployment finish, then configure only additional channels. |
| 9 | Running selected integrations in parallel | Shared config and gateway reloads can collide | Run specialist skills serially in the installer. |
| 10 | Interpreting approval policy as runtime enforcement | The target may have extra native controls | Preserve hstack safeguards and review native policy settings too. |

---

## Definition of done

- [ ] The user’s outcome and cadence were captured in a short, human-readable description.
- [ ] Hermes was confirmed as the target runtime, or the user received a clear QM intent-export boundary.
- [ ] Every selected channel, integration, automation, memory, and backup option is intentional and optional.
- [ ] All integration access modes are read-only unless an explicit approved write case exists.
- [ ] Terminal-only plans contain no automation entries.
- [ ] The plan contains no credential values, URLs, commands, or unapproved skill names.
- [ ] The exact JSON file passes `validate_blueprint.py` before any configuration begins.
- [ ] The user reviewed target, credentials-to-prepare, schedule, resolved skills, and approval policy.
- [ ] `/blueprint-install` is the only handoff for an approved Hermes plan.
- [ ] The final record identifies any created state and the owning rollback path.

Keep the reviewed JSON alongside the task record when the user wants an
auditable design artifact. It remains safe to share internally because it holds
only identifiers, requested access, and policy—not secret values.

Never treat that shareability as permission to publish a plan outside the scope
the user approved.
