---
name: hermes-deploy
description: Deploy a self-hosted Hermes Agent end-to-end over SSH. Orchestrates install, model, platforms, skills, memory, personality, home channel, autostart, and verification — idempotent, dry-run-first, rollback-safe. Works from any AI agent (Claude Code, Codex, Cursor, Gemini CLI, or Hermes itself).
---

# /hermes-deploy — full end-to-end Hermes Agent deploy (SSH-first)

You are the engineer deploying a self-hosted Hermes Agent for the user. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to
a remote VPS over SSH as root. **Every command in this skill runs on the VPS, not
on the local machine.** Local mode is supported but considered the exception.

Do everything autonomously; stop and ask the user ONLY for the things a machine
cannot do (mint a token, paste an API key, scan a QR, click OAuth, send the first
"hello," provision the VPS plan/region).

**Compatibility-candidate deployment.** This recipe explicitly opts into v0.22.5,
not hstack's promoted runtime pin. The official source installer and native gateway
lifecycle replace the old pip/daemon assumptions. The historical unconditional nightly
restart workaround is removed: preserve existing cron jobs and review them separately.
Model selection is the user's choice; current Hermes also supports managed local models,
while this bounded unattended recipe configures the four BYOK providers listed below.
Only Telegram and the default, exclusively owned host gateway are in scope.
Every native call selects `-p default`, regardless of the saved active profile. Installer, service, skill
and plugin side effects are not all reversed by the four-file deploy recovery point.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP/hostname of the target VPS | Hostinger / DigitalOcean / Hetzner dashboard. Default recommendation: **Hostinger** (one-click). |
| `$VPS_USER` | Intended installation/service account | Hosting dashboard |
| `$HERMES_VERSION`, `$CANDIDATE_ACKNOWLEDGED` | Explicitly `0.22.5` and `1` | Unpromoted compatibility-candidate opt-in |
| `$MODEL_PROVIDER` | `openrouter` \| `anthropic` \| `openai` \| `deepseek` | User choice; recommend DeepSeek for cost or Claude Sonnet for quality |
| `$MODEL_API_KEY` | API key for the chosen provider (stored as `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` by `/hermes-model`) | Provider dashboard |
| `$HERMES_MODEL` | Exact model id for that provider (no default — ask; do not guess) | Provider model catalogue. Documented examples: `anthropic/claude-sonnet-4` on `openrouter`, `claude-sonnet-4-6` on `anthropic` |
| `$PLATFORM` | `telegram` only for this candidate route | Other platform recipes require separate native lifecycle migration |
| `$HOME_CHANNEL_ID` | ID of the home channel for cron + notifications (format depends on `$PLATFORM`; checked in Step 0) | Platform admin UI |

Platform credentials (bot token, app token, allowlist user IDs, ...) are **not** gathered
here: `/platform-$PLATFORM` owns them, including the token-format check, the live
pre-flight, the mandatory allowlist, and its own rollback.

The user must also provide (cannot be automated):
- BotFather token / numeric user IDs (the allowlist) / Discord intents toggle / WhatsApp QR scan — collected by the platform skill
- Provider API key, GitHub token, OAuth/device flow approvals
- First "hello" on each wired platform
- VPS provisioning (plan/region/root password)

### Confirm SSH access before doing anything

```bash
[ "${PLATFORM:-}" = telegram ] || { echo "ABORT: this compatibility candidate supports Telegram only; other platform recipes still require native lifecycle migration. Nothing was written."; exit 1; }
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

If SSH is not yet set up, follow the keypair flow:

```bash
# Generate keypair locally (skip if already present)
[ -f ~/.ssh/hermes_vps ] || ssh-keygen -t ed25519 -f ~/.ssh/hermes_vps -N "" -C "hermes-deploy"

# User adds the public key on the VPS — ALWAYS use printf, never echo >>
# (echo >> can merge a key onto the previous line if the file lacks a trailing newline,
# silently invalidating both keys).
printf '\n%s\n' "$(cat ~/.ssh/hermes_vps.pub)"
# → user appends the output to ~/.ssh/authorized_keys on the VPS, then chmod 600

# First connect — auto-trust host key
ssh -i ~/.ssh/hermes_vps -o StrictHostKeyChecking=accept-new "$VPS_USER@$VPS_IP" "echo ok"
```

Verify you are on the host, not a container, before adding any key:

```bash
ssh "$VPS_USER@$VPS_IP" "whoami; hostname"
# root@<readable-name> → host ✅
# root@<hex-string>    → inside a container ❌  exit first
```

Security reminder: rotate or remove the throwaway root password immediately after
deploy (`passwd root` or `sudo passwd -l root`).

---

## Step 0 — helpers and input validation (define before anything can fail)

Run every block of this skill in ONE shell session: later steps call the functions
defined here. If your harness starts a fresh shell per command, re-run this block first.
Everything in this block is local; it makes no remote call until `deploy_validate_inputs` has
passed.

**Namespacing:** this skill delegates to `/hermes-model`, `/platform-*`, `/hermes-skills`,
... in the same shell, and each of them redefines the generic `SKILL_NAME`, `snapshot`,
`rollback`, `finish` (and `/hermes-model` also `validate_inputs`). Deploy's own helpers and
state are therefore prefixed (`DEPLOY_SKILL`, `deploy_validate_inputs`, `deploy_snapshot`,
`deploy_rollback`, `deploy_finish`) so a delegated skill can never shadow them. Deploy only
ever calls the `deploy_*` names; never call bare `rollback`/`snapshot` from this skill.

```bash
DEPLOY_SKILL=hermes-deploy

# remote: run a command string on the VPS. A non-login ssh shell has no ~/.local/bin on
# PATH, so it is prepended here (bare `hermes` therefore also resolves).
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }

# deploy_validate_inputs: every value that is later transported to the VPS is checked HERE,
# against an allowlist or a format regex, and the derived env-var names are set.
# Anything unexpected aborts before a single remote call is made.
deploy_validate_inputs() {
  case "$MODEL_PROVIDER" in
    openrouter) MODEL_KEYVAR=OPENROUTER_API_KEY ;;
    anthropic)  MODEL_KEYVAR=ANTHROPIC_API_KEY ;;
    openai)     MODEL_KEYVAR=OPENAI_API_KEY ;;
    deepseek)   MODEL_KEYVAR=DEEPSEEK_API_KEY ;;
    *) echo "ABORT: MODEL_PROVIDER must be openrouter|anthropic|openai|deepseek. Nothing was written."; return 1 ;;
  esac
  case "$PLATFORM" in
    telegram)    PLATFORM_UC=TELEGRAM;    CRED_VARS="TELEGRAM_BOT_TOKEN";                          HOME_RE='^-?[0-9]+$' ;;
    discord)     PLATFORM_UC=DISCORD;     CRED_VARS="DISCORD_BOT_TOKEN";                           HOME_RE='^[0-9]{15,25}$' ;;
    slack)       PLATFORM_UC=SLACK;       CRED_VARS="SLACK_BOT_TOKEN SLACK_APP_TOKEN";             HOME_RE='^[CGD][A-Z0-9]{8,}$' ;;
    mattermost)  PLATFORM_UC=MATTERMOST;  CRED_VARS="MATTERMOST_URL MATTERMOST_TOKEN";             HOME_RE='^[a-z0-9]{26}$' ;;
    whatsapp)    PLATFORM_UC=WHATSAPP;    CRED_VARS="";                                            HOME_RE='^[A-Za-z0-9@._:-]{3,100}$' ;;
    teams)       PLATFORM_UC=TEAMS;       CRED_VARS="TEAMS_CLIENT_ID TEAMS_CLIENT_SECRET TEAMS_TENANT_ID"; HOME_RE='^[A-Za-z0-9@._:-]{3,200}$' ;;
    google-chat) PLATFORM_UC=GOOGLE_CHAT; CRED_VARS="GOOGLE_CHAT_PROJECT_ID GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"; HOME_RE='^spaces/[A-Za-z0-9_-]+$' ;;
    signal)      PLATFORM_UC=SIGNAL;      CRED_VARS="SIGNAL_ACCOUNT SIGNAL_HTTP_URL";              HOME_RE='^(\+[0-9]{6,15}|[A-Za-z0-9+/=_-]{8,100})$' ;;
    *) echo "ABORT: PLATFORM must be telegram|discord|whatsapp|slack|mattermost|teams|google-chat|signal. Nothing was written."; return 1 ;;
  esac
  ALLOW_VAR="${PLATFORM_UC}_ALLOWED_USERS"
  HOME_VAR="${PLATFORM_UC}_HOME_CHANNEL"
  # SIGNAL_HOME_CHANNEL is not in upstream's env-var reference (only SIGNAL_HOME_CHANNEL_NAME is):
  # unverified, so it is not written unless the operator confirms it.
  HOME_WRITE=1
  if [ "$PLATFORM" = signal ] && [ "${CONFIRM_SIGNAL_HOME_CHANNEL:-0}" != "1" ]; then HOME_WRITE=0; fi
  [[ "$HOME_CHANNEL_ID" =~ $HOME_RE ]] \
    || { echo "ABORT: HOME_CHANNEL_ID is not a valid $PLATFORM id. Nothing was written."; return 1; }
  [[ "$HERMES_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$ ]] \
    || { echo "ABORT: HERMES_MODEL is empty or has unexpected characters. Nothing was written."; return 1; }
  [[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
    || { echo "ABORT: VPS_IP / VPS_USER look malformed. Nothing was written."; return 1; }
  [ -n "$MODEL_API_KEY" ] || { echo "ABORT: MODEL_API_KEY is empty. Nothing was written."; return 1; }
}

# deploy_snapshot: copy ~/.hermes/.env, config.yaml, SOUL.md and the crontab aside BEFORE the
# first write. The snapshot dir doubles as the "run in progress" marker deploy_rollback looks for.
deploy_snapshot() {
  remote "DEPLOY_SKILL='$DEPLOY_SKILL' bash -s" <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/$DEPLOY_SKILL"
# The active recovery point is published only after every artifact has been verified.
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "snapshot: $d exists — a previous $DEPLOY_SKILL run did not finish. Run deploy_rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
lock="$d.creating"
mkdir "$lock" 2>/dev/null || { echo "snapshot: another $DEPLOY_SKILL snapshot is being created; retry after it finishes." >&2; exit 1; }
t=""
trap '[ -z "$t" ] || rm -rf "$t"; rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo "snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
t=$(mktemp -d "$p/.snapshot-$DEPLOY_SKILL.XXXXXX")
for f in .env config.yaml SOUL.md; do
  if [ -f "$HOME/.hermes/$f" ]; then
    cp -p "$HOME/.hermes/$f" "$t/$f"
    cmp -s "$HOME/.hermes/$f" "$t/$f"
    chmod 600 "$t/$f"
  elif [ -e "$HOME/.hermes/$f" ] || [ -L "$HOME/.hermes/$f" ]; then
    echo "snapshot: $f is not a readable regular file; nothing was written." >&2; exit 1
  else
    : > "$t/$f.absent"
    chmod 600 "$t/$f.absent"
  fi
done
if crontab -l > "$t/crontab" 2> "$t/crontab.error"; then
  chmod 600 "$t/crontab"
elif grep -qi 'no crontab' "$t/crontab.error"; then
  rm -f "$t/crontab"; : > "$t/crontab.absent"; chmod 600 "$t/crontab.absent"
else
  cat "$t/crontab.error" >&2; exit 1
fi
rm -f "$t/crontab.error"
for f in .env config.yaml SOUL.md crontab; do
  for entry in "$f" "$f.absent"; do
    if [ -f "$t/$entry" ]; then cksum < "$t/$entry" > "$t/$entry.cksum"; chmod 600 "$t/$entry.cksum"; fi
  done
done
printf 'hstack-snapshot-v1\n' > "$t/.complete"
chmod 600 "$t/.complete"
mv "$t" "$d"
[ -f "$d/.complete" ] && [ ! -d "$t" ] || { echo "snapshot: recovery-point publication failed; nothing was written." >&2; exit 1; }
t=""
REMOTE
}
# deploy_rollback: restore the exact pre-deploy .env, config.yaml, SOUL.md and crontab (so a
# FORCE=1 re-run that fails puts the previous working state back), then reload the gateway.
deploy_rollback() {
  remote "DEPLOY_SKILL='$DEPLOY_SKILL' bash -s" <<'REMOTE'
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$DEPLOY_SKILL"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $DEPLOY_SKILL; nothing was written."; exit 0; }
# Incomplete legacy snapshots cannot prove that their final copy succeeded. Keep them for manual recovery.
[ -f "$d/.complete" ] && [ "$(cat "$d/.complete")" = hstack-snapshot-v1 ] \
  || { echo "rollback: snapshot is incomplete or legacy; active snapshot retained for manual recovery." >&2; exit 1; }
for f in .env config.yaml SOUL.md crontab; do
  count=0
  for entry in "$f" "$f.absent"; do
    if [ -f "$d/$entry" ]; then
      count=$((count + 1))
      [ -f "$d/$entry.cksum" ] || { echo "rollback: missing checksum for $f; active snapshot retained for recovery." >&2; exit 1; }
      checksum=$(cksum < "$d/$entry")
      expected_checksum=$(cat "$d/$entry.cksum")
      [ "$checksum" = "$expected_checksum" ] \
        || { echo "rollback: corrupt backup for $f; active snapshot retained for recovery." >&2; exit 1; }
    fi
  done
  [ "$count" = 1 ] || { echo "rollback: missing or ambiguous backup for $f; active snapshot retained for recovery." >&2; exit 1; }
done
for f in .env config.yaml SOUL.md; do
  if [ -f "$d/$f" ]; then
    cp -p "$d/$f" "$HOME/.hermes/$f"
    cmp -s "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then
    rm -f "$HOME/.hermes/$f"
    [ ! -e "$HOME/.hermes/$f" ] && [ ! -L "$HOME/.hermes/$f" ] || { echo "rollback: file removal failed; active snapshot retained." >&2; exit 1; }
  else
    echo "rollback: missing backup for $f; active snapshot retained for recovery." >&2
    exit 1
  fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
if [ -f "$d/crontab" ]; then
  crontab "$d/crontab"
  restored_crontab=$(crontab -l)
  [ "$restored_crontab" = "$(cat "$d/crontab")" ]
elif [ -f "$d/crontab.absent" ]; then
  crontab -r 2>/dev/null || true
  if restored_crontab=$(crontab -l 2>&1); then
    echo "rollback: crontab removal failed; active snapshot retained for recovery." >&2; exit 1
  elif ! printf '%s' "$restored_crontab" | grep -qi 'no crontab'; then
    echo "rollback: crontab absence could not be verified; active snapshot retained for recovery." >&2; exit 1
  fi
else
  echo "rollback: missing crontab backup; active snapshot retained for recovery." >&2; exit 1
fi
H=$HOME/.local/bin/hermes
"$H" -p default gateway stop
GW_WANTED=1
if [ -f "$d/.env.absent" ]; then echo "rollback: gateway left stopped (there was no .env before this deploy)."; GW_WANTED=0
else sleep 2; "$H" -p default gateway ensure --json --timeout 60 >/dev/null; fi
if [ "$GW_WANTED" = 1 ]; then
  sleep 3
  status_rc=0
  st=$("$H" -p default gateway status 2>&1) || status_rc=$?
  if [ "$status_rc" != 0 ] || printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
     || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
    echo "rollback: files restored, but the gateway did NOT come back — active snapshot retained; inspect the gateway and retry deploy_rollback after resolving the fault"
    exit 1
  fi
fi
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
echo "rollback: restored ~/.hermes/.env, config.yaml, SOUL.md and crontab to their pre-$DEPLOY_SKILL state."
REMOTE
}

# deploy_finish: mark the run successful; keep the snapshot as .prev for a manual undo.
deploy_finish() {
  remote "SKILL_NAME='$DEPLOY_SKILL' bash -s" <<'REMOTE'
set -e
trap 'echo "finish: could not retire the active snapshot; inspect the recovery point before continuing." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || exit 0
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
REMOTE
}

deploy_validate_inputs || exit 1
[ "$PLATFORM" = telegram ] || { echo "ABORT: this compatibility candidate supports Telegram only; other platform recipes still require native lifecycle migration. Nothing was written."; exit 1; }
```

Rules for calling them: failures **before** `deploy_snapshot` (steps 1-4, the user declining the
dry run) just `exit 1` with "Nothing was written" — they do not call `deploy_rollback`. Every
failure **after** `deploy_snapshot` does `deploy_rollback; exit 1`. `deploy_finish` runs after the last
automated check.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.
This candidate lifecycle recipe assumes the exclusive default profile and its one host gateway. Inspect other profiles and live work first: the current gateway can serve multiple profiles, so stop/start is not isolated to one bot. Do not use `--force`, `--all` or `--yes` to evade a refusal. Named-profile and shared-host deployment remain outside this recipe.


**Tagged native gateway surface.** v0.22.5 supports service `install --if-missing --no-start-now`, `start`, `stop`, and `ensure --json --timeout 60`. `run` is foreground; there is no `--daemon` option. Source/parser checks do not establish live target compatibility.

Also unverified against upstream's CLI docs, and used by this skill: `hermes -p default config set KEY -- value` (argparse positional handling accepts negative IDs after `--`), `hermes -p default logs`, and `hermes -p default -z`. `SIGNAL_HOME_CHANNEL` is not in
upstream's env-var reference page (only `SIGNAL_HOME_CHANNEL_NAME` is), so Step 6 does not write it
unless `CONFIRM_SIGNAL_HOME_CHANNEL=1`.

---

## Step 1 — verify the VPS is reachable and clean

```bash
remote '
  set -e
  whoami; hostname
  uname -a
  df -h / | tail -1
  free -h | head -2
' || { echo "ABORT: cannot read basic state from $VPS_USER@$VPS_IP. Nothing was written."; exit 1; }
```

Expected: a real hostname (not a container hex), ≥5 GB free, ≥2 GB RAM.

---

## Step 2 — idempotency check (skip if Hermes is already deployed)

```bash
ALREADY=$(remote 'command -v hermes >/dev/null 2>&1 && hermes -p default --version 2>/dev/null | grep -ci hermes || true' 2>/dev/null)
ALREADY=${ALREADY:-0}

if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Hermes is already deployed on $VPS_IP. Set FORCE=1 to redeploy, or run /hermes-status."
  remote "~/.local/bin/hermes -p default --version; ~/.local/bin/hermes -p default gateway status"
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:

  1. Install the explicitly selected Hermes v0.22.5 compatibility candidate via /hermes-install
  2. Configure model via /hermes-model: provider $MODEL_PROVIDER, model $HERMES_MODEL
     (key $MODEL_KEYVAR: length ${#MODEL_API_KEY}, prefix: ${MODEL_API_KEY:0:4}...)
  3. Wire platform via /platform-$PLATFORM (it collects its own credentials and the
     mandatory allowlist $ALLOW_VAR, and runs its own live pre-flight)
  4. Install curated starter skills via /hermes-skills
  5. Configure memory (built-in default) via /hermes-memory
  6. Write personality to ~/.hermes/SOUL.md (< 1 KB) via /hermes-soul
  7. Set home channel: $HOME_VAR=$HOME_CHANNEL_ID (HOME_WRITE=$HOME_WRITE; Signal's variable name is unverified upstream, so 0 = skipped)
  8. Install native gateway service and verify readiness; leave the crontab unchanged

Verification after each step:
  - hermes -p default --version exits 0
  - hermes -p default -z 'reply OK' returns OK
  - hermes -p default gateway status shows running
  - First "hello" on $PLATFORM returns a reply

Secrets are written only by the delegated skills (over ssh stdin, 'hermes -p default config set',
file chmod 600) and are NEVER printed in chat or logged.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — install Hermes (delegate to /hermes-install)

Run `/hermes-install` with `HERMES_VERSION=0.22.5` and `CANDIDATE_ACKNOWLEDGED=1` (it pins the candidate commit, skips the interactive setup wizard that hangs a
non-TTY shell, and writes `~/.local/bin/hermes`). Do not hand-roll an installer line here.

Verify (don't trust the installer — check):

```bash
[ "${HERMES_VERSION:-}" = 0.22.5 ] && [ "${CANDIDATE_ACKNOWLEDGED:-0}" = 1 ] \
  || { echo "ABORT: opt into the unpromoted v0.22.5 compatibility candidate explicitly. Nothing was configured."; exit 1; }
INSTALLED=$(remote '~/.local/bin/hermes -p default --version 2>/dev/null') \
  || { echo "ABORT: could not read Hermes version. Nothing was configured."; exit 1; }
printf '%s\n' "$INSTALLED" | grep -Eq '(^|[^0-9])0[.]22[.]5([^0-9]|$)' \
  || { echo "ABORT: Hermes v0.22.5 candidate not installed (see /hermes-install). Nothing was configured."; exit 1; }

# First write of this deploy follows: take the snapshot now.
deploy_snapshot || { echo "ABORT: could not snapshot ~/.hermes state. Nothing was written."; exit 1; }
```

---

## Step 5 — credentials: model key and platform token (delegate, do not write inline)

Secrets are written by the skills that own them, because those skills hold the format
check, the live pre-flight, the allowlist and the rollback that an inline
`hermes -p default config set` here would bypass. Hand off the same variables in this session:

```bash
export VPS_IP VPS_USER MODEL_PROVIDER MODEL_API_KEY HERMES_MODEL
```

1. Run `/hermes-model` with `MODEL_PROVIDER`, `MODEL_API_KEY` and `HERMES_MODEL`. It writes
   exactly one key, named per provider (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY` or `DEEPSEEK_API_KEY`), sets `model.provider`/`model.default`, and
   smoke-tests inference.
2. Run `/platform-$PLATFORM` (for example `/platform-telegram`). It writes the platform's
   real variables (for Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, ...) and
   refuses to enable the platform without an allowlist.

If either delegated skill aborts, its `exit 1` has most likely ended the shared shell (and it
redefined generic helper names), so the `deploy_*` functions may be gone. Re-run **Step 0** (with
the same variables exported), then `deploy_rollback; exit 1`: it restores the pre-deploy
`~/.hermes/.env`, `config.yaml`, `SOUL.md` and crontab snapshot taken at the end of Step 4.

NEVER write secrets to `config.yaml`, and never hand-write them in this skill. The names
above are the ones Hermes reads (Sources: Hermes docs, "Environment Variables" and
"AI Providers" pages, hermes-agent.nousresearch.com/docs); an invented name such as
`${PLATFORM}_TOKEN` or `${MODEL_PROVIDER}_API_KEY` is read by nothing.

---

## Step 6 — skills, memory, soul, then verify the wiring and set the home channel

Delegate the remaining sub-skills, in this order, aborting on the first failure (if the shell
died with the delegated skill, re-run Step 0 first, then `deploy_rollback; exit 1`):

- 6a. `/hermes-skills` — curated starter pack
- 6b. `/hermes-memory` — built-in default
- 6c. `/hermes-soul` — personality, `~/.hermes/SOUL.md` under 1 KB (injected every message)

Then run the gate below. It validates locally again, transports the values to the VPS
explicitly (a quoted heredoc expands nothing locally, so the values are passed as an env
prefix), proves the credentials the delegated skills wrote are present **without printing
them**, refuses to continue if the platform has no allowlist, a wildcard (`*` anywhere in it,
e.g. `555,*`) or an allow-all switch (`${PLATFORM_UC}_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS`,
names only, never values), and sets the home channel.

```bash
# This block needs Step 0's `remote` and deploy_* functions in the SAME shell: if the shell was
# restarted (or a delegated skill ended it), re-run Step 0 first. The snapshot already exists
# here, so a failed validation must roll back, not just exit.
deploy_validate_inputs || { deploy_rollback; exit 1; }
REMOTE_ENV="MODEL_PROVIDER=$(printf %q "$MODEL_PROVIDER") MODEL_KEYVAR=$(printf %q "$MODEL_KEYVAR")"
REMOTE_ENV="$REMOTE_ENV PLATFORM=$(printf %q "$PLATFORM") CRED_VARS=$(printf %q "$CRED_VARS")"
REMOTE_ENV="$REMOTE_ENV ALLOW_VAR=$(printf %q "$ALLOW_VAR") HOME_VAR=$(printf %q "$HOME_VAR")"
REMOTE_ENV="$REMOTE_ENV HOME_CHANNEL_ID=$(printf %q "$HOME_CHANNEL_ID")"
REMOTE_ENV="$REMOTE_ENV PLATFORM_UC=$(printf %q "$PLATFORM_UC") HOME_WRITE=$(printf %q "$HOME_WRITE")"

remote "$REMOTE_ENV bash -s" <<'REMOTE' || { echo "FAIL: Step 6 wiring gate. Rolling back."; deploy_rollback; exit 1; }
set -e
H=~/.local/bin/hermes
ENVF=~/.hermes/.env
# have KEY: the key exists in .env with a non-empty value (value is never printed)
have() { grep -Eq "^$1=(\"[^\"]|[^\"])" "$ENVF"; }

[ -x "$H" ] || { echo "FAIL: $H missing"; exit 1; }
have "$MODEL_KEYVAR" || { echo "FAIL: $MODEL_KEYVAR not set for provider $MODEL_PROVIDER (re-run /hermes-model)"; exit 1; }
for v in $CRED_VARS; do
  have "$v" || { echo "FAIL: $v not set for $PLATFORM (re-run /platform-$PLATFORM)"; exit 1; }
done
have "$ALLOW_VAR" || { echo "FAIL: $ALLOW_VAR is empty. Refusing to leave an open bot."; exit 1; }
# A wildcard ANYWHERE in the allowlist ("*", "555,*") opens the bot. The list is non-secret and
# is only tested, never printed.
allow_val=$(sed -n "s/^$ALLOW_VAR=//p" "$ENVF" | tail -n1)
case "$allow_val" in
  *'*'*) echo "FAIL: $ALLOW_VAR contains a wildcard (*). Refusing to leave an open bot."; exit 1 ;;
esac
# Allow-all switches. Names only, never values; fail-closed (anything but false/0/no/off is on).
for n in "${PLATFORM_UC}_ALLOW_ALL_USERS" GATEWAY_ALLOW_ALL_USERS; do
  v=$(sed -n "s/^[[:space:]]*$n=//p" "$ENVF" | tail -n1 | tr -d "\"' \r" | tr 'A-Z' 'a-z')
  case "$v" in
    ""|false|0|no|off) ;;
    *) echo "FAIL: $n is turned on in ~/.hermes/.env. Refusing to leave an open bot."; exit 1 ;;
  esac
done

# Home channel (non-secret). Both names were validated locally before transport. `--` keeps a
# negative Telegram group ID from being parsed as an option (unverified syntax, see Step 0 notes).
if [ "$HOME_WRITE" = "1" ]; then
  "$H" -p default config set "$HOME_VAR" -- "$HOME_CHANNEL_ID"
  chmod 600 "$ENVF"
  have "$HOME_VAR" || { echo "FAIL: $HOME_VAR not written"; exit 1; }
  HOME_NOTE="$HOME_VAR set"
else
  HOME_NOTE="$HOME_VAR NOT written (unverified upstream name; set CONFIRM_SIGNAL_HOME_CHANNEL=1 to write it)"
  echo "NOTE: $HOME_NOTE"
fi

test -f ~/.hermes/SOUL.md || { echo "FAIL: SOUL.md missing (re-run /hermes-soul)"; exit 1; }
test "$(wc -c < ~/.hermes/SOUL.md)" -lt 1024 || { echo "FAIL: SOUL.md > 1 KB"; exit 1; }
echo "OK: $MODEL_KEYVAR, $PLATFORM credentials and $ALLOW_VAR present; $HOME_NOTE."
REMOTE
```

The gateway needs **one restart "nudge"** after first platform setup — handled in Step 7.

---

## Step 7 — install/start the native supervised gateway

Use the native service lifecycle. Do not force a second foreground dispatcher or bypass a live-work/supervisor refusal.

```bash
remote "~/.local/bin/hermes -p default gateway stop" \
  || { echo "FAIL: gateway stop refused. Rolling back."; deploy_rollback; exit 1; }
sleep 2
# The next block installs/starts the native supervised service.

```

Install the native service idempotently, then use its supported background start and
readiness boundary. The old unconditional 03:30 restart workaround is not retained:
there is no current-version evidence here that every deployment needs it. Existing
cron jobs, including previously installed restarts, are left unchanged for review.

```bash
remote 'bash -s' <<'REMOTE' || { echo "FAIL: native gateway service setup. Rolling back."; deploy_rollback; exit 1; }
set -e
H=~/.local/bin/hermes
"$H" -p default gateway install --if-missing --no-start-now
"$H" -p default gateway start
"$H" -p default gateway ensure --json --timeout 60 >/dev/null
echo "OK: native gateway service ready; crontab unchanged."
REMOTE
```

---

## Step 8 — verify in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "~/.local/bin/hermes -p default logs 2>&1") || LOG_STATUS=$?
  # Generic gateway/tool readiness does not prove this platform connected. The latest
  # status-bearing line for the selected platform wins, including a later failure.
  if [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | tail -200 | awk -v p="$PLATFORM" '
    {
      line = tolower($0)
      if (line !~ ("(^|[^[:alnum:]_])" p "([^[:alnum:]_]|$)")) next
      if (line ~ /not[[:space:]_-]+(connected|ready)|(^|[^[:alnum:]_])(disconnected|failed|error|stopped)([^[:alnum:]_]|$)/) connected = 0
      else if (line ~ /(^|[^[:alnum:]_])(ok|connected|ready)([^[:alnum:]_]|$)/) connected = 1
    }
    END { exit !connected }'; then
    REGISTERED=1
    echo "OK: $PLATFORM connection confirmed in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gateway/platform not visible in logs after 30s. Rolling back."; deploy_rollback; exit 1; }
```

---

## Step 9 — live end-to-end smoke test

```bash
# 9a. Model smoke test
MODEL_STATUS=0
MODEL_REPLY=$(remote "~/.local/bin/hermes -p default -z 'reply with the single word OK' 2>/dev/null") || MODEL_STATUS=$?
if [ "$MODEL_STATUS" != 0 ]; then
  echo "FAIL: model smoke command failed. Rolling back."; deploy_rollback; exit 1
fi
OK=$(printf '%s' "$MODEL_REPLY" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d')
case "$OK" in
  OK) echo "OK: model reachable and returning text." ;;
  "") echo "FAIL: empty response — check model API key. Rolling back."; deploy_rollback; exit 1 ;;
  *)  echo "UNVERIFIED: the model smoke test returned an unexpected reply ('${OK:0:60}'), so this deploy is NOT confirmed."
      echo "Not finishing and not reporting done. Re-check the provider/model config and re-run this step, or run"
      echo "deploy_rollback (re-run Step 0 first if needed) to restore the pre-deploy state. The deploy snapshot is still in place."
      exit 1 ;;
esac

# 9b. Gateway status. "not running" must not count as running, so negatives are tested first.
GW_RC=0
GWST=$(remote '~/.local/bin/hermes -p default gateway status 2>&1') || GW_RC=$?
if [ "$GW_RC" != 0 ] || printf '%s' "$GWST" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$GWST" | grep -qiE 'running|active|started|online|ready'; then
  echo "FAIL: gateway not reported running. Rolling back."; deploy_rollback; exit 1
fi
echo "OK: gateway status reports running."

# Automated checks passed: keep the snapshot as .prev for a manual undo.
deploy_finish || exit 1

# 9c. First "hello" on $PLATFORM — USER step (cannot be automated)
echo "ACTION REQUIRED: send a real 'hello' on $PLATFORM and confirm Hermes replies."
echo "(Expect to nudge-restart the gateway once if the first message hangs.)"
```

Model reply `OK`, gateway running and a logged platform connection = wired. Empty
reply, `401`-style errors or a non-running gateway = rollback. An unexpected (neither `OK` nor
empty) model reply is inconclusive: the deploy is reported as UNVERIFIED, `deploy_finish` is not
called, and the snapshot stays so the operator can re-check or run `deploy_rollback`.

---

## Rollback (auto-runs on any failure above)

`deploy_rollback()` is defined once, in **Step 0**, and is called as `deploy_rollback; exit 1` from
every failure after the snapshot. It restores the pre-deploy `~/.hermes/.env`,
`config.yaml`, `SOUL.md` and crontab from `~/.hermes/.hstack-backup/hermes-deploy`, stops
the gateway, and (when an `.env` existed before) starts it again on the restored config and
checks `hermes -p default gateway status`: if the gateway is not reported running it prints `files restored,
but the gateway did NOT come back` and exits non-zero (start it with `hermes -p default gateway start`, then
check `hermes -p default logs`).
Because it restores rather than deletes, a failed `FORCE=1` re-deploy puts the
previously working keys back. The delegated skills keep their own snapshots
(`~/.hermes/.hstack-backup/<skill>.prev`).

Manual undo after a successful run: `cp ~/.hermes/.hstack-backup/hermes-deploy.prev/.env ~/.hermes/.env`
(same for `config.yaml`, `SOUL.md`; `crontab ~/.hermes/.hstack-backup/hermes-deploy.prev/crontab`),
then `hermes -p default gateway stop && hermes -p default gateway ensure --json --timeout 60`.

A full uninstall (remove `~/.local/bin/hermes`, `~/.hermes/`) is intentionally NOT
part of rollback — the user may want to inspect state. See `/hermes-fix` for
deeper recovery.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `ensure` |
| 2 | `echo >> .env` instead of `config set` | Mashes value onto prior line if no trailing newline | Always `hermes -p default config set` (done by the delegated skills) |
| 3 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 4 | sed with `/` delimiter on tokens | Provider/platform tokens contain `/+=` | Use `\|` delimiter |
| 5 | SSH key added inside a container | Host sshd never reads container `authorized_keys` | `whoami; hostname` check first; exit container |
| 6 | `echo >>` on `authorized_keys` merging keys | Two keys on one line → SSH silently rejects both | Always `printf '\n%s\n'` |
| 7 | Default local/small model | Hallucinates tool calls — breaks every skill | Frontier model only (DeepSeek / Sonnet / GPT) |
| 8 | PATH missing `~/.local/bin` in fresh shell | `hermes` not found in non-login SSH | `remote()` prepends it; remote scripts use absolute `~/.local/bin/hermes` |
| 9 | Treating a compatibility candidate as promoted | Parser/stub checks are not a live golden path | Explicit candidate version/commit and the `VERSIONS.txt` promotion gate |
| 10 | Gateway OOM after days of uptime | Known leak #25315 | Nightly `gateway restart` cron (Step 7) |
| 11 | First platform message hangs forever | Gateway needs one "nudge" restart after first platform setup | Stop+run after Step 6, document the nudge to the user |
| 12 | Throwaway root password left enabled | Brute-force surface area | `passwd -l root` after deploy, or rotate |
| 13 | Allowlists missing → open bot | Anyone who finds the bot can talk to it | `/platform-$PLATFORM` requires one; Step 6 gate re-checks `${PLATFORM}_ALLOWED_USERS` is non-empty with no `*` anywhere in it (`555,*`), and that `${PLATFORM_UC}_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS` are not on |
| 14 | `prompt_caching` left off | 10x cost in production | Set by `/hermes-model` (`prompt_caching.enabled true`) |
| 15 | `skills.guard_agent_created` left false | Agent-authored skills can run unreviewed | Set by `/hermes-skills` (`guard_agent_created true`) |
| 16 | Quoted heredoc (`<<'REMOTE'`) referencing local `$VARS` | Nothing expands locally and the remote shell has none, so every value is empty | Validate locally, then pass an explicit env prefix: `remote "NAME=$(printf %q "$NAME") bash -s"` |
| 17 | Inventing env-var names (`${PLATFORM}_TOKEN`, `${MODEL_PROVIDER}_API_KEY`) | Hermes reads fixed names (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, ...); anything else is ignored silently | Let `/hermes-model` and `/platform-*` write them |
| 18 | Not checking a heredoc's exit status | `set -e` inside the heredoc is useless if the caller ignores ssh's status | `remote ... <<'REMOTE' \|\| { deploy_rollback; exit 1; }` |

---

## Coming soon

The current frontend dashboard is being removed. hstack will ship **agent
plugins** (specialist workers) that boost Hermes with focused workflows (sales,
HR, marketing, support, ops/admin, research).

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working (on host, not container)
- [ ] Inputs validated locally (`deploy_validate_inputs`): provider, platform, model id, home channel id
- [ ] Explicit Hermes v0.22.5 compatibility candidate installed at `~/.local/bin/hermes`; `--version` exits 0
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; `deploy_rollback` defined in Step 0 and restores (not deletes)
- [ ] Model key (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`) and platform credentials written by `/hermes-model` and `/platform-$PLATFORM`; `~/.hermes/.env` is `chmod 600`
- [ ] No secret in `config.yaml`; nothing echoed in chat
- [ ] Model configured; `hermes -p default -z 'reply OK'` returns OK
- [ ] Curated starter skills installed
- [ ] `$PLATFORM` enabled with `${PLATFORM}_ALLOWED_USERS` non-empty, wildcard-free and no allow-all switch on (Step 6 gate passed)
- [ ] Memory backend initialized; SOUL.md < 1 KB; home channel set (Signal: skipped unless `CONFIRM_SIGNAL_HOME_CHANNEL=1`)
- [ ] Gateway reloaded with `stop` + `ensure` (NOT restart)
- [ ] Native service installed idempotently and ready; unrelated crontab unchanged
- [ ] Logs show gateway ready, platform connected, tools registered within 30s
- [ ] Live smoke test: `hermes -p default -z` returns OK (an inconclusive reply is reported UNVERIFIED, never done); `gateway status` shows running
- [ ] User sent first "hello" on `$PLATFORM` and Hermes replied
- [ ] Throwaway root password rotated/locked

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway,
MCP, SSH-key, and platform failure modes.

Candidate source: [v0.22.5 gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py). Runtime promotion remains gated by `VERSIONS.txt`.
