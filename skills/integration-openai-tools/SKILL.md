---
name: integration-openai-tools
description: Connect OpenAI's non-chat capabilities (DALL-E / GPT-image image generation, Whisper transcription, embeddings for mid-conversation RAG builds, Batch API for 50%-cost overnight bulk jobs, fine-tuned model endpoints) to a self-hosted Hermes Agent over SSH via api.openai.com with a static sk- key. Complementary to /hermes-model (which handles chat). Refuses to wire chat completions endpoints. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-openai-tools — connect OpenAI non-chat tools to a remote Hermes (SSH-first)

You are the engineer connecting OpenAI's **specialized (non-chat)** capabilities to a
self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex,
Cursor, Gemini, OpenClaw, any of them) work over SSH as root against the VPS. The user
does one thing a machine cannot: mint the `sk-` API key at https://platform.openai.com.

**IMPORTANT — read this first:** if you want OpenAI as the **main model** (chat completions,
GPT-5 reasoning), use `/hermes-model` instead. Hermes has native OpenAI support for main
and aux slots. This skill wires the **non-chat** OpenAI surface Hermes doesn't cover as a
model: DALL-E / GPT-image, Whisper, embeddings mid-conversation, Batch API, fine-tuned
model endpoints. Wiring these here does NOT duplicate `/hermes-model`.

Everything else — key storage, live API verification, MCP registration via stdio, gateway
reload, live-endpoint smoke test — runs on the VPS via SSH, idempotently with a rollback.

**Honest auth picture (verified 2026-06):** OpenAI ships **no first-party MCP server**.
The community `@modelcontextprotocol/server-openai` package exists but is community-
maintained (not first-party). This skill wires **direct REST** as Path A (most reliable)
and community stdio MCP as Path B (opt-in).

Sources:
- https://platform.openai.com/docs/api-reference
- https://platform.openai.com/docs/guides/batch

**Endpoints this skill enables (via REST tool layer, all at `https://api.openai.com/v1/`):**

- **Images:** `POST /images/generations` (DALL-E, GPT-image), `POST /images/edits`,
  `POST /images/variations`
- **Speech-to-text:** `POST /audio/transcriptions` (Whisper), `POST /audio/translations`
- **Text-to-speech:** `POST /audio/speech` (tts-1, tts-1-hd)
- **Embeddings:** `POST /embeddings` (text-embedding-3-small/large; useful for RAG builds
  mid-conversation)
- **Batch:** `POST /batches` (submit JSONL of up to 50k requests; 50% cost, 24h SLA)
- **Fine-tuning:** `POST /fine_tuning/jobs`, `GET /fine_tuning/jobs`
- **Files:** `POST /files`, `GET /files`

**Refuses to wire:** `/chat/completions` and `/responses` — those are covered by
`/hermes-model`. The refusal is a deliberate anti-duplication gate.

**Key scope:** OpenAI supports **project-scoped** API keys (recommended). A key at
project-level (starts `sk-proj-`) is tighter than an account-level `sk-` key. This skill
prefers `sk-proj-` and warns if given an account key.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$OPENAI_TOOLS_API_KEY` | API key `sk-proj-...` (project-scoped, preferred) or `sk-...` (account-level) | https://platform.openai.com/api-keys → Create → pick project scope |
| `$OPENAI_ORG_ID` *(optional)* | Organization ID for `OpenAI-Organization` header | Settings → Organization |
| `$OPENAI_PROJECT_ID` *(optional)* | Project ID for `OpenAI-Project` header (required for `sk-` keys used across projects) | Settings → Project → ID |
| `$WIRE_PATH` *(optional)* | `A` (direct REST, default) or `B` (community stdio MCP) | A is simplest |

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

## Step 2 — idempotency check + hermes-model overlap warning

```bash
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OPENAI_TOOLS_API_KEY=sk-' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "OpenAI tools already wired. Set FORCE=1 to rewire."; exit 0
fi

# Warn if hermes model provider is also OpenAI (dual keys)
HERMES_MODEL_OPENAI=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OPENAI_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HERMES_MODEL_OPENAI" = "1" ]; then
  echo "NOTE: OPENAI_API_KEY is also set (used by /hermes-model for chat). This skill uses"
  echo "OPENAI_TOOLS_API_KEY separately, so image/whisper/etc calls are billed independently."
  echo "You can share the same key across both if you want a single billing trail."
fi
```

---

## Step 3 — HARD GATE (key format + scope preference + live API verify)

```bash
# Accept sk-, sk-proj-, sk-svcacct- (service account), NOT sk-live_ (that's Stripe)
printf '%s' "$OPENAI_TOOLS_API_KEY" | grep -qE '^sk-(proj-|svcacct-)?[A-Za-z0-9_-]+$' \
  || { echo "ABORT: OPENAI_TOOLS_API_KEY must be an OpenAI key (sk-, sk-proj-, or sk-svcacct- prefix)."; exit 1; }
[ "${#OPENAI_TOOLS_API_KEY}" -ge 40 ] \
  || { echo "ABORT: OPENAI_TOOLS_API_KEY looks too short."; exit 1; }

# Prefer project-scoped
case "$OPENAI_TOOLS_API_KEY" in
  sk-proj-*) echo "Key scope: project (recommended for tool-specific use)." ;;
  sk-svcacct-*) echo "Key scope: service account (fine for automation)." ;;
  *) echo "WARN: account-level key detected. Prefer sk-proj-<project> for tighter scope."
     echo "      Create one at https://platform.openai.com/api-keys → Create → pick a Project." ;;
esac

# Live API verify — GET /v1/models
HEADERS=("-H" "Authorization: Bearer $OPENAI_TOOLS_API_KEY")
[ -n "${OPENAI_ORG_ID:-}" ] && HEADERS+=("-H" "OpenAI-Organization: $OPENAI_ORG_ID")
[ -n "${OPENAI_PROJECT_ID:-}" ] && HEADERS+=("-H" "OpenAI-Project: $OPENAI_PROJECT_ID")

HTTP=$(curl -sS -o /tmp/oai.json -w '%{http_code}' --max-time 10 \
  "${HEADERS[@]}" \
  'https://api.openai.com/v1/models' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    MODEL_COUNT=$(grep -oE '"id":"[^"]+"' /tmp/oai.json | wc -l | tr -d ' ')
    HAS_DALLE=$(grep -c '"id":"dall-e' /tmp/oai.json 2>/dev/null || echo 0)
    HAS_WHISPER=$(grep -c '"id":"whisper' /tmp/oai.json 2>/dev/null || echo 0)
    HAS_EMBED=$(grep -c '"id":"text-embedding' /tmp/oai.json 2>/dev/null || echo 0)
    echo "OpenAI API OK. $MODEL_COUNT models visible."
    echo "  DALL-E present: $([ "$HAS_DALLE" -gt 0 ] && echo yes || echo no)"
    echo "  Whisper present: $([ "$HAS_WHISPER" -gt 0 ] && echo yes || echo no)"
    echo "  Embeddings present: $([ "$HAS_EMBED" -gt 0 ] && echo yes || echo no)"
    ;;
  401|403) echo "ABORT: 401/403 — key rejected."; exit 1 ;;
  429) echo "ABORT: 429 — rate/credit limit hit even on models list. Check billing."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/oai.json | head -3; exit 1 ;;
esac
rm -f /tmp/oai.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write OPENAI_TOOLS_API_KEY (length ${#OPENAI_TOOLS_API_KEY}, prefix ${OPENAI_TOOLS_API_KEY:0:8}...) via 'hermes config set'
    2. Write OPENAI_ORG_ID + OPENAI_PROJECT_ID headers if supplied
    3. chmod 600 ~/.hermes/.env

  Path A (direct REST — default, no MCP):
    4. No MCP registration. Generic HTTP tool reads env; base URL https://api.openai.com/v1/
    5. Reload gateway: stop + run
    6. Smoke tests: /v1/embeddings + /v1/images/generations dry-mode

  Path B (community stdio MCP — opt-in):
    4. Register MCP with @modelcontextprotocol/server-openai (community, not first-party)
    5. Reload gateway: stop + run

Key is NEVER printed in plaintext beyond a length + first 8 chars.

REFUSAL: this skill will NOT wire /chat/completions or /responses endpoints.
Those belong to /hermes-model. Wiring here would duplicate what Hermes already does.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set OPENAI_TOOLS_API_KEY '$OPENAI_TOOLS_API_KEY'"
if [ -n "${OPENAI_ORG_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set OPENAI_ORG_ID '$OPENAI_ORG_ID'"
fi
if [ -n "${OPENAI_PROJECT_ID:-}" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set OPENAI_PROJECT_ID '$OPENAI_PROJECT_ID'"
fi
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OPENAI_TOOLS_API_KEY=sk-' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: key not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — document the REST surface (Path A) or wire MCP (Path B)

### Path A — REST surface (agent uses generic HTTP tool)

Base URL: `https://api.openai.com/v1`
Auth: `Authorization: Bearer ${OPENAI_TOOLS_API_KEY}`
Optional headers: `OpenAI-Organization: ${OPENAI_ORG_ID}`, `OpenAI-Project: ${OPENAI_PROJECT_ID}`

Common non-chat endpoints:

| Capability | Method + Path | Notes |
|---|---|---|
| Image generate | `POST /images/generations` | DALL-E 3 / GPT-image; body has `model`, `prompt`, `size`, `quality`, `n` |
| Image edit | `POST /images/edits` | Requires `image` file + `mask` |
| Speech-to-text | `POST /audio/transcriptions` | Multipart with `file` + `model=whisper-1` |
| Text-to-speech | `POST /audio/speech` | Body: `model=tts-1`, `input`, `voice=alloy/echo/fable/etc` |
| Embeddings | `POST /embeddings` | Body: `model=text-embedding-3-small`, `input` (string or array) |
| Batch create | `POST /batches` | Body: `input_file_id`, `endpoint`, `completion_window=24h` |
| Batch retrieve | `GET /batches/{id}` | Poll for `status=completed` |
| Fine-tune | `POST /fine_tuning/jobs` | Body: `training_file`, `model=gpt-4.1-mini-2025-...` |
| Files upload | `POST /files` | For batch inputs and fine-tune data |

### Path B — community stdio MCP (opt-in)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path B requires npx on VPS."; exit 1; }
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add openai-tools \
      --command 'npx' \
      --args '-y,@modelcontextprotocol/server-openai' \
      --env 'OPENAI_API_KEY=\${OPENAI_TOOLS_API_KEY}'
  "
  echo "Path B registered. NOTE: community package — audit before granting write scope."
fi
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (embeddings — cheapest specialized call)

```bash
# Embeddings is the cheapest non-chat endpoint (~$0.00002 per 1k tokens on 3-small)
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -X POST 'https://api.openai.com/v1/embeddings' \
    -H \"Authorization: Bearer \$OPENAI_TOOLS_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"text-embedding-3-small\",\"input\":\"hstack smoke test\"}'
")
case "$HTTP" in
  200) echo "OK: embeddings reachable from VPS (~\$0.00002 consumed)." ;;
  401) echo "FAIL: 401 from VPS. Rolling back."; rollback; exit 1 ;;
  429) echo "WARN: 429 — quota or rate limit." ;;
  *) echo "WARN: HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove openai-tools 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^OPENAI_TOOLS_API_KEY=/d;
            /^OPENAI_ORG_ID=/d;
            /^OPENAI_PROJECT_ID=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://platform.openai.com/api-keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Duplicating chat via this skill AND /hermes-model | Two paths to the same billing; confusion about which key is used where | This skill refuses to wire /chat/completions in DRY_RUN docs; use separate env vars for clarity |
| 2 | Account-level `sk-` key used everywhere | Compromise = all projects exposed | Prefer `sk-proj-` project-scoped keys; Step 3 warns if account key detected |
| 3 | DALL-E / GPT-image cost surprises | High-quality images cost $0.04-$0.19 each; a runaway agent burns credits fast | Set spend alerts at platform.openai.com; use `quality=standard` for drafts |
| 4 | Whisper file-size limits | 25 MB upload cap per request | Split large audio; chunk with 30-60s overlap for continuity |
| 5 | Embeddings model version drift | text-embedding-ada-002 → text-embedding-3-*; vectors NOT compatible across versions | Pin `model` explicitly; migrate vector store on model change |
| 6 | Batch API 24h SLA — sync agents wait | Batch responses can take up to 24h; agent must not block-poll | Use batch for offline enrichment; use sync endpoints for real-time |
| 7 | Rate limits per model tier | Tier 1 orgs have low RPM on some models; bursts 429 | Back off; upgrade tier by hitting spend thresholds |
| 8 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 9 | Fine-tune data with PII | Fine-tuning uploads data to OpenAI's servers | Strip PII before upload; use zero-retention flag if available |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Key may contain `_-`; universal rule | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Community MCP wrappers with stale endpoints | Path B community package may lag OpenAI API changes | Prefer Path A REST; Path B only when needed |
| 15 | Missing `OpenAI-Project` header on cross-project calls | Some endpoints 401 without the project header when using account-scoped key | Set both `OPENAI_ORG_ID` + `OPENAI_PROJECT_ID` for account-level keys |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] Hermes-model overlap warned about if `OPENAI_API_KEY` also present
- [ ] HARD GATE passed: key format is `sk-`/`sk-proj-`/`sk-svcacct-` + ≥40 chars; live `/v1/models` returned 200; DALL-E/Whisper/embeddings presence surfaced
- [ ] Dry-run shown to user; refusal-to-wire-chat explained; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: REST surface documented (base + Bearer + endpoint table)
- [ ] Path B: community stdio MCP registered with env indirection (opt-in)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/v1/embeddings` from VPS returned 200 (~$0.00002 consumed)
- [ ] User told about spend alerts at platform.openai.com/account/limits
- [ ] User told about embeddings model versioning trap (vectors not cross-compatible)
- [ ] Project-scoped key preferred (or warning acknowledged for account-scoped)
- [ ] Rollback function defined; key revocation URL included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, quota,
and OpenAI project-scope failure modes.
