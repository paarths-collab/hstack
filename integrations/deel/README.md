# Deel through Hstack

The default disabled candidate now uses Deel's recommended native OAuth/DCR route.
Public anonymous discovery passed the official SDK: eight input schemas compiled
and were preserved through Hstack's real forward/search registry. Two public OAuth
metadata GETs also passed. **No account registration, consent, token, vendor tool
invocation or account data was tested.**

## Public catalogue and protected account access are separate

Deel's [authorization guide](https://developer.deel.com/mcp/authorization) explicitly
allows anonymous `initialize` and `tools/list` at `https://api.letsdeel.com/mcp`.
The observed anonymous catalogue contains eight tools marked read-only/noauth:
employment-cost calculations, hiring comparisons/salary/summary/take-home
calculations and public ATS job-posting lookup. Exact definitions are recorded in
[public-tool-definitions.json](public-tool-definitions.json).

The default read list permits only those eight exact observed names. Their actual
execution, results, quota and any feature/fee requirements have not been verified.
No arbitrary organization ID or compensation calculation was submitted. The public
list is not proof that protected contracts, people, payroll or HR tools are available.
The [tool reference](https://developer.deel.com/mcp/reference/tools-reference) lists
protected capabilities, but this review does not guess their authenticated wire
names or expose them by default.

## Prepare native OAuth

Use [batch planning](../../docs/onboarding.md) with `plan deel` / `prepare deel`, or
copy [connection.json](connection.json). Keep the candidate disabled. Existing
HTTP/PAT configurations are preserved; preparation does not change authentication
in your source or copy its credentials into a different store.

After selecting the reviewed candidate with `HSTACK_CONNECTIONS_FILE`:

```sh
node --env-file=.env dist/manage.js doctor deel
node --env-file=.env dist/manage.js check deel
```

Doctor is offline. Check can succeed with the anonymous catalogue; it does not
prove account authentication or an API operation. Management output explicitly
labels discovery separately from account operation verification.

For protected account access, the vendor requires a Deel account with API access
and appropriate organization/worker permissions. Complete explicit foreground
consent in your own browser:

```sh
node --env-file=.env dist/manage.js login deel
node --env-file=.env dist/manage.js check deel
```

Hstack's default callback is `http://127.0.0.1:8678/callback`. The native SDK handles
public-client DCR, S256 PKCE and refresh; no pre-provisioned app secret or public
CIMD hosting is needed for the default DCR route. Real DCR/callback acceptance is
still unverified. The candidate requests only `contracts:read people:read
organizations:read profile:read`, all advertised in public metadata. Review actual
consent; requested scopes are not evidence of the granted account permissions.

After authentication, review the actual catalogue and schemas, add only required
reads and scopes, and restart Hstack before testing a safe account read. Changing
from an anonymous to authenticated catalogue can add tools. A running gateway
detects that change after auth-state replacement and requires restart/review before
dispatching another call. It never adds new account permissions automatically.
Deel's [documented single-use refresh tokens](https://developer.deel.com/mcp/authorization#token-management)
use Hstack's existing shared-lock native OAuth flow; real Deel refresh has not run.
No background startup/call performs initial registration or consent.

## PAT alternative

If OAuth is unsuitable, use [pat-connection.json](pat-connection.json) instead of
the native profile and set a bare `DEEL_MCP_TOKEN` privately. The vendor documents
PAT generation in its Developer Apps settings and `Authorization: Bearer <PAT>`.
Both variants use ID `deel`; select one, not both. The alternative leaves all
operations blocked until its authenticated catalogue is reviewed. Existing PAT
entries remain unchanged by preparation. Do not combine `headers` and `oauth`.

## Repeat public verification

```sh
npm run verify:deel-metadata
```

The probe allows only the three anonymous MCP discovery methods and two fixed
public OAuth metadata GETs, with credentials omitted and redirects refused. It
never loads private configuration or credentials and refuses registration, token
and vendor tool calls. Hstack forward/search metadata checks run locally.
See [verification.json](verification.json).

The measured SDK catalogue contains eight tools/11,155 JSON bytes; Hstack search
initially exposes two controls/843 bytes and returns matching schemas on demand.
These are serialized metadata counts, not model-token, billing, latency, native
Hermes or setup-time evidence. A direct SDK client also discovers these public
tools successfully. Hstack supplies the reviewed profile, shared management,
permission boundaries and search alongside other connected services.

There is no operational `verify deel` yet. Authenticated schemas, real public or
protected tool results, account/role/feature access, refresh/revocation, native
Hermes account use and model-driven acceptance remain pending.
