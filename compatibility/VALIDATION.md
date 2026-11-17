# Validation evidence and limits

Updated: **17 November 2026**. Hermes **0.23.2** is source-verified, not live-verified.
All 97 skills remain in the catalogue. The dedicated GitHub report workers and
experimental acceptance transaction have been removed; their previous checks are
not evidence for the current product. Historical results remain in Git history.

## Hermes 0.23.2 refresh — 17 November 2026

The official stable release is pinned to commit
`ae2a81ccc00e9b7c06301523e5bb09608397149c`, with installer SHA-256
`c73dad4dcf7c9ecadb98578e28cc763d23d7be3fa1b513545319038795493214`.
The new source fixture provenance records and verifies the Git blob and SHA-256
of each vendored file. The historical 0.22.5 fixtures are unchanged.

Executed locally on macOS:

- All **2,295 skill regressions passed**, with no failures or skips. These include
  the 97 catalogue CLI parser contracts, exact source/installer provenance,
  early profile selection, rollback, gateway refusal and readiness checks.
- Stock macOS Bash installer: **411 passed**. Script regressions: **116 passed**.
  Recipe/plugin/removal regressions: **18 passed** in both the working and isolated
  publishing checkouts.
- **97 skill validations**, skill references and all three sample blueprints passed.
  Markdown Bash lint parsed **962 blocks** with no errors; 87 placeholder blocks
  were excluded.
- The Next.js production build and **26 browser checks passed**. Additional desktop
  and mobile preview checks confirmed six filled feature cards, their six guide
  links, the 0.23.2 version label and removal of the visible artwork credit.
- Gitleaks found no leaks in the publication tree; **seven scanner controls passed**.

The tagged gateway readiness JSON, endpoint instance identity and guarded restart
handlers were reviewed. All 22 literal native MCP catalogue entries referenced by
the skills exist in the pinned tree, including the supported `official/` aliases.
These are source and simulated checks; they do not establish live credentials,
model responses or a running gateway. The parser checks used Python 3.12; Python
3.10 or later is required, and the SSH harness preserves the runner’s selected
interpreter. PowerShell was not installed for this refresh, so its older results
below have not been re-established on 0.23.2.

Reviewed source: [gateway verdict](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway_runtime_cli.py),
[gateway lifecycle](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/gateway.py),
[MCP catalogue](https://github.com/NousResearch/hermes-agent/blob/ae2a81ccc00e9b7c06301523e5bb09608397149c/hermes_cli/mcp_catalog.py).

## Earlier catalogue migration

All 68 remaining integration procedures were migrated to reviewed native routes.
The [migration record](MIGRATION.md) explains the changes. Source fixtures bind
Hermes CLI parser checks and the immutable installer to the pinned commit.

Previously completed catalogue checks include 97 skill validations, 411 stock
macOS installer checks, 116 script checks and 207 PowerShell 7 checks on macOS.
Linux CI exposed empty branches inside three executable vendor probes; these were
fixed, with direct heredoc syntax regression coverage. These are dated local/CI
results, not a claim that every vendor or platform has been exercised live.

## Plugin refresh

The 0.4.0 package adds the portable Agent Plugins manifest and a Codex repository
marketplace. Claude Code 2.1.310 validation passed with documented warnings;
Codex CLI 0.164.0-alpha.11.1 discovered the local package. The portable manifest
passed the official JSON Schema check. Cursor's published format was reviewed,
but the refreshed plugin has not been loaded in a Cursor session.

See [plugin validation details](../docs/plugins.md). Repository manifests do not
establish public marketplace approval or installation in a user's clients.

## Current checks

Run the commands in the [test guide](../tests/README.md). Retained checks cover:

- Recipe plans, connector allowlists, plugin metadata and retired-workflow boundaries.
- Skill blocks against simulated SSH/HTTP/native command fixtures.
- Native CLI parser contracts and source provenance.
- Installer ownership, conflict preservation and selective installation.
- Skill references, catalogue counts, shell syntax and secret-scanner controls.

## Removal verification (26 October 2026)

- 18 recipe/plugin/removal regressions passed.
- The skill suite passed 2,294 of 2,295 tests in the sandbox. The remaining test
  was blocked from opening a loopback socket; its isolated rerun with local socket
  access passed. No skill test remains unresolved and no product fix was needed.
- Stock macOS Bash installer: 411 checks passed. Script regressions: 116 passed.
- PowerShell 7 on macOS: 207 checks passed, with zero failures or skips. This
  does not establish native Windows behavior.
- 97 skill validations, skill references, catalogue counts and three sample
  blueprints passed. Markdown Bash lint parsed 961 blocks with no errors (87
  placeholder blocks excluded). The changed shell script passed ShellCheck 0.11.0.
- Working-tree and history Gitleaks scans found no leaks; seven scanner controls passed.
- Portable plugin schema and local Codex discovery passed. Browser inspection
  confirmed that the loaded catalogue and fallback omit GitHub; the fallback
  Notion-to-Slack preview produces a reviewable plan without credentials.

## Still unverified

- A real server installation and gateway lifecycle on the pinned release.
- Live vendor authentication, model calls and all chat platform connections.
- Real Telegram recipient delivery and the seven-day live reliability gate.
- Native Windows ACL, junction and Windows PowerShell behavior.
- Plugin execution across all supported coding-agent clients.

No live credentials or paid APIs were used for this removal. Source and simulated
tests cannot satisfy the [live promotion policy](README.md).
