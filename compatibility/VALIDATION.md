# Workflow packs implementation and validation status

Updated: **2026-10-24**. Implementation and local end-to-end validation are complete.
**Live target deployment and real Telegram verification remain pending.**

The runnable entrypoint is [the workflow pack guide](../packages/founder-brief/README.md).
Hermes 0.22.5 remains an explicit, unpromoted candidate; the legacy 0.15.2 fixture
baseline has not been changed. Machine-readable status is in [hermes.json](hermes.json).

## Completed

- Three distinct reports: repository activity, current explicitly requested PR reviews and publication-window releases.
- Private preparation without source or JSON authoring, hidden token capture, pack discovery and target-free report preview.
- Explicit repository, private-chat, daily-time, timezone and reporting-window configuration.
- Bounded GET-only GitHub collection, dated facts, canonical links and inert title rendering.
- Private Telegram chat/bot validation and exact API acknowledgement checks.
- Reviewed installation, native no-agent scheduling, first-run canary and rollback.
- Immutable reporting windows, durable journals, confirmed replay without HTTP, and unknown-send recovery.
- Artifact, credential, receipt and native-job drift checks before dispatch.

## Evidence

| Check | Result | What it establishes |
|---|---|---|
| Combined workflow pack suite | 48 top-level tests passed; 0 failures/skips | Complete local workflow and all three comparisons through controlled dependencies |
| Collector cases | 41 passed (23 activity + 18 pack cases) | Distinct source queries, queue/publication semantics, paging, windows, sanitization and failure handling |
| Preparation cases | 12 passed | Actual checkout/packaged CLI, deterministic runtime, private modes, safe refusal and instructions |
| Pack runtime/credential cases | 7 passed | Selection, target-free preview, actionable source errors and fail-closed hidden input |
| Executable comparison | 3 workflows across both arms passed | Matching reports, endpoints, API acknowledgement, replay and cleanup; documented metric provenance |
| Deployment scenarios | 16 passed | Install/retry, ownership, locking, interruption and rollback |
| Telegram sender scenarios | 14 passed | Real loopback HTTP, private-chat checks, acknowledgements and uncertain sends |
| Workflow scenarios | 21 passed | Collector-to-sender flow, schedule/DST, drift and canary recovery |
| Real loopback SSH | Passed in the combined suite | Key authentication, actual transport, bundle transfer, install, canary, replay and rollback |
| Focused acceptance checks | 20 passed | Observer freshness, operator validation and native adapter regressions |
| Native adapter models | 25 passed | Tagged job bookkeeping and schedule/configuration semantics |
| Contract recheck | 14 passed | Compatibility contract and version/status consistency |
| Skill validator | 97/97 passed | Skill structure and repository policy checks |
| Skill references / Bash lint | Passed | Referenced skills exist; fenced Bash parses |
| Public GitHub collection | Earlier activity check passed; fresh pack preview hit `rate_limited` | Earlier production read succeeded without a token; the current unauthenticated API quota prevents a fresh public-pack verification |

Pre-publication recheck on **24 October 2026**:

- The combined recipe, acceptance, skill and workflow suites passed **619 tests**,
  with zero failures and **14 optional Docker tests skipped**.
- The Bash installer passed **328 checks**. PowerShell runtime checks were not
  rerun because `pwsh` was unavailable.
- All 97 skills validated; skill references and fenced Bash lint passed.
- Gitleaks passed the working directory and all 299 existing commits. Three exact
  harmless literals have rule-and-path-specific exceptions; controls confirmed
  that real key patterns in those files and the literals elsewhere still trigger.
- A fresh primary-source review confirmed Hermes v0.22.5 remains the latest stable
  release. The [comparison guide](../packages/founder-brief/COMPARISON.md) links the
  native capabilities and explains the packs' narrower application setup benefit.

These remain local/source checks. They do not change live-verification or
promotion status.

Parent and component counts overlap; do not sum them as independent top-level tests.
The SSH test uses real SSH and HTTP, with a native Hermes CLI fixture and controlled
GitHub/Telegram endpoints. It does not run a real Hermes daemon or send to Telegram.

The public Hermes repository exceeded collection bounds. The collector returned
failure with no brief instead of describing incomplete data as a healthy result.
High-volume repositories are a documented limit, not a successful delivery check.
The review queue scans all open PRs, including records later filtered out; release
watch scans all releases, since creation order does not establish publication
order. More than 300 total records exceeds either scan's bound regardless of a
narrow reporting window. Preview reports fixed source failure codes and guidance;
it never turns a rate limit or incomplete page scan into a quiet healthy report.

## Executed setup comparison

The [comparison guide](../packages/founder-brief/COMPARISON.md) and its executable
harness compare all three packs with a supplied manual-native worker. Both receive
the same collector, sender, timezone code and fake credentials. Actual loopback
HTTP and a native CLI fixture exercise matching report text and endpoints, private
chat acknowledgements, replay without HTTP, native job semantics, payload cleanup,
retained delivery evidence and preservation of unrelated jobs.

Each supplied transcript uses three setup process invocations. The full lifecycle
uses six for hstack and seven for the manual baseline, whose payload cleanup is
separate. The native runbook supplies a seven-field configuration and 29-line
integration worker; hstack generates those artifacts. These artifact counts come
from the runbook manifest and constants, not observed human authoring. Machine
timings are test overhead. **Human setup time has not been measured**, and the
comparison does not establish a speed advantage or equal lifecycle safety.

A native scheduled AI prompt remains the simpler one-command alternative when a
flexible model-written summary is sufficient. The comparison grants the manual
baseline the deterministic runtime for free; it does not claim that native Hermes
lacks scheduling, script execution or messaging.

## Still required for live completion

- [ ] Select a Linux SSH target with the exact candidate runtime, systemd gateway and exclusive default profile.
- [ ] Supply the repositories, positive private Telegram chat ID, daily time and timezone.
- [ ] Prepare private credential files outside the repository.
- [ ] Run the native canary and obtain its matching Telegram API acknowledgement.
- [ ] Observe the actual dated message in the intended private chat.
- [ ] Verify real restart/failure recovery and preservation of unrelated target state.
- [ ] Record at least seven consecutive live golden-path days before promotion.

`telegram-api-ack` means the API accepted the checked text and returned a message ID.
It does not prove a human read the message. No production promotion, real-target
deployment or seven-day reliability run is claimed by the local tests.

## Reproduce local validation

From the repository root:

```bash
node --test --test-concurrency=3 tests/founder-brief/
python3 -I -B tests/founder-brief/helpers/compare-workflows.py --output /tmp/hstack-workflow-comparison.json
node --test --test-concurrency=3 tests/acceptance/untrusted.test.mjs tests/acceptance/observer.test.mjs tests/acceptance/native-adapter.test.mjs tests/acceptance/native-transaction.test.mjs
node --test tests/acceptance/contract.test.mjs
/bin/bash scripts/validate-skills.sh --quiet
/bin/bash scripts/check-skill-refs.sh --quiet
/bin/bash scripts/lint-md-bash.sh
```

Loopback tests need local socket access; the real SSH case needs `sshd`, `ssh` and
`ssh-keygen`. Credentials and real delivery evidence must stay outside public test
fixtures, commits and documentation.
