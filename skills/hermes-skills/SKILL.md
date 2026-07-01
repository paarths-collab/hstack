---
name: hermes-skills
description: Install a curated starter pack of Hermes skills on a remote VPS over SSH, resolving canonical names first and verifying each landed. Use when adding capabilities to a self-hosted Hermes agent. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-skills — install a curated skill pack on a remote Hermes (SSH-first)

You are the engineer installing skills onto a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every `hermes skills ...` command in this skill runs on the
VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do (decide which pack,
approve a custom tap).

**Honest picture (verified 2026-06):** Hermes leaf skill names are version-dependent. A
hardcoded id like `anthropics/skills/pdf` may resolve fine on 0.15.x and rename to
`anthropic/pdf` on 0.17.x. Always `hermes skills search <keyword>` BEFORE installing and
match the canonical id the runtime returns. Pre-trusted taps ship without `tap add`:
`openai/skills`, `anthropics/skills`, `huggingface/skills`, `NVIDIA/skills`,
`garrytan/gstack`. Anything else needs `hermes skills tap add owner/repo` first.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$PACK` | Space-separated keywords for the desired pack (e.g. `"pdf k8s gstack"`) | User's intent — confirm aloud before installing |
| Custom taps (optional) | `owner/repo` for any non-pre-trusted tap | Their internal registry, if any |

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

Expected: `0.15.x` or `0.17.x`. The pre-trusted tap list above was verified on 0.15.2;
on 0.17.x re-run `hermes skills tap list` to confirm before assuming any tap.

---

## Step 2 — idempotency check (skip already-installed leaves)

For every keyword in `$PACK`, see what is already installed. Skip those and only act on
the rest. This makes the skill safe to re-run.

```bash
INSTALLED=$(ssh "$VPS_USER@$VPS_IP" "hermes skills list 2>/dev/null" || echo "")
TODO=""
for kw in $PACK; do
  if printf '%s\n' "$INSTALLED" | grep -qi "$kw"; then
    echo "SKIP: '$kw' already present in 'hermes skills list'."
  else
    TODO="$TODO $kw"
  fi
done
if [ -z "$TODO" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "All requested skills already installed. Set FORCE=1 to reinstall."
  exit 0
fi
echo "Will resolve + install:$TODO"
```

---

## Step 3 — DRY RUN preview (always show before installing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. For each keyword in '$TODO', run 'hermes skills search <kw>' and pick the top exact match.
  2. Refuse to proceed for any keyword whose top hit is not from a pre-trusted tap,
     unless the user explicitly approved it (custom tap requires 'hermes skills tap add' first).
  3. Run 'hermes skills install <canonical-id> --force' for each resolved id.
  4. Verify each landed via 'hermes skills list | grep -i <kw>'.
  5. Optionally enable 'skills.guard_agent_created: true' for unattended deploys.

No secrets are written. No gateway reload is required for skill install.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — resolve canonical ids (search BEFORE install)

Leaf names are version-dependent. Resolve every keyword first; capture the canonical id
from the search output. Bundled skills (`plan`, `systematic-debugging`,
`test-driven-development`, ...) already ship with Hermes — skip them with a clear log
line instead of reinstalling.

```bash
BUNDLED_RE='^(plan|systematic-debugging|test-driven-development|brainstorming|writing-plans)$'
RESOLVED=""
for kw in $TODO; do
  if printf '%s\n' "$kw" | grep -qE "$BUNDLED_RE"; then
    echo "SKIP: '$kw' is bundled with Hermes — no install needed."
    continue
  fi
  HIT=$(ssh "$VPS_USER@$VPS_IP" "hermes skills search '$kw' 2>/dev/null" \
        | awk 'NR==1 {print $1}')
  if [ -z "$HIT" ]; then
    echo "FAIL: no skill matches '$kw'. Aborting before any install."
    exit 1
  fi
  echo "RESOLVED: $kw -> $HIT"
  RESOLVED="$RESOLVED $HIT"
done
```

Pre-trusted taps you can install from without `tap add`:
`openai/skills`, `anthropics/skills`, `huggingface/skills`, `NVIDIA/skills`,
`garrytan/gstack`.

If a resolved id is from a different owner, run this first (only with user approval):

```bash
ssh "$VPS_USER@$VPS_IP" "hermes skills tap add <owner>/<repo>"
```

---

## Step 5 — install each resolved skill (idempotent with --force)

```bash
for id in $RESOLVED; do
  ssh "$VPS_USER@$VPS_IP" "hermes skills install '$id' --force" \
    || { echo "FAIL: install of '$id' failed. Rolling back."; rollback; exit 1; }
done
```

`--force` makes re-runs idempotent: it re-fetches the leaf even if a stale copy exists in
`~/.hermes/skills/`, which is the documented mitigation for the "self-evaluated skill
went quietly broken" pitfall below.

---

## Step 6 — (optional) enable guard agent for unattended deploys

If the agent is expected to author its own skills (e.g. via `/skill-creator` in an
unattended loop), turn on the guard so written skills are scanned for dangerous shell
patterns before they are registered. No gateway reload needed — it picks up on next call.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set skills.guard_agent_created true"
```

Skip if the user only wants curated installs.

---

## Step 7 — verify each skill landed (poll up to 30s)

`hermes skills install` returns 0 on a successful fetch but the registry refresh can lag.
Poll `hermes skills list` until every requested keyword shows up.

```bash
for kw in $TODO; do
  printf '%s\n' "$kw" | grep -qE "$BUNDLED_RE" && continue
  LANDED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes skills list 2>/dev/null" | grep -qi "$kw"; then
      LANDED=1
      echo "OK: '$kw' visible in 'hermes skills list'."
      break
    fi
    sleep 5
  done
  if [ "$LANDED" != "1" ]; then
    echo "FAIL: '$kw' did not appear in 'hermes skills list' after 30s. Rolling back."
    rollback
    exit 1
  fi
done
```

---

## Step 8 — live invocation smoke test

For each installed skill, ask Hermes to describe it. A clean description (not "skill not
found") confirms the runtime parsed the SKILL.md frontmatter.

```bash
for id in $RESOLVED; do
  LEAF=$(printf '%s\n' "$id" | awk -F/ '{print $NF}')
  OUT=$(ssh "$VPS_USER@$VPS_IP" "hermes skills describe '$LEAF' 2>&1" || true)
  case "$OUT" in
    *"not found"*|*"unknown skill"*)
      echo "FAIL: '$LEAF' installed but describe failed: $OUT"
      rollback
      exit 1
      ;;
    "")
      echo "WARN: 'describe $LEAF' produced no output; check manually."
      ;;
    *)
      echo "OK: '$LEAF' described."
      ;;
  esac
done
```

`hermes skills describe` is the closest analogue to a tool-call smoke test for skills —
it confirms the leaf parses and the registry can route to it.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  for id in $RESOLVED; do
    ssh "$VPS_USER@$VPS_IP" "hermes skills uninstall '$id' 2>/dev/null || true"
  done
  ssh "$VPS_USER@$VPS_IP" "hermes config unset skills.guard_agent_created 2>/dev/null || true"
  echo "Rolled back. Requested skills are no longer installed."
}
```

No gateway reload is needed — skills are loaded lazily on first invocation, so removing
them from the registry is enough.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Hardcoding unverified leaf names | Leaf ids are version-dependent; rename between 0.15.x and 0.17.x | Always `hermes skills search <kw>` first; install the canonical id the runtime returns |
| 2 | Reinstalling bundled skills | `plan`, `systematic-debugging`, `test-driven-development` ship in-box; reinstall can shadow the bundled copy | Skip the bundled regex list in Step 4 |
| 3 | Installing from an untrusted tap without `tap add` | Hermes refuses the fetch; user sees an opaque error | Confirm owner is in the pre-trusted list, otherwise `hermes skills tap add owner/repo` with explicit user approval |
| 4 | "Confidently uses a skill that broke last week" | Self-evaluated skills can go quietly broken between versions | Periodically re-run with `FORCE=1`; review `~/.hermes/skills/` |
| 5 | Unattended deploys with no guard | Agent-authored skills can run dangerous shell unscanned | `hermes config set skills.guard_agent_created true` (Step 6) |
| 6 | `gateway restart` after install | Restart does NOT reliably re-read config; also unnecessary for skills | Skill install is a registry write, lazy-loaded — no reload needed |
| 7 | `echo "x" >> ~/.hermes/.env` for any side-config | Can merge onto a prior line without trailing newline | Always `hermes config set` for any config write |
| 8 | Secrets sneaking into a skill payload | A community skill could ship a stub that reads `.env` at runtime | Review the SKILL.md before approving a custom tap; keep `~/.hermes/.env` `chmod 600` |
| 9 | sed with `/` delimiter on tokens | Custom tap urls/tokens may contain `/+=` | Always use `\|` delimiter when patching config |
| 10 | Container vs host confusion | Skill installed in a container that gets rebuilt is lost | Always `whoami; hostname` check; confirm install path is on a mounted volume |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode) — already-installed leaves skipped
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Every keyword resolved to a canonical id via `hermes skills search` (no hardcoded leaves)
- [ ] Custom taps (if any) approved by user and `tap add`-ed before install
- [ ] Each resolved id installed with `hermes skills install --force`
- [ ] No secret was echoed; no `echo >>` used; any side-config went via `hermes config set`
- [ ] No gateway reload performed (not needed for skills)
- [ ] `hermes skills list` shows every requested keyword within 30s
- [ ] `hermes skills describe <leaf>` returns a clean description for each
- [ ] Rollback function defined and tested (re-run with `FORCE=1` reinstalls cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for tap and skill-registry failure modes.
