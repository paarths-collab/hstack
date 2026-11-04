# Google Analytics through Hstack

This profile uses Google's official `analytics-mcp` **0.8.0** local server with a
hash-locked Python 3.12 runtime. It replaces the generic executable placeholder.
See the [official setup guide](https://developers.google.com/analytics/devguides/MCP)
and [tagged release](https://github.com/googleanalytics/google-analytics-mcp/releases/tag/0.8.0).
The overview still describes read-only operation; the tagged source also has an
optional `--allow-write` annotation tool. Hstack does not pass that flag.

**Live Google account validation is pending.** Installed-process discovery and
missing-credential rejection do not prove an authenticated Analytics read works.

## Install the reviewed runtime

From the Hstack directory, with Python 3.12 and `uv` already installed:

```sh
python3.12 -I -B integrations/google-analytics/prepare-adk.py --download
uv venv --python 3.12 .hstack-tools/analytics
uv pip sync --python .hstack-tools/analytics/bin/python --require-hashes integrations/google-analytics/requirements.lock
```

Use a new environment; `sync` removes packages outside the lock from the selected
environment. Do not target a shared Python installation. The lock includes
Python MCP 2.3.0 and Google ADK 2.13.0. Runtime installation is explicit and does
not run automatically when Hermes starts. The package's ADK dependency does not
mean Hstack invokes a model.

### Why a compatibility wheel is required

Published ADK 2.13.0 dependency bounds exclude the fix for
[GHSA-xcq7-p3pf-p88h](https://github.com/advisories/GHSA-xcq7-p3pf-p88h).
Ordinary resolution cannot combine Analytics MCP 0.8.0 with that fix.
`prepare-adk.py` verifies the exact public upstream wheel SHA256 and creates a
deterministic `1hstack` build in ignored `.hstack-tools/analytics-wheels/`.
Only ADK's two OpenTelemetry dependency bounds change to API/SDK **1.45.1**, plus
wheel build/RECORD metadata. Vendor Python code and licences remain unchanged.
The lock pins the output hash; an existing differing artifact is refused.
There are no resolver overrides or ignored advisories.

This is an **Hstack compatibility build**, not an official ADK release or a claim
that Google supports this combination. Packaging, patched parsing, local trace
export and actual Analytics tool conversion/discovery are tested. The installed
graph passes consistency checks; its 64-package audit has no known vulnerabilities
or skipped packages. Other ADK functionality is outside the tested scope. Remove
the build when a reviewed official update resolves the conflict. If the pinned
artifact changes, review it rather than bypassing verification. For an offline
build, replace `--download` with
`--upstream-wheel /path/to/downloaded/google_adk-2.13.0-py3-none-any.whl`.

## Configure Google access yourself

1. Create/select your own Google Cloud project and enable the **Analytics Admin
   API** (`analyticsadmin.googleapis.com`) and **Analytics Data API**
   (`analyticsdata.googleapis.com`). Hstack does not create or modify projects.
2. In the Google Analytics UI, grant your user or service account at least
   **Viewer** access to the required GA4 property. Cloud IAM alone does not grant
   property access. Check your organisation's permissions and API quotas.
3. Use Google's Application Default Credentials (ADC) setup from the official
   guide. For user credentials, the documented command is:

   ```sh
   gcloud auth application-default login --scopes="https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform"
   ```

   Run this yourself only when ready to sign in and approve permissions. If your
   organisation requires your own OAuth client, add the guide's `--client-id-file`
   option. User ADC, service-account impersonation and service-account JSON are
   different setups; follow the appropriate Google instructions. Hstack does not
   mint a key, copy credential contents or replace native Google authentication.
4. Keep the ADC file private, outside this repository. Never paste its contents
   into `.env`, JSON configuration, arguments or chat. Use an absolute path and
   suitable owner-only file permissions. Google authentication libraries handle
   refresh where the chosen ADC type supports it.

## Prepare and validate

```sh
npm run build
node dist/manage.js plan google-analytics
node dist/manage.js prepare google-analytics
```

Privately review the candidate and select it using `HSTACK_CONNECTIONS_FILE` as
described in [batch setup](../../docs/onboarding.md). Existing customized entries
are preserved rather than overwritten. Add these names to your existing private
`.env`, using your actual absolute paths/project ID:

```dotenv
HSTACK_ANALYTICS_PYTHON=/absolute/path/to/hstack/.hstack-tools/analytics/bin/python
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/private/application_default_credentials.json
GOOGLE_CLOUD_PROJECT=your-project-id
```

The profile maps the project to both `GOOGLE_CLOUD_PROJECT` and Google's explicit
`GOOGLE_CLOUD_QUOTA_PROJECT` in the child. This avoids relying on a desktop shell
or an unrelated ADC quota-project default. The credential principal must be
permitted to use that quota project; enabling the APIs and granting Analytics
property access are separate requirements. If your organisation uses a different
quota project, review the environment mapping privately before activation.

```sh
node --env-file=.env dist/manage.js doctor google-analytics
node --env-file=.env dist/manage.js check google-analytics
node --env-file=.env dist/manage.js verify google-analytics
```

`doctor` is offline and checks setting names/executable presence. It does not
open the ADC file or validate authentication. `check` launches the server and
discovers schemas without API tools. This can pass even when credentials are
missing. `verify` explicitly calls `get_account_summaries` and requires a valid
account-summary result; raw account data is hidden in terminal output. It consumes
an Admin API request. An empty successful result does not establish access to a
particular property or prove that a reporting request works.

After a real read succeeds, enable the profile and restart Hstack in Hermes.
Ask it to list accessible accounts, select the intended property, and run a small
report. Property IDs and API validation errors must come from the actual account;
do not invent IDs. All nine tagged read tools are allowed, including report,
realtime, funnel and conversion reads. Calls still consume vendor quotas.
Writes remain disabled in both the vendor command and Hstack. Granting a Hstack
`writeTools` permission alone cannot enable a vendor tool that was not exposed.
The `login`/`disconnect` commands manage native HTTP OAuth, not this ADC profile;
manage/revoke Google credentials through Google's own account and CLI tools.

## Repeatable checks and limits

After installation, set `HSTACK_ANALYTICS_PYTHON` in the shell and run:

```sh
npm run verify:analytics-runtime
```

Separate offline packaging and installed tracing regressions:

```sh
python3.12 -I -B integrations/google-analytics/tests/test_adk_build.py
.hstack-tools/analytics/bin/python -I -B integrations/google-analytics/tests/test_tracing.py
```

This opt-in test uses an isolated temporary home, a nonexistent synthetic ADC
path and a Python network guard. It checks five installed source files against
the official release, actual nine-tool discovery, preservation of all nine
schemas, and missing-ADC failures through direct MCP and Hstack. A test-only
upstream exposes its annotation tool so Hstack's default block is exercised;
no annotation operation is dispatched. The test uses no real credentials.

If `HSTACK_TEST_HERMES_ROOT` and `HSTACK_TEST_HERMES_PYTHON` point to an existing
Hermes checkout/interpreter, it also checks native registry discovery and write
blocking in a temporary configuration. This is not a successful Google API read
or a model-driven conversation. Real account auth, refresh, report operations,
Linux/Windows behaviour and hosted quotas remain unverified.

Compared with a direct connection, Hstack adds shared preparation, exact
permissions, focused discovery and health/error reporting across services. A
single direct Analytics MCP may be simpler. It does not remove Google's account,
consent, project, property-access or quota requirements.
