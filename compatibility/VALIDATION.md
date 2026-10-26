# Workflow packs implementation and validation status

Updated: **2026-10-26**. All catalogue migration waves and multiple-instance workflow
implementation are complete. Final local validation includes native cron source checks,
Docker SSH and both installer runtimes.
**Live target deployment and real Telegram verification remain pending.**

The runnable entrypoint is [the workflow pack guide](../packages/founder-brief/README.md).
Hermes 0.22.5 is the pinned target and is source-verified, not live-verified; the legacy 0.15.2
fixture is used only by the offline acceptance contract. Machine-readable status is in [hermes.json](hermes.json).

## Completed

- Three distinct reports: repository activity, current explicitly requested PR reviews and publication-window releases.
- Private preparation without source or JSON authoring, hidden token capture, pack discovery and target-free report preview.
- Explicit repository, private-chat, daily-time, timezone and reporting-window configuration.
- Bounded GET-only GitHub collection, dated facts, canonical links and inert title rendering.
- Private Telegram chat/bot validation and exact API acknowledgement checks.
- Reviewed installation, native no-agent scheduling, first-run canary and rollback.
- Immutable reporting windows, durable journals, confirmed replay without HTTP, and unknown-send recovery.
- Artifact, credential, receipt and native-job drift checks before dispatch.
- Multiple named instances per default-profile target, including repeated copies
  of a pack, with independent configuration, credentials, state, locks and rollback.
- Legacy namespace, launcher and review-format compatibility; explicit instance
  selection for canary, status and rollback, plus metadata-only inventory.
- Ownership and write-permission checks on the target home, scripts and workflow
  parents before installation/dispatch; hard-link aliases and symlink collisions refused.

## Final catalogue migration checks (26 October 2026)

All 68 remaining integrations are migrated; the catalogue still contains 97 skills.
The [migration record](MIGRATION.md) describes routes and behavior changes.

| Check | Result | Evidence boundary |
|---|---|---|
| Stock macOS Bash installer | 411 passed | Disposable installation/ownership scenarios |
| Script and validator regressions | 116 passed | Executable positive and negative controls |
| Catalogue/native parser contract | 97 passed | Commands parse against the pinned Hermes source |
| Skill validator and references | 97/97; references passed | Repository structure and cross-references |
| Markdown Bash lint | 967 parsed; 87 placeholder blocks skipped; zero errors | Syntax, not live execution |
| ShellCheck | 39 shell files; zero errors | Official ShellCheck 0.11.0 container |
| Secret-scanner exception controls | 7 passed | Exact synthetic literals only; alternate IDs, paths and token detectors still fail |
| Working-directory and history secret scan | No leaks; 304 existing commits scanned | Gitleaks 8.30.1 with default rules and narrow fixture exceptions |
| Blueprint/count checks | Three blueprints and catalogue counts passed | 97 skills, 71 integrations, eight platforms |

The combined recipe, acceptance, skill and workflow matrix evaluated **2,666 tests**
with **zero skips**. Its only failure was a home-channel version-gate test targeting
a removed shell pattern. That test now supplies an actual unsupported runtime version;
its full **35-test suite passed on recheck**, leaving no unresolved runtime failures.
Docker SSH and exact-source native cron were explicitly enabled in this matrix.
No production behavior was weakened to satisfy the corrected assertion.

PowerShell **7.6.9 on macOS passed 207 checks**, with zero failures or skips.
This does not establish native Windows junction, ACL, Developer Mode or PowerShell 5.1 behavior.

### Linux CI follow-up

Ubuntu exposed three empty retired prerequisite branches inside executable heredocs
in SendGrid, Webflow and WooCommerce. These branches are removed. Regression tests
now parse all 22 embedded vendor probes directly, demonstrate that checking only the
outer heredoc misses this error, and reject syntax diagnostics even if an older Bash
cleanup trap returns zero.

The corrected batch passes **74/74 tests on macOS Bash 3.2**. A disposable Node 20 / Bash 5.2
Linux host-model run passes **2,294 skill tests**, with one root-only permission skip;
the permission suite also passes separately as an unprivileged user. The container's
markers were removed only inside that disposable test environment to model a host;
production host-only guards remain unchanged. Validators, fenced Bash lint and
Gitleaks were rerun successfully before the follow-up commit.

## Earlier workflow evidence (24 October 2026)

| Check | Result | What it establishes |
|---|---|---|
| Workflow and Telegram shim suite | 56 top-level tests passed; 0 failures/skips | Local reports, concurrent instances, comparisons, transport and real native cron through controlled vendors |
| Collector cases | 41 passed (23 activity + 18 pack cases) | Distinct source queries, queue/publication semantics, paging, windows, sanitization and failure handling |
| Preparation cases | 13 passed | Actual checkout/packaged CLI, instance defaults/custom names, deterministic runtime, private modes, safe refusal and instructions |
| Pack runtime/credential cases | 7 passed | Selection, target-free preview, actionable source errors and fail-closed hidden input |
| Executable comparison | 3 workflows across both arms passed | Matching reports, endpoints, API acknowledgement, replay and cleanup; documented metric provenance |
| Deployment scenarios | 17 passed | Install/retry, ownership, locking, interruption and rollback |
| Multi-instance deployment scenarios | 18 passed | Concurrent installs, same-pack copies, namespace/receipt binding, independent recovery/rollback, directory and link safety |
| Multi-instance runtime scenarios | 8 passed | Installed launchers, separate destinations/schedules, replay, unknown acknowledgements, drift, locks and legacy coexistence |
| Telegram sender scenarios | 14 passed | Real loopback HTTP, private-chat checks, acknowledgements and uncertain sends |
| Workflow scenarios | 21 passed | Collector-to-sender flow, schedule/DST, drift and canary recovery |
| Real loopback SSH | Passed | Actual authentication/transport and legacy plus two named instances: transfer, canary, replay and independent rollback |
| Pinned Hermes cron source | Passed on Python 3.14.9 | Three coexisting jobs, native claims/subprocesses, five controlled API acknowledgements, replay, failure/recovery and scheduler tick |
| Telegram Docker shim regression | 5 passed | Actual skill reachability/reload blocks accept current default-profile syntax; legacy acceptance stub remains unchanged |
| Focused acceptance checks | 20 passed | Observer freshness, operator validation and native adapter regressions |
| Native adapter models | 25 passed | Tagged job bookkeeping and schedule/configuration semantics |
| Contract recheck | 14 passed | Compatibility contract and version/status consistency |
| Skill validator | 97/97 passed | Skill structure and repository policy checks |
| Skill references / Bash lint | Passed | Referenced skills exist; fenced Bash parses |
| Public GitHub collection | Earlier activity check passed; fresh pack preview hit `rate_limited` | Earlier production read succeeded without a token; the current unauthenticated API quota prevents a fresh public-pack verification |

Final multiple-instance recheck on **24 October 2026**:

- All **56 workflow/native-cron/Telegram-shim tests passed**, with no skips, using
  the explicit opt-in exact-source environment as well as disposable loopback SSH.
- **89 compatibility and Telegram skill regressions passed**. Separate deployment
  checks passed 17 legacy and 18 multiple-instance Python scenarios; these component
  counts overlap the combined suite.
- All **97 skills** validated; references passed; **1,061 Bash blocks** parsed with
  120 placeholder blocks skipped and no errors. The final working-directory Gitleaks
  scan found no leaks.
- The legacy launcher, native job and four configuration descriptor hashes matched
  the preceding implementation. The new code validated and rolled back an actual
  receipt generated by that preceding implementation.
- No real Telegram message, Linux gateway restart or seven-day live run was performed.

Earlier pre-publication check on **24 October 2026**, before the multiple-instance changes:

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

The earlier remote recipe run exposed four Telegram Docker tests rejecting the
current default-profile CLI prefix. The repaired shim handles that syntax and
explicitly labels its readiness response as test-double evidence. The final
26 October matrix enables the Docker container suite; its current result is recorded above.

These remain local/source checks. They do not change live-verification or promotion status.

Parent and component counts overlap; do not sum them as independent top-level tests.
The SSH test uses real SSH and HTTP, with a native Hermes CLI fixture and controlled
GitHub/Telegram endpoints. It does not run a real Hermes daemon or send to Telegram.
The separate [opt-in native cron check](../tests/founder-brief/REAL_NATIVE.md) imports
seven hash-pinned source files from the exact 0.22.5 commit and uses the release's
pinned Python 3.14.9. It exercises the actual parser, store, claims, no-agent worker
subprocess and scheduler tick. Three packs produce five controlled API acknowledgements
across initial delivery, source-failure recovery and a tick; confirmed replay adds
no HTTP or send. Native failure bookkeeping and scoped cleanup are checked.
The harness bypasses Linux/systemd readiness and enters the cron handler directly,
excluding full startup and managed dependency activation. It does not verify a live
gateway, gateway restart or real Telegram delivery. Test dependency setup is separate
from a fully synchronized Hermes installation.

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
separate. The native runbook supplies an eight-field configuration and 29-line
integration worker; hstack generates those artifacts. These artifact counts come
from the runbook manifest and constants, not observed human authoring. Machine
timings are test overhead. **Human setup time has not been measured**, and the
comparison does not establish a speed advantage or equal lifecycle safety.

A native scheduled AI prompt remains the simpler one-command alternative when a
flexible model-written summary is sufficient. The comparison grants the manual
baseline the deterministic runtime for free; it does not claim that native Hermes
lacks scheduling, script execution or messaging.

## Still required for live completion

- [ ] Select a Linux SSH target with the exact Hermes 0.22.5 runtime, systemd gateway and exclusive default profile.
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
node --test --test-concurrency=3 tests/founder-brief/*.test.mjs
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
