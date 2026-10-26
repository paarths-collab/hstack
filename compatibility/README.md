# Hermes compatibility

hstack targets **Hermes 0.22.5**, pinned in [VERSIONS.txt](../VERSIONS.txt) to
commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e` with an immutable, hash-checked
installer. The catalogue is **source-verified, not live-verified**. See the
[machine-readable record](hermes.json), [migration notes](MIGRATION.md) and
[validation evidence](VALIDATION.md).

## Supported scope

The deployment procedure targets a host-installed Linux system with an exclusive
default Hermes profile and Telegram. Other platform skills configure an existing
compatible installation. Their presence in the catalogue does not establish
successful authentication or delivery against every platform.

Prefer native Hermes installation, connectors, plugins, profiles, scheduling,
backups and updates. Procedures must state what they change and what recovery
cannot undo. The retired GitHub-to-Telegram workers and their experimental
acceptance transaction are no longer distributed. The standalone GitHub
integration skill remains available.

## Native interfaces

`gateway run` is foreground and has no `--daemon` option. The reviewed procedures
record the current instance with `gateway ensure --json --timeout 10`, request
`gateway restart --detach`, then require readiness and a new instance identity.
A successful restart exit code alone is insufficient. Interrupting active chats
requires explicit operator consent; a refused restart must not be reported as a
successful reload.

The source fixtures check pinned CLI syntax and isolated behavior. They do not
prove a running daemon, valid vendor credentials, a model response or recipient
observation. Keep local checks distinct from live evidence.

## Live verification and promotion

Before describing a release as live-verified or changing the pin, collect at least
seven consecutive days of real-target evidence on the exact release. Cover
installation/version detection, configuration, native scheduling, an observed
private test delivery, restart, an injected failure and recovery, and preservation
of unrelated state. Explicit review is required. Never commit credentials, private
chat identifiers, recordings or local paths as evidence.

## Upstream review

For a new official release, compare tagged source and release notes with the
interfaces used by the skills. Review installation ownership, profile/service
boundaries, scheduling, connectors and memory migrations. Prepare bounded changes
and tests before changing the pin. Source review alone cannot promote a release.

The recurring compatibility check may prepare local changes; it does not commit,
push, deploy, use live credentials or promote releases automatically.

Official sources: [release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.5),
[gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py),
[cron CLI](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/cron.py).
