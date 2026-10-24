# Opt-in real Hermes cron integration

The normal suite uses a native-CLI fixture. This additional test executes the
actual Hermes `0.22.5` cron parser, command handler, job store, fire claims,
no-agent subprocess runner, completion bookkeeping and scheduler tick from commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Seven core source files are checked
against their exact upstream SHA-256 hashes before importing anything from Hermes.

The test creates three simultaneous hstack installations and checks each pack's
delivery, a confirmed replay with no additional HTTP, an upstream outage followed
by recovery, a scheduler tick, and independent rollback. Every native command and
worker runs in a fresh process, so the replay also exercises persisted state.

## Boundaries

GitHub and Telegram are loopback HTTP servers with synthetic data and credentials.
The hstack runtime bundle is built from the current checkout; its test launcher
injects those clients through the existing Python-only test seams. Production
endpoint and configuration validation remain unchanged.

Linux/systemd readiness is explicitly bypassed. The real top-level Hermes startup
bootstrap and its managed dependency activation are excluded, because they can
install a runtime. The test runs the real cron subcommand parser and handler
directly. This is **real native cron evidence with loopback vendors**, and does
not prove a live Linux gateway, a gateway restart, or delivery to Telegram.

All Hermes imports run in a temporary private home with a closed environment. The
test does not use an existing Hermes installation, read its credentials, install
system packages or start services. It downloads and installs nothing itself.

## Run

Provide an independent source checkout or source archive at the exact commit above
and a disposable Python **3.14.9** environment. This is the interpreter pinned by
that release's `pm/lock.json`; the harness refuses other interpreter versions.
Do not point at or modify your existing Hermes environment.

The minimal test environment used for this integration contains:

```text
python-dotenv==1.2.2
croniter==6.0.0
ruamel.yaml==0.18.16
PyYAML==6.0.3
rich==14.3.3
packaging==26.0
requests==2.33.0
psutil==7.2.2
```

These are a test dependency subset, not a fully synchronized Hermes installation.
Use a disposable environment for installation; no application credentials belong
in it. From the hstack repository root:

```bash
HSTACK_REAL_HERMES_SOURCE=/absolute/path/to/exact-hermes-source \
HSTACK_REAL_HERMES_PYTHON=/absolute/path/to/disposable-venv/bin/python \
node --test tests/founder-brief/real-native.test.mjs
```

Without both explicit environment variables, the test is skipped. A restricted
sandbox may require permission to bind the loopback HTTP servers.

The underlying helper emits a JSON evidence record when successful:

```bash
/absolute/path/to/disposable-venv/bin/python -I -B \
  tests/founder-brief/helpers/real-native-workflow.py \
  --source /absolute/path/to/exact-hermes-source
```

Live acceptance still requires a designated compatible Linux SSH target, a private
Telegram recipient and a private credential file. The production setup guide is
[`packages/founder-brief/README.md`](../../packages/founder-brief/README.md).
