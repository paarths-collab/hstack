# Zendesk through Hstack

This uses the community [michaelrice/zendesk-mcp v0.1.6](https://github.com/michaelrice/zendesk-mcp/releases/tag/v0.1.6),
with Python MCP 2.3.0 and hash-locked dependencies. It is not an official Zendesk
MCP server. Fourteen JSON read tools are permitted. Native write tools are
suppressed; attachment downloads and other unreviewed tools remain blocked.

**Real account validation is pending.** The installed vendor process has been
tested against a synthetic local OAuth/API fixture, including native Hermes
registry calls. No real Zendesk account, consent, eligibility, endpoint operation,
refresh token or model-driven conversation was tested.

## Install and prepare

With Python 3.12 and `uv` already installed, run from the Hstack directory:

```sh
uv venv --python 3.12 .hstack-tools/zendesk
uv pip sync --python .hstack-tools/zendesk/bin/python --require-hashes integrations/zendesk/requirements.lock
npm run build
node dist/manage.js plan zendesk
node dist/manage.js prepare zendesk
```

Use a new Python environment: `sync` removes packages outside the lock. Review
the private candidate and select it with `HSTACK_CONNECTIONS_FILE`; see
[batch setup](../../docs/onboarding.md). Existing customized entries are preserved.
No installation, account creation or sign-in happens during server startup.

## Native vendor authentication

An eligible Zendesk account and an admin-created OAuth client are required.
Follow the tagged vendor guide for application registration and current account
requirements. Its callback is **`http://localhost:8787/callback`**, belonging to
the vendor setup command, not Hstack's separate HTTP OAuth flow.

Create a dedicated directory outside the repository, owned by you and mode
0700. Do not use your normal home directory. The vendor uses its child process's
`HOME` to locate `.config/zendesk-mcp/config.json` and attachment cache paths.
Hstack refuses a shared home, symlinks, unsafe config modes or multiply-linked
credential files. Existing files are never chmod-ed or replaced by Hstack.

When ready to sign in, run this yourself with your actual paths:

```sh
env HOME=/absolute/path/to/private-zendesk-home /absolute/path/to/hstack/.hstack-tools/zendesk/bin/python -I -m zendesk_mcp setup
```

This changes `HOME` for that child process only. The vendor prompts for your
subdomain and OAuth client credentials, then opens its authorization flow.
**Its setup requests `read write` OAuth scope even for this read-only MCP
profile.** Review consent and account permissions; Hstack's tool policy does not
narrow the underlying grant. Do not approve permissions you do not want.
Do not run setup automatically or share tokens in chat.

The native file stores the access/refresh tokens and client secret in plaintext.
The tagged vendor saves it atomically with mode 0600; its final config directory
must be private (0700). Hstack checks metadata without opening or copying the
credential contents. The vendor owns token refresh and revocation semantics.
Manage or revoke the grant through Zendesk; Hstack's HTTP `login`/`disconnect`
commands do not manage this native store.

Add the following names to your existing private `.env`:

```dotenv
HSTACK_ZENDESK_PYTHON=/absolute/path/to/hstack/.hstack-tools/zendesk/bin/python
HSTACK_ZENDESK_HOME=/absolute/path/to/private-zendesk-home
ZENDESK_MCP_READ_ONLY=true
```

Keep `.env` private. The profile passes that home only to the vendor subprocess;
it does not alter the user's shell or normal Hermes home. It never passes a
token or secret in arguments. The reviewed result policy requires native
read-only mode. Enabling remote writes is outside this profile's verified scope;
an Hstack `writeTools` entry cannot expose a native tool that was suppressed.

## Check and use

```sh
node --env-file=.env dist/manage.js doctor zendesk
node --env-file=.env dist/manage.js check zendesk
node --env-file=.env dist/manage.js verify zendesk
```

`doctor` is offline; it does not inspect stored credentials or run vendor code.
`check` discovers tools and can pass before OAuth setup. `verify` explicitly calls
`zendesk_get_groups`, validates group JSON and hides account contents. It consumes
a real API request when configured. A successful group read does not prove that
every ticket/report operation is permitted. Enable the reviewed profile and
restart Hstack only after an actual read succeeds.

The default reads cover ticket search/list/detail/comments, views, macro listing,
users/groups, organisations, custom statuses and time-tracking reads. The native
read-only server exposes 19 tools; Hstack initially permits 14. Attachment
downloads can write local files and are deliberately excluded. Markdown export,
Git-Zen and macro preview are also outside the reviewed allowlist. Upstream
prompts and Help Center resources are not relayed by Hstack's tool gateway.

## What Hstack adds here

The vendor returns several authorization/API failures as ordinary successful
text results. Hstack's explicit v0.1.6 policy turns those JSON-read failures into
errors with safe remediation. It preserves valid JSON, including ticket content
that contains error-like words, and does not scan Markdown for keywords.

The vendor refreshes tokens but does not lock the read-refresh-write sequence
across processes. Hstack serializes calls sharing the same private vendor home,
using an owner-only `.hstack-zendesk-locks` directory there. No credential copy is
created. Waiting shares the call deadline and cancels before dispatch. Token-file
permissions are rechecked under the lock. Existing cross-process native OAuth
storage and this separate native-vendor lock have different locations.

**All concurrent clients of this native token file must use Hstack's guard.** A
standalone vendor client or the vendor setup command does not acquire this lock.
Stop those processes before setup/reauthorization. Locks are not stolen after a
crash; verify every owner is stopped before removing an abandoned lock directory.
POSIX file protections are implemented; Windows support is pending.

The controlled comparison used two real installed vendor processes with synthetic
expired credentials and a local HTTP fixture. Direct access attempted two
rotations: one succeeded and one was rejected. Two Hstack processes performed
one rotation and both group reads succeeded. This demonstrates the tested race
and guard, not real Zendesk compatibility, setup-time savings or production
latency. A single direct connection can still be simpler.

## Repeat the process test

Set `HSTACK_ZENDESK_PYTHON` in your terminal, then run:

```sh
npm run verify:zendesk-runtime
```

This opt-in test creates and removes its own homes, synthetic token files and
local HTTP fixture. Five installed source files must match the tag. It checks all
14 allowed schemas and missing-auth failures, native write suppression, download
blocking, actual vendor refresh logic and the direct/Hstack concurrency difference.
Only network routing is replaced; requests cannot leave the loopback fixture.
It reads no normal credentials. Optional existing `HSTACK_TEST_HERMES_ROOT` and
`HSTACK_TEST_HERMES_PYTHON` paths add a temporary native registry check, without a
model. All of this remains fixture evidence; see [verification.json](verification.json).

Vendor API quotas and error headers may be lost by the community server's text
error rendering. Hstack does not invent quota windows, provide an encrypted vault
or prove live refresh/revocation from these tests. Use a real eligible account to
complete acceptance before production use.
