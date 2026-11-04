# Social package for Hermes

Hstack groups optional social MCP connections behind one Hermes stdio entry.
Provider accounts and subscriptions remain separate. Only non-empty API keys
activate a connection; unused services are not contacted.

## Implemented adapters

| Provider | Environment variable | Authentication | Evidence |
| --- | --- | --- | --- |
| Buffer | BUFFER_API_KEY | Bearer | Live discovery, 8 read tools; actual writes unverified |
| Pallyy | PALLYY_API_KEY | Bearer | Official docs + local HTTP fixture tests; live account pending |
| Metricool | METRICOOL_API_KEY | X-Mc-Auth | Adapter/fixtures only; live catalogue and read-name review pending |
| Blotato | BLOTATO_API_KEY | blotato-api-key | Official docs + local HTTP fixture tests; live account pending |
| Ayrshare | AYRSHARE_API_KEY | Bearer | Official docs + local HTTP fixture tests; live account pending |

These are connections to existing official MCP servers, not new vendor APIs or
proof that every upstream tool works. Tools get service-specific prefixes:
`buffer__list_posts`, `pallyy__list_post_sets`, `ayrshare__get_comments`, etc.
Runtime tool names and schemas come from each service's actual tools/list.

## What each connection adds

- Buffer: drafts, queues, account/channel reads, ideas, templates and analytics.
- Pallyy: social sets, content calendar, media library and calendar notes. The
  upload_media_file tool expects ChatGPT file references; Hermes has no equivalent
  file-attachment mechanism here. Use a public URL through create_media_upload
  after deliberate write authorization instead.
- Metricool: brands, planner and analytics. OAuth MCP is available on Free, but
  this implementation only supports the header-key route requiring API access on
  Advanced/Custom. Until a real catalogue is reviewed, operations remain blocked
  by default, even when labelled read-only upstream. Do not enable writes just to
  work around this; review tool names first. Inbox and campaign management are
  not promised by its current MCP.
- Blotato: connected accounts, posts, analytics, comments, messages and automation
  data. API/MCP requires a paid plan. Generating a key during a trial starts billing.
  Hstack does not generate keys or run paid generation calls.
- Ayrshare: publishing-related reads plus history, analytics, comments and DMs.
  Ads require an add-on. Optional Profile-Key and X/Twitter BYO credential headers
  are not implemented, so operations needing those are not claimed supported.

MCP access never bypasses provider subscriptions, scopes, posting restrictions or
rate limits. Alternatives such as Pallyy and Buffer need not both be connected.

## Setup

1. Keep the existing BUFFER_API_KEY in your local .env.
2. Add only keys for services you already use; see .env.example for names.
3. Run npm run build, then restart the Hstack MCP connection in Hermes.
4. Read the discovered tool list. Begin with a read operation and verify its
   result in the vendor's app before enabling any writes.

Do not replace .env with the example: that would erase existing local values.
The real .env is ignored by Git. No keys are passed in command arguments.

A failed optional provider is reported on stderr and omitted from discovery;
healthy providers stay available. Schemas are cached for the process lifetime;
restart to refresh them. Hstack currently forwards tools only, not each upstream's
resources, prompts, OAuth flows, or subscription notifications.

Writes and unknown operations are blocked by default. Explicit per-provider
flags HSTACK_ALLOW_<PROVIDER>_WRITES=true enable them. The legacy
HSTACK_ALLOW_WRITES flag affects Buffer only. Client approval prompts are still
needed: Hstack does not provide its own human approval UI. Ads, sends and posting
must never be tested against real accounts as routine regression checks.

## Native Hermes coverage check

Checked official Hermes main at
[c419cf7c864ac0ee511dbd9f7091a8bba0b567ee](https://github.com/NousResearch/hermes-agent/tree/c419cf7c864ac0ee511dbd9f7091a8bba0b567ee)
on 2026-10-31. Searched 66 optional MCP catalogue entries, 910 plugin catalogue
entries, bundled/optional skills and plugin sources for these vendors and known
endpoint names. No dedicated entry was found for these five providers in those
paths. This is a public-source snapshot, not an exhaustive check of authenticated
Nous-hosted connector catalogues. Hermes already supports adding remote MCPs;
Hstack centralizes configuration rather than making previously impossible access
possible.

We do not add separate LinkedIn, Instagram, Facebook, Threads, TikTok or YouTube
connectors just to duplicate publishing already available through a scheduler.

## Deferred, rather than falsely labelled implemented

- [Brand24](https://help.brand24.com/en/articles/13011375-brand24-mcp): useful social
  listening; subscriber account and OAuth needed. Hstack's OAuth flow is pending.
- [Kit account MCP](https://developers.kit.com/mcp/kit-mcp): paid creator newsletter
  account with OAuth. Its developer-docs MCP is a different, read-only service.
- [Publer](https://publer.com/help/en/article/how-to-set-up-and-use-publers-mcp-server-14orlq0/):
  restricted beta eligibility and a private account-generated URL. Deferred until
  eligibility and secure endpoint handling can be validated.
- [Postiz](https://postiz.com/mcp): a Hermes CLI/skill route is documented by Postiz.
  Not advertised as wholly absent from Hermes's ecosystem. OAuth integration and
  overlap with other schedulers need evaluation before adding another connection.
- Mailchimp Marketing: newsletter marketing is adjacent to social publishing;
  community server review and local stdio upstream support are separate work.

## Official endpoint and tool references

- [Buffer MCP](https://developers.buffer.com/guides/integrations/mcp.html)
- [Pallyy setup](https://pallyy.com/docs/api/mcp) and [tools](https://pallyy.com/docs/api/mcp/tools)
- [Metricool setup](https://help.metricool.com/how-to-connect-metricools-mcp-eqp9h)
  and [plan limits](https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg)
- [Blotato setup](https://help.blotato.com/start-with-an-ai-agent/mcp/setup)
  and [tools](https://help.blotato.com/start-with-an-ai-agent/mcp/tools)
- [Ayrshare setup](https://www.ayrshare.com/docs/additional/mcp-action-connect)
  and [tools](https://www.ayrshare.com/docs/additional/mcp-action-tools)
