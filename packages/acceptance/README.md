# @hstack/acceptance — a reversible acceptance transaction for ONE workflow

This package puts a versioned, reviewable, reversible, receipt-producing transaction around exactly one
workflow:

> recipe `founder-brief-github-telegram` — a **read-only GitHub** source delivering a brief to **one private
> Telegram** destination — on **one Linux target** (Ubuntu/Debian, bash, ssh) running **one declared Hermes
> version** (`HERMES_VERSION` in `VERSIONS.txt`).

It is deliberately narrow. It is not a doctor, not a dashboard, not a new connector, and it does not grow the
catalogue. The scope, versions, managed keys, managed skills, cron schedule/prompt and the list of Hermes
subcommands it may call all live in one file:
[`acceptance/founder-brief-github-telegram.contract.json`](../../acceptance/founder-brief-github-telegram.contract.json).

## What a receipt proves — and what it does not

A receipt is a secret-free JSON attestation of one transaction
(schema: [`schema/receipt.schema.json`](schema/receipt.schema.json)).

A `verified` receipt proves **only**:

- the listed checks (`runtime-version`, `env-boundary`, `schedule-single`, `managed-skills-intact`,
  `unrelated-state-unchanged`, `private-destination-delivery`, `untrusted-input-boundary`) each came back
  `pass`,
- on the versions recorded in the receipt (`runtime_version` is what was **observed**, not what was declared),
- on the one target described in `target_profile` (including `transport_used`: `ssh`, `sandbox` or
  `recording`),
- at the times recorded in each check's `observed_at`.

Read the two delivery-related checks for what they are. `private-destination-delivery` is the observer's
report that at least one message reached the configured destination fingerprint and none reached another.
`untrusted-input-boundary` is the **observed outcome of one synthetic run; it is not an injection-resistance
test**: it re-derives the plan hash (showing blueprint text did not change what was executed) and checks that
the one observed run did not misdirect a message or put the synthetic secret in a body. A runtime that
behaves well on that one input has shown nothing about other inputs. The check keeps its id and its scope
reads `observed-outcome-single-run`.

A `verified` receipt does **not** prove:

- that real Hermes behaves like the declared adapter surface (that surface is **declared, unverified**
  against real Hermes — see "Simulated versus live"),
- that later scheduled runs will deliver, or that delivery is exactly-once (the contract says: *best-effort;
  duplicates possible after retry; exactly-once is not claimed*),
- that a hostile input class not exercised by the listed checks is harmless,
- anything about the host beyond the listed checks (hstack never runs `hermes doctor` and never claims a
  health result; `diagnostics=unknown` is recorded as such),
- anything about the receipt's authenticity: **receipts are unsigned and not tamper-evident.** Anyone who can
  write the receipt directory can write a receipt that validates. `validateReceipt` checks consistency, not
  provenance. Pin a receipt by its `receiptHash` (canonical sha256) somewhere you trust if that matters,
- that the GitHub token is least-privilege (the plan requests `read_only`; scope is the operator's setting).

Rules the code enforces:

- **Delivery cannot be proven without an observer.** The transaction takes an injected
  `observer.delivery({ destinationFp }) -> { deliveries: [{ to_fp, body_has_secret }] }`. No observer, an
  observer that errors, returns garbage, or sees no delivery => the delivery check is `unknown` =>
  the transaction **cannot** reach `verified`. A gateway that is merely running is not delivery.
- A `verified` receipt with any required check not `pass` is rejected by `validateReceipt`; so are
  `restored_verified` without `recovery.restoration_verified`, `changes_applied:true` before
  `applied_unverified`, unknown state names, duplicate JSON keys, secret-shaped strings, and keys named
  token/secret/password.
- The raw chat id is never written: `destination_fingerprint` = first 16 hex of `sha256("telegram:"+chat_id)`.
  That is an **unsalted, truncated hash of a small numeric space: it is brute-forceable and is not a privacy
  guarantee**. It stops casual disclosure of the id and nothing more. Treat receipts, history snapshots and
  evidence files as sensitive.
- `verified` is stricter than "the required checks passed": no check of any kind may be `fail`, `blocked` or
  `unknown`; `skipped` is allowed only for `target-os` and only on a simulated transport; the delivery check
  needs scope `delivery-observer` and an `evidence_ref`; `runtime_version` must be an observed version; every
  recorded apply op must be `ok`. `restored_verified` additionally needs passing `restoration` and
  `gateway-reloaded` checks.
- **What was reviewed is what runs.** The review pins the sha256 of the helper script and of the skills
  archive (shown as the digests in the redacted stdin descriptions). `stage()` and `apply()` recompute them and
  refuse with `artifact_changed` (nothing sent to the target) if either differs. The receipt records the
  script digest, the archive digest and a per-skill digest for **all** managed skills in `artifacts`.
- `validate-receipt` always prints `transport_used`, warns `SIMULATED target — not evidence about a real
  server` for sandbox/recording receipts, and notes that the adapter surface is declared-unverified.
- Things that cannot be undone (a Telegram message already delivered) are listed in
  `recovery.external_effects`; rollback does not pretend to recall them.

## States

```
start -> validated -> inspected -> change_reviewed -> staged -> applied_unverified
                                                                  |-> verified                (final)
                                                                  `-> rollback_required
                                                                        |-> restored_verified          (final)
                                                                        `-> manual_recovery_required   (final)
```

Anything else throws `IllegalTransition`. A blocked step **before** apply leaves `state` unchanged and sets
`blocked_reason` (`runtime_version_mismatch`, `runtime_unknown`, `incomplete_transaction:<id>`,
`skill_collision:<name>`, `precondition_conflict:<what>`, `stage_failed:<step>`, `unsupported_target:<os>`)
with `changes_applied:false`. A rejected blueprint (`invalid_blueprint`) produces no receipt at all: there is
no transaction to attest.

**Write-ahead.** The receipt is persisted as `applied_unverified` (`apply.started:true`,
`apply.completed:false`, `changes_applied:true`) **before** the first live mutation (skills sync, env swap,
cron entry, gateway reload). Anything that interrupts the run therefore leaves `applied_unverified`, and from
there only `verify` or `rollback` are legal (`Transaction.resume`). A transport failure (ssh exit 255,
timeout) is an *unknown outcome*: it throws `TransportError` and never advances the state.

**Crash between stage and apply.** `Transaction.resume` also accepts `change_reviewed` and `staged`
receipts (the reviewed digests are re-read from the receipt). From `staged` you may `apply()` or `abandon()`;
from `change_reviewed` you may `stage()` (only if no recovery point was taken) or `abandon()`. `abandon()` runs
the target-side pre-apply `restore`, which removes the staged secrets and closes the transaction, leaves
`state` unchanged, sets `blocked_reason: abandoned` with `changes_applied:false`, and kills the transaction
object (every later call is `IllegalTransition`). If the cleanup cannot be confirmed it returns `ok:false`
and the exact manual commands, which you can also run yourself on the target:

```
~/.hermes/.hstack/bin/hstack-target.sh restore '<txn>'     # closes it; nothing was applied
~/.hermes/.hstack/bin/hstack-target.sh purge '<txn>'       # optional: deletes that txn directory
```

`verify`: all required checks `pass` -> `verified` (and the target transaction is committed); any required
check `fail` -> `rollback_required`; otherwise (`unknown`) it stays `applied_unverified` with
`unresolved:[check ids]`. `rollback`: the target `restore` must exit 0 **and** print `restore_verified=1`
(exit 0 alone, or `already_restored=1`, is not enough); then the gateway is reloaded (`stop`, then
`run --daemon`, never `restart`) because the running process may still hold the new environment, and a
`gateway-reloaded` check is recorded. Only restore verified **and** reload confirmed -> `restored_verified`.
A conflict, a missing backup, an unconfirmed restore or a failed/unknown reload -> `manual_recovery_required`
(with the detail in the `restoration` / `gateway-reloaded` checks), never an overwrite.

## Untrusted blueprint text

A blueprint's `name`, `description`, `credential_requirements[]` text and automation `cadence` labels are
**display data**. `deriveExecutionGraph(blueprint, contract, operator)` reads only the allowlisted structural
fields (`runtime.agent/installation`, `delivery.mode/channels`, `integrations[].id/skill/access`,
`automations[].id/enabled`, `policies`, `resolved_skills` — which it re-derives from the contract and requires
to be equal) and never enumerates or serialises the blueprint. The cron schedule, cron prompt, destination
key, managed env keys and managed skills come from the **contract** plus a validated **operator input**
(`chatId`, `schedule`) — never from blueprint text, issue bodies or any retrieved content. `plan_hash` is
the sha256 of the canonical JSON of that derived graph, so payloads in display fields change nothing.
`renderUntrustedText` (strips control/ANSI/bidi, collapses whitespace, caps at 280, prefixes
`[untrusted blueprint text]`) is the only way display text reaches a terminal or log. The existing Python
validator (`skills/blueprint-install/scripts/validate_blueprint.py`) is the structural gate; `validate()`
runs it for real (`HSTACK_PYTHON` honoured) and fails loudly if no Python 3 is available — it is never
skipped.

## Modules

| file | role |
|------|------|
| `states.js` | `STATES`, legal transitions, `IllegalTransition` |
| `receipt.js` | build/validate (schema-driven + cross-field rules), canonical hash, strict JSON, atomic 0600 writes |
| `contract.js` | load + strictly validate the contract; cross-check `VERSIONS.txt` |
| `untrusted.js` | `deriveExecutionGraph`, `planHash`, operator input validation, `renderUntrustedText` |
| `ops.js` | op builders -> `{ op, remote, stdin, redactedStdin, mutates }`; `assertSafeArg`; host/user validation; deterministic skills tar |
| `transports.js` | `SshTransport`, `SandboxTransport` (same remote string via `env -i`), `RecordingTransport` |
| `transaction.js` | `Transaction`: `validate / inspect / previewChanges / reviewChanges(approve) / stage / apply / verify / rollback / abandon / purge / resume` (plus the `EXEC_FOR_TESTS` seam used to test the write-ahead guard) |
| `cli.js` | `validate-receipt`, `plan-hash`, `review` — and nothing else |
| `target/hstack-target.sh` | the script that runs **on the target** (installed over ssh, never fetched from the network) |

`reviewChanges(approve)` calls `approve(review)`; the approval must **return the exact `plan_hash`** of the
review (quote it), otherwise `ApprovalError`. The review lists every op in order with its exact command
(secrets shown as `<STDIN secret len=N>`), the expected previous state per op (stable ids such as
`env:TELEGRAM_BOT_TOKEN`) and the recovery point `bk_<txn>`.

### CLI (no network, nothing else)

```
node packages/acceptance/cli.js validate-receipt receipt.json
node packages/acceptance/cli.js plan-hash blueprint.json --chat-id <id> --schedule '0 8 * * 1-5'
node packages/acceptance/cli.js review    blueprint.json --host vps.example.com --user root --chat-id <id> --schedule '0 8 * * 1-5'
```

The chat id and schedule are operator input and are never read from the blueprint. `review` validates the host
and user, runs the structural gate, and prints the reviewable op list; it never connects.

## Simulated versus live

Everything verified in this repository is **simulated**:

- `tests/acceptance/stubs/hermes` is a bash **test double** of an adapter surface *declared* in the contract.
  It is not Hermes and is not evidence about Hermes.
- The "Telegram" in the tests is that stub's outbox file; the delivery observer in the tests reads it.
- The sandbox transport runs the same remote strings under `env -i HOME=<tmp> PATH=/usr/bin:/bin bash -c`, so
  the commands covered by the golden fixtures are the commands the sandbox executes. Receipts produced that
  way say `transport_used: "sandbox"`.
- Golden SSH command fixtures (`tests/acceptance/golden/`) pin the exact command text of every op.
- A gated Docker target with a real `sshd` (`HSTACK_DOCKER=1`) is a separate deliverable; it still uses the
  stub `hermes`.

**Live validation is the operator's job and is not claimed anywhere here:** a real Hermes at the declared
version, a real bot token and chat, and a real GitHub token, on a real VPS. Until a live run exists, treat
`contract.adapter_surface` as unverified. Secrets only ever travel on ssh stdin (`put-env`), are charset- and
length-checked, and appear in no argv, receipt, evidence file or log.

## Running the tests

```
node --test tests/acceptance/                 # host: node >= 18, python3, bash (macOS /bin/bash 3.2 is fine)
UPDATE_GOLDEN=1 node --test tests/acceptance/ops-golden.test.mjs   # regenerate golden command fixtures, then review the diff
```

The integration tests drive the real `target/hstack-target.sh` through `SandboxTransport`; if that file is
absent they are **skipped with an explicit reason**, never silently passed. Docker-gated tests are skipped
with "skipped: HSTACK_DOCKER not set". The five acceptance cases live in
`tests/acceptance/test-acceptance-cases.mjs`.

## Retention and purge

Receipts, per-transition snapshots (`history/NN-<state>.json`) and redacted evidence live under
`<receiptDir>/<txn_id>/`, directories `0700`, files `0600`, written atomically (tmp + rename), one snapshot per
transition. They are never deleted automatically. The recovery point on the target
(`~/.hermes/.hstack/txn/<txn>`) is kept after both `verified` and `restored_verified`; `Transaction.purge()`
removes **only that transaction's directory** and only from a final state. `~/.hermes/.hstack/bin` (the
installed helper) and `managed-skills.tsv` are hstack's own files and are left in place. An incomplete
transaction blocks the next one (`incomplete_transaction:<id>`) until it is verified, rolled back,
abandoned or recovered by hand.

**What stays on the target until `purge`.** The recovery point contains `env.bak`, a copy of the previous
`~/.hermes/.env` **including the previous secret values**, kept at mode `600` (as are the other backup files).
It persists after `verified`, `restored_verified` and `abandon()` until `purge` removes the whole transaction
directory. Staged new secrets (`env.staged`) are deleted as soon as `apply` succeeds and when `restore` (rollback or abandon) completes. If you
do not want old secrets lingering in a backup file, purge as soon as you no longer need the rollback option.
Receipts and evidence on the operator's machine are also sensitive (see the fingerprint note above).

## Limits

- One workflow, one Linux target, one Hermes version, one Telegram destination. No other platform, source,
  or runtime is accepted by the contract.
- The Hermes CLI surface is declared, not verified against real Hermes. `cron list` is assumed to print one
  job per line (`id TAB schedule TAB prompt`).
- Delivery evidence is only as good as the injected observer. The package ships no production observer: an
  operator must supply one (for example a second Telegram client or bot that confirms receipt). Without one
  the best outcome is `applied_unverified`.
- Rollback restores only the managed env keys, managed skills and the managed cron entry, then reloads the
  gateway. It refuses to overwrite anything changed since apply (`manual_recovery_required`) and cannot
  recall delivered messages.
- **Unverified assumption about `config.yaml`:** the restore treats *any* change to `config.yaml` since the
  backup as a conflict. If real Hermes rewrites `config.yaml` on its own (for example on gateway start or
  `config set`), every rollback would end in `manual_recovery_required`. This has not been checked against a
  real Hermes; the stub does not rewrite it.
- The adapter surface lists `gateway run --daemon` explicitly because that is the exact call the target
  script makes. Upstream's documented gateway commands do not include `--daemon`; like the rest of the
  surface it is declared, unverified (see the note in `skills/hermes-deploy/SKILL.md`).
- Receipts are unsigned and not tamper-evident (see above).
- `skills:sync` installs the shipped `skills/<name>` directories; a pre-existing unmanaged directory with a
  managed name is a collision and blocks the transaction.
- Secret handling is shape- and charset-based. Receipts reject known token shapes, but a secret in an
  unknown format that appears in free text would not be recognised; the code therefore never places target
  output or secret values in a receipt unredacted.

## Open decision (not ours to fix here)

`VERSIONS.txt` pins `HERMES_VERSION=0.15.2`, but the upstream project has **no `v0.15.2` tag**. The contract
reads the pin from `VERSIONS.txt` and a test asserts they agree; whether the pin should change, or upstream
should be asked to tag it, is an open decision for the maintainers. Until it is resolved, "runtime-version
pass" means "the target reports the string the repository pins", not "this is a known upstream release".
