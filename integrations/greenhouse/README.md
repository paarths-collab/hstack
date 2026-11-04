# Greenhouse through Hstack

This disabled profile uses native HTTP/OAuth for the official
[Greenhouse MCP server](https://support.greenhouse.io/hc/en-us/articles/52096319906971).
It replaces the generic local-command placeholder. There is no separate vendor
process or deployment, but account/admin setup is required.

**No live Greenhouse account has been tested.** Hstack's OAuth/PKCE and refresh
fixtures do not establish Greenhouse callback acceptance, actual scopes, token
refresh or successful account operations.

## Account and admin setup

1. Check Greenhouse MCP beta eligibility. The official guide currently lists
   Core, Plus and Pro organizations; actual access also depends on admin settings.
2. A Site Admin must add Hstack as a client in **Dev Center → MCP Access → Clients**
   and approve its exact callback:

   ```text
   http://127.0.0.1:8678/callback
   ```

   This is required for custom clients and proxies too. If the admin UI takes a
   regex pattern, use the narrow pattern appropriate to this exact URI and test
   it before saving. Changing `callbackPort` requires updating the approval.
3. Review the organization's enabled MCP scopes. Those are the maximum available
   permissions; each user is also restricted by their existing Greenhouse access.
   Scope changes require disconnecting and signing in again. Hstack cannot bypass
   this approval process or copy another tool's pre-approved callback.

## Configure and inspect

1. Copy [connection.json](connection.json) into your private `connections.json`,
   preserving other entries. Keep the profile disabled while checking access.
2. Put the documented endpoint in your existing private `.env`:

   ```dotenv
   GREENHOUSE_MCP_URL=https://mcp.us.greenhouse.io/mcp
   ```

   This is the endpoint shown for CLI/ChatGPT connections in the official guide.
   The same guide shows `https://mcp.greenhouse.io/mcp` for other clients. Confirm
   the correct endpoint for your account/custom client; do not guess a region or
   copy an unrelated account's configuration.
3. Build, check prerequisites, sign in, then discover tools:

   ```sh
   npm run build
   node --env-file=.env dist/manage.js doctor greenhouse
   node --env-file=.env dist/manage.js login greenhouse
   node --env-file=.env dist/manage.js check greenhouse
   ```

   The offline doctor shows the admin prerequisite but cannot verify approval.
   Login uses the SDK's advertised registration/PKCE flow and your own browser.
   Discovery contacts the server but executes no tool.
4. Review the actual discovered tool names and schemas. The vendor describes
   scope capabilities such as listing jobs and applications, which are not a
   guarantee of exact MCP tool identifiers. The profile therefore starts with
   **empty `readTools`**: every operation remains blocked until you add exact
   read names that you have reviewed. Writes stay disabled.
5. Enable the profile, restart Hstack in Hermes, and explicitly test a selected
   read and later token refresh. Hstack has no reviewed operational verifier for
   Greenhouse yet. Login/discovery alone do not prove the account workflow works.

Hstack keeps endpoint values outside JSON, stores native OAuth credentials with
its documented [POSIX plaintext-store protections](../../docs/oauth.md), and
applies shared namespacing, permissions, errors and focused discovery. A single
direct connection can be simpler when you do not need those shared controls.
Real Greenhouse operations, writes and model-driven Hermes use remain unverified.
