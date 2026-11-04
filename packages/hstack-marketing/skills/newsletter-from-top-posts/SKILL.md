---
name: newsletter-from-top-posts
description: "Write an email newsletter draft from the best recent social posts (Buffer) and past email results (Mailchimp): subject lines, preview text and body, returned in chat for the user to paste or edit. Read-only. Use for 'write our newsletter', 'monthly roundup email'."
version: 0.1.0
author: Hstack
license: MIT
metadata:
  tags: "marketing, email, newsletter, mailchimp, buffer, drafting"
  hermes_related_skills: "hstack-marketing:marketing-weekly-review, hstack-marketing:social-post-drafts"
---

# Newsletter From Top Posts

Turns what already resonated on social into a newsletter, and uses past email
results to pick the subject line. This version returns the draft in chat. It
does not create or send anything in Mailchimp. The Mailchimp server runs
read-only.

## When to Use

- "Write this month's newsletter", "roundup email from our best posts".
- NOT for sending, scheduling or editing audiences. Those stay manual in
  Mailchimp for now.

## Steps

1. Pick source material (read-only):
   - Buffer: `list_posts` plus `get_aggregated_post_metrics` for the period.
     Take the 3–5 best posts.
   - Mailchimp: `list_campaigns` (`status: sent`, recent) and
     `get_campaign_report` for the last 3–5 campaigns. Note which subject
     styles had the best open rate. Optionally `get_campaign_content` on the
     best one for structure and voice.
2. Confirm audience, tone and any must-include items (an offer, an event, a
   link).
3. Draft:
   - 3 subject line options with preview text, each tied to a past result
     ("short question subjects opened 31% vs 22%").
   - Body: short intro, 3–5 sections built from the top posts (expanded, not
     pasted), one clear call to action, sign-off.
   - A plain-text version.
4. Return the draft in chat and offer revisions. Tell the user to paste it into
   a Mailchimp campaign and send a test email from Mailchimp before sending.

## Pitfalls

- Treat a Mailchimp result with an `error` field, or a missing or null total,
  as a failed read. Say so; don't write "no past campaigns".
- Don't include subscriber names or emails in the draft. This skill never reads
  member lists.
- No invented numbers, quotes or claims. Every stat in the email must come
  from the user or from the reads above.
- Respect the user's legal footer and unsubscribe handling. Mailchimp adds it;
  don't write a fake one.
