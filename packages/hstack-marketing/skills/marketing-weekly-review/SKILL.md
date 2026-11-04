---
name: marketing-weekly-review
description: "Summarise how recent social posts (Buffer) and email campaigns (Mailchimp) performed, what stood out, and what to try next. Read-only. Use for 'how did marketing do this week', 'what worked last month', or before planning new content."
version: 0.1.0
author: Hstack
license: MIT
metadata:
  tags: "marketing, analytics, buffer, mailchimp, report, weekly"
  hermes_related_skills: "hstack-marketing:social-post-drafts, hstack-marketing:newsletter-from-top-posts"
---

# Weekly Marketing Review

Builds a short, honest performance summary from Buffer and Mailchimp. It only
reads. It never creates, edits or sends anything.

## When to Use

- "How did our posts and emails do this week / month?"
- Before drafting new posts or a newsletter, to find what worked.
- NOT for paid ads, website analytics or sales numbers. Those services are not
  in this package.

## Steps

1. Agree the period (default: last 7 days) and which channels or audiences
   matter. Ask only if it is genuinely unclear.
2. Buffer:
   - `list_channels` to know which accounts exist.
   - `list_posts` for sent posts in the period.
   - `get_aggregated_post_metrics` for the period and channels.
3. Mailchimp:
   - `list_campaigns` with `status: sent` and `since_send_time` set to the
     period start.
   - `get_campaign_report` for each campaign. For more than 10 campaigns, the
     10 most recent.
4. Report in this shape:
   - **Headline:** one or two sentences.
   - **Social:** posts sent, best 3 posts with the metric that made them best,
     weakest post.
   - **Email:** campaigns sent, open and click rates, best subject line.
   - **Patterns:** topics, formats, days or times that did well. Only claim a
     pattern backed by at least two examples.
   - **Try next:** 2–3 concrete suggestions.
5. Offer the follow-ups: draft posts (`social-post-drafts`) or a newsletter
   (`newsletter-from-top-posts`).

## Pitfalls

- A Mailchimp result with an `error` field, or a list whose total is missing
  or null, is a failed read, not "zero campaigns". Say the read failed and
  why. Never present it as an empty result.
- A genuinely empty period is fine. Say "nothing was sent", don't invent data.
- Don't compare rates across very different audience sizes without saying so.
- Metrics differ per network. Name the metric (impressions, clicks,
  engagement) rather than blending them into one score.
- If one service is not connected, report the other and say which is missing.
  Load `marketing-connect` only if the user wants to fix it.
