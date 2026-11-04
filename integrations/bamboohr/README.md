# BambooHR through Hstack

This is a disabled native HTTP/OAuth profile for the official
[BambooHR MCP server](https://documentation.bamboohr.com/docs/mcp-server).
It replaces the generic local-executable placeholder. BambooHR hosts the server;
no vendor MCP subprocess or separate deployment is needed.

**Live validation is pending.** Hstack's registered-client login, token exchange
and refresh are tested with local synthetic OAuth/MCP servers, not a BambooHR
account. Discovery, scopes, callback acceptance, actual token behavior, tool
payloads and operations still need a real eligible account.

## Prerequisites and registration

1. Use an active BambooHR account with permission to see the needed metadata.
   The official MCP guide describes beta access and admin enablement through
   **Settings → Apps → AI Connectors**; check your account's actual eligibility.
2. Create an application in the
   [BambooHR developer portal](https://developers.bamboohr.com/login). The vendor
   does not support dynamic client registration; this application is required.
3. Register Hstack's exact redirect URI:

   ```text
   http://127.0.0.1:8678/callback
   ```

   If you change `callbackPort` in the profile, update the registered URI too.
   Hstack's current login requires the vendor to accept its loopback callback.
   Do not substitute a third-party application's client credentials or callback.
4. Request `mcp` plus the needed entity scopes. For the metadata profile, start
   with `mcp employees offline_access`, subject to vendor/admin approval.
   The official [OAuth instructions](https://documentation.bamboohr.com/docs/getting-started)
   require `offline_access` to issue a refresh token. A one-hour bearer token
   pasted into a header is not a replacement for refresh validation.

## Configure and inspect

1. Copy [connection.json](connection.json) into your private `connections.json`,
   preserving other entries. Leave `enabled: false` and `allowWrites: false`.
2. Add the following names to your existing private `.env`, without replacing
   its other settings:

   ```dotenv
   BAMBOOHR_MCP_URL=https://your-company.bamboohr.com/api/mcp
   BAMBOOHR_MCP_ISSUER=
   BAMBOOHR_MCP_CLIENT_ID=
   BAMBOOHR_MCP_CLIENT_SECRET=
   BAMBOOHR_MCP_SCOPES="mcp employees offline_access"
   ```

   Replace `your-company` and fill the client values from your own application.
   Set the issuer to the **exact** `issuer` in your account's published
   `https://your-company.bamboohr.com/.well-known/oauth-authorization-server`
   metadata. It is an issuer identifier, not the metadata document URL. Hstack
   verifies it against discovery rather than guessing or accepting a different issuer.
   Keep all values in the private environment, never arguments or shared exports.
3. Build and explicitly check setup/sign-in/discovery:

   ```sh
   npm run build
   node --env-file=.env dist/manage.js doctor bamboohr
   node --env-file=.env dist/manage.js login bamboohr
   node --env-file=.env dist/manage.js check bamboohr
   ```

   `doctor` is offline and shows the missing setting names and account
   prerequisites. It cannot check admin approval or authenticate you. `login`
   prints an authorization link for your own browser; inspect its permissions.
   `check` contacts the vendor to discover tools, but executes none of them.
4. Confirm that `list_fields`, `list_list_fields` and `list_tabular_fields` exist
   with the documented read semantics. These are the profile's three default
   metadata reads, classified as Read by the vendor guide. Review any newly
   requested employee/directory tools separately before adding them to `readTools`.
5. Enable the entry, restart the Hstack MCP connection in Hermes, and explicitly
   exercise one approved metadata read. Then confirm refresh after access-token
   expiry. Hstack has no reviewed BambooHR operational verifier yet; neither
   successful login nor discovery is full account-operation evidence.

## Behavior and limits

Hstack supplies the configured client ID and secret to the official SDK, which
uses discovered token authentication methods. Configured scopes are explicit
requests during foreground login; the vendor still decides what it grants.
Background operation can refresh stored credentials but never launches a browser
or approves broader scopes. The POSIX owner-only credential store is plaintext;
see [OAuth storage and recovery](../../docs/oauth.md).

The vendor enforces the signed-in user's permissions. It also documents silently
partial results: omitted records do not prove that those people or data do not
exist. Hstack does not reconstruct withheld data or treat an empty result as
proof of complete access. Writes remain blocked by default.

The profile and account instructions are documentation-reviewed. No claims of
free account eligibility, live BambooHR compatibility, Windows support or a
model-driven Hermes session are made.
