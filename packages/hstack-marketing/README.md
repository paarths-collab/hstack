# Hstack Marketing

A marketing assistant package for [Hermes Agent](https://github.com/NousResearch/hermes-agent).
It reads your **Buffer** social posts and **Mailchimp** email results, tells you
what worked, and drafts posts and newsletters for you to approve.

It is a portable Agent Plugins v1 package (`plugin.json` + `mcp.json` +
`skills/`). It contains no executable code of its own.

## What you get

| Skill | What it does | Changes anything? |
| --- | --- | --- |
| `marketing-connect` | Sets up both API keys through Hermes and checks each with one read | No |
| `marketing-weekly-review` | Summarises recent posts and campaigns, patterns and what to try next | No |
| `social-post-drafts` | Drafts posts from your best performers; adds approved ones to Buffer | Only after you approve each post |
| `newsletter-from-top-posts` | Writes a newsletter draft (subjects, body, plain text) in chat | No |

Ask in plain words: "How did marketing do this week?", "Draft five posts about
our launch", "Write this month's newsletter".

## Install

```bash
hermes plugins install <owner>/<repo> --no-enable   # catalog name once listed
hermes plugins enable hstack-marketing
```

Then ask Hermes to "connect Buffer and Mailchimp", or set the keys yourself in
a terminal:

```bash
hermes config set BUFFER_API_KEY
hermes config set MAILCHIMP_API_KEY
```

Start a new session (or `/reload-mcp`) afterwards. Requirements:

- A Buffer account and API key ([Buffer MCP guide](https://developers.buffer.com/guides/integrations/mcp.html)).
- A Mailchimp Marketing account and API key ([Mailchimp API keys](https://mailchimp.com/help/about-api-keys/)).
- [`uv`](https://docs.astral.sh/uv/) on PATH (runs the pinned Mailchimp server).
- Hermes with portable package support. Exact floor to be confirmed.

You can connect only one of the two. The skills report the missing one and
continue with the other.

## Safety and disclosure

- **Where calls go.** Buffer tools call Buffer's official hosted MCP server at
  `https://mcp.buffer.com/mcp`. Mailchimp tools run the community
  [mailchimp-mcp-server](https://github.com/damientilman/mailchimp-mcp-server)
  1.2.0 on your machine, which calls `https://<dc>.api.mailchimp.com`. It is
  pinned with `mcp==1.30.0`, because 1.2.0 does not run on MCP SDK 2. It is
  **not** an official Mailchimp product.
- **Downloads.** On first launch `uvx` downloads `mailchimp-mcp==1.2.0`,
  `mcp==1.30.0` and their dependencies from PyPI. Transitive dependencies are
  not hash-pinned by this package.
- **Credentials.** Hermes stores `BUFFER_API_KEY` and `MAILCHIMP_API_KEY` in
  your profile `.env` and passes them to these two servers only. This package
  never reads, stores, refreshes or prints keys.
- **Writes.** Both servers are marked `trust: untrusted`, so Hermes asks you
  before any tool call that is not marked read-only. Mailchimp also runs with
  `MAILCHIMP_READ_ONLY=true` and `MAILCHIMP_MAX_RETRIES=0`, so its write tools
  refuse to run and nothing is retried behind your back. Buffer writes
  (adding a post) happen only when you approve them.
- **Data in your model context.** Post text, post metrics, campaign names,
  subject lines and campaign reports are pulled into the conversation and reach
  your model provider. The skills do not read Mailchimp member lists.
- **Tool lists come from the servers.** Buffer's hosted tool list can change
  without a new release of this package.
- No telemetry and no background processes beyond the MCP servers Hermes starts.

## Tested so far

- Buffer: a real account read through the Hstack gateway that preceded this
  package. **This package itself has not yet been tested end to end.**
- Mailchimp 1.2.0: the real server process with a synthetic key and network
  denied. **No live Mailchimp account has been tested.**
- No model-driven conversation has been verified with this package yet.

## License

MIT
