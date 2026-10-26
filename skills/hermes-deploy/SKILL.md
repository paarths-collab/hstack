---
name: hermes-deploy
description: Deploy a self-hosted Hermes Agent v0.22.5 with Telegram end-to-end over SSH, covering install, model, platform, skills, memory, personality, home channel, native gateway service and verification. Idempotent, dry-run-first and rollback-safe, and it works from any AI agent (Claude Code, Codex, Cursor, Gemini CLI, or Hermes itself).
---

# /hermes-deploy — full end-to-end Hermes Agent deploy (SSH-first)

You are the engineer deploying a self-hosted Hermes Agent for the user. The agent
(Hermes, Codex, Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to
a remote VPS over SSH as root. **Every command in this skill runs on the VPS, not
on the local machine.** Local mode is supported but considered the exception.

Do everything autonomously; stop and ask the user ONLY for the things a machine
cannot do (mint a token, paste an API key, scan a QR, click OAuth, send the first
"hello," provision the VPS plan/region).

**Target: Hermes v0.22.5 only (source-verified, not live-verified).** Every command, flag and
variable name below was read in the v0.22.5 source (see "Verified against Hermes v0.22.5" at the end).
Nothing here has been run against a real host, a real Telegram bot or a real model provider, and
the promotion policy in `VERSIONS.txt` still applies before anyone calls it live-verified. The
official source installer and the native gateway lifecycle replace the old pip/daemon assumptions. The
historical unconditional nightly restart workaround is removed: preserve existing cron jobs and
review them separately. Model selection is the user's choice; current Hermes also supports managed
local models, while this bounded unattended recipe configures the four BYOK providers listed below.
Only Telegram and the default, exclusively owned host gateway are in scope in this release; the other
platform recipes are being re-verified for 0.22.5 one at a time. Every native call selects
`-p default`, regardless of the saved active profile. Installer, service, skill and plugin side
effects are not all reversed by the four-file deploy recovery point.

---

## Before you start — gather (ask once, in one batch)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP/hostname of the target VPS | Hostinger / DigitalOcean / Hetzner dashboard. Default recommendation: **Hostinger** (one-click). |
| `$VPS_USER` | Intended installation/service account | Hosting dashboard |
| `$HERMES_VERSION` | Optional. If set it must be exactly `0.22.5`; unset is fine | The only version this recipe is verified for (`VERSIONS.txt`) |
| `$MODEL_PROVIDER` | `openrouter` \| `anthropic` \| `openai` \| `deepseek` | User choice; recommend DeepSeek for cost or Claude Sonnet for quality |
| `$MODEL_API_KEY` | API key for the chosen provider (stored as `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` by `/hermes-model`) | Provider dashboard |
| `$HERMES_MODEL` | Exact model id for that provider (no default — ask; do not guess) | Provider model catalogue. Documented examples: `anthropic/claude-sonnet-4` on `openrouter`, `claude-sonnet-4-6` on `anthropic` |
| `$PLATFORM` | `telegram` only for now | The other platform recipes are being re-verified for 0.22.5 one at a time |
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
[ "${PLATFORM:-}" = telegram ] || { echo "ABORT: /hermes-deploy supports Telegram only for now; the other platforms are being re-verified for Hermes 0.22.5 one at a time. Nothing was written."; exit 1; }
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

# deploy_validate_inputs: every value that is later transported to the VPS is checked HERE,
# against an allowlist or a format regex, and the derived env-var names are set.
# Anything unexpected aborts before a single remote call is made.
deploy_validate_inputs() {
  [ -z "${HERMES_VERSION:-}" ] || [ "$HERMES_VERSION" = 0.22.5 ] \
    || { echo "ABORT: HERMES_VERSION must be 0.22.5 (the only version this recipe is verified for) or unset. Nothing was written."; return 1; }
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
    google-chat) PLATFORM_UC=GOOGLE_CHAT; CRED_VARS="GOOGLE_CHAT_PROJECT_ID GOOGLE_CHAT_SUBSCRIPTION_NAME GOOGLE_CHAT_SERVICE_ACCOUNT_JSON"; HOME_RE='^spaces/[A-Za-z0-9_-]+$' ;;
    signal)      PLATFORM_UC=SIGNAL;      CRED_VARS="SIGNAL_ACCOUNT SIGNAL_HTTP_URL";              HOME_RE='^(\+[0-9]{6,15}|group:[A-Za-z0-9+/=_-]{8,100})$' ;;
    *) echo "ABORT: PLATFORM must be telegram|discord|whatsapp|slack|mattermost|teams|google-chat|signal. Nothing was written."; return 1 ;;
  esac
  ALLOW_VAR="${PLATFORM_UC}_ALLOWED_USERS"
  HOME_VAR="${PLATFORM_UC}_HOME_CHANNEL"
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
# FORCE=1 re-run that fails puts the previous working state back), reload the gateway with gw_reload,
# then retire the snapshot. When there was no .env before the deploy the gateway is stopped instead.
deploy_rollback() {
  local rc=0
  remote "DEPLOY_SKILL='$DEPLOY_SKILL' bash -s" <<'REMOTE' || rc=$?
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$DEPLOY_SKILL"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $DEPLOY_SKILL; nothing was written."; exit 10; }
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
# 11 = restored, and there was no .env before this deploy, so the gateway must not keep running on credentials that are gone.
if [ -f "$d/.env.absent" ]; then exit 11; fi
exit 0
REMOTE
  [ "$rc" = 10 ] && return 0
  if [ "$rc" = 11 ]; then
    local stop_flag=""
    if [ "${GW_INTERRUPT:-0}" = 1 ]; then stop_flag=1; fi
    remote "hermes -p default gateway stop${stop_flag:+ -y}" \
      || { echo "rollback: files restored, but the gateway could not be stopped (live sessions? GW_INTERRUPT=1 interrupts them) — active snapshot retained; retry deploy_rollback" >&2; return 1; }
    echo "rollback: gateway left stopped (there was no .env before this deploy)."
  elif [ "$rc" = 0 ]; then
    gw_reload >/dev/null \
      || { echo "rollback: files restored, but the gateway did NOT come back ready — active snapshot retained; inspect the gateway and retry deploy_rollback after resolving the fault" >&2; return 1; }
  else
    return "$rc"
  fi
  deploy_finish || return 1
  echo "rollback: restored ~/.hermes/.env, config.yaml, SOUL.md and crontab to their pre-$DEPLOY_SKILL state."
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
[ "$PLATFORM" = telegram ] || { echo "ABORT: /hermes-deploy supports Telegram only for now; the other platforms are being re-verified for Hermes 0.22.5 one at a time. Nothing was written."; exit 1; }
```

Rules for calling them: failures **before** `deploy_snapshot` (steps 1-4, the user declining the
dry run) just `exit 1` with "Nothing was written" — they do not call `deploy_rollback`. Every
failure **after** `deploy_snapshot` does `deploy_rollback; exit 1`. `deploy_finish` runs after the last
automated check.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.
**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`
(`gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id`). Source-verified, not live-verified:
`restart` restarts the installed service or, with none, runs the replacement in the calling shell unless `--detach` is given
(`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`); with live sessions and no terminal it refuses
with exit 1 and `-y` interrupts them (`hermes_cli/gateway_lifecycle_guards.py:97-129`), so the helper adds `-y` only when you set
`GW_INTERRUPT=1`; `ensure` never installs a service and exits 0 only when ready (`hermes_cli/gateway_runtime_cli.py:8-37`);
`gateway status` prints `✗ Gateway is not running` when stopped, so its text is never a health check. The gateway reads `.env` at
start (`gateway/run.py:1583-1585`). `gateway run` is the foreground command (it
has no `--daemon` flag). The recipe assumes the
exclusive default profile and its one host gateway; do not use `--force` or `--all` to evade a refusal.

Other native calls used below: `hermes -p default config set KEY -- value` (key and value are optional positionals, so `--` keeps a
negative group id from being read as an option: `hermes_cli/subcommands/config.py:27-30`), `hermes -p default logs gateway -n N`
(`hermes_cli/subcommands/logs.py:33-51`) and `hermes -p default -z PROMPT` (`hermes_cli/_parser.py:148-153`). The per-platform
variable table in `deploy_validate_inputs` was re-read against `plugins/platforms/*/gateway_env.py`; `SIGNAL_HOME_CHANNEL` is a real
variable (`plugins/platforms/signal/gateway_env.py:16`) even though upstream's variable reference page only lists its `_NAME` twin.

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
  remote "hermes -p default --version; hermes -p default gateway status"   # informational only: never parsed for health
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:

  1. Install Hermes v0.22.5 (pinned commit, checksummed installer) via /hermes-install
  2. Configure model via /hermes-model: provider $MODEL_PROVIDER, model $HERMES_MODEL
     (key $MODEL_KEYVAR: length ${#MODEL_API_KEY}, prefix: ${MODEL_API_KEY:0:4}...)
  3. Wire platform via /platform-$PLATFORM (it collects its own credentials and the
     mandatory allowlist $ALLOW_VAR, and runs its own live pre-flight)
  4. Install curated starter skills via /hermes-skills
  5. Configure memory (built-in default) via /hermes-memory
  6. Write personality to ~/.hermes/SOUL.md (< 1 KB) via /hermes-soul
  7. Set home channel: $HOME_VAR=$HOME_CHANNEL_ID
  8. Install the native gateway service, reload with gateway restart --detach and require gateway ensure --json to report ready; leave the crontab unchanged

Verification after each step:
  - hermes -p default --version exits 0
  - hermes -p default -z 'reply OK' returns OK
  - hermes -p default gateway ensure --json reports state ready
  - First "hello" on $PLATFORM returns a reply

Secrets are written only by the delegated skills (over ssh stdin, 'hermes -p default config set',
file chmod 600) and are NEVER printed in chat or logged.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — install Hermes (delegate to /hermes-install)

Run `/hermes-install` (with `HERMES_VERSION=0.22.5` if you set it: it pins the v0.22.5 commit, checks the installer's SHA-256,
skips the interactive setup wizard that hangs a non-TTY shell, and writes `~/.local/bin/hermes`). Do not hand-roll an installer line here.

Verify (don't trust the installer — check):

```bash
INSTALLED=$(remote 'hermes -p default --version 2>/dev/null') \
  || { echo "ABORT: could not read Hermes version. Nothing was configured."; exit 1; }
printf '%s\n' "$INSTALLED" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' \
  || { echo "ABORT: Hermes 0.22.5 is not installed on the target (got: $INSTALLED). See /hermes-install. Nothing was configured."; exit 1; }

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
- 6b. `/hermes-memory` with its default `MODE=inspect` — confirms what `memory status` reports (built-in memory, no external provider) and changes nothing; an external provider is a separate, attended decision. A finished inspect run ends with `exit 0`, which ends a shared shell, so re-run Step 0 before the gate below
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
REMOTE_ENV="$REMOTE_ENV PLATFORM_UC=$(printf %q "$PLATFORM_UC")"

remote "$REMOTE_ENV bash -s" <<'REMOTE' || { echo "FAIL: Step 6 wiring gate. Rolling back."; deploy_rollback; exit 1; }
set -e
ENVF=~/.hermes/.env
# have KEY: the key exists in .env with a non-empty value (value is never printed)
have() { grep -Eq "^$1=(\"[^\"]|[^\"])" "$ENVF"; }

command -v hermes >/dev/null || { echo "FAIL: hermes missing from PATH"; exit 1; }
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
# negative Telegram group ID from being parsed as an option (config.py:27-30 makes key/value positionals).
hermes -p default config set "$HOME_VAR" -- "$HOME_CHANNEL_ID"
chmod 600 "$ENVF"
have "$HOME_VAR" || { echo "FAIL: $HOME_VAR not written"; exit 1; }
HOME_NOTE="$HOME_VAR set"

test -f ~/.hermes/SOUL.md || { echo "FAIL: SOUL.md missing (re-run /hermes-soul)"; exit 1; }
test "$(wc -c < ~/.hermes/SOUL.md)" -lt 1024 || { echo "FAIL: SOUL.md > 1 KB"; exit 1; }
echo "OK: $MODEL_KEYVAR, $PLATFORM credentials and $ALLOW_VAR present; $HOME_NOTE."
REMOTE
```

The delegated skills already reload the gateway after their own writes; Step 7 installs the native service and does the final reload.

---

## Step 7 — install/start the native supervised gateway

Install the native service idempotently (`--if-missing`, and `--no-start-now` so the install itself starts nothing), then reload through the
shared lifecycle helper: with a service installed, `gateway restart` restarts that service (`hermes_cli/gateway.py:5487-5495`), and the systemd
restart drains the gateway that is currently running (the unmanaged one the delegated skills started) with SIGUSR1 before it starts the unit
(`hermes_cli/gateway.py:3736-3773`); `gw_ready` then requires `ensure` to report `ready` with a new instance. (Source-read, not observed on a
live host; the unit itself runs `gateway run` without `--replace`, `hermes_cli/gateway_launchd.py:271`.) Do not force a second foreground dispatcher or bypass a live-session/supervisor refusal. The old unconditional 03:30
restart workaround is not retained: there is no evidence that every deployment needs it, and Hermes' cron lifecycle guard refuses
cron jobs that restart or stop the gateway (`cron/lifecycle_guard.py:30-67`). Existing cron jobs, including previously
installed restarts, are left unchanged for review.

```bash
remote "hermes -p default gateway install --if-missing --no-start-now" \
  || { echo "FAIL: native gateway service setup. Rolling back."; deploy_rollback; exit 1; }
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; deploy_rollback; exit 1; }
echo "OK: native gateway service installed and ready; crontab unchanged."
```

---

## Step 8 — verify in logs (poll up to 30s)

The gateway logs `✓ <platform> connected (profile: <name>)` when an adapter comes up (`gateway/run_adapters.py:1347`), and platform
adapter records go to `gateway.log` (`hermes_logging.py:311`), so the check reads `hermes -p default logs gateway -n 200` (the bare
`hermes logs` shows `agent.log`, `hermes_cli/subcommands/logs.py:33-51`). The exact wording is read from source, not observed on a live host.

```bash
REGISTERED=0
for i in $(seq 1 6); do
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 200 2>&1") || LOG_STATUS=$?
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
MODEL_REPLY=$(remote "hermes -p default -z 'reply with the single word OK' 2>/dev/null") || MODEL_STATUS=$?
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

# 9b. Gateway readiness: `gateway ensure --json` must exit 0 with "state":"ready". Never grep `gateway status`
# for "running": the stopped gateway prints "✗ Gateway is not running".
gw_ready >/dev/null || { echo "FAIL: gateway not ready. Rolling back."; deploy_rollback; exit 1; }
echo "OK: gateway reports ready."

# Automated checks passed: keep the snapshot as .prev for a manual undo.
deploy_finish || exit 1

# 9c. First "hello" on $PLATFORM — USER step (cannot be automated)
echo "ACTION REQUIRED: send a real 'hello' on $PLATFORM and confirm Hermes replies."
echo "(If it gets no reply, read: hermes -p default logs gateway -n 100 on the VPS, with bot URLs redacted, before restarting anything.)"
```

Model reply `OK`, a gateway that `gateway ensure --json` reports `ready` and a logged platform connection = wired. Empty
reply, `401`-style errors or a gateway that is not ready = rollback. An unexpected (neither `OK` nor
empty) model reply is inconclusive: the deploy is reported as UNVERIFIED, `deploy_finish` is not
called, and the snapshot stays so the operator can re-check or run `deploy_rollback`.

---

## Rollback (auto-runs on any failure above)

`deploy_rollback()` is defined once, in **Step 0**, and is called as `deploy_rollback; exit 1` from
every failure after the snapshot. It restores the pre-deploy `~/.hermes/.env`,
`config.yaml`, `SOUL.md` and crontab from `~/.hermes/.hstack-backup/hermes-deploy`, then (when an `.env`
existed before) reloads the gateway with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance);
when no `.env` existed it stops the gateway instead. If the gateway does not come back ready it prints `files restored,
but the gateway did NOT come back`, keeps the snapshot and exits non-zero (look at `hermes -p default gateway status` and
`hermes -p default logs gateway`, fix the fault, retry). A restart refused because of live sessions is the same case; retry with
`GW_INTERRUPT=1` only if interrupting them is acceptable.
Because it restores rather than deletes, a failed `FORCE=1` re-deploy puts the
previously working keys back. The delegated skills keep their own snapshots
(`~/.hermes/.hstack-backup/<skill>.prev`).

Manual undo after a successful run: `cp ~/.hermes/.hstack-backup/hermes-deploy.prev/.env ~/.hermes/.env`
(same for `config.yaml`, `SOUL.md`; `crontab ~/.hermes/.hstack-backup/hermes-deploy.prev/crontab`),
then `hermes -p default gateway restart --detach` and `hermes -p default gateway ensure --json --timeout 60` (the `gw_reload` helper).

A full uninstall (remove `~/.local/bin/hermes`, `~/.hermes/`) is intentionally NOT
part of rollback — the user may want to inspect state. See `/hermes-fix` for
deeper recovery.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Substring `running` in `gateway status` as health, or the foreground `gateway run` with an invented daemon flag | `✗ Gateway is not running` contains `running`; `gateway run` is the foreground command and a daemon flag does not exist (argparse rejects it) | `gw_reload`/`gw_ready` only |
| 2 | `echo >> .env` instead of `config set` | Mashes value onto prior line if no trailing newline | Always `hermes -p default config set` (done by the delegated skills) |
| 3 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 4 | sed with `/` delimiter on tokens | Provider/platform tokens contain `/+=` | Use `\|` delimiter |
| 5 | SSH key added inside a container | Host sshd never reads container `authorized_keys` | `whoami; hostname` check first; exit container |
| 6 | `echo >>` on `authorized_keys` merging keys | Two keys on one line → SSH silently rejects both | Always `printf '\n%s\n'` |
| 7 | Default local/small model | Hallucinates tool calls — breaks every skill | Frontier model only (DeepSeek / Sonnet / GPT) |
| 8 | PATH missing `~/.local/bin` in fresh shell | `hermes` not found in non-login SSH | `remote()` prepends it, including for `bash -s` heredocs; use bare `hermes -p default ...` inside remote strings |
| 9 | Calling this deploy "live-verified" | It is read from the v0.22.5 source and exercised against offline stubs, never against a real host, bot or provider | Report "source-verified"; the `VERSIONS.txt` promotion gate (real-target golden path, 7 days, review) is what changes that |
| 10 | Scheduling a cron job that restarts the gateway | Hermes refuses to create jobs whose prompt or script contains `hermes gateway restart/stop/uninstall` or the systemctl/pkill equivalents (`cron/lifecycle_guard.py:30-67`, `cron/jobs.py:1853-1855`) | Do not schedule restarts; reload natively with `gw_reload` and review any existing restart jobs separately |
| 11 | Reporting done when the gateway is `ready` but the platform never connected | `gateway ensure` readiness is the gateway process, not the Telegram adapter | Step 8 needs `✓ telegram connected` in `gateway.log`; the user's first "hello" (Step 9c) is the last check |
| 12 | Throwaway root password left enabled | Brute-force surface area | `passwd -l root` after deploy, or rotate |
| 13 | Allowlists missing → open bot | Anyone who finds the bot can talk to it | `/platform-$PLATFORM` requires one; Step 6 gate re-checks `${PLATFORM}_ALLOWED_USERS` is non-empty with no `*` anywhere in it (`555,*`), and that `${PLATFORM_UC}_ALLOW_ALL_USERS` / `GATEWAY_ALLOW_ALL_USERS` are not on |
| 14 | `prompt_caching` left off | 10x cost in production | Set by `/hermes-model` (`prompt_caching.enabled true`) |
| 15 | `skills.guard_agent_created` left false | Agent-authored skills can run unreviewed | Set by `/hermes-skills` (`guard_agent_created true`) |
| 16 | Quoted heredoc (`<<'REMOTE'`) referencing local `$VARS` | Nothing expands locally and the remote shell has none, so every value is empty | Validate locally, then pass an explicit env prefix: `remote "NAME=$(printf %q "$NAME") bash -s"` |
| 17 | Inventing env-var names (`${PLATFORM}_TOKEN`, `${MODEL_PROVIDER}_API_KEY`) | Hermes reads fixed names (`TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, ...); anything else is ignored silently | Let `/hermes-model` and `/platform-*` write them |
| 18 | Not checking a heredoc's exit status | `set -e` inside the heredoc is useless if the caller ignores ssh's status | `remote ... <<'REMOTE' \|\| { deploy_rollback; exit 1; }` |
| 19 | Deploying any Hermes other than 0.22.5 | Only that tag's source was read; older and newer builds differ in flags and lifecycle | Step 0 refuses a `HERMES_VERSION` other than `0.22.5`, Step 4 refuses any other version banner, both before the first write |
| 20 | Restarting with `-y` "to get past" a refusal | `-y` interrupts live chats | The helpers add it only when the operator sets `GW_INTERRUPT=1`; otherwise report the refusal and ask |

---

## Coming soon

The current frontend dashboard is being removed. hstack will ship **agent
plugins** (specialist workers) that boost Hermes with focused workflows (sales,
HR, marketing, support, ops/admin, research).

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working (on host, not container)
- [ ] Inputs validated locally (`deploy_validate_inputs`): provider, platform, model id, home channel id
- [ ] `HERMES_VERSION` unset or exactly `0.22.5`; Hermes 0.22.5 installed at `~/.local/bin/hermes` and `--version` names it
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; `deploy_rollback` defined in Step 0 and restores (not deletes)
- [ ] Model key (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`) and platform credentials written by `/hermes-model` and `/platform-$PLATFORM`; `~/.hermes/.env` is `chmod 600`
- [ ] No secret in `config.yaml`; nothing echoed in chat
- [ ] Model configured; `hermes -p default -z 'reply OK'` returns OK
- [ ] Curated starter skills installed
- [ ] `$PLATFORM` enabled with `${PLATFORM}_ALLOWED_USERS` non-empty, wildcard-free and no allow-all switch on (Step 6 gate passed)
- [ ] Memory backend initialized; SOUL.md < 1 KB; home channel set
- [ ] Gateway reloaded with `gw_reload` (`restart --detach`, then `ensure --json` ready with a new instance)
- [ ] Native service installed idempotently and ready; unrelated crontab unchanged
- [ ] `gateway.log` shows `✓ telegram connected` within 30s
- [ ] Live smoke test: `hermes -p default -z` returns OK (an inconclusive reply is reported UNVERIFIED, never done); `gw_ready` reports `ready`
- [ ] User sent first "hello" on `$PLATFORM` and Hermes replied
- [ ] Throwaway root password rotated/locked

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway,
MCP, SSH-key, and platform failure modes.

## Verified against Hermes v0.22.5

Source-verified at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository. Nothing below
was run against a real Hermes, Telegram bot or model provider, and `VERSIONS.txt` keeps the live-verification policy.

- Gateway commands and flags: `gateway ensure [--json] [--timeout]` `hermes_cli/subcommands/gateway.py:122-131`; `stop` and `restart`
  with `-y/--yes/--interrupt` and `restart --detach` `:141-156`; `install --if-missing --no-start-now` `:165-185`. Behaviour: restart and
  the live-session refusal `hermes_cli/gateway.py:5454-5536`, `gateway_supervised_restart.py:140-151`, `gateway_lifecycle_guards.py:97-129`;
  `ensure` `gateway_runtime.py:390-495`, `gateway_runtime_cli.py:8-37`; stopped status text `gateway.py:5636`.
- `.env` is read by the gateway process at start and per turn: `gateway/run.py:1583-1600`. `config set` of an UPPER_SNAKE name goes to
  `.env` and never echoes it: `hermes_cli/config.py:3417-3440`; `key`/`value` are optional positionals `hermes_cli/subcommands/config.py:27-30`.
- Platform variables (`ENV_ENABLE_CREDENTIALS`, home step, `AUTHZ`): `plugins/platforms/telegram/gateway_env.py:12-28`, `discord/gateway_env.py:6-20`,
  `slack/gateway_env.py:22-31` plus `SLACK_APP_TOKEN` in `slack/adapter.py:1791-1793`, `mattermost/gateway_env.py:6-21`,
  `whatsapp/gateway_env.py:21-30` (a flag, no token), `signal/gateway_env.py:7-24` (home channel at `:16`),
  `teams/adapter.py:162-164,183,850`, `google_chat/adapter.py:1590-1592,1626,1673,1684`. Only Telegram is deployable here; the rest of
  the table is kept for the per-platform re-verification.
- Connection log line `gateway/run_adapters.py:1347`; log routing `hermes_logging.py:311`; `logs [name] -n N` `hermes_cli/subcommands/logs.py:33-51`.
- Cron lifecycle guard `cron/lifecycle_guard.py:30-67`, `cron/jobs.py:1853-1855`.

Not verified: any behaviour on a live host (install, service start, Telegram polling, model replies), the exact `ensure`/`restart`
interaction when a service is installed but never started, and the vendor endpoints (nothing in this skill calls a vendor; the delegated skills do).

Source: [v0.22.5 gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py).
