---
name: integration-segment
description: Connect Segment (Twilio Segment CDP — event pipeline that fans track/identify/group calls out to 400+ destinations) to a self-hosted Hermes agent over SSH. Documents the HTTP Tracking API surface; the Public API is documented separately. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and any AI agent.
---

# /integration-segment — connect Segment CDP to a remote Hermes (SSH-first)

You are the engineer connecting Segment (Twilio Segment CDP) to a self-hosted Hermes
agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. Every command in this skill runs on
the VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do — creating the
Source in the Segment UI and (for querying) minting a Public API token.

**Honest picture (verified 2026-06):** Segment ships **no first-party MCP server**.
The product is two separate HTTP surfaces:

1. **HTTP Tracking API** — `https://api.segment.io/v1` — takes a per-Source **Write Key**
   via HTTP Basic (`user = write_key`, empty password). This is what you use to `track`,
   `identify`, `group`, `page`, `screen`, and `alias`. It is one-way (write-only from
   your perspective — Segment fans events out to configured destinations like Mixpanel,
   Amplitude, BigQuery, Snowflake, S3, etc.).
2. **Public API** — `https://api.segmentapim.com/v1beta` — takes a Workspace-scoped
   **bearer token** (`Authorization: Bearer <token>`). This is what you use to list
   sources, destinations, tracking-plan status, and audit deliveries.

Segment is *not* an analytics product itself — it's the pipe. Do NOT wire it as a
replacement for `integration-posthog` (analytics) or `integration-sentry` (errors); it
sits *upstream* of both. Also NOT chat-completion.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$SEGMENT_WRITE_KEY` | Source-scoped write key (opaque alnum, ~32 chars) | <https://app.segment.com/> -> Sources -> select/create HTTP API Source -> Settings -> API Keys -> **Write Key** |
| `$SEGMENT_PUBLIC_TOKEN` | (Optional) Workspace token for the Public API | Workspace Settings -> Access Management -> Tokens -> **Create Token** (workspace-owner role); leave blank to skip Public API tools |
| `$SEGMENT_REGION` | `us` (default) or `eu` — Segment has two isolated regions | Same page shows the region; EU sources use `https://events.eu1.segmentapis.com/v1` |
| `$WRITE_ONLY_ACKNOWLEDGED` | Set to `1` to confirm you understand this is send-only (no read from destinations via Segment) | Consent gate |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
ssh "$VPS_USER@$VPS_IP" '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^SEGMENT_WRITE_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Segment is already wired (SEGMENT_WRITE_KEY present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate credential format AND live Segment API pre-flight

Do NOT write anything until both pass.

```bash
[ "${WRITE_ONLY_ACKNOWLEDGED:-0}" = "1" ] || {
  echo "ABORT: WRITE_ONLY_ACKNOWLEDGED=1 required. Segment is a fan-out pipe, not an analytics/read source. Wire integration-posthog (or destination-specific) for reads."; exit 1;
}

# Format
[ "${#SEGMENT_WRITE_KEY}" -ge 20 ] || { echo "ABORT: SEGMENT_WRITE_KEY too short (${#SEGMENT_WRITE_KEY} chars)."; exit 1; }
case "$SEGMENT_REGION" in us|eu) ;; *) echo "ABORT: SEGMENT_REGION must be 'us' or 'eu' (got '$SEGMENT_REGION')."; exit 1 ;; esac

# Region -> endpoint
case "$SEGMENT_REGION" in
  us) TRACK_HOST="https://api.segment.io" ;;
  eu) TRACK_HOST="https://events.eu1.segmentapis.com" ;;
esac

# Live pre-flight: a well-formed no-op track call. 200 = key accepted; 400 = bad payload; 401 = key rejected.
HTTP=$(curl -sS -o /tmp/seg-preflight.json -w "%{http_code}" \
  -u "$SEGMENT_WRITE_KEY:" \
  -H "Content-Type: application/json" \
  -d '{"userId":"hstack-preflight","event":"hstack.integration.preflight","properties":{"source":"integration-segment"}}' \
  "$TRACK_HOST/v1/track")
case "$HTTP" in
  200) echo "OK: Segment write key valid ($SEGMENT_REGION region)." ;;
  401) echo "ABORT: 401 — write key invalid. Copy from Sources -> API Keys -> Write Key."; rm -f /tmp/seg-preflight.json; exit 1 ;;
  400) echo "ABORT: 400 — payload rejected. Details:"; cat /tmp/seg-preflight.json; rm -f /tmp/seg-preflight.json; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/seg-preflight.json; rm -f /tmp/seg-preflight.json; exit 1 ;;
esac
rm -f /tmp/seg-preflight.json

# Optional Public API pre-flight
if [ -n "$SEGMENT_PUBLIC_TOKEN" ]; then
  HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $SEGMENT_PUBLIC_TOKEN" \
    "https://api.segmentapim.com/v1beta/workspaces")
  case "$HTTP" in
    200) echo "OK: Segment Public API token valid." ;;
    401|403) echo "ABORT: Public API token rejected ($HTTP). Regenerate with workspace-owner scope."; exit 1 ;;
    *) echo "WARN: Public API returned HTTP $HTTP. Continuing without it." ; SEGMENT_PUBLIC_TOKEN="" ;;
  esac
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write SEGMENT_WRITE_KEY   (length ${#SEGMENT_WRITE_KEY},   prefix ${SEGMENT_WRITE_KEY:0:4}...)
     Write SEGMENT_REGION      ($SEGMENT_REGION)
$( [ -n "$SEGMENT_PUBLIC_TOKEN" ] && echo "     Write SEGMENT_PUBLIC_TOKEN (length ${#SEGMENT_PUBLIC_TOKEN}, prefix ${SEGMENT_PUBLIC_TOKEN:0:4}...)" )
  2. chmod 600 ~/.hermes/.env
  3. Document REST surface at /opt/data/segment-rest.md (track/identify/group/page/screen/alias + Public API)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify env loaded: env | grep -c '^SEGMENT_' inside the gateway
  6. Smoke test: POST /v1/track with a real event -> expect 200; verify it appears in Source Debugger

Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 5 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes config set SEGMENT_WRITE_KEY '$SEGMENT_WRITE_KEY'
  hermes config set SEGMENT_REGION    '$SEGMENT_REGION'
  $( [ -n "$SEGMENT_PUBLIC_TOKEN" ] && echo "hermes config set SEGMENT_PUBLIC_TOKEN '$SEGMENT_PUBLIC_TOKEN'" )
  chmod 600 ~/.hermes/.env
"
```

Verify each landed (returns `1` per line, NEVER the value):

```bash
KEYS="SEGMENT_WRITE_KEY SEGMENT_REGION"
[ -n "$SEGMENT_PUBLIC_TOKEN" ] && KEYS="$KEYS SEGMENT_PUBLIC_TOKEN"
for K in $KEYS; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$K=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $K not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with
> `|` delimiter — write keys can contain `+/=`, so `/` delimiter is unsafe:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'SEGMENT_WRITE_KEY=$SEGMENT_WRITE_KEY' 'SEGMENT_REGION=$SEGMENT_REGION'; do
>     K=\${KV%%=*}
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 6 — document the REST surface (no MCP exists)

Write `/opt/data/segment-rest.md` on the VPS so any tool-using agent can call Segment
via Hermes' generic HTTP tool. Secrets stay only in `~/.hermes/.env`.

```bash
ssh "$VPS_USER@$VPS_IP" "mkdir -p /opt/data && cat > /opt/data/segment-rest.md" <<'DOC'
# Segment REST surface (wired via Hermes generic HTTP tool)

**Region-aware host:** us -> `https://api.segment.io`, eu -> `https://events.eu1.segmentapis.com`

**Tracking API auth:** HTTP Basic — `user = ${SEGMENT_WRITE_KEY}`, password empty.
Segment is send-only from your perspective; use destinations (Mixpanel, Amplitude, BigQuery, etc.) for reads.

## track — behavioral event

`POST /v1/track`
```json
{
  "userId": "user-123",
  "event": "Order Completed",
  "properties": {"revenue": 42.0, "currency": "USD"},
  "context": {"source": "hermes-agent"},
  "timestamp": "2026-06-01T12:00:00Z"
}
```
Success: `200 {"success":true}`. Failures return `400` on payload issues, `401` on bad key.

## identify — associate traits with a user

`POST /v1/identify`
```json
{"userId":"user-123","traits":{"email":"a@b.co","plan":"pro"}}
```

## group — associate user with an account/org

`POST /v1/group`  — `{"userId":"user-123","groupId":"org-42","traits":{"name":"Acme"}}`

## page / screen — surface views

`POST /v1/page`   — `{"userId":"user-123","name":"Home","properties":{"path":"/"}}`
`POST /v1/screen` — `{"userId":"user-123","name":"Home"}` (mobile equivalent)

## alias — merge anonymous → known

`POST /v1/alias`  — `{"previousId":"anon-abc","userId":"user-123"}`

## batch — up to 500 events in one call

`POST /v1/batch`
```json
{"batch":[{"type":"track","event":"…","userId":"…"}, …]}
```
Max payload: **500 KB total, 32 KB per event**. Larger payloads return `413`.

## Public API (workspace-scoped reads)

Base: `https://api.segmentapim.com/v1beta`
Auth: `Authorization: Bearer ${SEGMENT_PUBLIC_TOKEN}`

- `GET /workspaces` — the workspace this token belongs to.
- `GET /sources` — list sources (name, slug, region, write-key exposure OFF).
- `GET /destinations?sourceId=…` — active destinations for a source.
- `GET /tracking-plans` — tracking plans + violation counts.
- `GET /delivery-metrics/sources/{sourceId}` — event volume + delivery success rate per destination.

## Common failure modes to surface in agent replies

| Code | Meaning | Fix |
|------|---------|-----|
| 400  | Malformed payload (missing `userId`/`anonymousId`, bad timestamp) | Enforce schema client-side; every event needs one of userId or anonymousId |
| 401  | Write key rejected | Rotate; ensure you're using the *Source* write key, not a Public API token |
| 413  | Payload too large | Split into smaller `/v1/batch` calls (500 KB / 32 KB per event) |
| 429  | Rate limited (rare — Segment scales generously) | Backoff; check destination-side throttles too |
DOC
ssh "$VPS_USER@$VPS_IP" "chmod 644 /opt/data/segment-rest.md"
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify env is loaded inside the gateway

```bash
EXPECT=2
[ -n "$SEGMENT_PUBLIC_TOKEN" ] && EXPECT=3
LOADED=$(ssh "$VPS_USER@$VPS_IP" '
  AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
  if [ -n "$AGENT" ]; then
    docker exec "$AGENT" env | grep -c "^SEGMENT_"
  else
    hermes gateway env 2>/dev/null | grep -c "^SEGMENT_"
  fi
')
[ "$LOADED" = "$EXPECT" ] || { echo "FAIL: expected $EXPECT SEGMENT_* vars in gateway env, saw $LOADED. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (inside the VPS so the key stays there)

Send one real `track` event; Segment's Source Debugger will show it within ~2 seconds.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  case "$SEGMENT_REGION" in
    us) H="https://api.segment.io" ;;
    eu) H="https://events.eu1.segmentapis.com" ;;
  esac
  curl -sS -o /dev/null -w "%{http_code}" \
    -u "$SEGMENT_WRITE_KEY:" \
    -H "Content-Type: application/json" \
    -d "{\"userId\":\"hstack-smoketest\",\"event\":\"hstack.integration.wired\",\"properties\":{\"skill\":\"integration-segment\"}}" \
    "$H/v1/track"
')
case "$HTTP" in
  200) echo "OK: Hermes-side track call succeeded. Confirm event appears in Segment Source Debugger within ~2s." ;;
  401) echo "FAIL: 401 from inside Hermes — env not loaded or key rotated."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP. Investigate manually." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    for K in SEGMENT_WRITE_KEY SEGMENT_REGION SEGMENT_PUBLIC_TOKEN; do
      hermes config unset \$K 2>/dev/null || sed -i \"/^\$K=/d\" ~/.hermes/.env
    done
    rm -f /opt/data/segment-rest.md
    hermes gateway stop; sleep 2; hermes gateway run --daemon
  "
  echo "Rolled back. Segment is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Bearer instead of Basic on Tracking API | Segment ignores Bearer for `/v1/track` and returns 401. | HTTP Basic; `user = write_key`, empty password. |
| 2 | Using Public API token as write key | Different scopes; write returns 401. | Keep them separate; write key is per-Source, public token is workspace-wide. |
| 3 | Cross-region calls | US key on EU endpoint (or vice versa) returns 401 or drops silently. | Read region from Source Settings; store `SEGMENT_REGION`. |
| 4 | Missing `userId` and `anonymousId` | Segment rejects with 400. | Enforce at least one before send; use `anonymousId` for pre-login. |
| 5 | Oversized batch | `/v1/batch` caps at 500 KB total, 32 KB per event → 413. | Split; drop huge property blobs before send. |
| 6 | Wiring Segment as an analytics *reader* | Segment writes to destinations; reading data requires the destination's own API. | For reads use `integration-posthog` or destination-specific skill. |
| 7 | Treating this as an LLM provider | Segment is a CDP, not a chat/completion API. | Use `/hermes-model` for chat. |
| 8 | Storing write key in `config.yaml` | World-readable; can't be rotated without restart. | Only `~/.hermes/.env`, `chmod 600`. |
| 9 | sed with `/` delimiter | Write keys may contain `+/=`; `/` breaks. | Always use `\|` delimiter. |
| 10 | Container vs host confusion | Env on host but Hermes runs in container. | Step 1 detects layer; verify env inside gateway (Step 8). |
| 11 | `gateway restart` for env changes | Restart doesn't reliably re-read `.env`. | Always `stop` + `run`. |
| 12 | Logging event payloads | Traits often contain PII (email, plan tier, org). | Log status codes only; redact `traits` if you must log more. |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] `WRITE_ONLY_ACKNOWLEDGED=1` consent gate passed
- [ ] Format check passed for write key and region
- [ ] Live pre-flight `POST /v1/track` returned `200` BEFORE any write
- [ ] (Optional) Public API pre-flight returned `200` if token provided
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `SEGMENT_WRITE_KEY`, `SEGMENT_REGION` (+ optional `SEGMENT_PUBLIC_TOKEN`) in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `/opt/data/segment-rest.md` written with all event types + Public API + error table
- [ ] Gateway reloaded with `stop` + `run` (NOT `restart`)
- [ ] Env verified: 2 (or 3) `SEGMENT_*` vars visible inside gateway
- [ ] Hermes-side smoke test `POST /v1/track` returned `200`
- [ ] Event visible in Segment Source Debugger within ~2s
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and REST failure modes.
