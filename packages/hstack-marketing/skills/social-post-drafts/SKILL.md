---
name: social-post-drafts
description: "Draft a set of social posts based on what performed well recently in Buffer, show them for approval, and only add approved ones to Buffer with the user's per-post confirmation. Use for 'write this week's posts', 'plan social content', or 'turn this into posts'."
version: 0.1.0
author: Hstack
license: MIT
metadata:
  tags: "marketing, social-media, buffer, drafting, content"
  hermes_related_skills: "hstack-marketing:marketing-weekly-review"
---

# Social Post Drafts

Writes posts in the user's voice, grounded in their own recent results. Drafts
stay in the chat until the user approves each one.

## When to Use

- "Draft this week's posts", "give me 5 LinkedIn posts about X".
- After `marketing-weekly-review`, to act on what worked.
- NOT for replying to comments or DMs, and not for paid promotion.

## Steps

1. Gather context (read-only):
   - `list_channels`: which networks to write for.
   - `list_posts` with recent sent posts, plus `get_aggregated_post_metrics`
     to pick the 3–5 best performers. These set the voice and format.
   - `list_ideas` and `list_post_templates` if the user keeps them.
2. Ask for anything missing: topic or campaign, number of posts, links to
   include, dates. Keep it to one short question.
3. Draft. For each post: channel, text sized for that network, suggested day
   and time based on past performance, and one line on why (for example
   "question openers got 2x clicks last month").
4. Show all drafts and ask which to keep, edit or drop.
5. Only after explicit approval, and one post at a time, add it to Buffer
   with Buffer's create-post tool, as a draft or into the queue as the user
   chose. Hermes asks the user to approve each Buffer write. Never batch-approve
   on the user's behalf, and never schedule without being asked.
6. Confirm what was added, where, and when it will go out.

## Pitfalls

- Never publish immediately unless the user explicitly says "post now".
- Don't reuse a past post's text word-for-word. Learn from it, don't copy it.
- No invented statistics, testimonials, prices or claims about competitors.
- Respect per-network limits (length, hashtags, link handling). If unsure,
  keep it short.
- If a Buffer write is declined in the approval prompt, keep the draft in
  chat. Do not retry the write.
