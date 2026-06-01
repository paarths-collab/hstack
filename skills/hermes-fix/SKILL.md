---
name: hermes-fix
description: Diagnose and repair common Hermes failures (gateway down, model not configured, bot silent, PATH, Docker UID). Use when something is broken.
---

# /hermes-fix — diagnose + repair

Run `hermes doctor` (capture output; don't gate on its exit code), then match the symptom to the fix.
Full catalogue: `reference/TROUBLESHOOTING.md`.

```bash
HERMES="$HOME/.local/bin/hermes"
"$HERMES" doctor 2>&1 | tee /tmp/hermes_doctor.log
```

## Symptom → fix
| Symptom | Fix |
|---------|-----|
| `hermes: command not found` after install | `export PATH="$HOME/.local/bin:$PATH"`; use the absolute path; `source ~/.bashrc` |
| Gateway won't start / restart loop | `/hermes-restart` (clear stale `gateway.pid` + locks) |
| Bot doesn't reply | `hermes gateway status` → `start`; check allowlist value is the numeric ID; tail `~/.hermes/logs/gateway.log` |
| Model error 400 | model name / key mismatch (OpenAI key ≠ OpenRouter); `hermes model` |
| Vision/web/compression "don't work" | auxiliary model not keyed — add the provider key (silent-degradation gotcha) |
| RSS many GB / OOM after a day | the leak (#25315) — restart + add a nightly restart cron |
| Docker `chown … not permitted` | honor `HERMES_UID`/`HERMES_GID`; avoid image `v2026.4.23`; run CLI + gateway as same UID |
| "Not configured" for gateway tools | often cosmetic (#13301) — if tools work, ignore |

Never `sudo` to "fix" install perms — that's usually the cause. Remove the sudo install and reinstall as the user.
