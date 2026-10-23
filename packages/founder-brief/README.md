# Ready-to-use GitHub workflows for Hermes

Choose a repository activity brief, a requested-review queue or a release digest.
Each pack collects different GitHub facts and sends one bounded plain-text report
to a verified private Telegram chat. Hermes owns scheduling; hstack supplies the
report, private setup, preview, delivery journal and owned rollback. No model is
called. The directory retains its original `founder-brief` name for compatibility.

Use native Hermes directly for a flexible scheduled AI summary. These packs are
for people who want the supplied deterministic report without writing a worker,
assembling configuration or integrating a sender. See the executable
[setup comparison](COMPARISON.md) for what was measured.

It is an **unpromoted Hermes 0.22.5 candidate**. Local HTTP integration tests and
native CLI fixtures do not establish real-server or recipient delivery. A Telegram
API acknowledgement means the API accepted the exact text for the checked chat;
it does not mean a person read it. Live promotion still requires the evidence in
[the compatibility policy](../../compatibility/README.md).

## Current completion status

The combined suite passes **48 top-level local tests**, including actual loopback
SSH/HTTP, all three report comparisons, preparation and preview checks. Component
counts and evidence are in the [validation record](../../compatibility/VALIDATION.md).
Native Hermes remains a CLI fixture in local integration checks; no real Telegram
message was sent. The latest unauthenticated public preview hit an API rate limit.

Live completion still needs the Linux target, selected repositories, private chat,
daily time/timezone and private credential files. See the
[validation record and live checklist](../../compatibility/VALIDATION.md).

## Choose the report

| Pack | Report | Time semantics |
|---|---|---|
| `activity-brief` | Default-branch commits and updated issues/PRs, with dated canonical links | Facts inside the stated reporting window |
| `review-queue` | Open, non-draft PRs with explicit user/team review requests; author and creation date; oldest first | Current API snapshot, including stale requests; displayed ages use the daily cutoff |
| `release-watch` | Published versions and links; stable releases and labelled prereleases | `published_at` inside the reporting window; drafts excluded |

The review queue does not infer approvals, CI status or merge readiness. Release
watch does not inspect assets or recommend dependency upgrades. There is **one
selected pack per exclusive default-profile target**, not three simultaneous jobs.
Changing an installed pack requires a migration review; setup refuses replacement.

- Selected repositories only, with canonical GitHub links.
- The selected pack's facts, with a clear quiet result when none match.
- A bounded report, with errors or incomplete pagination treated as failure.

Repository titles are data, never instructions. They cannot select another chat,
run commands, install integrations or push to GitHub. There is no AI inference cost.
GitHub API limits and Telegram availability still apply.

The configuration accepts **1–8 repositories** and a **1–168-hour window**. Each
source is limited to three pages of 100 records and a 2 MiB HTTP response. The
public Hermes repository exceeded those bounds during a live activity check. An
incomplete source prevents sending. Review queue needs the complete open-PR list;
release watch scans release history because creation order is not publication
order. More than 300 open PRs or releases can exceed the respective pack's bound
even with a narrow time window. Preview exposes this before installation.

## Prepare a pack without writing code or JSON

From the reviewed checkout, create a private parent outside the repository and
prepare a new directory. The command validates your choices and builds the runtime
locally; it downloads nothing and contacts no service.

```bash
mkdir -p -m 700 "$HOME/.hstack-prepared"
python3 -I -B packages/founder-brief/prepare.py \
  --workflow review-queue --repository octo-org/example \
  --chat-id 123456789 --at 09:00 --timezone Asia/Kolkata \
  --output "$HOME/.hstack-prepared/review-queue"
```

Repeat `--repository` for up to eight repositories. `--at` defaults to `09:00`,
`--timezone` to `UTC`, and `--window-hours` to `24`; the generated configuration
shows these choices. Existing output paths are refused. Files are private from
creation, including under a permissive or restrictive shell umask.

The output contains `runtime.pyz`, `config.json`, an optional invalid credential
example, and `NEXT_STEPS.md` with target command arrays and quoted shell commands.
Transfer runtime and configuration using your existing trusted route to a private
mode-700 directory on the Linux target. Paths in those instructions are explicit
placeholders; preparation does not transfer files or provision Hermes.

On an interactive target terminal, capture credentials through hidden prompts,
then preview the actual report without installing, changing Hermes or sending:

```bash
python3 -I -B /private/path/runtime.pyz credentials \
  --output /private/path/credentials.json
python3 -I -B /private/path/runtime.pyz preview \
  --config /private/path/config.json --credentials /private/path/credentials.json
python3 -I -B /private/path/runtime.pyz packs
```

The GitHub token prompt permits an empty answer for public repositories. Preview
also permits omitting `--credentials` for public repositories. The credential
command refuses non-interactive input, existing files and non-private parents.
No token goes in command arguments or logs. An existing runtime can also run
`prepare` with the same flags to create another preparation directory.

## Target prerequisites and configuration reference

The target must already have the exact candidate Hermes installation, an installed
systemd gateway, Python 3.9+ with timezone data, and an exclusive default profile.
This installer does not upgrade Hermes or reconfigure its other integrations.
Native Hermes Telegram and GitHub integration setup is not required for these
packs: the worker calls the APIs using its own private credential file, while its
native job delivers locally. You still need the bot token, a started private chat
and the appropriate repository read access. This keeps the app's credentials and
delivery configuration separate from shared Hermes settings.

The preparation command generates this configuration; manual JSON editing is
optional. Keep configuration and credentials outside the repository with mode
`600`. Example `config.json`:

```json
{
  "schema_version": 1,
  "workflow": "activity-brief",
  "repositories": ["octo-org/example"],
  "telegram_chat_id": "123456789",
  "daily_time": "09:00",
  "timezone": "Asia/Kolkata",
  "window_hours": 24
}
```

`credentials.json` contains `TELEGRAM_BOT_TOKEN` and `GITHUB_TOKEN`. The GitHub token
can be empty for public repositories; for private repositories grant only the
read access required for the selected repositories. Never paste credentials into
commands or chat. Start the bot in the intended private Telegram chat first.
Groups and channels are refused, including a group that the bot can access.

For a fine-grained private-repository token, review queue needs
[Pull requests: read](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#list-pull-requests);
release watch needs
[Contents: read](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10#list-releases).
Activity brief needs Contents, Issues and Pull requests read access. `packs` lists
each pack's sources, omissions and permissions.

## Review and install on the Linux target

Use the generated runtime and configuration. On the target, use absolute paths
and keep the same runtime for review and install:

```bash
python3 -I -B /private/path/runtime.pyz review \
  --home "$HOME/.hermes" --hermes "$HOME/.local/bin/hermes" \
  --config /private/path/config.json
```

Inspect the repository list, destination, daily time/timezone, managed files, exact
runtime hashes and native job. Supply the printed `plan_hash` to install:

```bash
python3 -I -B /private/path/runtime.pyz install \
  --home "$HOME/.hermes" --hermes "$HOME/.local/bin/hermes" \
  --config /private/path/config.json --credentials /private/path/credentials.json \
  --approve REVIEWED_HASH
```

Installation owns one script and `.hermes/.hstack/founder-brief/`. It preserves
global `.env`, Hermes configuration, unrelated jobs and other integrations. Existing
unmanaged workflow files or an earlier Founder Brief job cause refusal. An identical
installation is idempotent; changing an existing deployment requires a migration
review, rather than silently replacing it.

## Run the end-to-end canary

```bash
python3 -I -B /private/path/runtime.pyz canary \
  --home "$HOME/.hermes" --approve REVIEWED_HASH
```

This arms an immutable reporting window, prints a canary ID, invokes native
`hermes --profile default cron run`, and requires the resulting worker's matching
Telegram API acknowledgement. A successful cron exit alone cannot pass. Check the
actual message in Telegram separately before calling the real delivery verified.

After interruption, reuse the printed ID with `--run-id CANARY_ID`. Confirmed
requests return their existing proof without another send. An uncertain response
stays unknown and requires reconciliation; do not choose a new canary ID merely
to hide an uncertain prior send. A fresh invocation without `--run-id` is an
explicit request for another test message.

## Daily operation and recovery

Native cron triggers the no-agent worker every minute with delivery set to `local`.
The worker selects the latest daily cutoff in the configured timezone, then sends
at most once for that logical reporting window. It performs no HTTP calls when a
confirmed window is revisited. The minute trigger avoids depending on the gateway's
timezone and follows daylight saving changes: repeated hours use the first occurrence;
nonexistent wall times shift forward by the DST gap.

The first automatic brief waits for a cutoff after installation. Following downtime,
the latest eligible window is attempted; the worker does not flood all missed days.
Reporting windows can overlap when `window_hours` exceeds a day. Partial GitHub
collection never becomes a misleading no-activity message.

Credentials, immutable configuration, launcher and runtime must still match the
reviewed installation before HTTP or message dispatch. Private journal/receipt
files under `state/` bind the reporting window, configuration hash, destination
fingerprint, body hash, bot identity and returned Telegram message ID. They contain
no message text or credentials. Only bounded explicit rate-limit responses retry;
ambiguous sends are not blindly repeated.

```bash
python3 -I -B /private/path/runtime.pyz status --home "$HOME/.hermes"
python3 -I -B /private/path/runtime.pyz rollback \
  --home "$HOME/.hermes" --approve REVIEWED_HASH
```

`status` displays installation metadata: phase, installation time, review hash and
job ID. It is not a fresh health, credential or delivery test. Use the canary and
recipient observation for those checks.

Rollback removes only the unchanged owned job and payload. It preserves delivery
evidence and refuses user edits. It cannot recall Telegram messages. The legacy
acceptance transaction in `packages/acceptance/` remains a separate experimental
control-plane fixture; installing skill text there is not this runnable workflow.

## Offline checks

```bash
node --test --test-concurrency=3 tests/founder-brief/
node --test tests/acceptance/observer.test.mjs tests/acceptance/untrusted.test.mjs
```

Tests use private temporary directories, fake credentials, a native CLI fixture and
real loopback HTTP requests. Test clients are Python-only injection points, with no
CLI or configuration flag that redirects production credentials to a test origin.
No test result here should be described as a live GitHub/Telegram or seven-day run.
