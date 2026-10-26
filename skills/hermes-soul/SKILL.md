---
name: hermes-soul
description: Give a self-hosted Hermes v0.22.5 agent a name and personality by writing ~/.hermes/SOUL.md directly over SSH. Backs up the previous file, needs no gateway reload (new sessions read it from disk), and checks the result with a one-shot native call. Use when setting or updating the agent's identity. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-soul — set the agent's name + personality (SSH-first)

You are the engineer setting the Hermes agent's identity for the user. The agent (Hermes, Codex, Claude Code, Cursor,
Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches
the VPS through the `remote` helper from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the
remote PATH. Run all blocks in ONE shell session: later steps call the Step 0 functions.

Do everything autonomously; stop only for the one thing a machine cannot do: pick a name and a vibe for the agent (or
supply the user's own SOUL.md).

**How SOUL.md works in Hermes v0.22.5 (read from source).**

- **Where and what.** `<Hermes home>/SOUL.md` (`~/.hermes/SOUL.md` for the default profile) is the first slot of the
  system prompt, in place of the built-in "You are Hermes Agent, built by Nous Research..." identity. Missing, empty or
  unreadable means the built-in identity, silently (`agent/prompt_builder.py:1540-1588`, `agent/system_prompt.py:550-556`).
- **No wizard writes it.** `hermes setup agent` is the "Agent Settings" section: max iterations, tool-progress display and
  context compression (`hermes_cli/setup.py:450-500,596`). It does not touch SOUL.md. Run without a terminal it prints
  guidance and returns instead of hanging (`hermes_cli/setup.py:77-82,694-696`); it only blocks under `ssh -t`. So this skill
  writes the file itself and never calls `hermes setup`.
- **No gateway reload.** The file is read from disk each time a system prompt is BUILT, which happens when a session starts
  (`agent/system_prompt.py:555`). A running conversation keeps the prompt that was stored for it and reuses it on every
  later turn, also after a gateway restart (`agent/conversation_loop.py:817-897`), so a reload neither is needed for new
  sessions nor changes existing ones, and it would interrupt live chats. The new identity appears in a **new session**
  (`/new` or `/reset` in the chat, or the next cron run). The legacy "stop + run" step is gone.
- **Size.** Keep it short: the text rides in every request of every session. The 20,000-character figure is the FLOOR of
  the cap, not a hard limit: `context_file_max_chars` in `config.yaml` pins a cap, otherwise it scales with the model's
  context window (20K to 500K characters); above the cap the middle is cut with a marker
  (`agent/prompt_builder.py:1044-1065,1496-1521`, `hermes_cli/config_defaults.py:533-536`).
- **Safety scan.** SOUL.md in your own Hermes home that matches an injection pattern is loaded anyway with a log warning; if
  a profile distribution (`distribution.yaml`) owns the file, a match BLOCKS it and the prompt gets a `[BLOCKED: ...]` line
  (`agent/prompt_builder.py:84-126,1540-1588`). Hermes' own file tools need human approval to edit SOUL.md
  (`security.protected_instruction_files`, `hermes_cli/config_defaults.py:1799-1801`); this skill writes over ssh, outside that gate.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | User's hosting dashboard |
| `$AGENT_NAME` | The agent's name: a letter, then letters, digits, `_` or `-` (at most 32) | Ask the user (e.g. `Atlas`, `Juno`) |
| `$AGENT_STYLE` | One line of tone/vibe (optional, at most 300 characters) | Ask the user; default "Concise, direct, helpful. No filler, no hedging." |
| `$SOUL_FILE` | Optional: path of the user's own SOUL.md on THIS machine, used instead of the generated text | The user |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

SOUL.md is the only file this skill changes, so it does not use the shared `.env`/`config.yaml` snapshot. `soul_snapshot`,
`soul_rollback` and `soul_finish` do the same job for that one file: copy it aside before the first write, restore the exact
bytes (or remove the file if there was none) on failure, and keep the old copy as `.prev` after success. `gw_ready` and
`gw_reload` are the shared lifecycle helpers; this skill does not call them because nothing needs a reload.

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=hermes-soul
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
# gw_ready [SECONDS]: native readiness. Succeeds only when `gateway ensure --json` exits 0 and reports "state":"ready"
# (the transient pending/draining codes 5 and 6 are retried twice). It never greps `gateway status` text, because the stopped
# gateway prints "✗ Gateway is not running", which contains "running".
gw_ready() {
  remote "T=${1:-60} bash -s" <<'REMOTE'
n=0
while :; do
  out=$(hermes -p default gateway ensure --json --timeout "$T") && rc=0 || rc=$?
  [ "$rc" = 0 ] && break
  n=$((n + 1))
  { [ "$rc" = 5 ] || [ "$rc" = 6 ]; } && [ "$n" -lt 3 ] || { printf '%s\n' "$out" >&2; exit 1; }
  sleep 3
done
case $out in *'"state":"ready"'*) printf '%s\n' "$out" ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
REMOTE
}
# gw_reload: restart the default-profile gateway natively and require a ready gateway with a NEW instance_id.
# `--detach` keeps `restart` from running the gateway inside the ssh shell when no service is installed. With live
# sessions and no terminal, restart refuses; GW_INTERRUPT=1 adds -y and interrupts them deliberately (never set by default).
# Side effect: the pre-restart `ensure` read that captures the old instance_id STARTS a gateway when none is running (ensure never
# installs a service, but it does start one). A reload implies the gateway should run, so that is accepted; read-only skills never call gw_reload.
gw_reload() {
  local old new out interrupt
  interrupt=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then interrupt=1; fi
  # Keep an endpoint identity even when ensure exits 6 (draining/restart_wait).
  out=$(remote 'hermes -p default gateway ensure --json --timeout 10 2>/dev/null') || :
  old=$(printf '%s\n' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  remote "hermes -p default gateway restart --detach${interrupt:+ -y}" \
    || { echo "gw_reload: gateway restart failed or was refused (live sessions? re-run with GW_INTERRUPT=1 only if interrupting them is acceptable)." >&2; return 1; }
  out=$(gw_ready) || return 1
  new=$(printf '%s' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  if [ -n "$old" ] && [ "$new" = "$old" ]; then echo "gw_reload: the gateway instance did not change, so it was not restarted." >&2; return 1; fi
  printf '%s\n' "$out"
}

# soul_snapshot: copy ~/.hermes/SOUL.md aside BEFORE the first write (or record that there was none). Refuses to run over a
# leftover snapshot, which means an earlier run did not finish.
soul_snapshot() {
  remote 'bash -s' <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/hermes-soul"
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "soul_snapshot: $d exists - a previous hermes-soul run did not finish. Run soul_rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
t=$(mktemp -d "$p/.snapshot-hermes-soul.XXXXXX")
trap 'rm -rf "$t"' EXIT
if [ -f "$HOME/.hermes/SOUL.md" ]; then
  cp -p "$HOME/.hermes/SOUL.md" "$t/SOUL.md"
  cmp -s "$HOME/.hermes/SOUL.md" "$t/SOUL.md"
elif [ -e "$HOME/.hermes/SOUL.md" ] || [ -L "$HOME/.hermes/SOUL.md" ]; then
  echo "soul_snapshot: SOUL.md is not a regular file; nothing was written." >&2
  exit 1
else
  : > "$t/SOUL.md.absent"
fi
printf 'hstack-soul-snapshot-v1\n' > "$t/.complete"
[ ! -e "$d" ] || { echo "soul_snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
mv "$t" "$d"
trap - EXIT
REMOTE
}
# soul_rollback: put SOUL.md back exactly as it was before this run (removing it if there was none) and retire the snapshot.
# No gateway reload: a restored file applies to new sessions, exactly like the write did.
soul_rollback() {
  local rc=0
  remote 'bash -s' <<'REMOTE' || rc=$?
set -e
d="$HOME/.hermes/.hstack-backup/hermes-soul"
[ -d "$d" ] || { echo "soul_rollback: no snapshot for hermes-soul; nothing was written."; exit 10; }
[ "$(cat "$d/.complete" 2>/dev/null)" = hstack-soul-snapshot-v1 ] \
  || { echo "soul_rollback: snapshot is incomplete; kept for manual recovery." >&2; exit 1; }
if [ -f "$d/SOUL.md" ]; then
  rm -f "$HOME/.hermes/SOUL.md"
  cp -p "$d/SOUL.md" "$HOME/.hermes/SOUL.md"
  cmp -s "$d/SOUL.md" "$HOME/.hermes/SOUL.md" || { echo "soul_rollback: restore could not be verified; snapshot kept." >&2; exit 1; }
elif [ -f "$d/SOUL.md.absent" ]; then
  rm -f "$HOME/.hermes/SOUL.md"
else
  echo "soul_rollback: snapshot has neither SOUL.md nor the absent marker; kept for manual recovery." >&2
  exit 1
fi
rm -rf "$d.prev"
mv "$d" "$d.prev"
REMOTE
  [ "$rc" = 10 ] && return 0
  [ "$rc" = 0 ] || return "$rc"
  echo "rollback: restored ~/.hermes/SOUL.md to its pre-hermes-soul state."
}
# soul_finish: the run succeeded; keep the old copy as .prev for a manual undo.
soul_finish() {
  remote 'bash -s' <<'REMOTE'
set -e
d="$HOME/.hermes/.hstack-backup/hermes-soul"
[ -d "$d" ] || exit 0
rm -rf "$d.prev"
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ -f "$d.prev/.complete" ] || { echo "soul_finish: could not retire the snapshot; inspect it." >&2; exit 1; }
REMOTE
}
```

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked
against the v0.22.5 source; it has not been run against a live host. `~/.hermes` is the Hermes home of a host install; for a
Docker deployment the same file lives in the container's data volume (`/opt/data/SOUL.md`), so run `whoami; hostname` once: a
hex hostname means you are inside a container.

---

## Step 2 — validate the inputs locally and build the file content

Everything is checked before any remote write. The text travels over ssh STDIN, so no quoting of the name or style can reach a
shell on either machine.

```bash
nl=$(printf '\nx'); nl=${nl%x}
cr=$(printf '\rx'); cr=${cr%x}
if [ -n "${SOUL_FILE:-}" ]; then
  [ -f "$SOUL_FILE" ] && [ -r "$SOUL_FILE" ] \
    || { echo "ABORT: SOUL_FILE is not a readable file on this machine. Nothing was written."; exit 1; }
  SIZE=$(wc -c < "$SOUL_FILE" | tr -d ' ')
  { [ "$SIZE" -gt 0 ] && [ "$SIZE" -le 50000 ]; } \
    || { echo "ABORT: SOUL_FILE must be 1 to 50000 bytes (it is $SIZE). Nothing was written."; exit 1; }
  tr -d '\000' < "$SOUL_FILE" | cmp -s - "$SOUL_FILE" \
    || { echo "ABORT: SOUL_FILE contains NUL bytes, so it is not a text file. Nothing was written."; exit 1; }
  CONTENT=$(cat "$SOUL_FILE")
else
  case "${AGENT_NAME:-}" in ""|[!A-Za-z]*|*[!A-Za-z0-9_-]*)
    echo "ABORT: AGENT_NAME must start with a letter and contain only letters, digits, _ and - (got: ${AGENT_NAME:-empty}). Nothing was written."; exit 1 ;;
  esac
  [ "${#AGENT_NAME}" -le 32 ] || { echo "ABORT: AGENT_NAME is longer than 32 characters. Nothing was written."; exit 1; }
  STYLE="${AGENT_STYLE:-Concise, direct, helpful. No filler, no hedging.}"
  case "$STYLE" in *"$nl"*|*"$cr"*)
    echo "ABORT: AGENT_STYLE must be a single line. Nothing was written."; exit 1 ;;
  esac
  [ "${#STYLE}" -le 300 ] || { echo "ABORT: AGENT_STYLE is longer than 300 characters. Nothing was written."; exit 1; }
  CONTENT=$(printf '# Identity\nYou are %s, a personal AI assistant.\n\n# Style\n%s\n\n# Avoid\nLong preambles, fabricated results, over-apologizing.' "$AGENT_NAME" "$STYLE")
fi
echo "SOUL.md content: ${#CONTENT} characters"
```

---

## Step 3 — idempotency check and overwrite guard

```bash
if printf '%s\n' "$CONTENT" | remote 'cmp -s - "$HOME/.hermes/SOUL.md"' 2>/dev/null; then
  echo "SOUL.md already has exactly this content. Nothing to do."
  exit 0
fi
EXISTING=$(remote 'if [ -s "$HOME/.hermes/SOUL.md" ]; then wc -c < "$HOME/.hermes/SOUL.md" | tr -d " "; else echo 0; fi')
if [ "${EXISTING:-0}" -gt 0 ] && [ "${FORCE:-0}" != 1 ]; then
  echo "ABORT: ~/.hermes/SOUL.md already exists ($EXISTING bytes) with different content and this run would replace it. Show it to the user; if they agree, re-run with FORCE=1 (the old file is kept as ~/.hermes/.hstack-backup/hermes-soul.prev). Nothing was written."
  exit 1
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) inputs validated, Hermes 0.22.5 confirmed, nothing written yet
  1. Copy the current ~/.hermes/SOUL.md (${EXISTING:-0} bytes, or none) to ~/.hermes/.hstack-backup/hermes-soul
  2. Write ~/.hermes/SOUL.md: ${#CONTENT} characters${AGENT_NAME:+, agent name $AGENT_NAME}${SOUL_FILE:+ (from your SOUL_FILE)}
  3. Verify it byte for byte and that it is readable
  4. No gateway reload: new sessions (/new, /reset, the next cron run) read the file; running chats keep their stored prompt
  5. Check with a one-shot call: hermes -p default -z asking for the agent's name (a real, billed model call)
  Any failure after step 1 restores the previous SOUL.md. No secret is involved.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user declines:
`echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write SOUL.md

The content goes in over stdin. It overwrites the file in place, so an existing file keeps its owner and mode (the gateway
user must be able to read it, or Hermes silently falls back to the built-in identity).

```bash
soul_snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run soul_rollback first, then re-run). Nothing was written."; exit 1; }
remote 'mkdir -p "$HOME/.hermes"' || { echo "FAIL: could not create ~/.hermes."; soul_rollback; exit 1; }
printf '%s\n' "$CONTENT" | remote 'cat > "$HOME/.hermes/SOUL.md"' \
  || { echo "FAIL: could not write ~/.hermes/SOUL.md."; soul_rollback; exit 1; }
```

---

## Step 6 — verify the file

```bash
printf '%s\n' "$CONTENT" | remote 'cmp -s - "$HOME/.hermes/SOUL.md" && [ -r "$HOME/.hermes/SOUL.md" ]' \
  || { echo "FAIL: SOUL.md did not write cleanly. Rolling back."; soul_rollback; exit 1; }
WRITTEN=$(remote 'wc -c < "$HOME/.hermes/SOUL.md" | tr -d " "')
echo "OK: ~/.hermes/SOUL.md written ($WRITTEN bytes)."
if [ "${WRITTEN:-0}" -gt 20000 ]; then
  echo "WARN: over 20,000 characters. Hermes cuts the middle of a context file above its cap (context_file_max_chars, or the model-window default, never below 20,000), and every request pays for this text."
fi
```

---

## Step 7 — check with a one-shot native call (the only proof that matters)

`hermes -p default -z PROMPT` starts a fresh session, so it builds the system prompt from disk exactly as a new chat would.
It is a real model call: it needs a working provider (`/hermes-model`) and costs a few tokens. A failure of the call itself
says nothing about SOUL.md, so it does not roll the file back; it is reported as UNVERIFIED.

```bash
if REPLY=$(remote "hermes -p default -z 'What is your name? Reply with just the name, nothing else.'" </dev/null 2>/dev/null) && [ -n "$REPLY" ]; then
  if [ -z "${AGENT_NAME:-}" ]; then
    echo "OK: the agent answered, but with SOUL_FILE alone this skill cannot check the name. Reply: $(printf '%s' "$REPLY" | head -c 200)"
  elif printf '%s' "$REPLY" | tr 'A-Z' 'a-z' | grep -qF -- "$(printf '%s' "$AGENT_NAME" | tr 'A-Z' 'a-z')"; then
    echo "OK: the agent identifies as '$AGENT_NAME'."
  else
    echo "WARN: the agent answered '$(printf '%s' "$REPLY" | head -c 200)', which does not contain '$AGENT_NAME'. SOUL.md is in place; check it is readable by the user running Hermes and is not owned by a profile distribution (that blocks a flagged file), then try a new session."
  fi
else
  echo "UNVERIFIED: the one-shot call failed or returned nothing (no provider or model configured? run /hermes-model). SOUL.md is written and verified byte for byte, but the identity was not confirmed."
fi
soul_finish || exit 1
```

`soul_finish` keeps the previous SOUL.md as `~/.hermes/.hstack-backup/hermes-soul.prev` (see Rollback).

---

## Rollback

`soul_rollback` (Step 0) runs automatically (`soul_rollback; exit 1`) on every failure after `soul_snapshot`. It RESTORES the
exact previous bytes, or removes SOUL.md if there was none, and retires the snapshot. It does not reload the gateway: a
restored file applies to new sessions like the write did.

Failures before the snapshot (inputs, guard, declined dry run) wrote nothing. If a run is interrupted after the snapshot, the
next `soul_snapshot` refuses to run: call `soul_rollback` first.

To undo a run that already finished (the old file was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote 'd=$HOME/.hermes/.hstack-backup/hermes-soul; [ -d "$d.prev" ] && rm -rf "$d" && mv "$d.prev" "$d"'; then
  soul_rollback
else
  echo "No .prev snapshot for hermes-soul; nothing to undo."
fi
```

Open chats keep the identity they started with either way; use `/new` to see the restored one.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Running `hermes setup agent` to "set the personality" | It is the Agent Settings section (iterations, tool progress, compression), not an identity wizard; headless it prints guidance and returns | Write SOUL.md directly (Step 5) |
| 2 | Restarting the gateway to "apply" a new SOUL.md | A running conversation keeps its stored system prompt; a restart changes nothing and interrupts live chats | No reload; start a new session (`/new`) |
| 3 | Empty or whitespace-only SOUL.md | Hermes falls back to the built-in identity silently | Step 3 compares content; Step 6 verifies bytes |
| 4 | SOUL.md unreadable by the gateway user | The read error is swallowed: built-in identity again | Write in place (keeps owner and mode); Step 7 checks the reply |
| 5 | A very long file | It is in every request; above the cap the middle is cut | Keep it short; Step 6 warns above 20,000 characters |
| 6 | A name or style with shell characters | Would corrupt a here-doc or command | Step 2 allowlists the name; the text travels on stdin, never in a command |
| 7 | Overwriting the user's hand-written SOUL.md | Their persona is lost | Step 3 refuses without `FORCE=1`; the old file is kept as `.prev` |
| 8 | Appending with `>>` | Concatenates onto a line without a trailing newline | Always overwrite the whole file |
| 9 | A SOUL.md installed by a profile distribution | A flagged file is BLOCKED (replaced by a `[BLOCKED ...]` line), unlike your own file | Edit your own Hermes home; check the smoke test |
| 10 | Judging the smoke test when no model is configured | `-z` needs a provider; its failure is not a SOUL.md failure | Reported as UNVERIFIED, file kept |
| 11 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run Step 0 first |
| 12 | Container versus host | The file lands in a layer that gets replaced | `whoami; hostname`; use the volume for Docker |

---

## Definition of done

- [ ] SSH confirmed; Hermes banner names `0.22.5`
- [ ] Inputs validated locally (name, style or `SOUL_FILE`); a different existing SOUL.md was only replaced with `FORCE=1`
- [ ] Dry run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `~/.hermes/SOUL.md` backed up by `soul_snapshot` before the write, then written over stdin
- [ ] File verified byte for byte and readable; size reported
- [ ] No gateway reload and no `hermes setup`: the user was told new sessions pick it up (`/new`)
- [ ] One-shot `hermes -p default -z` reply contains the name, or the result was reported as WARN/UNVERIFIED
- [ ] `soul_finish` ran; rollback restores the previous bytes (or removes the file)

---

## Verified against Hermes v0.22.5

Read from the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the
repository root of that tag.

- `load_soul_md` reads `<home>/SOUL.md` from disk, strips it, scans it (own file: warn only; distribution-owned: block) and
  truncates above the cap: `agent/prompt_builder.py:84-126,1540-1588`; cap and its floor/ceiling: `:1044-1065`, `:1496-1521`,
  `hermes_cli/config_defaults.py:533-536`. It is called when a system prompt is built: `agent/system_prompt.py:550-556`.
- The built prompt is stored per session and reused for continuing turns (also across restarts) unless model, provider or cwd
  changed: `agent/conversation_loop.py:817-897,959-986`. This is the trace behind "no gateway reload". SOUL.md edits through
  Hermes' own file tools need approval: `hermes_cli/config_defaults.py:1799-1801`.
- `hermes setup agent` is "Agent Settings"; non-interactive runs print guidance: `hermes_cli/setup.py:450-500,596,694-696`,
  `hermes_cli/subcommands/setup.py:9-27`. New-session commands `/new` (alias `/reset`): `hermes_cli/commands.py` (`CommandDef("new", ...)`).
- `hermes -z PROMPT` runs a one-shot with the same context rules as a normal chat turn: `hermes_cli/oneshot.py:1-8`.

**Not verified:** nothing here was run against a real Hermes, VPS or model. The stubs behind the tests model `-z` as a canned reply.
Unknown: whether a gateway that started before SOUL.md existed behaves differently for sessions it already opened (the code path says
each new session builds its prompt from disk); and how a very large SOUL.md is truncated for a specific model window.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and identity-load failure modes.
