---
name: platform-google-chat
description: Connect Hermes to Google Chat via a Google Workspace Chat app backed by a Cloud Pub/Sub pull subscription (no public URL, no tunnel). Handles service-account creds, the Pub/Sub wiring, and the email allowlist. Use when wiring Google Chat.
---

# /platform-google-chat — wire Google Chat (Workspace, Pub/Sub pull)

Google Chat support landed upstream in the "Tenacity" line and is listed among Hermes' supported
messaging platforms; on **v0.15.2** the runtime reads `GOOGLE_CHAT_*` env vars and the gateway
exposes `hermes gateway setup` with a Google Chat entry. Inbound events arrive via a Cloud
**Pub/Sub pull subscription**, outbound replies use the **Chat REST API** — same ergonomics as
Slack Socket Mode or Telegram long-polling, no inbound webhook URL required.

This is the heaviest of the messaging skills: most of the work is in **Google Cloud / Workspace
console** (human steps), not on the VPS. The skill prepares Hermes config and gates enabling on
the allowlist; the GCP-side resources must already exist before the gateway will receive events.

## Ask the user (the human-only parts)

1. **GCP project ID** — the project where the Chat app + Pub/Sub live (e.g. `acme-hermes-chat`).
2. **Service-account JSON key** — for an SA named e.g. `hermes-chat-bot` in that project, with
   `Pub/Sub Subscriber` + `Pub/Sub Viewer` on the subscription. Upload the key file to the VPS at
   `/root/.hermes/google-chat-sa.json` (or `$HOME/.hermes/google-chat-sa.json`) **first**, then
   `chmod 600` it. Hermes reads it from disk; the path goes in the env var, not the JSON contents.
3. **Pub/Sub subscription name** — full resource path, e.g.
   `projects/acme-hermes-chat/subscriptions/hermes-chat-events-sub` (pull, 7-day retention).
4. **Workspace user emails** for the allowlist (e.g. `alice@acme.com,bob@acme.com`). These are the
   Google identities that may DM the bot. Hard gate, same pattern as WhatsApp.
5. **Optional home space ID** — `spaces/AAAA...` if Hermes should post unsolicited into a space.

### Console prerequisites (must already be done in GCP / Workspace before this skill runs)

- GCP project created.
- **Google Chat API** and **Cloud Pub/Sub API** enabled in that project.
- Pub/Sub topic `hermes-chat-events` exists; the Chat push principal
  `chat-api-push@system.gserviceaccount.com` has **Pub/Sub Publisher** on the topic.
- Pull subscription `hermes-chat-events-sub` exists on that topic.
- Google Chat API → **Configuration**: app name, avatar, connection set to **Cloud Pub/Sub**,
  topic = the topic above, and the app is **published** (at least to the Workspace domain).
- Workspace admin has installed/allowed the Chat app for users who will DM it.

If any of those are missing, stop and tell the user — Hermes cannot create Workspace apps for them.

## Procedure

**HARD GATE: do not enable Google Chat or start the gateway with it on until
`GOOGLE_CHAT_ALLOWED_USERS` holds at least one email.** With an empty allowlist any Workspace
user (potentially the whole domain, depending on publish scope) who can reach the bot could
execute skills and tools. Set the allowlist first, then enable, then reload.

```bash
HERMES="$HOME/.local/bin/hermes"
SA_PATH="$HOME/.hermes/google-chat-sa.json"   # uploaded by the user beforehand

# 0. Sanity-check the SA key file is present and locked down.
test -s "$SA_PATH" || { echo "ABORT: $SA_PATH missing or empty — upload the service-account JSON first." >&2; exit 1; }
chmod 600 "$SA_PATH"

# 1. Set the allowlist FIRST — this is the gate. Comma-separated Workspace emails, no spaces.
"$HERMES" config set GOOGLE_CHAT_ALLOWED_USERS "alice@acme.com,bob@acme.com"

# 2. Wire the GCP plumbing (project + Pub/Sub pull subscription + SA key path).
"$HERMES" config set GOOGLE_CHAT_PROJECT_ID        "acme-hermes-chat"
"$HERMES" config set GOOGLE_CHAT_SUBSCRIPTION_NAME "projects/acme-hermes-chat/subscriptions/hermes-chat-events-sub"
"$HERMES" config set GOOGLE_CHAT_SERVICE_ACCOUNT_JSON "$SA_PATH"

# Optional: a default space Hermes can post into unprompted.
# "$HERMES" config set GOOGLE_CHAT_HOME_CHANNEL "spaces/AAAAxxxxxxx"

chmod 600 ~/.hermes/.env

# 3. Refuse to continue if the allowlist is empty (read it back from `config show`;
#    there is no `config get`). Match an email-shaped value.
if ! "$HERMES" config show | grep -qE '^GOOGLE_CHAT_ALLOWED_USERS *[:=].*@'; then
  echo "ABORT: GOOGLE_CHAT_ALLOWED_USERS is unset/empty — the Chat app could answer anyone reachable. Set it first." >&2
  exit 1
fi

# 4. Only now enable the platform.
"$HERMES" config set GOOGLE_CHAT_ENABLED true

# 5. Reload — env changes need a clean re-read; restart does not reliably re-read new env vars.
"$HERMES" gateway stop
sleep 3
"$HERMES" gateway run
sleep 8
"$HERMES" gateway status
```

If the user prefers the guided wizard, `hermes gateway setup` → **Google Chat** walks through the
same env vars interactively; the allowlist gate above still applies before you let the gateway
come up.

## Pitfalls (pre-solve)

- **`GOOGLE_CHAT_ALLOWED_USERS` is a hard gate, not a nicety.** Leave it unset/empty and any
  Workspace user who can reach the published Chat app may execute skills on their behalf. Never
  enable Google Chat before the allowlist holds at least one email.
- **The bulk of setup is in GCP, not on the VPS.** Project, APIs enabled, Pub/Sub topic +
  subscription, IAM, Chat API Configuration page, and a **published** app must all exist before
  the gateway will see any event. No env var setting fixes a missing Pub/Sub subscription.
- **Topic vs subscription** — `GOOGLE_CHAT_SUBSCRIPTION_NAME` is the **subscription** resource
  path (`projects/<p>/subscriptions/<sub>`), not the topic. Hermes pulls, not pushes.
- **Service-account JSON path, not contents.** `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` is a filesystem
  path. The file must be readable by the hermes process and `chmod 600`. Never paste the JSON
  into chat or commit it. (`GOOGLE_APPLICATION_CREDENTIALS` is honoured as a fallback, and
  `GOOGLE_CLOUD_PROJECT` as a fallback for the project ID.)
- **Chat publisher IAM is easy to miss.** `chat-api-push@system.gserviceaccount.com` needs
  **Pub/Sub Publisher** on the topic, or the Chat API will silently drop events and the bot
  appears dead while your SA's pull subscription works fine.
- **4000-char message limit** — long replies are split into multiple messages. This is a
  platform constraint, not a Hermes bug.
- **Threads = separate sessions.** Replies inside a thread land in the same thread; each thread
  is its own Hermes session, so don't expect cross-thread memory unless your memory backend
  spans them.
- **Workspace publish scope.** A Chat app published only to "just me" won't be reachable by
  other allowlisted users — confirm publish scope matches the allowlist.

## Verify

1. `hermes gateway status` reports the gateway running and lists `google_chat` among active
   platforms.
2. An **allowed** Workspace user DMs the bot → gets a reply. Pub/Sub message count on the
   subscription increments (visible in GCP console / `gcloud pubsub subscriptions pull`).
3. A user **not** on `GOOGLE_CHAT_ALLOWED_USERS` DMs the bot → no reply (default-deny).
4. If `GOOGLE_CHAT_HOME_CHANNEL` is set, `hermes` can post into that space unprompted (smoke-test
   via `/hermes-home`).

## Definition of done

- [ ] Service-account JSON is on disk at the configured path with `chmod 600`; the path (not the
      contents) is in `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON`.
- [ ] `GOOGLE_CHAT_PROJECT_ID` and `GOOGLE_CHAT_SUBSCRIPTION_NAME` are set via `hermes config set`
      (subscription is the full `projects/<p>/subscriptions/<sub>` path, not the topic).
- [ ] `GOOGLE_CHAT_ALLOWED_USERS` holds at least one Workspace email, set via `hermes config set`,
      and `~/.hermes/.env` is `chmod 600`.
- [ ] `GOOGLE_CHAT_ENABLED true` was set **only after** the allowlist gate passed (the gateway
      was never started with Google Chat on and an empty allowlist).
- [ ] Gateway was reloaded with `gateway stop` + `gateway run` (not `restart`) and
      `hermes gateway status` reports it running.
- [ ] An allowed Workspace user DMs the bot and gets a reply; a non-allowlisted user gets none.

See `reference/TROUBLESHOOTING.md` for gateway and platform failure modes.
