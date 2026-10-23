# Hermes compatibility and promotion

hstack's default acceptance contract is a **legacy offline fixture baseline** for
Hermes 0.15.2. It does not establish that a real Hermes installation works. That
runtime's historical upstream tag is `v2026.5.29.2`, not `v0.15.2`.

The current migration candidate is Hermes **0.22.5**, pinned to commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Candidate state and promotion
requirements are recorded in [hermes.json](hermes.json), independently of the
baseline pin in [VERSIONS.txt](../VERSIONS.txt). A successful offline test or a
source review must never silently promote the candidate.

The activity, requested-review and release packs and local end-to-end checks are complete. Real
target/Telegram validation is pending. See the dated [validation record](VALIDATION.md)
for passing checks, collection limits and the remaining live checklist.

## Explicit candidate selection

The candidate contract is
[`founder-brief-github-telegram.hermes-0.22.5.candidate.contract.json`](../acceptance/founder-brief-github-telegram.hermes-0.22.5.candidate.contract.json).
Load it explicitly with `loadContract(CANDIDATE_CONTRACT_PATH)` or pass that file
to the acceptance CLI's review command. The default contract remains unchanged.
Candidate and baseline contracts use distinct version-source keys and CLI
surfaces; a contract cannot silently combine them.

The candidate requires Python 3 and is restricted to one Linux target with an
installed systemd gateway service using the exclusive default Hermes profile.
Native job and service mutations must explicitly select that profile and refuse known
shared or unsupported profile layouts. The gateway is a host service: restarting
it must not be presented as an isolated operation on an arbitrary named profile.

The migrated candidate deployment path supports Telegram only. The other seven
platform recipes remain outside this migration and must not be presented as
current-Hermes-compatible because they appear in the catalog.

## Native interfaces

Current Hermes does not expose the prompt in `cron list`, and that human-readable
output is not a structured job inventory. Candidate cron inspection therefore
needs a strict, read-only adapter for the pinned native job schema. Native job
changes use Hermes's own CLI; hstack must not rewrite the live job store or import
upstream readers that can repair it during supposedly read-only inspection.

`gateway run` is foreground and has no `--daemon` flag. Use the reviewed native
service interface and verify readiness. Reviewed helper hashes must cover the
complete native adapter as well as its shell wrapper.

The older acceptance recovery adapter permits recurring five-field numeric jobs
with options its reviewed CLI can recreate. It refuses unsupported origins,
context sources, scripts, custom base URLs and toolset overrides before backup.
The separate report-pack deployment deliberately owns a reviewed script and
native `--script --no-agent` job; the acceptance adapter's script restriction does
not apply to that separate deployment.

The adapter's JSON reads do not import Hermes or repair its store. However,
inspection still invokes `hermes --version`; upstream startup can run maintenance
before dispatch. A live zero-write inspection guarantee has not been established
by the offline command fixture and must be checked on a disposable installation.

Prefer native Hermes installers, the package manager, stable updates, connectors,
plugins, memory setup, profiles and scheduling. Retain custom plumbing only for a
demonstrated gap. A workflow-specific approval, verification or recovery layer
must describe exactly which changes it owns and what it cannot undo.

## Promotion evidence

Before changing the baseline version, collect at least seven consecutive days of
the real-target golden path on the exact candidate release. Evidence must cover
installation/version detection, safe configuration, scheduling, a real delivery
to the configured private destination, restart, an injected failure and recovery,
and preservation of unrelated user state. Never commit real secrets, recordings,
chat identifiers, local paths or private project data as evidence.

Record gaps and failures explicitly. Parser-backed tests establish accepted CLI
syntax; synthetic job fixtures establish behavior against that schema. Neither
proves a real daemon, vendor authentication, model response or message delivery.

## Ongoing review

The three runnable GitHub report packs are documented in
[`packages/founder-brief/`](../packages/founder-brief/README.md). Its separate private
deployment owns its script, runtime, configuration, credentials and native no-agent
job. The older acceptance transaction remains an experimental control-plane fixture.
An API acknowledgement from the runnable worker is explicitly distinguished from
recipient observation and does not satisfy the live promotion gate by itself.

On a new upstream stable release, compare its tagged interfaces and upgrade notes
with the compatibility record. Review installation ownership, package-manager
behavior, profile/service boundaries, cron storage and commands, connectors and
memory migrations. Prepare a separate candidate and tests before promotion.
Keep unexpected changes visible instead of adding a version to an allowlist just
to make a test green.

The local recurring check can prepare reviewable changes. It does not commit,
push, publish, deploy, use live credentials or promote a release automatically.

Primary references: [0.22.5 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5),
[tagged cron CLI](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/cron.py),
[tagged gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py),
and [official update ownership](https://hermes-agent.nousresearch.com/docs/getting-started/updating).
