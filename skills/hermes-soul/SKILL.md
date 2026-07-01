---
name: hermes-soul
description: Give a self-hosted Hermes agent a name and personality by writing SOUL.md directly over SSH. Use when setting or updating the agent's identity. Idempotent, rollback-safe, works from any AI agent (Claude Code, Codex, Cursor, Hermes, Gemini CLI).
---

# /hermes-soul — set the agent's name + personality (SSH-first)

You are the engineer setting the Hermes agent's identity for the user. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a
remote VPS over SSH as root. Every command in this skill runs on the VPS, not on the
local machine.

Write `~/.hermes/SOUL.md` **directly** — do NOT use the interactive `hermes setup agent`
wizard. It prompts for stdin and hangs unattended over SSH. SOUL.md is injected into
the system prompt on **every message**, so keep it **short (< 1KB)** to save tokens on
every turn.

Stop only for the one thing a machine cannot do: pick a name and a vibe for the agent.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$AGENT_NAME` | The agent's name (e.g. `Atlas`, `Juno`, `Hermes`) | Ask the user |
| `$AGENT_STYLE` | One line describing tone/vibe (optional) | Ask the user; default = "Concise, direct, helpful." |

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

## Step 2 — idempotency check (skip if SOUL.md already has this name)

```bash
EXISTING_NAME=$(ssh "$VPS_USER@$VPS_IP" "grep -oE 'You are [A-Za-z][A-Za-z0-9_-]*' ~/.hermes/SOUL.md 2>/dev/null | head -1 | awk '{print \$3}'" || true)
if [ -n "$EXISTING_NAME" ] && [ "$EXISTING_NAME" = "$AGENT_NAME" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "SOUL.md already sets agent name to '$AGENT_NAME'. Set FORCE=1 to overwrite."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Back up existing ~/.hermes/SOUL.md (if any) to ~/.hermes/SOUL.md.bak
  2. mkdir -p ~/.hermes
  3. Write ~/.hermes/SOUL.md (target size < 1KB) with:
       Identity: You are $AGENT_NAME, a personal AI assistant.
       Style:    ${AGENT_STYLE:-Concise, direct, helpful. No filler, no hedging.}
       Avoid:    Long preambles, fabricated results, over-apologizing.
  4. chmod 600 ~/.hermes/SOUL.md
  5. Verify non-empty and < 20000 chars (hard cap; injection-scanned + truncated above).
  6. Smoke test: hermes -z 'what is your name?' should echo "$AGENT_NAME".
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — back up any existing SOUL.md, then write the new one

No `echo >>` — we generate the file in full via heredoc so partial writes can't merge
into a previous file. No secrets are involved, but `chmod 600` is still right because
the file is in the user's `~/.hermes/` namespace.

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  mkdir -p ~/.hermes
  if [ -s ~/.hermes/SOUL.md ]; then
    cp ~/.hermes/SOUL.md ~/.hermes/SOUL.md.bak
  fi
"
```

Write SOUL.md (heredoc, single-quoted to disable local expansion; `$AGENT_NAME` and
`$AGENT_STYLE` are expanded by the local shell before the SSH payload is sent):

```bash
STYLE="${AGENT_STYLE:-Concise, direct, helpful. No filler, no hedging.}"
ssh "$VPS_USER@$VPS_IP" "cat > ~/.hermes/SOUL.md" <<EOF
# Identity
You are $AGENT_NAME, a personal AI assistant.

# Style
$STYLE

# Avoid
Long preambles, fabricated results, over-apologizing.
EOF
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/SOUL.md"
```

Verify the write — non-empty AND under the 20,000-char hard cap:

```bash
ssh "$VPS_USER@$VPS_IP" "
  test -s ~/.hermes/SOUL.md \
    && [ \"\$(wc -c < ~/.hermes/SOUL.md)\" -lt 20000 ] \
    && grep -q \"You are $AGENT_NAME\" ~/.hermes/SOUL.md
" || { echo "FAIL: SOUL.md did not write cleanly. Rolling back."; rollback; exit 1; }
```

---

## Step 5 — reload the gateway so the new identity is picked up

SOUL.md is read into the system prompt at gateway start. `gateway restart` does NOT
reliably re-read identity files. Use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 6 — verify the new identity is loaded (poll up to 30s)

```bash
LOADED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "SOUL\.md loaded|identity.*$AGENT_NAME|system prompt.*ready"; then
    LOADED=1
    echo "OK: SOUL.md picked up by gateway."
    break
  fi
  sleep 5
done
[ "$LOADED" = "1" ] || echo "WARN: did not see explicit load line; smoke test in Step 7 is authoritative."
```

---

## Step 7 — live smoke test (the only proof that matters)

```bash
REPLY=$(ssh "$VPS_USER@$VPS_IP" "hermes -z 'What is your name? Reply with just the name, nothing else.' 2>/dev/null" | tr -d '[:space:]')
case "$REPLY" in
  *"$AGENT_NAME"*)
    echo "OK: agent identifies as '$AGENT_NAME'."
    ;;
  "")
    echo "FAIL: empty reply. Gateway may not be up. Rolling back."
    rollback; exit 1
    ;;
  *)
    echo "WARN: agent replied '$REPLY' — does not contain '$AGENT_NAME'."
    echo "      SOUL.md may have fallen back to generic 'Hermes Agent' identity."
    echo "      Check ~/.hermes/SOUL.md is non-empty and the gateway was restarted."
    ;;
esac
```

A clean `200` equivalent here is: the agent's reply contains `$AGENT_NAME`.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    if [ -s ~/.hermes/SOUL.md.bak ]; then
      mv ~/.hermes/SOUL.md.bak ~/.hermes/SOUL.md
      chmod 600 ~/.hermes/SOUL.md
    else
      rm -f ~/.hermes/SOUL.md
    fi
    hermes gateway stop; sleep 2; hermes gateway run --daemon
  "
  echo "Rolled back. Previous SOUL.md restored (or removed if none existed)."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Running `hermes setup agent` over SSH | It's an interactive wizard; stdin hangs forever | Write SOUL.md directly via heredoc |
| 2 | Empty / whitespace-only SOUL.md | Silent fallback to generic "You are Hermes Agent…" identity | `test -s` verify after write; rollback on empty |
| 3 | SOUL.md > 1KB | Injected into the system prompt on every turn — burns tokens | Keep prose tight; hard cap is 20,000 chars but aim for < 1KB |
| 4 | SOUL.md > 20,000 chars | Hermes injection-scans + truncates above this | Check `wc -c < SOUL.md` before declaring done |
| 5 | `echo "…" >> SOUL.md` to append | No leading newline → concatenates with prior line | Always overwrite via heredoc; never append |
| 6 | `gateway restart` to pick up identity | Does NOT reliably re-read SOUL.md | Use `gateway stop` + `gateway run` |
| 7 | Container vs host confusion (file written in wrong layer) | SOUL.md ends up inside a container that gets replaced | Run `whoami; hostname` — host has readable name, container has hex id |
| 8 | Identity name with shell metacharacters (`$`, `` ` ``, `"`) | Heredoc expands them and corrupts the file | Quote `$AGENT_NAME` strictly alphanumeric; validate before write |
| 9 | Windows path expectation | Self-hosted Hermes uses `~/.hermes/SOUL.md`; Windows desktop uses `%USERPROFILE%\.hermes\SOUL.md` | This skill is Linux/VPS only — confirm with `uname` if unsure |
| 10 | Writing SOUL.md but no gateway running | Identity changes never take effect | Step 1 hard-gates on `hermes --version` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Existing `~/.hermes/SOUL.md` backed up to `SOUL.md.bak` (if it existed)
- [ ] New `~/.hermes/SOUL.md` written via heredoc, `chmod 600`
- [ ] File is non-empty AND under 20,000 chars AND contains `You are $AGENT_NAME`
- [ ] SOUL.md is **not** in `config.yaml` and **not** echoed in chat
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs scanned for SOUL.md load line (advisory; smoke test is authoritative)
- [ ] Smoke test `hermes -z 'what is your name?'` reply contains `$AGENT_NAME`
- [ ] Rollback function defined and proven (restores `SOUL.md.bak`, or removes file)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and identity-load failure modes.
