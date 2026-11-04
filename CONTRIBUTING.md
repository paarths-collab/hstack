# Contributing

Hstack is a local MCP connection layer with social adapters and a broader catalogue
of disabled setup templates. Production acceptance is tracked in
docs/production-readiness.md; vendor live evidence must remain distinct from fixtures.

Use official service documentation. Keep service adapters separate from MCP
transport and shared error handling. Describe account requirements and quotas
without promising that all subscriptions or MCP clients behave identically.

Test protocol behavior and failure handling with isolated fixtures. Report live
account validation separately. Never commit credentials or private account data.
Commit and publishing authorization and identity follow the user's current instructions.
