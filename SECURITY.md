# Security

Hstack runs locally and exposes tools from explicitly configured social providers.
Writes are blocked by default; HSTACK_ALLOW_<PROVIDER>_WRITES=true enables them
for one provider. Legacy HSTACK_ALLOW_WRITES=true affects only Buffer. Client approvals are
still required for deliberate writes; the gateway has no built-in approval UI.
A calling MCP agent can receive account and tool-result data from those services.
Header credentials are sent to the configured provider endpoint; OAuth credentials
are also used with that service's discovered authorization server. Issuer binding
is retained and checked. No raw transport errors are printed to the calling agent.

Desktop API keys and Hstack-owned OAuth grants are encrypted with AES-256-GCM.
macOS uses a Keychain-held encryption key; headless POSIX hosts require a private
master-key file. There is no silent plaintext fallback. See
[credential storage and recovery](docs/credential-security.md). OAuth uses the MCP
SDK, loopback callbacks and cross-process refresh locks.

The local .env and third-party native credential stores are outside this vault;
restrict and protect them separately. Explicit plaintext compatibility mode is
not recommended for production. Hosted multi-user isolation is not implemented.
Do not expose this stdio prototype as a public remote service.

Never commit account data, keys or recordings. For vulnerabilities, use the
repository's private GitHub security reporting facility when available.

Local connections.json is trusted executable configuration. Keep it private and
review each command before enabling it. Local vendor servers and OAuth bridges
receive only explicitly selected credential environment variables, in addition
to the SDK's default safe environment. They run with your OS user permissions;
Hstack does not sandbox them. Bridge-owned OAuth stores are separate from .env
and have their own security requirements. No packages are automatically installed.
