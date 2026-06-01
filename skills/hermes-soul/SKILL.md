---
name: hermes-soul
description: Give the Hermes agent a name and personality by writing SOUL.md directly. Use when setting the agent's identity.
---

# /hermes-soul — set the agent's name + personality

Write `~/.hermes/SOUL.md` **directly** — do NOT use the interactive `hermes setup agent` (it's a wizard
that hangs unattended). SOUL.md is injected into the system prompt on **every message**, so keep it
**short (< 1KB)** to save tokens.

## Procedure
```bash
mkdir -p ~/.hermes
cat > ~/.hermes/SOUL.md <<'EOF'
# Identity
You are <Name>, a personal AI assistant for <user>.
# Style
Concise, direct, helpful. No filler, no hedging.
# Avoid
Long preambles, fabricated results, over-apologizing.
EOF
test -s ~/.hermes/SOUL.md && [ "$(wc -c < ~/.hermes/SOUL.md)" -lt 20000 ]
```

Ask the user for the agent's **name** and any personality preference; put the name in the prose under
`# Identity` (there is no name flag).

## Pitfalls
- Empty/whitespace SOUL.md → silent fallback to the generic "You are Hermes Agent…" identity. Verify non-empty.
- Hard cap is 20,000 chars (content is injection-scanned + truncated) — but keep it well under 1KB for cost.
- Windows path: `%USERPROFILE%\.hermes\SOUL.md`.

## Verify
`hermes -z 'what is your name?'` echoes the chosen name.
