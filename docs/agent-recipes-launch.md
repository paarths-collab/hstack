# Agent Recipes — Product Hunt launch kit

This launch kit describes the product as it exists today:

```text
Agent Recipes Composer = simple, nontechnical recipe builder
hstack official skills = reviewed Hermes setup and operation engine
```

The Composer is a planner, not a hosted agent runtime, secret manager, or
browser-based deployer. It builds a secret-free plan; the existing official
hstack skills validate and apply that plan on infrastructure the customer owns.

## Positioning

**Product name**

Agent Recipes

**Tagline**

Turn the tools you use into a safe, reviewable AI agent plan.

**One-paragraph description**

Agent Recipes helps a curious, nontechnical person start with one useful AI
agent outcome instead of a blank configuration screen. Choose optional sources
such as GitHub, Stripe, PostHog, Sentry, Notion, or Linear; choose where a
Founder Brief should arrive; then review and download a secret-free, read-only
Hermes plan. The customer keeps their own infrastructure and credentials; the
official hstack skills handle live setup, verification, and scoped rollback.

## What we can substantiate

- A working Founder Brief Composer with optional individual integrations.
- Six optional read-only sources: GitHub, Stripe, PostHog, Sentry, Notion, and
  Linear.
- Three optional, approval-gated delivery destinations: Telegram, Slack, and
  Discord.
- A recipe compiler that allows a safe preview with no connector, but requires
  one source and one delivery destination before it emits a deployment plan.
- Generated plans are secret-free and pass hstack's existing Hermes blueprint
  validator before any setup can begin.
- Seven additional recipe concepts are visible as `Labs`, not live products.
- The underlying hstack catalog retains 97 checked official skills and its
  declared Hermes 0.15.2 compatibility contract.

## What we must not claim

- That every recipe is deployed, customer-tested, or proven.
- That Agent Recipes hosts, operates, or stores a customer's agent or secrets.
- That a browser click deploys an agent, creates OAuth connections, or works
  with every runtime.
- That OpenClaw or QM are full deployment targets today; Hermes is the first
  supported recipe target.
- That a generated plan proves a selected third-party service is live. Each
  official specialist skill performs its own live verification.

## Maker comment

Most agent builders start with a blank chat box or a page full of credentials.
I wanted the first experience to be simpler: pick what matters, see exactly
what will be read, choose where the result goes, and keep the whole plan
reviewable.

The first Recipe is Founder Brief. Every individual source and destination is
optional. You can safely explore with no connection at all. A live plan only
unlocks once it has the two capabilities it needs: at least one source of
information and one place to deliver the result.

Agent Recipes never asks for an API key, password, or SSH key in the browser.
It creates a secret-free plan for the customer-owned Hermes environment, and
the underlying official hstack skills perform validation, live setup, and
scoped rollback. The other recipes are deliberately labelled Labs until they
earn stronger evidence.

I would love feedback on the first workflow you would trust with read-only
access to your own tools.

## Demo plan

Use the real Composer. Do not simulate a provider connection or a successful
deployment.

1. **Start safe (4–6 seconds).** Show the empty Founder Brief preview. State
   that nothing is connected and no credential is requested.
2. **Choose only what matters (8–12 seconds).** Pick one source such as GitHub
   and one destination such as Telegram. Make clear that neither is mandatory
   by name.
3. **Review safeguards (8–12 seconds).** Show read-only access, approval
   required for external messages, customer-owned credentials, verification,
   and rollback.
4. **Show the artifact (6–10 seconds).** Download the secret-free blueprint
   and validate it with the official hstack plan validator.
5. **Close honestly (3 seconds).** Show the Labs labels for the next recipes;
   do not imply they are deployed products yet.

## Screenshot captions

1. **Start with a safe preview** — explore an agent idea without connecting an
   account or entering a key.
2. **Pick only the signals you need** — every integration is optional; the
   plan becomes live-ready only with a source and a destination.
3. **Read-only by default** — the review names access, verification, and
   rollback before setup begins.
4. **Your infrastructure, your credentials** — the browser exports a
   secret-free plan for official setup skills; it never stores credentials.

## Launch-day response guide

### “Is this another hosted agent platform?”

No. Agent Recipes creates a reviewable plan. The agent runtime, infrastructure,
and credentials stay with the customer. The product does not operate a hosted
control plane.

### “Why do I need a source and a destination?”

They are capability requirements, not required brand integrations. A live brief
needs information to summarize and a place to arrive. You can preview the
recipe with none, and select any supported optional source and destination when
you are ready.

### “Can it write to my tools?”

Not in the Founder Brief path. Its product default is read-only; external and
destructive actions remain approval-required in the generated plan.

### “Where do my secrets go?”

Nowhere in Agent Recipes. The browser neither asks for nor retains them. The
customer provides a credential only to the relevant official setup skill in
their own Hermes environment.

### “Does it work with OpenClaw, QM, Codex, Claude, and Cursor?”

Hermes is the current deployment target. Codex, Claude, Cursor, and OpenClaw
can be ways to follow the official hstack setup instructions. QM remains a
future recipe-export route, not a claimed Hermes-equivalent deployment target.

## Release checklist

- [ ] The Composer is hosted on a stable public URL; do not launch a repository
  directory as the primary Product Hunt product.
- [ ] A redacted, real 35–60 second demo follows the flow above.
- [ ] The deployed site serves the reviewed `recipes/` and `connectors/`
  metadata alongside the Composer.
- [ ] `node --test tests/recipes/test-founder-brief.mjs` passes.
- [ ] `bash scripts/validate-skills.sh --quiet` passes all 97 skills.
- [ ] `bash tests/skill-contract/test-validator.sh`,
  `bash scripts/validate-hermes-skill-contract.sh --quiet`,
  `bash tests/hermes-env/test-hstack-env.sh`, and
  `bash scripts/validate-compatibility.sh` pass.
- [ ] A real, customer-owned pilot has verified at least one selected source
  and one selected destination end to end before either is described as
  `pilot-tested`.
- [ ] The Product Hunt listing uses the bounded claims above.

Do not publish a release, create a Product Hunt listing, or post externally
from this document. Those are deliberate owner actions after the hosted demo,
checks, and evidence are complete.
