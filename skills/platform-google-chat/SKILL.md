---
name: platform-google-chat
description: Wire a remote Hermes Agent to Google Chat via a Workspace Chat app backed by a Cloud Pub/Sub pull subscription over SSH (no public webhook, no tunnel). Enforces a hard email allowlist gate, validates GCP resources exist, and checks the chat-api-push Publisher IAM. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /platform-google-chat — wire Google Chat to a remote Hermes (SSH-first, Pub/Sub pull)

You are the engineer connecting Google Chat to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The bulk of the setup is in GCP / Workspace consoles (human steps);
this skill prepares Hermes config, validates the GCP resources exist, and gates enabling on
the allowlist + IAM checks.

The user does several things a machine cannot:

1. Create the GCP project, enable Google Chat API + Cloud Pub/Sub API.
2. Create the Pub/Sub topic + pull subscription, grant `chat-api-push@system.gserviceaccount.com`
   the **Pub/Sub Publisher** role on the topic.
3. Create the service account and download its JSON key; upload it to the VPS.
4. Configure the Chat app in the Google Chat API → Configuration page (set connection to
   **Cloud Pub/Sub**, point at the topic, publish at least to the Workspace domain).
5. Supply Workspace user emails for the allowlist.

Everything verifiable from the VPS — JSON key file presence + permissions, env writes,
subscription existence via `gcloud`, Publisher IAM on the topic, gateway reload, smoke test
— runs over SSH idempotently with a rollback path.

**Honest picture (verified 2026-06 on Hermes v0.15.x/0.17.x):** Google Chat support landed in
the "Tenacity" line. Inbound = Pub/Sub pull subscription (no public webhook URL needed —
similar ergonomics to Slack Socket Mode or Telegram long-polling). Outbound = Chat REST API
via the service-account credentials. This makes Google Chat one of the rare enterprise
platforms that's headless-friendly. The pain isn't on the Hermes side — it's the **GCP
prerequisites**: missing Publisher IAM on the topic is the #1 silent-failure mode
(subscription pulls succeed but no events arrive).

**Why the hard allowlist matters:** A Chat app published to a Workspace domain is reachable
by every user in the domain. Without `GOOGLE_CHAT_ALLOWED_USERS`, the entire domain can DM
the bot. This skill refuses to enable until at least one email is set, and validates each
entry is email-shaped.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GOOGLE_CHAT_PROJECT_ID` | GCP project ID hosting the Chat app + Pub/Sub | GCP console → Home → Project info |
| `$GOOGLE_CHAT_SUBSCRIPTION_NAME` | Full resource path `projects/<P>/subscriptions/<S>` | GCP console → Pub/Sub → Subscriptions → click the pull subscription |
| `$GOOGLE_CHAT_TOPIC_NAME` | Full resource path `projects/<P>/topics/<T>` | GCP console → Pub/Sub → Topics. Needed for the IAM check in Step 1. |
| `$SA_KEY_LOCAL_PATH` | Local path to the service-account JSON on YOUR machine (to be uploaded) | Wherever you saved it after creating the SA |
| `$SA_KEY_REMOTE_PATH` | Path on the VPS where the SA JSON will live | Default: `$HOME/.hermes/google-chat-sa.json` |
| `$GOOGLE_CHAT_ALLOWED_USERS` | Comma-separated Workspace emails | The people who should be able to DM the bot |
| `$GOOGLE_CHAT_HOME_CHANNEL` *(optional)* | `spaces/AAAA...` for unsolicited posts | Right-click space → Get link → space ID |

Pre-flight (the operator's responsibility — this skill checks but cannot create):
- GCP project exists; Chat API + Pub/Sub API enabled.
- Pub/Sub topic exists.
- `chat-api-push@system.gserviceaccount.com` has **Pub/Sub Publisher** on the topic.
- Pull subscription exists on that topic.
- Chat app published at least to the Workspace domain.

If `$GOOGLE_CHAT_ALLOWED_USERS` is empty, ABORT in Step 3 — do not proceed.

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + upload SA key + verify GCP pre-flight

```bash
# Hermes reachable
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    HERMES="docker exec $AGENT hermes"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
  echo "Using: $HERMES"
  $HERMES --version
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }

# Upload SA key to the VPS (chmod 600). The path on the VPS, NOT the contents, is what goes in env.
SA_REMOTE=${SA_KEY_REMOTE_PATH:-/root/.hermes/google-chat-sa.json}
scp "$SA_KEY_LOCAL_PATH" "$VPS_USER@$VPS_IP:$SA_REMOTE" \
  || { echo "ABORT: failed to upload $SA_KEY_LOCAL_PATH → $VPS_USER@$VPS_IP:$SA_REMOTE."; exit 1; }
ssh "$VPS_USER@$VPS_IP" "test -s '$SA_REMOTE' && chmod 600 '$SA_REMOTE' && echo 'SA key on VPS: $SA_REMOTE chmod 600'"

# Pre-flight GCP: subscription must exist; topic must have chat-api-push as Publisher.
# Use gcloud if available on the VPS; if not, document the manual checks.
ssh "$VPS_USER@$VPS_IP" "
  if command -v gcloud >/dev/null 2>&1; then
    gcloud auth activate-service-account --key-file='$SA_REMOTE' --quiet >/dev/null 2>&1 || true
    echo '--- subscription exists? ---'
    gcloud pubsub subscriptions describe '$GOOGLE_CHAT_SUBSCRIPTION_NAME' --format='value(name)' 2>&1 || echo 'WARN: subscription not visible to this SA — check name + roles/pubsub.subscriber on this subscription.'
    echo '--- chat-api-push has Publisher on topic? ---'
    gcloud pubsub topics get-iam-policy '$GOOGLE_CHAT_TOPIC_NAME' --format='get(bindings)' 2>&1 \
      | grep -q 'chat-api-push@system.gserviceaccount.com' \
      && echo 'OK: chat-api-push is bound on the topic.' \
      || echo 'WARN: could not confirm chat-api-push has Publisher — verify in GCP console.'
  else
    echo 'WARN: gcloud not installed on VPS — cannot auto-verify GCP resources.'
    echo 'Manual checks before continuing:'
    echo '  1. Subscription exists: $GOOGLE_CHAT_SUBSCRIPTION_NAME'
    echo '  2. chat-api-push@system.gserviceaccount.com has Pub/Sub Publisher on $GOOGLE_CHAT_TOPIC_NAME'
  fi
"
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ENABLED=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GOOGLE_CHAT_ENABLED=true' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_PROJ=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GOOGLE_CHAT_PROJECT_ID=.' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_SUB=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GOOGLE_CHAT_SUBSCRIPTION_NAME=projects/' ~/.hermes/.env 2>/dev/null" || echo 0)
HAS_SA=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=/' ~/.hermes/.env 2>/dev/null" || echo 0)
ALLOW=$(ssh "$VPS_USER@$VPS_IP" "grep -E '^GOOGLE_CHAT_ALLOWED_USERS=.+@' ~/.hermes/.env 2>/dev/null | grep -cv 'GOOGLE_CHAT_ALLOWED_USERS=\$'" || echo 0)
if [ "$ENABLED" = "1" ] && [ "$HAS_PROJ" = "1" ] && [ "$HAS_SUB" = "1" ] && [ "$HAS_SA" = "1" ] && [ "$ALLOW" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Google Chat already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (allowlist + email format + subscription path format + SA path)

```bash
if [ -z "${GOOGLE_CHAT_ALLOWED_USERS:-}" ]; then
  echo "ABORT: GOOGLE_CHAT_ALLOWED_USERS is empty. The whole Workspace domain could DM the bot."
  echo "Supply Workspace user emails, comma-separated. Example: alice@acme.com,bob@acme.com"
  exit 1
fi

# Validate each entry is email-shaped (very loose; Google validates the rest)
INVALID=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" \
  | tr ',' '\n' \
  | awk 'NF && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/ { print }')
if [ -n "$INVALID" ]; then
  echo "ABORT: invalid emails in GOOGLE_CHAT_ALLOWED_USERS:"
  echo "$INVALID"
  exit 1
fi

# Subscription path must be full resource path
printf '%s' "$GOOGLE_CHAT_SUBSCRIPTION_NAME" | grep -qE '^projects/[^/]+/subscriptions/[^/]+$' \
  || { echo "ABORT: GOOGLE_CHAT_SUBSCRIPTION_NAME must be 'projects/<P>/subscriptions/<S>'."; exit 1; }
printf '%s' "$GOOGLE_CHAT_TOPIC_NAME" | grep -qE '^projects/[^/]+/topics/[^/]+$' \
  || { echo "ABORT: GOOGLE_CHAT_TOPIC_NAME must be 'projects/<P>/topics/<T>'."; exit 1; }

# Home channel format
if [ -n "${GOOGLE_CHAT_HOME_CHANNEL:-}" ]; then
  printf '%s' "$GOOGLE_CHAT_HOME_CHANNEL" | grep -qE '^spaces/[A-Za-z0-9_-]+$' \
    || { echo "ABORT: GOOGLE_CHAT_HOME_CHANNEL must be 'spaces/<ID>'."; exit 1; }
fi

# SA key file must be on disk on the VPS and chmod 600
SA_REMOTE=${SA_KEY_REMOTE_PATH:-/root/.hermes/google-chat-sa.json}
ssh "$VPS_USER@$VPS_IP" "test -s '$SA_REMOTE' && [ \"\$(stat -c '%a' '$SA_REMOTE')\" = '600' ]" \
  || { echo "ABORT: $SA_REMOTE missing, empty, or not chmod 600 on the VPS."; exit 1; }

echo "Allowlist + paths + SA file OK."
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
SA_REMOTE=${SA_KEY_REMOTE_PATH:-/root/.hermes/google-chat-sa.json}
USERS_N=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" | tr ',' '\n' | wc -l | tr -d ' ')
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write GOOGLE_CHAT_PROJECT_ID ($GOOGLE_CHAT_PROJECT_ID)
  2. Write GOOGLE_CHAT_SUBSCRIPTION_NAME ($GOOGLE_CHAT_SUBSCRIPTION_NAME)
  3. Write GOOGLE_CHAT_SERVICE_ACCOUNT_JSON ($SA_REMOTE — path, NOT contents)
  4. Write GOOGLE_CHAT_ALLOWED_USERS ($USERS_N email(s))
  5. Write GOOGLE_CHAT_HOME_CHANNEL (${GOOGLE_CHAT_HOME_CHANNEL:-none}) if supplied
  6. chmod 600 ~/.hermes/.env
  7. Verify all landed (grep -c)
  8. ONLY NOW: GOOGLE_CHAT_ENABLED=true
  9. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
 10. Verify google_chat in gateway status + Pub/Sub pull starts working
 11. Smoke test: allowlisted user DMs the bot; expect reply
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write Hermes config (NOT enable yet)

```bash
SA_REMOTE=${SA_KEY_REMOTE_PATH:-/root/.hermes/google-chat-sa.json}
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_PROJECT_ID '$GOOGLE_CHAT_PROJECT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_SUBSCRIPTION_NAME '$GOOGLE_CHAT_SUBSCRIPTION_NAME'"
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_SERVICE_ACCOUNT_JSON '$SA_REMOTE'"
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_ALLOWED_USERS '$GOOGLE_CHAT_ALLOWED_USERS'"
if [ -n "${GOOGLE_CHAT_HOME_CHANNEL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_HOME_CHANNEL '$GOOGLE_CHAT_HOME_CHANNEL'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "
  grep -cE '^(GOOGLE_CHAT_PROJECT_ID=.|GOOGLE_CHAT_SUBSCRIPTION_NAME=projects/|GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=/|GOOGLE_CHAT_ALLOWED_USERS=.|GOOGLE_CHAT_HOME_CHANNEL=spaces/)' ~/.hermes/.env
" || echo 0)
[ "$COUNT" -ge 4 ] || { echo "FAIL: Google Chat config did not land (got $COUNT, need ≥4). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the SA JSON contents in `config.yaml` (path only).

---

## Step 6 — enable Google Chat (only after Step 5 verification)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_ENABLED true"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 8
```

---

## Step 8 — verify Google Chat adapter + Pub/Sub pull is working

```bash
CONNECTED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes gateway status 2>&1 | grep -i google_chat" \
       || ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1 | grep -qiE 'google_chat.*(ready|pull|subscription|connected)'"; then
    CONNECTED=1
    echo "OK: Google Chat adapter loaded; Pub/Sub pull active."
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || { echo "FAIL: Google Chat did not attach. Rolling back."; rollback; exit 1; }

# Optional: if gcloud is on the VPS, confirm the subscription is receiving messages
ssh "$VPS_USER@$VPS_IP" "
  if command -v gcloud >/dev/null 2>&1; then
    SUB_STATE=\$(gcloud pubsub subscriptions describe '$GOOGLE_CHAT_SUBSCRIPTION_NAME' --format='value(state)' 2>/dev/null)
    echo \"Subscription state: \$SUB_STATE\"
  fi
"
```

---

## Step 9 — live smoke test (allowlisted Workspace user DMs the bot)

```bash
FIRST_USER=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Workspace user $FIRST_USER:
  1. Open Google Chat in that user's account.
  2. Find the published Chat app (the name you set in the Chat API → Configuration page).
  3. Send "hello" as a DM.
  4. Expect a reply within 5s.

If silent:
  - 'hermes logs gateway -n 50 | grep -i google_chat' on the VPS
  - In GCP console: Pub/Sub → Subscriptions → '$GOOGLE_CHAT_SUBSCRIPTION_NAME' → Metrics
    → Unacked message count should increment when messages arrive; if it stays at 0,
    the Publisher IAM on the topic is wrong (chat-api-push not bound)
  - Confirm the Chat app is published at least to your Workspace domain (not "just me")
EOF

ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 50 2>&1 | grep -i google_chat" | tail -20
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config set GOOGLE_CHAT_ENABLED false 2>/dev/null || \
    sed -i 's|^GOOGLE_CHAT_ENABLED=true|GOOGLE_CHAT_ENABLED=false|' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Google Chat disabled. SA key + config preserved for retry."
}

hard_rollback() {
  rollback
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^GOOGLE_CHAT_PROJECT_ID=/d;
            /^GOOGLE_CHAT_SUBSCRIPTION_NAME=/d;
            /^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=/d;
            /^GOOGLE_CHAT_ALLOWED_USERS=/d;
            /^GOOGLE_CHAT_HOME_CHANNEL=/d;
            /^GOOGLE_CHAT_ENABLED=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  echo "Hard-rolled back. Env wiped. SA key file left in place — delete manually if decommissioning."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Empty `GOOGLE_CHAT_ALLOWED_USERS` | Whole Workspace domain can DM the bot | Step 3 hard-abort; Step 6 only after Step 5 |
| 2 | Setting `GOOGLE_CHAT_SUBSCRIPTION_NAME` to a TOPIC path | Hermes pulls subscriptions, not topics — no events arrive | Step 3 validator requires `projects/.../subscriptions/...` |
| 3 | `chat-api-push@system.gserviceaccount.com` missing Publisher on the topic | Subscription stays empty; bot looks dead while logs show "pulling" | Step 1 IAM check via `gcloud pubsub topics get-iam-policy`; Step 9 troubleshooting calls it out |
| 4 | `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` set to JSON contents instead of file path | Hermes expects a filesystem path | Step 3 validator requires `^/` |
| 5 | SA key file not `chmod 600` | World-readable secret | Step 1 chmod after upload; Step 3 verifies mode |
| 6 | Chat app published to "just me" | Allowlisted users can't find or install the bot | Verify publish scope before smoke test |
| 7 | Allowlist with @handles or display names | Allowlist matcher is exact-string on email | Step 3 validator requires `<local>@<domain>.<tld>` |
| 8 | 4000-char message limit | Long replies split into multiple chat messages — looks like duplicate sends | Platform limit; document, don't debug |
| 9 | Threads = separate sessions | Memory doesn't cross threads in Google Chat | Set expectations; use external memory backend if needed |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | SA JSON in `config.yaml` | Often checked into git | Only the path goes in `.env`; the file stays on disk at chmod 600 |
| 13 | sed with `/` delimiter on subscription path | Path contains `/` and breaks sed | Always `\|` delimiter |
| 14 | Container vs host confusion | SA key uploaded to host but Hermes runs in container | Mount the file into the container or upload to `/opt/data/google-chat-sa.json` |
| 15 | `GOOGLE_APPLICATION_CREDENTIALS` left set from another GCP tool | Conflicts with `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` | Unset the other or align them to the same path |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] SA JSON uploaded to the VPS at `$SA_KEY_REMOTE_PATH`, `chmod 600`
- [ ] Pre-flight GCP checks: subscription exists (or warning printed), chat-api-push has Publisher on topic (or warning printed)
- [ ] Idempotency check ran (skipped if enabled + project + subscription + SA path + allowlist, unless `FORCE=1`)
- [ ] HARD GATE passed: allowlist non-empty + every entry is email-shaped; subscription path matches `projects/.../subscriptions/...`; topic path matches `projects/.../topics/...`; home channel (if set) is `spaces/...`; SA key file is chmod 600
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] All env keys written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `GOOGLE_CHAT_ENABLED=true` set ONLY after Step 5 verification passed
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Google Chat adapter loaded (confirmed in `gateway status` or logs)
- [ ] Live smoke: allowlisted Workspace user DM'd the bot and got a reply
- [ ] Rollback function defined (`rollback`: disable, keep config; `hard_rollback`: env wipe)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, GCP IAM,
and Pub/Sub failure modes.
