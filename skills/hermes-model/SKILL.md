---
name: hermes-model
description: Configure the Hermes model and provider with an API key, validate context window, and detect silent capability degradation. Use when setting up or changing which LLM Hermes uses.
---

# /hermes-model — configure provider + model (frontier-default, capability-aware)

## Procedure (unattended path — bypass the interactive wizard)
```bash
HERMES="$HOME/.local/bin/hermes"

# 1. Fail fast if no key (a missing key isn't caught at config time — it fails at runtime).
[ -n "$OPENROUTER_API_KEY" ] || { echo "Need an API key first"; exit 1; }

# 2. Set key (secret -> ~/.hermes/.env) and model (>=64K context REQUIRED, or startup is rejected).
"$HERMES" config set OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
"$HERMES" config set model "deepseek/deepseek-v4"     # cheapest high-quality; or anthropic/claude-sonnet-*
"$HERMES" config set prompt_caching.enabled true       # free cost win
chmod 600 ~/.hermes/.env

# 3. Finalize + smoke-test (the grep-safe end-to-end check).
"$HERMES" setup --non-interactive
out="$("$HERMES" -z 'reply with the single word OK')"; echo "$out" | grep -qi OK || exit 1
```

## Ask the user
- The **API key** for their chosen provider (OpenRouter is easiest; OpenAI/Anthropic also fine).
- Confirm the model. **Never default to a local/small model** — they hallucinate tool calls. Frontier only.

## Capability check (kills the #1 silent-failure gotcha)
Auxiliary features — **vision, web summarization, compression** — silently degrade (no error) if the
provider that powers them isn't keyed. After setup, tell the user which capabilities are active vs
degraded based on the keys provided, and offer to add an OpenRouter key to cover the gaps.

## Pitfalls
- **Never `--portal`** in an unattended/headless run — it's an interactive OAuth flow that hangs.
- The compression/vision aux model's context must be **≥ the main model's** (and ≥64K) or summarization
  fails *silently* and drops context. Validate this.
- `/model` (in-session) only switches *already-configured* providers; adding one needs the terminal.
- Read config back with `hermes config show` (there is no `config get`).
- Watch for the billing-mode trap (a subscription can silently flip to per-token API billing).

## Verify
`hermes -z 'reply with OK'` returns OK; `hermes config show | grep -i model` shows the chosen model.
