---
name: integration-elevenlabs
description: Connect ElevenLabs (text-to-speech + voice cloning + conversational AI + speech-to-text — market-leading TTS quality, 32 languages, low-latency streaming) to a self-hosted Hermes Agent over SSH. Activates voice-out on WhatsApp, Signal, Telegram, and phone bots. Path A first-party stdio MCP; Path B direct REST with xi-api-key header (NOT Bearer). Refuses voice-clone requests without OWNS_VOICE_ACKNOWLEDGED=1. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-elevenlabs — connect ElevenLabs voice to a remote Hermes (SSH-first)

You are the engineer connecting ElevenLabs (best-in-class text-to-speech + voice cloning +
Conversational AI + STT) to a self-hosted Hermes agent on the user's VPS. You (the AI
agent — Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH
as root against the VPS. The user does one thing a machine cannot: mint the API key at
https://elevenlabs.io/app/settings/api-keys.

Everything else — key storage, live API verification, MCP registration, gateway reload,
live TTS generation smoke test — runs on the VPS via SSH, idempotently with a rollback.

**Honest auth picture (verified 2026-06):** ElevenLabs ships an **official first-party
stdio MCP** at `github.com/elevenlabs/elevenlabs-mcp` (published as `@elevenlabs/mcp` on
npm). Uses `ELEVENLABS_API_KEY` env. Auth on the REST API is the `xi-api-key` header
(NOT `Authorization: Bearer` — this is the #1 mistake).

Sources:
- https://elevenlabs.io/docs/api-reference/introduction
- https://github.com/elevenlabs/elevenlabs-mcp

**Two paths:**

- **Path A (default) — official stdio MCP via `npx`.** Full ElevenLabs API (TTS, voices,
  models, agents, STT, dubbing, voice-clone).
- **Path B (opt-in) — direct REST** against `https://api.elevenlabs.io/v1/` with
  `xi-api-key: <key>` header.

**Why this matters:** ElevenLabs unlocks voice-out for the messaging platforms Hermes
already supports (Telegram, WhatsApp, Signal, Discord). Combined with `/integration-deepgram`
(voice-in), Hermes becomes a full-duplex voice bot on any platform that supports audio.

**Voice-clone consent gate:** cloning a real person's voice without consent is legally and
ethically dangerous. This skill refuses `CLONE_ENABLED=1` unless `OWNS_VOICE_ACKNOWLEDGED=1`
is also set — a two-key gate that surfaces the consent obligation.

**Cost knob:** TTS costs characters-per-request. Free tier is 10k chars/mo; Starter tier
is 30k for $5/mo. A 30s reply is ~500 characters. Bursty voice replies drain quotas fast.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ELEVENLABS_API_KEY` | API key (long alphanumeric, no fixed prefix) | https://elevenlabs.io/app/settings/api-keys → Generate → set scopes → copy |
| `$ELEVENLABS_VOICE_ID` *(optional)* | Default voice ID for TTS | https://elevenlabs.io/app/voice-library → pick a voice → copy voice ID |
| `$ELEVENLABS_MODEL_ID` *(optional)* | Model ID (default `eleven_multilingual_v2`) | https://elevenlabs.io/docs/models |
| `$CLONE_ENABLED` *(optional)* | `1` to include voice-clone tools | Requires `OWNS_VOICE_ACKNOWLEDGED=1` (consent gate) |
| `$OWNS_VOICE_ACKNOWLEDGED` *(required if CLONE_ENABLED=1)* | `1` to confirm you have explicit consent for every voice you clone | Legal / ethical obligation |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (direct REST) | A requires `npx` on VPS |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + Path A prereqs

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

if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires npx on the VPS."; exit 1; }
fi
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci elevenlabs" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^ELEVENLABS_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY" -gt 0 ]; then
    echo "ElevenLabs already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "ElevenLabs key present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (key + voice-clone consent + live API verify)

```bash
# Key sanity — ElevenLabs keys are typically 32-40 char alphanumeric, no fixed prefix
[ "${#ELEVENLABS_API_KEY}" -ge 30 ] \
  || { echo "ABORT: ELEVENLABS_API_KEY looks too short (<30 chars)."; exit 1; }
printf '%s' "$ELEVENLABS_API_KEY" | grep -qE '^[A-Za-z0-9]+$' \
  || { echo "ABORT: ELEVENLABS_API_KEY should be alphanumeric only."; exit 1; }

# Voice-clone consent gate
if [ "${CLONE_ENABLED:-0}" = "1" ] && [ "${OWNS_VOICE_ACKNOWLEDGED:-0}" != "1" ]; then
  echo "ABORT: CLONE_ENABLED=1 requires OWNS_VOICE_ACKNOWLEDGED=1."
  echo ""
  echo "Voice cloning has legal + ethical obligations. You must have explicit consent"
  echo "from every person whose voice you clone. Cloning a public figure or celebrity"
  echo "without consent may violate their right of publicity and platform TOS."
  echo ""
  echo "Set OWNS_VOICE_ACKNOWLEDGED=1 to acknowledge you understand and comply."
  exit 1
fi

# Live API verify — GET /v1/user (uses xi-api-key header, NOT Bearer)
HTTP=$(curl -sS -o /tmp/el.json -w '%{http_code}' --max-time 10 \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  'https://api.elevenlabs.io/v1/user' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    TIER=$(grep -oE '"tier":"[^"]+"' /tmp/el.json | head -1 | cut -d'"' -f4)
    CHAR_LIMIT=$(grep -oE '"character_limit":[0-9]+' /tmp/el.json | head -1 | cut -d: -f2)
    CHAR_USED=$(grep -oE '"character_count":[0-9]+' /tmp/el.json | head -1 | cut -d: -f2)
    echo "ElevenLabs API OK. Tier: $TIER. Characters used: $CHAR_USED / $CHAR_LIMIT this cycle."
    ;;
  401|403) echo "ABORT: 401/403 — key rejected."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/el.json | head -3; exit 1 ;;
esac
rm -f /tmp/el.json

# Voice ID validation (optional)
if [ -n "${ELEVENLABS_VOICE_ID:-}" ]; then
  VHTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "xi-api-key: $ELEVENLABS_API_KEY" \
    "https://api.elevenlabs.io/v1/voices/$ELEVENLABS_VOICE_ID" 2>/dev/null) || VHTTP=000
  [ "$VHTTP" = "200" ] || { echo "ABORT: ELEVENLABS_VOICE_ID=$ELEVENLABS_VOICE_ID not found ($VHTTP)."; exit 1; }
  echo "Voice $ELEVENLABS_VOICE_ID visible."
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
MODEL=${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}
CLONE_STATUS=$([ "${CLONE_ENABLED:-0}" = "1" ] && echo "ENABLED (consent-acknowledged)" || echo "disabled (default)")
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN
  Voice clone tools: $CLONE_STATUS

  Always:
    1. Write ELEVENLABS_API_KEY (length ${#ELEVENLABS_API_KEY}) via 'hermes config set'
    2. Write ELEVENLABS_VOICE_ID (${ELEVENLABS_VOICE_ID:-none}) if supplied
    3. Write ELEVENLABS_MODEL_ID ($MODEL)
    4. chmod 600 ~/.hermes/.env

  Path A (stdio MCP):
    5. Register MCP: hermes mcp add elevenlabs --command npx --args -y,@elevenlabs/mcp
       --env ELEVENLABS_API_KEY=\${ELEVENLABS_API_KEY}
    6. Reload gateway: stop + run

  Path B (direct REST):
    5. No MCP; generic HTTP tool uses xi-api-key header (NOT Bearer)
    6. Reload gateway: stop + run

Smoke test: POST /v1/text-to-speech/{voice_id} with 15-char sample text (~ 20 characters
consumed from monthly quota) — expect audio/mpeg response.

Key is NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ELEVENLABS_API_KEY '$ELEVENLABS_API_KEY'"
if [ -n "${ELEVENLABS_VOICE_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set ELEVENLABS_VOICE_ID '$ELEVENLABS_VOICE_ID'"
fi
ssh "$VPS_USER@$VPS_IP" "hermes config set ELEVENLABS_MODEL_ID '${ELEVENLABS_MODEL_ID:-eleven_multilingual_v2}'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^ELEVENLABS_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: key not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

### Path A — official stdio MCP

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add elevenlabs \
      --command 'npx' \
      --args '-y,@elevenlabs/mcp' \
      --env 'ELEVENLABS_API_KEY=\${ELEVENLABS_API_KEY}'
  "
fi
```

### Path B — direct REST

Generic HTTP tool reads env and uses:

- **Base URL:** `https://api.elevenlabs.io/v1`
- **Auth header:** `xi-api-key: ${ELEVENLABS_API_KEY}` **(NOT `Authorization: Bearer`)**
- **Content-Type:** `application/json` (except multipart uploads)

Key endpoints:

| Capability | Method + Path | Notes |
|---|---|---|
| Text-to-speech | `POST /text-to-speech/{voice_id}` | Body: `{text, model_id, voice_settings}`; response is audio/mpeg |
| TTS streaming | `POST /text-to-speech/{voice_id}/stream` | Chunked audio for low-latency |
| List voices | `GET /voices` | |
| List models | `GET /models` | |
| Speech-to-text | `POST /speech-to-text` | Multipart with audio file |
| Voice clone (instant) | `POST /voices/add` | Requires OWNS_VOICE_ACKNOWLEDGED=1 gate |
| Conversational AI agent | `POST /convai/agents` | Full voice agent creation |
| User info + quota | `GET /user` | Check `character_count` / `character_limit` |

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live TTS smoke test

```bash
# Use a public default voice ID if none set (Rachel = 21m00Tcm4TlvDq8ikWAM)
VOICE=${ELEVENLABS_VOICE_ID:-21m00Tcm4TlvDq8ikWAM}
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    -X POST 'https://api.elevenlabs.io/v1/text-to-speech/$VOICE' \
    -H \"xi-api-key: \$ELEVENLABS_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"text\":\"hstack smoke test\",\"model_id\":\"'\"\$ELEVENLABS_MODEL_ID\"'\"}'
")
case "$HTTP" in
  200) echo "OK: TTS reachable from VPS (~17 characters consumed)." ;;
  401) echo "FAIL: 401. Rolling back."; rollback; exit 1 ;;
  402) echo "FAIL: 402 — over character quota."; rollback; exit 1 ;;
  429) echo "WARN: 429 — rate limit hit." ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

Path A registration verify:

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*elevenlabs|MCP server.*elevenlabs.*(ok|ready)"; then
      REGISTERED=1; echo "OK: elevenlabs MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "WARN: elevenlabs not in logs after 30s. REST-only fallback works."; }
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove elevenlabs 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^ELEVENLABS_API_KEY=/d;
            /^ELEVENLABS_VOICE_ID=/d;
            /^ELEVENLABS_MODEL_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://elevenlabs.io/app/settings/api-keys if compromised."
  echo "IMPORTANT: manually delete any cloned voices at Voice Library → Delete."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `Authorization: Bearer <key>` instead of `xi-api-key: <key>` | ElevenLabs rejects Bearer — 401 | This skill uses `xi-api-key` throughout; documented in Path B |
| 2 | Voice cloning without consent | Legal + ethical + TOS violation | Two-key gate: `CLONE_ENABLED=1` requires `OWNS_VOICE_ACKNOWLEDGED=1` |
| 3 | Bursty TTS drains monthly char quota | Voice replies to every message = free tier gone in an hour | Rate-limit voice replies in the agent; monitor quota via `/user` |
| 4 | Streaming endpoint used for small text | Streaming has higher latency setup than short one-shot | Use `/text-to-speech/{id}` for ≤500 chars, streaming for longer |
| 5 | Model mismatch — pinning a deprecated model | Some models sunset (e.g. eleven_monolingual_v1) | Track model deprecations in dashboard; pin only current ones |
| 6 | Voice ID from another account's Voice Library | Can't use another user's private voices | Only use voices from Voice Library, or clone your own |
| 7 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | STT (speech-to-text) confused with Deepgram/Whisper | ElevenLabs added STT but latency is higher than Deepgram | Use ElevenLabs STT only if you want unified billing; else Deepgram for real-time |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Voice-lab clone quality with <1min samples | Instant Voice Cloning wants ≥30s clean audio; less = worse quality | Provide 1-3min high-quality mono samples |
| 14 | Voice-clone TOS on public-figure voices | ElevenLabs bans political-figure voices during elections | Read TOS; don't clone politicians/celebrities |
| 15 | Character-count quota resets monthly on billing anniversary, not calendar month | Reset date confusion → budgeting mistakes | Check `next_character_count_reset_unix` in `/user` response |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `npx` present on VPS
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: key ≥30 alphanumeric chars; live `/v1/user` returned 200 with tier and quota; voice ID visible if supplied
- [ ] Voice-clone consent gate enforced: `CLONE_ENABLED=1` requires `OWNS_VOICE_ACKNOWLEDGED=1`
- [ ] Dry-run shown to user; xi-api-key vs Bearer distinction explained; user approved
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP registered with `ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}` indirection
- [ ] Path B: REST surface documented (base + xi-api-key header + endpoint table)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'elevenlabs'` within 30s
- [ ] Smoke test: TTS on ~17-char sample from VPS returned 200 (~17 characters consumed)
- [ ] User informed of character quota trap (monthly reset on billing anniversary)
- [ ] User told: pair with `/integration-deepgram` or `/integration-assemblyai` for voice-in
- [ ] Rollback function defined; key revocation + voice-delete instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, xi-api-key
vs Bearer, and ElevenLabs quota failure modes.
