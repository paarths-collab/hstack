# Credential storage and recovery

Hstack-owned OAuth grants and Desktop API keys now use AES-256-GCM encrypted
files. Authentication tags detect tampering; encryption is bound to the credential
file's identity and absolute location. Files are owner-only, updates use atomic
replacement and filesystem sync, and cross-process locks serialize refreshes.
Secrets are never passed as command arguments or included in recovery messages.

This protects stored files, not a compromised logged-in OS user or malicious
vendor process. Tokens must exist in memory while authenticating. Legacy `.env`,
private URL/header settings and credentials owned by external vendor runtimes
(including Google ADC, Zendesk and QuickBooks) are not automatically encrypted
or moved. Their native security requirements still apply. Windows is unsupported.

## macOS

Build with `npm run build`. This compiles the small Security.framework helper
using Apple's command-line developer tools. The default backend is `keychain`:
the encryption key is held in the local user's Keychain, while encrypted records
stay in the selected state directory. A locked or inaccessible Keychain fails
closed; it never falls back to plaintext or silently opens a login dialog.
Unlock the Keychain using macOS, then retry. Run Hstack as the same OS user.

The helper is locally built, not a signed/notarized distributed application.
Keychain access after reinstall, rebuild, account migration or a locked headless
session must be validated on the deployment host. The opt-in synthetic native
test is `node scripts/verify-keychain.mjs`; it removes only its disposable item.

## Headless POSIX host

Provide a master key separately from the credential directory, preferably through
your deployment's secret-file facility. It must be exactly 32 random raw bytes,
owned by the Hstack OS user, with mode 0600 and no symlinks or hard links. A
hex/base64 string is not a raw key. Keep its parent directory private too.

For a local setup, create a private directory, then create a key without replacing
an existing file (run from a trusted shell; no secret is printed):

```sh
mkdir -m 700 "$HOME/.hstack-vault"
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(process.argv[1], randomBytes(32), {flag:"wx", mode:0o600})' "$HOME/.hstack-vault/master.key"
export HSTACK_CREDENTIAL_BACKEND=keyfile
export HSTACK_MASTER_KEY_FILE="$HOME/.hstack-vault/master.key"
```

Set those two environment variables on the Hermes gateway host or Hstack process.
The Desktop plugin passes the backend name and file path, never the raw master
key, into its generated MCP configuration. On macOS this explicit backend also
allows `HSTACK_CREDENTIAL_BACKEND=keyfile npm run build` without a Swift build.
Do not put the key file in Git, the application image or an unprotected backup.

## Existing credentials

Legacy plaintext records are rejected by the encrypted backend until explicitly
migrated. Desktop offers **Encrypt existing key**; for native OAuth, use:

```sh
node --env-file=.env dist/manage.js migrate-credentials SERVICE_ID
```

Migration makes no vendor request, preserves activation/grants and is atomic.
Failed encryption leaves the original file intact. Old backups may still contain
plaintext. `HSTACK_CREDENTIAL_BACKEND=plaintext` exists only as an explicit testing
or compatibility option; it is not the production recommendation.

## Recovery behavior

| Situation | Behavior and next action |
| --- | --- |
| API key rejected with an authentication failure | Desktop disables it. Obtain a replacement, then Save → Validate → Activate. API keys cannot be refreshed like OAuth tokens. |
| OAuth access token expires | The SDK refreshes under the credential lock when the provider supports it; rotated tokens are saved encrypted. |
| OAuth grant revoked | Run the explicit `login SERVICE_ID` flow again. Background operations never start consent or client registration. |
| Provider timeout/outage | Preserve credentials, apply bounded reconnection backoff and allow a later explicit request. Successful reads clear transient Desktop failure state. |
| Rate limited | Report supplied timing/window data; don't invent the exhausted quota. Desktop persists supplied cooldowns across process restarts. |
| Lost master key or damaged record | Reads fail closed. Explicit replacement/removal works for safely owned files; reauthenticate the affected services. |
| Disconnect | Remove Hstack's local grant/key. This is not remote vendor revocation and does not erase `.env` or third-party stores. |

Queued HTTP/stdio requests are capped at 64 per connection; excess requests fail
before dispatch. Deadlines/cancellation remain in force. A lost response can mean
an operation executed: Hstack never blindly replays it. Vendor-native SDK behavior
and quotas remain service-specific. Opaque tool error text is not guessed to be
an authentication error.

Stop all processes using a state directory before restoring a backup. Preserve
the original absolute path and its matching master key; moving encrypted records
to a different path fails authentication. There is no automatic master-key rotation
or portable encrypted export yet. Losing the master key requires fresh sign-in.

Crash-created lock directories are not automatically stolen: a paused process
could still be refreshing a token. If lock waits keep timing out, stop every
Hstack process sharing that state, confirm no refresh is running, then remove
only the affected empty `.lock` directory and restart. Do not delete live locks.

## Evidence limits

Encryption, corruption recovery, refresh/reauthentication, queue limits and outage
handling have synthetic regressions. A separate macOS test exercises the real
Keychain with a disposable synthetic key. Buffer's backend/React/native-registry
acceptance is recorded separately in `desktop-verification.json`.
Neither result proves every vendor account, a packaged Hermes Desktop application,
Windows, multi-user hosting or production readiness for the whole catalogue.
