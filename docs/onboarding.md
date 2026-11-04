# Prepare several connections safely

These commands prepare local configuration for the 30-service catalogue. They
do not create accounts, install vendor software, sign in, contact services or
execute tools. Buffer and the other built-in social adapters use the separate
[social setup](social-package.md).

Run from the Hstack directory after `npm ci --ignore-scripts` and `npm run build`:

```sh
node dist/manage.js catalog
node dist/manage.js plan mongodb redis
node dist/manage.js prepare mongodb redis
```

`catalog` lists available candidate templates and their evidence. All 30 current
entries have templates. Availability means a template can be prepared, not that the service has
been tested with your account. Choose IDs from that output. `plan` shows public
defaults, change names and recorded evidence; it prints no existing private values.

By default the source is `connections.json` in the Hstack directory. To use a
different source, set `HSTACK_CONNECTIONS_FILE` before running these commands.
If you keep that setting in `.env`, use `node --env-file=.env dist/manage.js ...`
consistently so management and the MCP server select the same file.

## Review the candidate

`prepare` prints an absolute candidate path inside a new `.hstack-setup/candidate-*`
directory beside the source. It never edits the source or selects the new file.
There is no need to initialize or copy the entire example first.

- New profiles start disabled, with no write opt-in.
- Only an untouched, disabled legacy placeholder can be replaced. Customized
  profiles are preserved, including their existing enabled state and permissions.
- Other connections and top-level settings are retained. The accompanying
  `plan.json` records the actions, public defaults and source fingerprint.
- Unknown or duplicate IDs fail before creating a candidate. An unresolved generic
  vendor placeholder is also rejected if introduced in a future catalogue.
  Invalid source configuration fails without changing it.

Read the candidate in your editor and follow each service's linked setup guide.
Install the pinned vendor runtime if required. Add credential/environment values
privately and review exact read-tool permissions. Existing configured entries
are not silently upgraded to the bundled defaults.

The candidate copies your full configuration and can contain private values.
Its directory is owner-only (0700) and its files are owner-only (0600). Git ignores
`.hstack-setup/`; do not share, upload or commit these files. Private candidate
creation currently requires POSIX permissions. On Windows, use `plan` and configure
manually; equivalent Windows ACL handling is not implemented.

## Select and validate

After review, set `HSTACK_CONNECTIONS_FILE` in your private `.env` to the absolute
candidate path. Keep the original as recovery. The candidate is a snapshot:
later source edits are not merged automatically. Preparing a fresh candidate
also does not copy changes from an earlier candidate unless it is selected as
the source.

```sh
node --env-file=.env dist/manage.js doctor mongodb
node --env-file=.env dist/manage.js check mongodb
node --env-file=.env dist/manage.js verify mongodb
```

`doctor` checks local prerequisites offline. `check` connects and discovers
schemas, but runs no tool. `verify` executes a reviewed read and currently supports
MongoDB, MySQL, Redis, Mailchimp, Zendesk, QuickBooks and Google Analytics. For native HTTP OAuth profiles, run `login <id>`
explicitly before `check`; see [OAuth setup](oauth.md). These checks can run while
the profile is disabled, so it need not be exposed to Hermes during setup.

Zendesk and QuickBooks are local native-OAuth runtimes: use their separate vendor setup commands,
not Hstack HTTP `login`. Google Analytics similarly uses native Google ADC.

After a successful read, explicitly enable the reviewed profile in the selected
candidate and restart Hstack in Hermes. Keep writes blocked unless you choose
exact `writeTools` names. Existing enabled connections in a copied configuration
remain enabled. The gateway uses the file selected at its own startup; selecting
a file for a terminal command does not change an already running server.

The real disposable MongoDB test exercises this preparation path and then native
Hermes registry calls. It uses synthetic data, not a hosted account or model-driven
conversation. Most catalogue services still need account validation; see
[current evidence](production-readiness.md).
