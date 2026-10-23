# What the workflow packs save

Hermes already schedules jobs, executes scripts and connects to messaging
platforms. hstack uses those native features. If a scheduled AI prompt meets your
needs, use Hermes directly: creating that schedule can take one command after
the required integrations and delivery destination are configured.

Primary-source check on **24 October 2026**: Hermes
[v0.22.5](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5)
already documents [script-only reports without inference](https://hermes-agent.nousresearch.com/docs/guides/cron-script-only),
including scripts written and scheduled from chat. Its
[tagged cron documentation](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/website/docs/user-guide/features/cron.md)
also covers Telegram delivery, execution history, incidents, diagnosis and
recorded-slot replay protection. These are native capabilities; the pack supplies
specific report logic and application setup. Similar outcomes also exist in
[n8n's GitHub digest template](https://n8n.io/workflows/15898-send-weekly-github-digests-to-telegram-with-qwen-via-openrouter/).
This comparison establishes neither unique capability nor a general speed or
reliability advantage over those alternatives.

The packs address a narrower need: a deterministic, repository-scoped report,
without a model call, with checked private Telegram delivery, a durable reporting
identity and an owned installation that can be removed safely. Choose activity,
requested PR reviews or published releases instead of assembling that worker.
Only one selected pack is supported on each exclusive default-profile target.
The pack uses its own private API credentials and a native local-delivery job, so
it does not require configuring shared Hermes Telegram/GitHub integrations. This
is an application setup choice, not a capability missing from native scripts.

## Reproduce the comparison

From the reviewed checkout, run:

```bash
python3 -I -B tests/founder-brief/helpers/compare-workflows.py \
  --output /tmp/hstack-workflow-comparison.json
node --test tests/founder-brief/comparison.test.mjs
```

Use a new output filename on each run. The first command creates a machine-readable
report with measured process timings and executed operation ledgers. The second
checks all three packs against the comparison contract. Both use fake tokens, a
declared Hermes CLI fixture, disposable homes and actual loopback HTTP. Network
policies that refuse local listeners prevent this check from running.

The comparison does not contact GitHub or Telegram, install Hermes, require SSH,
or measure a person using either product. The separate SSH integration test checks
the transport. Live validation has its own [evidence requirements](../../compatibility/VALIDATION.md).

## Give the manual baseline the same implementation

Both arms start with the same existing target, exact Hermes version, credential
file and repository/chat/time choices. Credential acquisition, trusted target
access and Hermes installation are excluded equally. In normal hstack use,
`credentials --output PATH` captures tokens through hidden terminal prompts;
the comparison instead provides fake credentials to both arms.

The manual-native arm gets the **complete collector, sender, timezone calculation
and runtime archive for free**. Its supplied 29-nonblank-line worker integrates
these shared components. It receives the same five explicit choices: workflow,
repositories, private chat, daily time and timezone. The default 24-hour reporting
window is the same in both arms. Time and timezone have hstack defaults; providing
them explicitly here prevents unequal input assumptions.

The native arm then assembles its seven-field JSON configuration, publishes the
archive/configuration/credentials and small launcher, and creates a native job:

```bash
hermes --profile default cron create \
  --script=manual-brief.py --no-agent \
  --deliver=local --failure-deliver=local --name=manual-comparison \
  -- '* * * * *' 'Run supplied workflow'
```

Its launcher uses `reporting_window`, `collect_report` and `TelegramDelivery`
from the shared runtime. The minute trigger and daily cutoff match hstack. The
native fixture invokes it for a fixed test window, then invokes it again to check
confirmed-window replay. It finally removes its job and its private payload.
The worker and the exact executed operations are in
[`compare-workflows.py`](../../tests/founder-brief/helpers/compare-workflows.py).

The hstack arm runs the actual `prepare`, `review`, `install`, `canary` and
`rollback` code paths. A test wrapper permits fixture installation off Linux,
injects the fixed test clock and supplies loopback HTTP clients through Python-only
test seams. Production CLI/configuration has no API-origin override. A second
canary with the same identity must reuse the first acknowledgement.

## Results from these supplied transcripts

Each of the three packs produces these counts; the JSON report records them
from the subprocess invocations that actually ran:

| Measured work | Supplied manual-native worker | hstack pack |
|---|---:|---:|
| Explicit workflow choices | 5 | 5 |
| Setup process invocations | 3 | 3 |
| Full transcript, including replay and cleanup | 7 | 6 |
| Runbook-supplied integration artifacts | 2 | 0 |
| Runbook-supplied configuration fields | 7 | 0 |
| Runbook-supplied worker, nonblank source lines | 29 | 0 |
| Telegram sends after a confirmed replay | 1 | 1 |

The native setup operations are configuration authoring, worker publication and
`cron create`. The hstack setup operations are `prepare`, `review` and `install`.
Validation/cleanup adds native `cron run`, repeat `cron run`, `cron remove` and
payload cleanup; hstack adds `canary`, repeated `canary` and `rollback`.

**This does not show a reduction in setup command count.** The supplied native
runbook contains two integration artifacts that hstack generates. Their fields
and source lines are classifications/counts from fixture constants, not observed
human assembly or source authoring. The JSON report records this metric provenance
explicitly. hstack's one fewer
full-transcript invocation comes from combining owned job and file cleanup.
Shell grouping, aliases, an AI agent or a different runbook can change invocation
counts. The supplied baseline already avoids the much larger unmeasured effort
of implementing the shared runtime.

All three comparisons require:

- Exactly matching rendered report text for the same interval and source data.
- Only each pack's declared GitHub endpoints, followed by checked private-chat
  Telegram API calls.
- Native default-profile, script, no-agent and local-delivery job semantics.
- A matching API acknowledgement, one send and no additional HTTP on replay.
- Removal of the launcher, runtime, configuration and credentials after cleanup,
  retention of the confirmed delivery journal and acknowledgement, and preservation
  of an unrelated native job.

## What remains unproven

Machine elapsed milliseconds describe test process and runtime overhead. They
are **not human setup minutes**, a production performance benchmark or proof
that hstack is faster for an experienced Hermes user. No such time-saving claim
is supported until people complete both setups under comparable conditions.

The native baseline matches report, acknowledgement and replay behavior because
it receives those components for free. It does **not** reproduce hstack's review
hashes, installation receipt, verified owned files, installation/dispatch lock,
interruption handling or conflict-aware rollback. The comparison makes no equal
recovery or safety claim. Separate tests exercise those hstack guarantees.

The minimal scheduled-prompt alternative is disclosed, not executed here: it
uses a model and depends on configured tools/delivery, so its output and costs
would be a different experiment. Native scheduling alone is already sufficient
when those differences do not matter to the user.
