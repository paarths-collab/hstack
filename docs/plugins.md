# Claude Code, Codex and Cursor plugins

The repository distributes the same 97 setup skills through three host formats
and a portable Agent Plugins manifest. The plugin identity remains `hstack`.
The refreshed package version is **0.4.0**, targeting source-verified Hermes
**0.22.5**. Installing a plugin makes procedures available to the coding agent;
it does not deploy Hermes, connect vendor accounts or activate an automation.

## Package files

| File | Purpose |
|---|---|
| `plugin.json` | Portable Agent Plugins 1.0 manifest; discovers root `skills/` |
| `.claude-plugin/plugin.json` | Claude plugin metadata; uses default `skills/` discovery |
| `.claude-plugin/marketplace.json` | Claude repository marketplace, plugin source `./` |
| `.codex-plugin/plugin.json` | Codex compatibility manifest, synchronized with portable metadata |
| `.agents/plugins/marketplace.json` | Codex repository marketplace; plugin is available, not automatically installed |
| `.cursor-plugin/plugin.json` | Cursor compatibility manifest with explicit `./skills/` |

All paths resolve from the plugin or marketplace root, not from the hidden
manifest directory. Keep the skill tree and supporting repository files together.

## Claude Code

In Claude Code:

```text
/plugin marketplace add paarths-collab/hstack
/plugin install hstack@hstack
```

For an older installed copy, refresh the marketplace and update the plugin:

```bash
claude plugin marketplace update hstack
claude plugin update hstack@hstack
```

Start a new session after updating. Invoke a skill such as `/hstack:hermes-status`.
The repository's root `CLAUDE.md` describes repository maintenance; Claude does
not automatically inject it as installed-plugin context. Runtime instructions
belong in the individual skill files.

## Codex

Register the repository, then use `/plugins` in Codex CLI or the desktop Plugins
browser to select the `hstack` marketplace and install `hstack`:

```bash
codex plugin marketplace add paarths-collab/hstack --ref main
```

On CLIs that expose `plugin add`, installation is also available as:

```bash
codex plugin add hstack@hstack
```

To refresh an existing Git marketplace:

```bash
codex plugin marketplace upgrade hstack
```

Inspect the installed version in the plugin browser and apply its update/reinstall
flow if it is still cached at an older version. Start a new session afterwards.
Marketplace refresh and plugin installation are separate operations. A repo
manifest does not establish a listing in the universal public directory.

For local development, register the repository root with
`codex plugin marketplace add /absolute/path/to/hstack` instead of the Git URL.
Project trust and managed marketplace policies can affect local discovery.

## Cursor

For a local plugin, copy the repository's plugin files and supporting directories
into `~/.cursor/plugins/local/hstack`, then restart Cursor or run **Developer:
Reload Window**. Open **Customize** and confirm the expected skills are present.
An external symlink into a checkout is not a supported substitute: Cursor skips
local-plugin symlinks whose targets are outside its local-plugin directory.

For an existing local copy, back up local modifications before replacing it with
the updated package. A marketplace installation of the same plugin can take
precedence over the local copy; inspect the installed source before updating it.

For team distribution, an administrator can import the repository through
**Dashboard → Plugins & MCPs → Add Marketplace → Import from Repo**, review the
plugin and make it available. Use **Refresh**, or the supported GitHub Auto
Refresh option, to pick up repository updates. Public Cursor Marketplace
publication requires a separate reviewed submission; it is not implied by these
manifest files. Managed policies may disable local plugin imports.

## Validation and limits

```bash
node --test tests/recipes/test-plugins.mjs
claude plugin validate .
```

The regression suite checks manifest consistency, skill discovery, contained
paths, catalogue counts, Codex presentation limits and CI triggers. Anthropic's
validator is the authoritative Claude manifest check. On the full repository it
warns that root `CLAUDE.md` is not plugin context; `--strict` therefore fails on
that intentional repository file. A missing public-listing icon is also reported
as a separate directory warning. Neither is proof of a runtime failure, and this
repository does not claim a completed public directory submission.

Native Codex marketplace discovery can be checked without changing saved settings:

```bash
codex -c 'marketplaces.hstack.source_type="local"' \
  -c "marketplaces.hstack.source=\"$PWD\"" \
  plugin list --marketplace hstack --available --json
```

Checked on 26 October 2026 with Claude Code 2.1.310 (standard validation passes
with the warnings above) and Codex CLI 0.164.0-alpha.11.1 (native discovery reports
`hstack@hstack` version 0.4.0). Cursor compatibility is checked against its published
format and the portable JSON Schema; the plugin has not been loaded into a Cursor
session as part of this source update.

Schema checks and discovery are not live execution tests in all three hosts.
Installing/updating a user's existing plugins, publishing directory listings and
running the skills against a real server require their own task scope. See the
[compatibility evidence](../compatibility/VALIDATION.md) for live validation limits.

## Official format references

- [Claude plugin manifests](https://code.claude.com/docs/en/plugins/manifest-reference)
- [Claude marketplace and update commands](https://code.claude.com/docs/en/plugins/cli-reference)
- [OpenAI plugin packaging and marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Codex marketplace configuration](https://developers.openai.com/codex/config-reference)
- [Cursor plugin reference](https://cursor.com/docs/reference/plugins)
- [Cursor local installation and updates](https://cursor.com/docs/plugins)
