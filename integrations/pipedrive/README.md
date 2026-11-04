# Pipedrive through Hstack

Pipedrive's [current official setup guide](https://support.pipedrive.com/en/article/mcp-chatgpt)
documents the native endpoint `https://mcp.pipedrive.ai/mcp`. Hstack now has a
disabled HTTP profile instead of a placeholder local executable. Public OAuth
metadata passed official SDK discovery. **No vendor login, callback approval or
account operation has been tested.** This remains a setup candidate.

## Registration is still a prerequisite

The public issuer is `https://oauth.pipedrive.com`. It advertises S256 PKCE,
refresh tokens and client-secret Basic/Post authentication. It also advertises
dynamic registration. However, the pinned SDK treats Hstack's loopback login as a
native public client and sends `token_endpoint_auth_method=none` for DCR. That
does not match Pipedrive's advertised confidential methods. Local fixtures verify
the rejection boundary; no registration request was sent to Pipedrive.

This profile therefore requires an **MCP-compatible registered client**, its
secret and acceptance of the exact redirect:

```text
http://127.0.0.1:8678/callback
```

Obtain or confirm those settings before enabling it. We have not established
that a normal API application can be reused unchanged. Reports on the vendor's
[developer forum](https://devcommunity.pipedrive.com/t/mcp-server-allow-redirect-uris-for-our-mcp-client-jurnie/20803)
describe callback allowlisting failures for other custom clients; that is not
proof of how Hstack's callback will behave. Do not impersonate an approved
connector or change the SDK's native-client classification to bypass this gate.

## Configure once registration is accepted

1. Copy [connection.json](connection.json) into your private configuration or use
   `plan pipedrive` / `prepare pipedrive`. Keep it disabled. Preserve existing
   configurations; customized entries are not automatically replaced.
2. Add these names to your existing private `.env`:

   ```dotenv
   PIPEDRIVE_MCP_CLIENT_ID=your_registered_client_id
   PIPEDRIVE_MCP_CLIENT_SECRET=your_registered_client_secret
   ```

3. Run the offline check, then explicitly sign in using your own browser:

   ```sh
   node --env-file=.env dist/manage.js doctor pipedrive
   node --env-file=.env dist/manage.js login pipedrive
   node --env-file=.env dist/manage.js check pipedrive
   ```

   Doctor checks references, not vendor eligibility. Login is the only step that
   may start consent; missing registered references cannot silently select DCR.
   Check discovers tools without executing them. Actual vendor acceptance must
   succeed before a real read is attempted and the profile is enabled.

The 23 default read names come from the vendor's [tool reference](https://support.pipedrive.com/article/mcp-tools):
activities, deals, contacts, organisations, leads, products, stages, notes and
account context. Mail-sync and Projects add-on tools are excluded. These names
are documentation-reviewed; their schemas and successful operations still need
account validation. The vendor may change its catalogue.

The requested CRM module scopes are advertised as `:full`, not read-only scopes.
Hstack's read allowlist blocks other tools by default; it does not narrow the
underlying OAuth grant. Review consent and keep agent approval prompts enabled.
Pipedrive account permissions and plan/add-on requirements still apply. Hosted
ChatGPT/Claude connector setup does not establish compatibility with Hstack.

## Repeat public evidence without an account

```sh
npm run verify:pipedrive-metadata
```

The checker performs exactly two public metadata GETs with credentials omitted
and redirects refused. It never registers a client, signs in, gets tokens or calls
tools. See [verification.json](verification.json). Registered Basic/Post login
and refresh have local fixture coverage; there is no live Pipedrive or native
Hermes Pipedrive account proof. No operational `verify pipedrive` command exists
yet because no real response contract has been validated.
