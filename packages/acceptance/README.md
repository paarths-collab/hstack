# @hstack/acceptance — a reversible acceptance transaction for ONE workflow

For the runnable deterministic GitHub-to-Telegram report packs, use
[`packages/founder-brief/`](../founder-brief/README.md). This package is the older
experimental control-plane transaction: its injected observer and scheduled generic
prompt do not implement repository collection or establish fresh real delivery.

The default contract is a legacy 0.15.2 offline fixture (`HERMES_LEGACY_FIXTURE_VERSION` in `VERSIONS.txt`).
Hermes 0.22.5 (`HERMES_VERSION`) is the release the skills and report packs target; it is **source-verified, not
live-verified**, and has a separate contract and native adapter. See
[compatibility and promotion](../../compatibility/README.md) for its exact commit, exclusive-default-profile
scope and missing live evidence. Neither contract has been established by these tests as a working real-server
deployment.

This package puts a versioned, reviewable, reversible, receipt-producing transaction around exactly one
workflow:

> recipe `founder-brief-github-telegram` — a **read-only GitHub** source delivering a brief to **one private
> Telegram** destination — on **one Linux target** (Ubuntu/Debian, bash, ssh) running **one declared Hermes
> version** (the contract's `runtime.versions_source` key in `VERSIONS.txt`: `HERMES_LEGACY_FIXTURE_VERSION` for the
> default contract, `HERMES_VERSION` for the 0.22.5 contract).

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
  Helpers are published atomically at `~/.hermes/.hstack/bin/hstack-target-<script_sha256>.sh` and are
  never replaced by another helper version. Every transaction operation, including resumed recovery,
  uses its reviewed digest. The `Transaction` API binds this automatically; low-level transport callers
  must use `bindHelper(op, scriptSha)` after `opInstallHelper(scriptBody)` rather than execute an unbound
  builder against the former shared path.
  Caller-supplied contracts are snapshotted on construction; changing the original object later cannot
  change the reviewed execution plan.
- **The live credential boundary is checked.** Applying staged credentials sets `.env` to mode `0600`,
  including when the previous file had broader permissions. Staging refuses Telegram allow-all overrides
  and group-wide access; verification checks those settings again, checks the live file mode, and detects
  changes to the backed-up `config.yaml`. Verification also requires numeric allowlist entries and the
  recorded cron schedule and prompt. Exact-file rollback restores the recorded previous mode; when
  rollback merges managed keys with unrelated user edits, it preserves the current file mode.
- Target operations acquire the transaction lock before checking mutable lifecycle state, so an operation
  waiting behind a completed restore cannot apply changes to that restored transaction.
  Apply also checks each requested managed cron entry against its backup and recorded intent before any
  live mutation. A user's intervening edit, addition or deletion is a conflict. Once recorded, a cron ID's
  intent cannot change within the same transaction; use a subsequent transaction for an update. Retrying
  a completed apply requires its exact recorded cron result; an interrupted apply may resume its known
  partial replacement state.
- Successful exit status alone does not confirm a reload or commit. Apply requires `reloaded=1`, and
  verification requires `committed=1`. A missing commit acknowledgement leaves `applied_unverified` with
  an unresolved commit check, so verification can safely retry the idempotent commit.
- A `Transaction` instance rejects overlapping operations with `operation_in_progress`; callers must await
  each operation before starting the next. This prevents concurrent staging calls from corrupting its receipt.
- Managed skill signatures include file and directory permissions, empty directories, content and link
  targets. A permission-only edit is a conflict, not permission to remove or replace that skill. Older
  content-only manifest signatures are conservatively treated as modified and require manual reconciliation;
  the transaction cannot infer their original permissions safely.
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
from `change_reviewed` you may `stage()` (only if no recovery point was requested) or `abandon()`.
The expected `recovery.backup_ref` is saved before sending the backup request; the `backup-create` check
distinguishes a request with an unknown outcome from a confirmed backup. A lost reply requires target
reconciliation. A missing backup after an unknown outcome does not confirm cleanup, because a delayed
remote request could still be running. `abandon()` runs
the target-side pre-apply `restore`, which removes the staged secrets and closes the transaction, leaves
`state` unchanged, sets `blocked_reason: abandoned` with `changes_applied:false`, and kills the transaction
object (every later call is `IllegalTransition`). If the cleanup cannot be confirmed it returns `ok:false`
and the exact manual commands, which you can also run yourself on the target:

```
~/.hermes/.hstack/bin/hstack-target-<script_sha256>.sh restore '<txn>'
~/.hermes/.hstack/bin/hstack-target-<script_sha256>.sh purge '<txn>'
```

Use `artifacts.script_sha256` from the reviewed receipt for the filename; `abandon()` also returns the
exact recovery command. Restore closes the unapplied transaction; purge optionally removes its directory.

`verify`: all required checks `pass` -> `verified` (and the target transaction is committed); any required
check `fail` -> `rollback_required`; otherwise (`unknown`) it stays `applied_unverified` with
`unresolved:[check ids]`. `rollback`: the target `restore` must exit 0 **and** print `restore_verified=1`
(exit 0 alone, or `already_restored=1`, is not enough); then the gateway is reloaded through the
selected adapter's service operations because the running process may still hold the new environment, and a
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

This package's Hermes and Telegram tests use **test doubles**:

- `tests/acceptance/stubs/hermes` is a bash **test double** of an adapter surface *declared* in the contract.
  It is not Hermes and is not evidence about Hermes.
- The "Telegram" in the tests is that stub's outbox file; the delivery observer in the tests reads it.
- The sandbox transport runs the same remote strings under `env -i HOME=<tmp> PATH=/usr/bin:/bin bash -c`, so
  the commands covered by the golden fixtures are the commands the sandbox executes. Receipts produced that
  way say `transport_used: "sandbox"`.
- Golden SSH command fixtures (`tests/acceptance/golden/`) pin the exact command text of every op.
- A gated Docker target with a real `sshd` (`HSTACK_DOCKER=1`) is a separate deliverable; it still uses the
  stub `hermes`.

The separate [Founder Brief suite](../founder-brief/README.md) also exercises actual
loopback SSH and HTTP, and its production collector has been checked against public
GitHub. Those checks still use a native CLI fixture and do not establish a real
Hermes/Telegram deployment. See the [validation record](../../compatibility/VALIDATION.md).

**Live validation is the operator's job and is not claimed anywhere here:** a real Hermes at the declared
version, a real bot token and chat, and a real GitHub token, on a real VPS. Until a live run exists, treat
`contract.adapter_surface` as unverified. Secrets only ever travel on ssh stdin (`put-env`), are charset- and
length-checked, and appear in no argv, receipt, evidence file or log.

## Running the tests

```
node --test tests/acceptance/*.mjs tests/acceptance/target/*.test.mjs tests/acceptance/docker/*.test.mjs
                                              # host: node >= 18, python3, bash (macOS /bin/bash 3.2 is fine)
UPDATE_GOLDEN=1 node --test tests/acceptance/ops-golden.test.mjs   # regenerate golden command fixtures, then review the diff
```

Pass the files as shell globs, as above. `node --test tests/acceptance/` (a directory) works on Node 18 and 20 but
fails on Node 22 ("Cannot find module"), and a quoted pattern such as `'tests/acceptance/**/*.test.mjs'` works only on
Node 21+. The unquoted per-directory globs work on 18, 20 and 22. `tests/acceptance/*.mjs` includes
`test-acceptance-cases.mjs`, which does not end in `.test.mjs`; the Docker-gated tests are skipped unless
`HSTACK_DOCKER=1`.

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

- One workflow, one Linux target, one Hermes version per contract, one Telegram destination. No other platform, source,
  or runtime is accepted by the contract.
- The legacy adapter assumes `cron list` prints one job per line (`id TAB schedule TAB prompt`); that is a
  fixture protocol, not the current native CLI. The 0.22.5 adapter reads structured native job snapshots
  and changes jobs through the native CLI. Both remain unverified against a real running installation.
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
- `gateway run --daemon` does not exist at any Hermes release (`gateway run` is the foreground gateway; an unknown
  option is an argparse usage error, exit 2), and the test doubles reject it the same way. Reloading the gateway is
  `gateway restart` on the legacy 0.15.2 fixture (upstream tag `v2026.5.29.2`: no `-y`, no `gateway ensure`) and
  the following on 0.22.5, restricted to an exclusive default-profile Linux target with an installed systemd
  service: remember the current `instance_id` (`gateway ensure --json --timeout 10`), `gateway restart --detach`,
  then `gateway ensure --json --timeout 60` must exit 0 (exit 5/6 are retried twice), report `"state":"ready"` and
  carry a NEW `instance_id`. `restart` can exit 0 without restarting anything (linger case), and `instance_id` is a
  fresh uuid4 per gateway process, so only a changed id is proof. Without an installed service `restart` would run
  the gateway in the foreground of the ssh call; `--detach` keeps it in the background, and the readiness check
  then fails closed because the supervisor is not systemd.
- **Live sessions:** without a TTY, Hermes 0.22.5 refuses `restart` while sessions are live (exit 1). The
  transaction does not force it: the reload fails (`restart_refused_or_failed`); during rollback the files are
  restored and the result is `manual_recovery_required`, whose detail names the opt-in. Only the operator's explicit
  `new Transaction({ ..., interruptLiveSessions: true })` adds `-y` (`reload <txn> --interrupt-live-sessions` on the
  target), which interrupts those sessions. The default is false and the review shows the flag.
- A runtime version is accepted only if the whole string equals a supported version: `0.15.2.1`, `0.22.5.dev3` and
  `0.22.5+3.gabc` are `runtime_version_mismatch` and are recorded verbatim, never truncated to x.y.z. The version is
  read from the banner on the first line of `hermes --version` (`Hermes Agent v<ver> (<date>)`), because the lines
  after it (install directory, Python, OpenAI SDK) carry unrelated x.y.z tokens.
- A transaction can only be resumed on a transport of the same kind its receipt records (`ssh`, `sandbox` or
  `recording`); `Transaction.resume` throws `resume_transport_mismatch` otherwise.
- The cron prompt budget in the contract includes the `[hstack:<id>] ` marker the target prepends: the stored prompt
  must be at most 400 characters (the native adapter refuses longer), so a contract prompt must be shorter by the
  marker length and the contract is rejected at load otherwise.
- Receipts are unsigned and not tamper-evident (see above).
- `skills:sync` installs the shipped `skills/<name>` directories; a pre-existing unmanaged directory with a
  managed name is a collision and blocks the transaction.
- Secret handling is shape- and charset-based. Receipts reject known token shapes, but a secret in an
  unknown format that appears in free text would not be recognised; the code therefore never places target
  output or secret values in a receipt unredacted.

## Version promotion

Hermes 0.15.2 was published under upstream tag `v2026.5.29.2`. The default contract and its fixture pin
remain separate from the 0.22.5 contract. Reporting a matching version proves only the measured
string; it does not prove compatible job storage, service behavior, credentials, or delivery. Promotion
requires the live evidence recorded in [compatibility and promotion](../../compatibility/README.md),
including seven consecutive real-target golden-path days. No source review or passing stub suite silently
changes that policy.
