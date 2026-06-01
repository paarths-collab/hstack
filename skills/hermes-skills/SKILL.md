---
name: hermes-skills
description: Install a curated starter pack of Hermes skills from pre-trusted registries, resolving canonical names first. Use when adding capabilities to the agent.
---

# /hermes-skills — install a curated starter pack

## Procedure (search first, then install idempotently)
```bash
HERMES="$HOME/.local/bin/hermes"
# Resolve the canonical id BEFORE installing — leaf skill names are version-dependent.
"$HERMES" skills search pdf
"$HERMES" skills install anthropics/skills/pdf --force      # pre-trusted tap (no tap-add needed)
"$HERMES" skills install openai/skills/k8s --force
"$HERMES" skills list | grep -i pdf                         # verify it landed
```

Pre-trusted taps (no setup): `openai/skills`, `anthropics/skills`, `huggingface/skills`,
`NVIDIA/skills`, `garrytan/gstack`. Custom repos need `hermes skills tap add owner/repo` first.

## Pitfalls
- **Don't hardcode unverified leaf names** — `search`/`browse` to resolve the real id first.
- Bundled skills (`plan`, `systematic-debugging`, `test-driven-development`, …) ship already — don't reinstall.
- For unattended deploys set `skills.guard_agent_created: true` (scans agent-written skills for danger).
- Self-evaluated skills can be quietly broken — review `~/.hermes/skills/` periodically; the agent
  sometimes "confidently uses a skill that broke last week."

## Verify
`hermes skills list` shows the installed pack.
