# Brevo setup candidate

The disabled [profile](connection.json) uses Brevo's documented native HTTP endpoint
`https://mcp.brevo.com/v1/brevo/mcp` and `Authorization: Bearer <MCP token>`.
The header path passes a synthetic SDK server test. **No Brevo account, real token,
catalogue or tool operation has been tested.**

Follow the [official MCP guide](https://developers.brevo.com/docs/mcp-protocol):
generate a key under Account → SMTP & API → API Keys and select the **MCP option**.
Use that MCP token, rather than assuming a normal SMTP/API key is interchangeable.
Set its bare value privately as `BREVO_MCP_TOKEN`; the profile adds `Bearer `.
Do not paste the whole header into the variable or put the token in arguments.

Use `plan brevo` / `prepare brevo` as described in [batch setup](../../docs/onboarding.md),
select the reviewed private candidate, then:

```sh
node --env-file=.env dist/manage.js doctor brevo
node --env-file=.env dist/manage.js check brevo
```

Doctor checks the reference offline. Check consumes vendor requests for discovery
only; actual credential validity, account access and tool operations remain
unverified. Keep the profile disabled until those checks and a safe real read pass.

The vendor offers a main endpoint combining 27 modules and narrower module endpoints.
A narrower endpoint can reduce tool exposure; inspect its actual schemas and
review permissions before changing the private URL. No exact read names were
verified from a real catalogue, so `readTools` is empty and every operation remains
blocked. Contact import/export, campaign sends and account mutations must not be
enabled based on a broad module name or read/write annotation alone.

No external bridge is required by Hstack's HTTP client. API scopes, subscription
features, rate limits and token revocation must still be validated with your
account. There is no operational `verify brevo` yet. The token is supplied through
your private launch environment; `login`/`disconnect` do not manage this static
credential. Revoke or rotate it through Brevo separately.
