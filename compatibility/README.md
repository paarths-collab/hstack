# Hermes compatibility and promotion

hstack targets Hermes **0.22.5** (`HERMES_VERSION` in [VERSIONS.txt](../VERSIONS.txt)), pinned to
commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e` with an immutable, hash-checked installer. It is
**source-verified, not live-verified**: its tagged interfaces were read and the offline and loopback tests pass,
but no real target has run it. State and promotion requirements are recorded in [hermes.json](hermes.json).
A successful offline test or a source review must never silently turn it into a "live-verified" claim.

The default acceptance contract is a **legacy offline fixture** for Hermes 0.15.2
(`HERMES_LEGACY_FIXTURE_VERSION`). It does not establish that a real Hermes installation works. That
runtime's historical upstream tag is `v2026.5.29.2`, not `v0.15.2`. No skill targets it.

The activity, requested-review and release packs and local end-to-end checks are complete. Real
target/Telegram validation is pending. See the dated [validation record](VALIDATION.md)
for passing checks, collection limits and the remaining live checklist.

## Explicit contract selection

The 0.22.5 contract is
[`founder-brief-github-telegram.hermes-0.22.5.candidate.contract.json`](../acceptance/founder-brief-github-telegram.hermes-0.22.5.candidate.contract.json).
Load it explicitly with `loadContract(CANDIDATE_CONTRACT_PATH)` or pass that file
to the acceptance CLI's review command. The default contract remains the legacy fixture.
The two contracts use distinct version-source keys (`HERMES_VERSION` and
`HERMES_LEGACY_FIXTURE_VERSION`) and CLI surfaces; a contract cannot silently combine them.

The 0.22.5 contract requires Python 3 and is restricted to one Linux target with an
installed systemd gateway service using the exclusive default Hermes profile.
Native job and service mutations must explicitly select that profile and refuse known
shared or unsupported profile layouts. The gateway is a host service: restarting
it must not be presented as an isolated operation on an arbitrary named profile.

The 0.22.5 deployment path supports Telegram only. The other seven
platform recipes remain outside this migration and must not be presented as
current-Hermes-compatible because they appear in the catalog.

## Native interfaces

Current Hermes does not expose the prompt in `cron list`, and that human-readable
output is not a structured job inventory. 0.22.5 cron inspection therefore
needs a strict, read-only adapter for the pinned native job schema. Native job
changes use Hermes's own CLI; hstack must not rewrite the live job store or import
upstream readers that can repair it during supposedly read-only inspection.

`gateway run` is foreground and has no `--daemon` flag (an unknown option is an argparse usage error, exit 2, at
every release). Reload by remembering the current `instance_id` (`gateway ensure --json --timeout 10`), running
`gateway restart --detach`, then requiring `gateway ensure --json --timeout 60` to exit 0 with state `ready` and a
NEW `instance_id` (exit 5/6 retried twice): `restart` can exit 0 without restarting, and without an installed
service it would otherwise run the gateway in the foreground of the calling shell (`--detach` avoids that). `-y`
is added only when the operator explicitly opts in to interrupting live sessions; otherwise a refused restart
fails the reload (and a rollback ends in `manual_recovery_required` naming the opt-in). The 0.15.2 fixture reloads with a plain
`gateway restart`; that release has no `-y` and no `ensure`. Reviewed helper hashes must cover the
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

Before any "live-verified" claim, or before changing the pinned version, collect at least seven consecutive days of
the real-target golden path on the exact release. Evidence must cover
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
deployment supports multiple named instances on the same default-profile target.
Each owns its script, runtime, configuration, credentials, journal and native
no-agent job; legacy unlabelled installations keep their original namespace.
The older acceptance transaction remains an experimental control-plane fixture.
An API acknowledgement from the runnable worker is explicitly distinguished from
recipient observation and does not satisfy the live promotion gate by itself.

On a new upstream stable release, compare its tagged interfaces and upgrade notes
with the compatibility record. Review installation ownership, package-manager
behavior, profile/service boundaries, cron storage and commands, connectors and
memory migrations. Prepare a separate contract and tests before moving the pin.
Keep unexpected changes visible instead of adding a version to an allowlist just
to make a test green.

The local recurring check can prepare reviewable changes. It does not commit,
push, publish, deploy, use live credentials or promote a release automatically.

Primary references: [0.22.5 release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5),
[tagged cron CLI](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/cron.py),
[tagged gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py),
and [official update ownership](https://hermes-agent.nousresearch.com/docs/getting-started/updating).
