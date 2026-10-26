# Hermes 0.22.5 catalogue migration

The catalogue contains 97 procedures: 15 core, one SSH prerequisite, eight chat platforms, 71 integrations and two blueprints. The selected runtime is [Hermes v0.22.5](https://github.com/NousResearch/hermes-agent/tree/bf0203a794a07aac3ff764972ab9087baa4e4f4e), commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`.

All migration batches target that host-installed release and its exclusive default profile. Source/parser checks and isolated test clients establish the reviewed interfaces and failure handling. They do not establish real vendor account access or a live gateway restart. See [validation evidence](VALIDATION.md) and [live acceptance requirements](README.md).

## What changed

| Area | Before | Now |
|---|---|---|
| Gateway lifecycle | Invalid daemon flags, status-text matches and unconditional interruption | Native restart/ensure, literal interruption opt-in, readiness and instance checks |
| Runtime selection | Loose version substrings and container fallback into host commands | Exact stable-version token and host-only preflight |
| Integrations | Mixed custom MCP snippets, placeholder packages and inert REST notes | Pinned native catalog/custom MCP routes or discoverable executable Hermes skills |
| Authentication | Static credentials applied to some OAuth-only services | Native OAuth where required; browser consent remains a user action |
| Recovery | Some legacy procedures removed keys or overwrote state | Prior env/config snapshots, owned artifact recovery, refusal on conflicts |
| Legacy acceptance | Recovery could run against an unknown upgraded runtime | Only the original exact fixture runtime is accepted; otherwise retain the backup |
| Weekly reporting | A valid seven-local-day fall-back window failed the collector | Calendar-day scheduled windows accepted; standalone explicit elapsed limits retained |
| Validation | Parser checks concentrated on the first migration wave | Every catalogue procedure is checked against pinned native argparse |

## Integration routes

GitHub, Notion and Obsidian retain their separately reviewed native MCP/skill procedures.
The remaining 68 procedures were migrated in three ownership batches, covering the original catalog, header-auth, stdio and REST work queues:

| Batch | Integrations | Routes |
|---|---|---|
| Airtable through Hetzner | 23 | Seven native OAuth catalog entries; five pinned stdio bridges; five custom HTTP routes; five executable native API skills; Google Workspace delegates to the bundled native skill |
| HubSpot through Render | 23 | Eight catalog routes including region/environment alternatives; custom HTTP where supported; executable API/database skills replace unsupported package guesses |
| Replicate through Zoom | 22 | Native catalog and custom HTTP routes where available; executable local REST clients for headless credentials and unsupported bridges |

Service-specific scope matters. Jira uses the Atlassian catalog entry; Bitbucket uses its own API. GitLab's catalog route targets GitLab.com. Google Workspace uses Hermes's bundled setup. PayPal sandbox and non-US Intercom use explicit API alternatives. WordPress self-hosting is distinct from WordPress.com OAuth. A documentation MCP, such as Twilio docs or AWS knowledge, is not an account administration connector.

Native MCP login can require an interactive browser and callback forwarding. A zero exit from catalog installation or login is not proof of connection: enabled inventory and `mcp test` are required. OAuth cache ownership and rollback limits are stated in each procedure; local file recovery cannot revoke a vendor authorization grant.

Native API skills provide concrete executable reads, not a promise to expose every vendor action as an MCP tool. Database access still depends on a properly restricted role/ACL. Paid calls, messages, writes and destructive operations require their own explicit scope and consent. Vendor-specific client packages and availability are not live service evidence.

## Regression coverage

The added suites exercise version boundaries, false interruption values, draining endpoints, rollback conflicts, native catalog and custom registration, installed API clients, preflight rejection, discovery and credential handling. Scanner controls prove the synthetic Discord-ID exceptions match only their exact literals and paths, while other IDs and token patterns remain detectable.

The validation record lists executed results. Docker SSH, loopback vendor HTTP and exact-source native cron are separate from live vendor delivery. No candidate is promoted to live-verified by these tests.
