---
name: integration-replicate
description: Connect Replicate (10k+ image/video/audio/language ML models — FLUX, Stable Diffusion 3.5, MusicGen, Meta Llama, Whisper, Real-ESRGAN, etc, addressed by owner/name:version SHA) to a self-hosted Hermes Agent over SSH via api.replicate.com with a static r8_ API token. Bearer auth. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-replicate — connect Replicate model catalog to a remote Hermes (SSH-first)

You are the engineer connecting Replicate (the "app store" of ML models — 10k+ open-source
models runnable via a single unified REST API, addressed by `owner/model:version_sha`) to
a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code,
Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against the VPS. The
user does one thing a machine cannot: mint the `r8_` API token at
https://replicate.com/account/api-tokens.

Everything else — token storage, live API verification, MCP registration, gateway reload,
live prediction smoke test — runs on the VPS via SSH, idempotently with a rollback.

**Honest auth picture (verified 2026-06):** Replicate has **no first-party MCP server**.
Their REST API is straightforward Bearer auth: `Authorization: Bearer <r8_...>`. This
skill wires **direct REST** (Path A) — no third-party MCP in the trust path.

Sources:
- https://replicate.com/docs/reference/http
- https://replicate.com/docs/get-started/http

**Why Replicate for AI agents:** you get access to models that don't fit anywhere else:
- **FLUX.1** (best-in-class open image gen)
- **Stable Diffusion 3.5** (image gen)
- **Kling / Pika / Runway** (text-to-video via community mirror pipes)
- **MusicGen** (music from text)
- **Real-ESRGAN** (image upscaling)
- **BLIP-2** (image captioning)
- **Whisper-large-v3** (transcription — Replicate's variant)
- **Meta Llama family** — including open weights not on OpenRouter

**Version pinning is mandatory:** every model on Replicate is addressed by
`owner/model:VERSION_SHA` (e.g. `black-forest-labs/flux-1.1-pro:d5f4d2c8...`). Running
`owner/model` alone (without SHA) uses the latest version — which can change silently and
break your outputs. Always pin.

**Cost model:** billed **per second of GPU/CPU time**, with per-run price shown in the
model's Replicate page. FLUX-Pro is ~$0.05/image; Kling video is ~$0.03/second of output.
Budget carefully — a runaway agent generating videos can burn through $10 fast.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$REPLICATE_API_TOKEN` | API token starting with `r8_` | https://replicate.com/account/api-tokens → Create token |
| `$REPLICATE_WEBHOOK_URL` *(optional)* | HTTPS webhook to receive prediction completion notifications | Any public HTTPS endpoint you control (or your Hermes ingress) |
| `$REPLICATE_ALLOWED_MODELS` *(optional but recommended)* | Comma-separated allowlist of `owner/model` prefixes | e.g. `black-forest-labs/flux-1.1-pro,meta/llama-3-70b` |

Confirm SSH access:

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
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^REPLICATE_API_TOKEN=r8_' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_TOKEN" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Replicate already wired. Set FORCE=1 to rewire."; exit 0
fi
```

---

## Step 3 — HARD GATE (token format + live account verify + spend check)

```bash
# Token format
printf '%s' "$REPLICATE_API_TOKEN" | grep -qE '^r8_[A-Za-z0-9]+$' \
  || { echo "ABORT: REPLICATE_API_TOKEN must start with 'r8_' (Replicate API token)."; exit 1; }
[ "${#REPLICATE_API_TOKEN}" -ge 30 ] \
  || { echo "ABORT: REPLICATE_API_TOKEN looks too short."; exit 1; }

# Live account verify — GET /v1/account
HTTP=$(curl -sS -o /tmp/rep.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $REPLICATE_API_TOKEN" \
  'https://api.replicate.com/v1/account' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    USERNAME=$(grep -oE '"username":"[^"]+"' /tmp/rep.json | head -1 | cut -d'"' -f4)
    TYPE=$(grep -oE '"type":"[^"]+"' /tmp/rep.json | head -1 | cut -d'"' -f4)
    echo "Replicate account OK. User: $USERNAME (type: $TYPE)."
    ;;
  401|403) echo "ABORT: 401/403 — token rejected. Re-check https://replicate.com/account/api-tokens."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/rep.json | head -3; exit 1 ;;
esac
rm -f /tmp/rep.json

# Webhook URL format if supplied
if [ -n "${REPLICATE_WEBHOOK_URL:-}" ]; then
  printf '%s' "$REPLICATE_WEBHOOK_URL" | grep -qE '^https://[^[:space:]]+$' \
    || { echo "ABORT: REPLICATE_WEBHOOK_URL must be HTTPS."; exit 1; }
fi

# Allowed models format if supplied
if [ -n "${REPLICATE_ALLOWED_MODELS:-}" ]; then
  INVALID=$(printf '%s' "$REPLICATE_ALLOWED_MODELS" \
    | tr ',' '\n' \
    | awk 'NF && !/^[a-z0-9][a-z0-9-]+\/[a-z0-9][a-z0-9.-]+$/ { print }')
  [ -z "$INVALID" ] || { echo "ABORT: invalid model entries: $INVALID (must be owner/model format)"; exit 1; }
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write REPLICATE_API_TOKEN (length ${#REPLICATE_API_TOKEN}, prefix r8_) via 'hermes config set'
  2. Write REPLICATE_WEBHOOK_URL (${REPLICATE_WEBHOOK_URL:-none}) if supplied
  3. Write REPLICATE_ALLOWED_MODELS (${REPLICATE_ALLOWED_MODELS:-none}) if supplied
  4. chmod 600 ~/.hermes/.env
  5. No MCP server registered (Replicate has no first-party MCP)
  6. Generic HTTP tool reads REPLICATE_API_TOKEN and calls api.replicate.com/v1/
  7. Reload gateway: stop + run
  8. Smoke test: POST /v1/predictions with cheapest available model (~$0.0001)
     OR skip smoke if free-tier credits are the concern

Token is NEVER printed in plaintext beyond a length + prefix.

Cost warning: Replicate bills per-second GPU time. A runaway agent generating videos or
high-res images can burn \$10+ fast. Set spend alerts at
https://replicate.com/account/billing before letting the agent run unattended.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the token (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set REPLICATE_API_TOKEN '$REPLICATE_API_TOKEN'"
if [ -n "${REPLICATE_WEBHOOK_URL:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set REPLICATE_WEBHOOK_URL '$REPLICATE_WEBHOOK_URL'"
fi
if [ -n "${REPLICATE_ALLOWED_MODELS:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set REPLICATE_ALLOWED_MODELS '$REPLICATE_ALLOWED_MODELS'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^REPLICATE_API_TOKEN=r8_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the token in `config.yaml`.

---

## Step 6 — document the REST surface (no MCP)

Generic HTTP tool reads env and uses:

- **Base URL:** `https://api.replicate.com/v1`
- **Auth:** `Authorization: Bearer ${REPLICATE_API_TOKEN}`
- **Content-Type:** `application/json`

Key endpoints:

| Capability | Method + Path | Notes |
|---|---|---|
| Create prediction | `POST /predictions` | Body: `{"version":"OWNER/MODEL:SHA","input":{...},"webhook":"..."}` |
| Get prediction | `GET /predictions/{id}` | Poll until `status:"succeeded"` |
| Cancel prediction | `POST /predictions/{id}/cancel` | Halts running prediction (partial billing) |
| List predictions | `GET /predictions` | Recent runs |
| Get model version | `GET /models/{owner}/{name}` | Get latest_version.id (SHA to pin) |
| Search models | `GET /models?search=...` | Discover new models |
| Account info | `GET /account` | Used in pre-flight |

**Sync vs async pattern:**
- **Sync (small/fast):** `POST /predictions` with `sync: true` — server holds connection
  until done (up to 60s). Only for very fast models.
- **Async (default):** `POST /predictions` returns immediately with `id` and `status:
  "starting"`. Poll `GET /predictions/{id}` or use webhook.
- **Webhook (best):** provide `webhook` URL in the POST body; Replicate calls it when the
  prediction status changes. Avoid tight polling loops.

**Version-pinning tool contract:** the agent's tool wrapper must reject `version` values
that don't match `^[a-z0-9-]+/[a-z0-9.-]+:[a-f0-9]{64}$` (owner/name:64-char-hex-SHA).
Never allow bare `owner/model` (unpinned).

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (account only, skip prediction to avoid cost)

```bash
# Only re-verify /v1/account — no prediction because even the cheapest costs money
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$REPLICATE_API_TOKEN\" \
    'https://api.replicate.com/v1/account'
")
case "$HTTP" in
  200) echo "OK: Replicate account API reachable from VPS. No prediction run (cost-safe)." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

Optional: if `RUN_PAID_SMOKE=1`, run the cheapest known model (~$0.0001):

```bash
if [ "${RUN_PAID_SMOKE:-0}" = "1" ]; then
  # meta/llama-3-70b via replicate has a very cheap text-only pass; adjust to whatever you trust
  echo "Running paid smoke — ~\$0.0001 estimated"
  # (Model + version SHA omitted here — user must supply to control cost precisely)
  echo "Consult https://replicate.com/explore for a model you trust and re-run with RUN_PAID_SMOKE=1 SMOKE_MODEL=owner/model:sha"
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^REPLICATE_API_TOKEN=/d;
            /^REPLICATE_WEBHOOK_URL=/d;
            /^REPLICATE_ALLOWED_MODELS=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at https://replicate.com/account/api-tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Running `owner/model` without version SHA | Latest version can change silently → different outputs | Tool contract must enforce `owner/model:64-hex-SHA` pattern |
| 2 | Runaway video generation | Kling/Runway videos at $0.03/sec × long durations = big bill fast | Set spend alerts; use REPLICATE_ALLOWED_MODELS to restrict expensive models |
| 3 | Sync mode timeout on slow models | `sync:true` holds connection up to 60s; models running longer fail | Use async + webhook for anything expected >30s |
| 4 | Tight polling loop | Rapid `GET /predictions/{id}` polls hit rate limits + are wasteful | Poll every 2-5s at first, back off; prefer webhooks |
| 5 | Model deprecation | Models can be removed by their owner; version SHAs become invalid | Handle 404 gracefully; document which models your agent depends on |
| 6 | Free-tier free credits exhaust silently | New accounts get $1 free; runs out fast | Monitor at https://replicate.com/account/billing |
| 7 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Model-not-found = wrong owner | Cursor-agent might guess wrong owner; typos land as 404 | Validate against `REPLICATE_ALLOWED_MODELS` prefix list before POSTing |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Webhook URL not publicly reachable | Replicate can't POST back → predictions stuck as "starting" in agent's mind | Verify webhook URL is publicly accessible with a curl smoke test before wiring |
| 14 | NSFW model without moderation | Some models generate NSFW; user's platform (WhatsApp, etc) may TOS-violate | Use REPLICATE_ALLOWED_MODELS to whitelist safe models |
| 15 | Prediction result URLs expire | Model outputs (images, videos) are stored on Replicate CDN; URLs expire after ~1 hour | Copy outputs to /integration-r2 or S3 for persistence |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: token starts with `r8_` + ≥30 chars; live `/v1/account` returned 200 with username + type
- [ ] Webhook URL (if set) is HTTPS
- [ ] Allowed-models list (if set) matches `owner/name` format for every entry
- [ ] Dry-run shown to user; cost warning acknowledged; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] REST surface documented (base + Bearer + endpoint table + sync/async/webhook patterns)
- [ ] Version-pinning contract documented (agent tool must enforce SHA-pinned refs)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v1/account` from VPS returned 200 (cost-safe — no prediction run)
- [ ] User told about spend alerts at replicate.com/account/billing
- [ ] User told to store prediction outputs in /integration-r2 or S3 (URLs expire ~1h)
- [ ] Rollback function defined; token revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, model
versioning, and Replicate spend-alert failure modes.
