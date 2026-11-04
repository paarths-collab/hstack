# Hstack Connections for Hermes Desktop

A local connection screen: **Save key → Validate read → Activate → Use read tool**.
Buffer's complete backend path has passed with a real account and the installed
Hermes native MCP registry in a disposable profile. The actual React component
also passed this live flow under jsdom, with shell/routing atoms supplied by a test
harness. Hermes Desktop is not installed
on the test machine: renderer loading, plugin mounting in the actual app and a
model-driven chat remain unverified. This is not a completed Desktop acceptance claim.

## Supported flows

| Service | Validation and native read | Evidence / requirements |
| --- | --- | --- |
| Buffer | `get_account` | Real-account backend acceptance passed |
| Pallyy | `get_me` | Implemented and fixture-tested; real account pending |
| Blotato | `blotato_get_user` | Implemented and fixture-tested; paid API/MCP plan required; real account pending |
| Ayrshare | `list_profiles` | Implemented and fixture-tested; Business profile access required; real account pending |
| Metricool | No reviewed validation read | Keys can be saved/removed; validation and activation remain blocked |

Validation executes the exact discovered read with schema-checked empty arguments.
Discovery alone never validates a key. A failed revalidation clears activation.
Other OAuth, database and catalogue-service screens are not implemented.

## Install the preview

1. Build Hstack with Node.js 22+: `npm ci --ignore-scripts`, then `npm run build`.
2. Copy this `hstack-connections` directory into the intended Hermes profile's
   `plugins/` directory, only if the destination does not already exist. Preserve
   existing plugins and configuration.
3. Set `HSTACK_DESKTOP_PROJECT_ROOT` to the absolute Hstack project directory in
   the Hermes gateway process. Set `HSTACK_DESKTOP_NODE` to the absolute Node
   executable if it is not on the gateway PATH.
4. Enable the agent plugin using Hermes's native plugin configuration and restart
   the gateway. Enable the Desktop half separately in its plugin settings.
   Open **Hstack Connections** in settings or its pane on older SDKs.
5. Choose Buffer, enter its key, then click **Save key**, **Validate key**,
   **Activate in Hermes**, and **Use read tool** in order.

Activation adds one profile-specific `hstack-desktop-…` MCP entry through Hermes's
native configuration helper. It never overwrites a different existing entry or
replaces the whole server map. All supported social services share this one entry.
A conflicting entry produces a review message. No key is written into MCP config.
The dedicated Desktop server always uses search mode and read-only permissions.
It excludes legacy `.env` credentials, write flags and `connections.json`.
An older manually configured Hstack entry is preserved; disable it yourself in
Hermes if you no longer want both entries.

The read button invokes a bounded, separate native Hermes registry worker against
this exact configured connection. It does not call an AI model or prove an existing
chat has refreshed its tool list. **Start a new chat after first activation.**
Ask it to search Hstack for `buffer__get_account` and read your Buffer account.
That model-driven step still needs actual Desktop acceptance.

Once the Desktop MCP server is running, changes to its saved keys/activation are
picked up before the next search or call, without restarting. Replacement clears
validation and activation. Deactivation/removal blocks subsequent calls; a request
already in flight may finish. The screen reports saved activation separately from
the explicit native read check; it is not a continuous connection-health monitor.

## Storage and limitations

Keys are encrypted with AES-256-GCM under
`<selected Hermes profile>/hstack-connections`. macOS holds the master key in
Keychain; headless POSIX gateways need a private master-key file. See
[storage and recovery](../../docs/credential-security.md). Windows ACL support is unavailable.
Existing plaintext records require **Encrypt existing key** or explicit replacement.
A rejected key clears activation and prompts replacement; API keys cannot use
OAuth refresh. Temporary outages preserve the key. Reported cooldowns persist
across server restarts, and **Refresh status** shows the latest saved state.
The old preview's `~/.hstack-auth` keys are not silently migrated: re-enter the
chosen key in the new screen. Legacy Hstack environment precedence is unchanged.
Removing a key here does not revoke it at the provider or erase a legacy `.env`.

With a remote gateway, keys are stored on the gateway host and pass through its
authenticated plugin API. Use a trusted gateway; the plugin does not add an
independent authentication layer. It requires Hermes's own authenticated plugin
mount and profile routing. It uses installed native profile/configuration helpers;
compatibility with another Hermes version must be checked before claiming support.
Provider account/plan errors remain possible even when other reads work.

Rate-limit failures show provider-supplied timing/window details when known. No
write, publishing, paid generation, automatic retry of a write or account signup
is part of this flow. No paid account was used for the other providers.

## Verification

- `npm test`: synthetic regression tests, including key lifecycle, same-session
  activation/removal, no environment-key fallback, writes blocked, provider
  isolation, configuration collisions, profile isolation and account/quota parsing.
- `scripts/verify-desktop-native.py`: **opt-in live Buffer read**, requires the
  installed Hermes Python environment with FastAPI/httpx, `--hermes-source`,
  `--project`, `--node`, `--buffer-env-file`, and `--live-buffer-read`. It creates
  and deletes a disposable profile and reports only sanitized status. Optional
  `--renderer-dependencies` points at an existing Hermes `node_modules` with React,
  jsdom and Testing Library to exercise the real component against that backend;
  the shell SDK context is a fixture, not a running Desktop application.
- Actual Desktop UI, model-driven chat, Windows and the other real provider
  accounts remain untested. Local tests are not GitHub CI evidence.

Read contracts: [Buffer](https://developers.buffer.com/guides/integrations/mcp.html),
[Pallyy](https://pallyy.com/docs/api/mcp/tools),
[Blotato](https://help.blotato.com/start-with-an-ai-agent/mcp/tools),
[Ayrshare](https://www.ayrshare.com/docs/additional/mcp-action-tools).

Hermes source interface: [Desktop plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk).
