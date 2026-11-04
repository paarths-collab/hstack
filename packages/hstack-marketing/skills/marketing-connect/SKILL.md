---
name: marketing-connect
description: "Connect Buffer and Mailchimp to Hermes for the Hstack Marketing package: obtain the API keys, let Hermes store them, and confirm each service with one read. Use when a marketing tool reports a missing or rejected key, or the user asks to set up Buffer or Mailchimp."
version: 0.1.0
author: Hstack
license: MIT
required_environment_variables:
  - name: BUFFER_API_KEY
    prompt: "Buffer API key"
    help: "Create a key as described in Buffer's MCP guide: https://developers.buffer.com/guides/integrations/mcp.html"
    required_for: "Buffer posts, channels and post metrics"
  - name: MAILCHIMP_API_KEY
    prompt: "Mailchimp Marketing API key (ends in -usN)"
    help: "Mailchimp → Profile → Extras → API keys (https://mailchimp.com/help/about-api-keys/)"
    required_for: "Mailchimp audiences, campaigns and reports"
metadata:
  tags: "marketing, buffer, mailchimp, setup, api-key"
  hermes_related_skills: "hstack-marketing:marketing-weekly-review"
---

# Connect Buffer and Mailchimp

Sets up the two services this package reads. Keys are stored by Hermes in the
profile `.env`. They are never pasted into chat, written to a file by the
agent, or shown back to the user.

## When to Use

- First use of the Hstack Marketing package.
- A `buffer` or `mailchimp` tool returns an authentication error, or Hermes
  reports an unresolved `${BUFFER_API_KEY}` / `${MAILCHIMP_API_KEY}`.
- NOT for changing posting permissions. Writes are governed by Hermes approvals.

## Steps

1. If Hermes prompted for the keys when this skill loaded, the user enters them
   there. Otherwise ask the user to run, in their own terminal (not in chat):

   ```bash
   hermes config set BUFFER_API_KEY
   hermes config set MAILCHIMP_API_KEY
   ```

   If the user starts pasting a key into the conversation, stop them and point
   to the commands above.
2. Ask the user to start a new session (or run `/reload-mcp`) so both servers
   reconnect with the keys.
3. Confirm each service with exactly one read and report only the outcome:
   - Buffer: `get_account`. Success means an account id and at least one
     organization came back.
   - Mailchimp: `get_account_info`. Success means an account name came back
     and the result has no `error` field.
4. Tell the user which services are connected. A service whose key was skipped
   stays unavailable; the other one still works.

## Pitfalls

- Mailchimp starts through `uvx` and downloads its pinned runtime on first
  launch. The first connection can take a minute and needs `uv` installed.
- The Mailchimp server runs with `MAILCHIMP_READ_ONLY=true`. Write tools exist
  in its list but refuse to run. That is intended for this version.
- An authentication failure means the key is wrong, revoked, or for the wrong
  account. Ask for a replacement key. Do not retry in a loop.
- Never echo, log, summarise or partially reveal a key, even to "confirm" it.
