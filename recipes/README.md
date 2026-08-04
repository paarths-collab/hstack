# Agent Recipes metadata

This directory is the product-facing layer above the existing hstack skills. A recipe describes an outcome in plain language; it does not contain credentials, deployment commands, or a hosted runtime.

## Connector rule

Every connector choice is optional. A recipe may be explored in preview mode with no live connection. To create a live deployment plan, the selected recipe must have:

- at least one **source** of information; and
- at least one **delivery** destination.

The eventual Recipe Compiler must reject a deployment plan that does not meet those two capability requirements. It should display the selected connectors, their access level, verification steps, and connector-scoped rollback before anything is deployed.

## Truth labels

- `labs` — an outcome and configuration concept exist; it is not deployable yet.
- `contract_tested` — the metadata references real existing hstack skills and has passed its contract checks. It is not a claim of customer proof.
- `self_tested`, `pilot_tested`, and `proven` are reserved for evidence collected after real deployments.

Customers connect apps only inside their own approved runtime. Agent Recipes must never request, receive, log, or retain passwords, API keys, SSH keys, or other secret values.
