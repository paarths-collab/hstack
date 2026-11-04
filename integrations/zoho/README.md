# Zoho CRM, Desk and Books through Hstack

These disabled profiles use **Zoho's hosted MCP service**, replacing generic
local executable placeholders. No vendor subprocess or Hstack OAuth app is
needed for this URL-key connection path. **No Zoho account, generated URL or
vendor tool operation has been tested.** Local tests cover the HTTP transport,
secret handling and permission boundary only.

Zoho's [MCP overview](https://www.zoho.com/mcp/) and
[Books setup guide](https://www.zoho.com/us/books/help/mcp/zoho-books-mcp.html)
describe creating a hosted server, authorizing apps and choosing tools. Its
[getting-started guide](https://help.zoho.com/portal/en/kb/mcp/getting-started/articles/zoho-mcp-help-documentation)
documents a generated URL that contains the server's API key. The help article's
body was not available to the public page fetch; its indexed official text
confirmed the URL-key requirement. The exact account UI, region, eligibility,
tool names and schemas remain unverified. Do not treat a fixture as vendor proof.

## Configure the vendor server first

1. In Zoho MCP, create a server for the apps you actually use. Connect the
   appropriate Zoho accounts/organisations and obtain required admin approval.
   Start with read-only actions in Zoho's selected tools. API/app quotas and
   subscription requirements still apply; free access to every app is not promised.
2. Copy the complete connection URL from that server's Connect page. Treat the
   entire URL as a credential. Do not paste it into chat, arguments, public JSON,
   screenshots or a repository. Do not construct the URL from an API hostname.
3. Add only the relevant private references to your existing owner-only `.env`:

   ```dotenv
   ZOHO_CRM_MCP_URL="your_complete_private_generated_url"
   ZOHO_DESK_MCP_URL="your_complete_private_generated_url"
   ZOHO_BOOKS_MCP_URL="your_complete_private_generated_url"
   ```

   You do not need three duplicate connections if one Zoho server already exposes
   the desired apps. Choose one profile for that server and review its complete
   tool set, or create separate servers for separate app permissions. Hstack
   namespaces a connection, not the apps hidden behind a vendor's combined hub.
4. Use `plan` / `prepare` for the selected IDs, or copy the corresponding profile:

   - [Zoho CRM](../zoho-crm/connection.json)
   - [Zoho Desk](../zoho-desk/connection.json)
   - [Zoho Books](../zoho-books/connection.json)

   Keep it disabled, then check setup and discover its actual catalogue:

   ```sh
   node --env-file=.env dist/manage.js doctor zoho-crm
   node --env-file=.env dist/manage.js check zoho-crm
   ```

   Substitute `zoho-desk` or `zoho-books` as needed. Doctor is offline and does not
   validate a URL key. Check contacts the selected server but executes no tool.
   There is no Hstack `login` step for these profiles; app consent and native
   credential refresh are managed inside Zoho's server setup.
5. Inspect the account-selected tools and schemas in an MCP inspector. Add exact
   reviewed read names to private `readTools`, validate a real read deliberately,
   then enable the profile and restart Hstack. Empty `readTools` intentionally
   blocks every call. Tool IDs are not guessed from action labels or a different
   Zoho server. There is no reviewed operational verifier for these apps yet.

Review arguments as well as labels: a generic API/execute tool may permit writes.
Leave it blocked unless its allowed actions are constrained in Zoho. Hstack's
allowlist checks tool names; it does not impose a separate HTTP-method policy on
an opaque vendor tool.

These profiles use native Streamable HTTP with SDK negotiation. Remote URLs must
be HTTPS; redirects are refused. Local loopback HTTP is used only by tests.
No extra Bearer header is added to a generated URL-key connection. Zoho's default
Claude OAuth connectors are a different setup path and cannot be substituted
without reviewing their registration requirements.

## Recovery and limits

If the key URL is expired or compromised, use the vendor's documented key
regeneration procedure in the MCP console, replace the private environment value
and restart Hstack. Hstack does not rotate Zoho's server key or revoke it through
the local OAuth disconnect command. See the [official FAQ](https://help.zoho.com/portal/en/kb/mcp/help-support/articles/zoho-mcp-faq).

Failures preserve authentication, permission and known rate-limit metadata without
printing the key URL. Local tests exercise private URL credentials, default call
blocking, explicitly reviewed fixture reads, write blocking, offline checks and
safe expired-key failures. The test tools are synthetic, not claimed Zoho tool
names. Real server handshake/authentication, key rotation, tool semantics,
native Hermes account use and plan limits are still required for acceptance.

Hstack adds one connection alongside your other vendors, exact per-tool
permissions and compact tool discovery. Zoho already combines apps itself;
wrapping it alone does not establish a setup-time advantage.
