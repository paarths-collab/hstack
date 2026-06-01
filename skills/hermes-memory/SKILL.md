---
name: hermes-memory
description: Configure Hermes memory — built-in (default) or an external provider — and surface the memory-ceiling reality. Use when setting up or changing memory.
---

# /hermes-memory — configure memory (built-in by default)

Built-in memory is **always on** and is the safe default. Only add an external provider if the user
explicitly wants larger/searchable memory.

## Default: built-in (do nothing but verify)
```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" memory status
```

## The memory ceiling — TELL THE USER THIS (it's the #1 daily frustration)
Built-in memory is small and fixed: **~1,375 chars user profile, ~2,200 chars agent memory** (≈20 short
notes). When it fills, the agent **spends turns consolidating instead of working**. This contradicts the
"grows with you" marketing — it's structured note-taking against a tight budget. When it fills, offer an
external provider.

## Optional: external provider (e.g. mem0) — REQUIRES installing the python dep
```bash
echo "MEM0_API_KEY=$MEM0_API_KEY" >> ~/.hermes/.env && chmod 600 ~/.hermes/.env
"$HERMES" config set memory.provider mem0
# CRITICAL: hermes memory setup reports success but does NOT install the dep (#25086) -> runtime crash.
uv pip install --python ~/.hermes/hermes-agent/venv/bin/python mem0ai
"$HERMES" memory status
```

## Pitfalls
- mem0/openviking/memori need their python package installed into the **same venv** or they crash at
  runtime with a false-success config (#25086).
- Only ONE external provider may be active. Cloud providers fail at runtime if the key is missing.
- Stale memory files are "the #1 cause of weird agent behavior" — if the agent acts up, have it read
  its memory aloud and prune.
