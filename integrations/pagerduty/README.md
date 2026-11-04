# PagerDuty remote setup candidate

The disabled [profile](connection.json) uses the maintained hosted MCP endpoint
`https://mcp.pagerduty.com/mcp` and `Authorization: Token token=<API token>`.
The native SDK header route passes a synthetic server test. **No PagerDuty account,
real credential, remote catalogue or incident read has been tested.**

The [remote guide](https://docs.pagerduty.com/developer/mcp-tooling-remote-server)
documents API-token and OAuth authentication. This profile deliberately uses the
documented API-token route; it does not guess the separate OAuth registration
requirements. Set the bare value as `PAGERDUTY_MCP_TOKEN` in the private launch
environment. The profile adds `Token token=`. Do not supply a whole header or an
Events/integration key in place of a REST API token.

PagerDuty's [authentication guide](https://docs.pagerduty.com/developer/authentication)
distinguishes account tokens from user tokens. An account administrator can issue
a read-only account token; account tokens have account-wide access. User-token
availability and permissions depend on the account. Choose the appropriate least
privilege credential; Hstack's tool allowlist does not narrow the underlying key.

Use `plan pagerduty` / `prepare pagerduty` as described in
[batch setup](../../docs/onboarding.md), select the reviewed candidate, then:

```sh
node --env-file=.env dist/manage.js doctor pagerduty
node --env-file=.env dist/manage.js check pagerduty
```

Doctor is offline. Check discovers tools only. Keep the candidate disabled until
the real catalogue/schema and a safe read have been validated. The single default
read, `list_incidents`, comes from the [hosted MCP reference example](https://docs.pagerduty.com/developer/api/reference/mcp/pagerduty-mcp-api/mcp-root.md).
Its example uses a `query_model` object; inspect the actual schema and explicitly
choose filters/limits before making an account request. No incident IDs were
invented or queried here. Incident changes, notes, escalation and other operations
remain blocked until deliberately reviewed.

The vendor's [local-server repository](https://github.com/PagerDuty/pagerduty-mcp-server)
was archived and directs development to the hosted service. Its old tool lists
and local proxy instructions are not proof of the current remote catalogue; this
profile installs neither that runtime nor another filtering proxy. Hstack already
supports native remote HTTP, shared permissions and optional tool search.

Actual feature/plan access, input/result contracts, quotas and native Hermes/model
acceptance remain unverified. There is no operational `verify pagerduty` yet.
This static token is managed through the vendor and your launch environment;
Hstack's OAuth `login`/`disconnect` commands do not revoke it.
