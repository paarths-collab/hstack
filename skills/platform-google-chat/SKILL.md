---
name: platform-google-chat
description: "Wire a remote Hermes 0.22.5 agent to Google Chat over SSH using a Cloud Pub/Sub pull subscription: service-account key upload, an email allowlist, a live Google token plus subscription check before any write, rollback, and log verification. A human must create the GCP resources and the Chat app."
---

# /platform-google-chat — wire Google Chat to a remote Hermes (SSH-first, Pub/Sub pull)

You are the engineer connecting Google Chat to a self-hosted Hermes agent on the user's VPS.
The agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI — whichever ran you) works over SSH as
root. This skill is **source-verified against Hermes v0.22.5 only** (see "Verified against Hermes
v0.22.5" at the end); nothing here was run against a live Hermes, GCP project or Workspace.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS,
bash 3.2) and reaches the VPS through the `remote` helper from Step 0. Run all blocks in ONE shell
session. The service-account key travels only over ssh STDIN (and ends up in a mode-600 file on the
VPS); it is never an ssh argument, a URL on a command line, a single-quoted remote string, or part
of `config.yaml`.

## What is automated and what is not

Most of Google Chat is set up in Google consoles. Be explicit with the user about this up front:

| Part | Who | Notes |
|------|-----|-------|
| GCP project, Google Chat API and Cloud Pub/Sub API enabled; a service account and its downloaded JSON key | **Human** | The key is the secret this skill uploads. |
| A Pub/Sub **topic** and a **pull** subscription on it; `chat-api-push@system.gserviceaccount.com` granted **Pub/Sub Publisher on the topic**; the service account granted **Pub/Sub Subscriber and Pub/Sub Viewer on the subscription** | **Human** | The Publisher binding is the #1 silent failure and cannot be read with the bot's own key, so this skill cannot verify it. |
| Chat API, Configuration: connection = Cloud Pub/Sub with the topic, visibility, then adding the app in a DM or space | **Human** | Needs a Google Workspace account with rights to publish an app; Gmail-only accounts cannot host Chat apps. |
| The allowlist e-mails, project ID, subscription path, key file | **Human** supplies | |
| Key upload (mode 600), live Google token and subscription check from the VPS, writes, reload, log verification, optional home-space message | **This skill** | Everything before the first write is read-only. |

**What Hermes v0.22.5 does (source-verified):**

- Google Chat is a bundled platform plugin. It is enabled by environment alone: a GCP project ID plus a
  Pub/Sub subscription path (or an HTTP events URL). There is **no `GOOGLE_CHAT_ENABLED` variable**
  (`plugins/platforms/google_chat/adapter.py:1581-1630`, `gateway/config_env.py:164-225`); only an explicit
  `platforms.google_chat.enabled: false` in `config.yaml` blocks it (`gateway/config_env.py:192-194`), and this
  skill refuses to proceed over one.
- Inbound is either a Pub/Sub **pull** subscription (no public URL) or authenticated HTTP callbacks served by the
  api_server platform on a public URL (`plugins/platforms/google_chat/adapter.py:477-502`, `gateway/platforms/api_server.py:1544`). **This skill configures Pub/Sub pull only**;
  HTTP callback mode needs public ingress and more settings and is out of scope.
- Credentials: `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` is a file path or inline JSON; it falls back to
  `GOOGLE_APPLICATION_CREDENTIALS`, then to Application Default Credentials, which a plain VPS does not have
  (`adapter.py:257-292,1619-1630`). This skill writes a **path** to a mode-600 key file.
- The Pub/Sub client (extra `google-chat`) is **not** in a plain install: the default `[all]` set includes `google` but not
  `google-chat` (`pyproject.toml:503-534`). The gateway installs the missing extras on first start through PM, which needs
  package-index access and `security.allow_lazy_installs` true (`adapter.py:194-215`, `pm/install.py:164-189`).
  Step 3 refuses early when lazy installs are off, and the first start can be slow.
- At start the adapter calls `subscriptions.get` on your subscription and treats NotFound and PermissionDenied as fatal
  (`adapter.py:612-628`), which is why the service account needs Viewer as well as Subscriber.
- Authorization: the user ID is the sender's e-mail (`adapter.py:992`). With no allowlist and no allow-all switch the default is
  **deny**, and an unknown direct message is answered with a pairing code (`gateway/authz_mixin.py:631-714,751-757`). It does
  not fail open. This skill still requires a non-empty e-mail allowlist (an explicit policy choice). `*` in any allowlist,
  `GOOGLE_CHAT_ALLOW_ALL_USERS` or `GATEWAY_ALLOW_ALL_USERS` opens the bot to everyone; Step 3 refuses all of them.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GOOGLE_CHAT_PROJECT_ID` | GCP project ID | GCP console, Project info |
| `$GOOGLE_CHAT_SUBSCRIPTION_NAME` | `projects/<project>/subscriptions/<subscription>` of the PULL subscription (a topic path is wrong) | GCP console, Pub/Sub, Subscriptions. The project part must equal `$GOOGLE_CHAT_PROJECT_ID` |
| `$SA_KEY_LOCAL_PATH` | Path on YOUR machine to the service-account JSON key | Downloaded when the key was created |
| `$GOOGLE_CHAT_ALLOWED_USERS` | Comma-separated Workspace e-mails, at least one | The people who may drive the bot |
| `$GOOGLE_CHAT_HOME_CHANNEL` *(optional)* | `spaces/<ID>` for cron/notification delivery | The space's URL in Chat. When set, the skill sends one test message there |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was written."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=platform-google-chat
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

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/$SKILL_NAME"
# The active recovery point is published only after every artifact has been verified.
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
lock="$d.creating"
mkdir "$lock" 2>/dev/null || { echo "snapshot: another $SKILL_NAME snapshot is being created; retry after it finishes." >&2; exit 1; }
t=""
trap '[ -z "$t" ] || rm -rf "$t"; rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo "snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
t=$(mktemp -d "$p/.snapshot-$SKILL_NAME.XXXXXX")
for f in .env config.yaml; do
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

for f in .env config.yaml; do
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
# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), reload the gateway with gw_reload, then retire the snapshot.
rollback() {
  local rc=0
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE' || rc=$?
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 10; }
# Incomplete legacy snapshots cannot prove that their final copy succeeded. Keep them for manual recovery.
[ -f "$d/.complete" ] && [ "$(cat "$d/.complete")" = hstack-snapshot-v1 ] \
  || { echo "rollback: snapshot is incomplete or legacy; active snapshot retained for manual recovery." >&2; exit 1; }
for f in .env config.yaml; do
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
for f in .env config.yaml; do
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
exit 0
REMOTE
  [ "$rc" = 10 ] && return 0
  [ "$rc" = 0 ] || return "$rc"
  gw_reload >/dev/null \
    || { echo "rollback: files restored, but the gateway did NOT come back ready — active snapshot retained; inspect the gateway and retry rollback after resolving the fault" >&2; return 1; }
  finish || return 1
  echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
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
```

Rules used below: a failure BEFORE `snapshot` (Steps 1-3) is `exit 1` with `ABORT: ... Nothing was
written.` and never calls `rollback`. Every failure AFTER `snapshot` (Steps 5-7) is
`rollback; exit 1` (Step 5 adds `gc_fail`, which also removes a key file this run created).
Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums; rollback
validates the whole recovery point before changing live files and keeps it active if restoration fails.

**Gateway lifecycle (Hermes v0.22.5).** `gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`,
which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a different `instance_id` than before. Why this shape
(source-verified, not live-verified):

- `gateway restart` restarts the installed systemd/launchd service, or, with no service, stops the profile's gateway and runs the
  replacement **in the calling shell**; `--detach` starts it in the background the way `ensure` does, so an ssh call cannot hang
  (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`, `hermes_cli/gateway_runtime_start.py:86-97`).
- With live sessions it asks y/N on a TTY and **refuses with exit 1 without one**; `-y`/`--yes` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:97-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y`
  on its own: set `GW_INTERRUPT=1` only when interrupting live chats is acceptable. Do not use `--force` or `--all` to evade a refusal.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the
  gateway is ready (5 deadline/starting, 6 draining, 3 incompatible, 4 authorization, 7 conflict)
  (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_runtime_cli.py:8-37`). `instance_id` is a fresh uuid per gateway process
  (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is never used as a health check.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  `gateway run` is the foreground command; it has
  no `--daemon` flag.

---

## Step 1 — verify Hermes v0.22.5 on the VPS host

This skill writes the HOST's `~/.hermes`, so `hermes` must be installed on the host, not only inside a container.

```bash
HERMES_BANNER=$(remote '
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: hermes not found on the VPS host PATH"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host (a container-only install is not supported by this skill). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1;
}
```

---

## Step 2 — idempotency and safety scan of what is already stored

Skip the rest only when the VPS already holds a project, subscription, key path and e-mail allowlist, the
`.env` is private, the key file exists at mode 600 and no open-access switch is on. An unsafe stored setup
aborts instead of being reported as "already wired". Only a status word is printed, never a value. "Already
wired" means **configured**; it does not prove the bot is connected (use Step 7's checks).

```bash
if [ "${FORCE:-0}" != "1" ]; then
  STATE=$(remote 'bash -s' <<'REMOTE'
f=$HOME/.hermes/.env
if [ ! -e "$f" ] && [ ! -L "$f" ]; then echo needs_setup; exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || { echo unsafe; exit 0; }
mode=$(stat -c %a "$f" 2>/dev/null) || mode=$(stat -f %Lp "$f" 2>/dev/null) || exit 1
[ "$mode" = 600 ] || { echo unsafe; exit 0; }
res=$(awk '
  function value(s) {
    sub(/^[^=]*=/, "", s)
    sub(/\r$/, "", s)
    if (length(s) >= 2) {
      q = substr(s, 1, 1)
      if (q == substr(s, length(s), 1) && (q == "\"" || q == "\047")) s = substr(s, 2, length(s)-2)
    }
    return s
  }
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line ~ /^GOOGLE_CHAT_PROJECT_ID=/) { projects++; project = value(line) }
    if (line ~ /^GOOGLE_CHAT_SUBSCRIPTION_NAME=/) { subs++; sub_name = value(line) }
    if (line ~ /^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=/) { keys++; key = value(line) }
    if (line ~ /^GOOGLE_CHAT_ALLOWED_USERS=/) { lists++; users = value(line) }
    if (line ~ /^(GOOGLE_CHAT_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS)=/) {
      v = tolower(value(line)); gsub(/[[:space:]]/, "", v)
      if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") open_access = 1
    }
    if (line ~ /^GATEWAY_ALLOWED_USERS=/) {
      n = split(value(line), parts, ",")
      for (i = 1; i <= n; i++) { p = parts[i]; gsub(/[[:space:]]/, "", p); if (p == "*") open_access = 1 }
    }
  }
  END {
    if (projects == 0 || subs == 0 || keys == 0 || lists == 0) { print "needs_setup"; exit }
    if (open_access || projects > 1 || subs > 1 || keys > 1 || lists > 1) { print "unsafe"; exit }
    if (sub_name !~ /^projects\/[^\/]+\/subscriptions\/[^\/]+$/ || key !~ /^\/[A-Za-z0-9_.\/-]+$/) { print "needs_setup"; exit }
    n = split(users, parts, ",")
    for (i = 1; i <= n; i++) if (parts[i] !~ /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/) { print "unsafe"; exit }
    print "safe " key
  }' "$f")
if [ "${res%% *}" = safe ]; then
  kf=${res#safe }
  kmode=$(stat -c %a "$kf" 2>/dev/null) || kmode=$(stat -f %Lp "$kf" 2>/dev/null) || kmode=""
  if [ -f "$kf" ] && [ ! -L "$kf" ] && [ -s "$kf" ] && [ "$kmode" = 600 ]; then echo safe; else echo needs_setup; fi
else
  echo "$res"
fi
REMOTE
) || { echo "ABORT: could not check the stored Google Chat setup. Nothing was written."; exit 1; }
  case "$STATE" in
    safe) echo "Google Chat settings and key file are already stored (configuration only; this does not prove the bot is connected). Set FORCE=1 to rewrite."; exit 0 ;;
    needs_setup) ;;
    *) echo "ABORT: the stored Google Chat setup is unsafe (check file mode, duplicate keys, an e-mail-only allowlist and the access overrides). Nothing was written."; exit 1 ;;
  esac
fi
```

---

## Step 3 — HARD GATE: validate everything BEFORE anything is written

Nothing has been written yet, so every failure in Step 3 is a plain `exit 1`. Three parts: local checks (no ssh,
no network), a read-only look at the VPS, and a live Google check from the VPS that signs in with the service
account and reads your subscription.

**3a. Local checks.**

```bash
csv_clean() { LC_ALL=C tr -d ' \t\r\n' | sed 's/,,*/,/g; s/^,//; s/,$//' | LC_ALL=C tr 'A-Z' 'a-z'; }
EMAIL_RE='^[a-z0-9._%+][a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z][a-z]+$'
GOOGLE_CHAT_ALLOWED_USERS=$(printf '%s' "${GOOGLE_CHAT_ALLOWED_USERS:-}" | csv_clean)
GOOGLE_CHAT_PROJECT_ID=$(printf '%s' "${GOOGLE_CHAT_PROJECT_ID:-}" | tr -d ' \t\r\n')
GOOGLE_CHAT_SUBSCRIPTION_NAME=$(printf '%s' "${GOOGLE_CHAT_SUBSCRIPTION_NAME:-}" | tr -d ' \t\r\n')
GOOGLE_CHAT_HOME_CHANNEL=$(printf '%s' "${GOOGLE_CHAT_HOME_CHANNEL:-}" | tr -d ' \t\r\n')

if [ -z "$GOOGLE_CHAT_ALLOWED_USERS" ]; then
  echo "ABORT: GOOGLE_CHAT_ALLOWED_USERS is empty. This skill requires at least one Workspace e-mail."
  echo "(Hermes itself denies unknown users and offers them a pairing code, but an explicit allowlist is the policy here.)"
  echo "Nothing was written."
  exit 1
fi
case "$GOOGLE_CHAT_ALLOWED_USERS" in
  *'*'*) echo "ABORT: GOOGLE_CHAT_ALLOWED_USERS contains a wildcard (*). That would let anyone use the bot. Nothing was written."; exit 1 ;;
esac
BAD=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" | tr ',' '\n' | grep -vE "$EMAIL_RE" | cut -c1-60 || true)
if [ -n "$BAD" ]; then
  echo "ABORT: invalid entries in GOOGLE_CHAT_ALLOWED_USERS (expected user@domain.tld e-mails):"
  echo "$BAD"
  echo "Nothing was written."
  exit 1
fi

printf '%s' "$GOOGLE_CHAT_PROJECT_ID" | grep -qE '^[a-z][a-z0-9.:-]{2,60}$' \
  || { echo "ABORT: GOOGLE_CHAT_PROJECT_ID must be a GCP project ID (lowercase letters, digits, hyphens). Nothing was written."; exit 1; }
printf '%s' "$GOOGLE_CHAT_SUBSCRIPTION_NAME" | grep -qE '^projects/[a-z][a-z0-9.:-]{2,60}/subscriptions/[A-Za-z][A-Za-z0-9._~+-]{2,254}$' \
  || { echo "ABORT: GOOGLE_CHAT_SUBSCRIPTION_NAME must be projects/<project>/subscriptions/<subscription> (a TOPIC path will not work: Hermes pulls subscriptions). Nothing was written."; exit 1; }
SUB_PROJECT=$(printf '%s' "$GOOGLE_CHAT_SUBSCRIPTION_NAME" | sed -n 's#^projects/\([^/]*\)/subscriptions/[^/]*$#\1#p')
[ "$SUB_PROJECT" = "$GOOGLE_CHAT_PROJECT_ID" ] \
  || { echo "ABORT: the project in GOOGLE_CHAT_SUBSCRIPTION_NAME ($SUB_PROJECT) does not match GOOGLE_CHAT_PROJECT_ID. Hermes refuses that combination. Nothing was written."; exit 1; }
if [ -n "$GOOGLE_CHAT_HOME_CHANNEL" ]; then
  printf '%s' "$GOOGLE_CHAT_HOME_CHANNEL" | grep -qE '^(spaces|users)/[A-Za-z0-9_-]+$' \
    || { echo "ABORT: GOOGLE_CHAT_HOME_CHANNEL must be spaces/<ID> (or users/<ID>). Nothing was written."; exit 1; }
fi

# The key file is read from YOUR machine and never printed. Shape checks only; Google validates the key itself in Step 3c.
KEY_ERR=""
if [ -z "${SA_KEY_LOCAL_PATH:-}" ] || [ ! -f "$SA_KEY_LOCAL_PATH" ] || [ ! -r "$SA_KEY_LOCAL_PATH" ] || [ ! -s "$SA_KEY_LOCAL_PATH" ]; then
  KEY_ERR="SA_KEY_LOCAL_PATH is not a readable, non-empty file"
else
  KEY_SIZE=$(wc -c < "$SA_KEY_LOCAL_PATH" | tr -d ' ')
  [ "$KEY_SIZE" -le 16384 ] || KEY_ERR="the key file is larger than 16 KiB"
  grep -q '"type" *: *"service_account"' "$SA_KEY_LOCAL_PATH" || KEY_ERR="the file is not a service-account key (\"type\": \"service_account\" missing)"
  grep -q '"client_email" *:' "$SA_KEY_LOCAL_PATH" && grep -q '"private_key" *:' "$SA_KEY_LOCAL_PATH" || KEY_ERR="the key file lacks client_email or private_key"
fi
[ -z "$KEY_ERR" ] || { echo "ABORT: $KEY_ERR. Nothing was written."; exit 1; }
echo "Local checks passed."
```

**3b. Read-only look at the VPS** (open-access switches, a `platforms.google_chat` block that would override
or disable the env settings, whether the Google libraries can be installed on first start, and where the key
file will live). Only names are printed.

```bash
# open_access_names prints NAMES only (never values). Fail-closed: any value other than an explicit false/0/no/off counts as on.
open_access_names() {
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 0; fi
[ -f "$f" ] && [ ! -L "$f" ] && [ -r "$f" ] || exit 1
awk '
  {
    line = $0
    sub(/^[[:space:]]*/, "", line)
    sub(/^export[[:space:]]+/, "", line)
    sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^(GOOGLE_CHAT_ALLOW_ALL_USERS|GATEWAY_ALLOW_ALL_USERS|GATEWAY_ALLOWED_USERS)=/) next
    n = line; sub(/=.*/, "", n)
    v = line; sub(/^[^=]*=/, "", v)
    gsub(/[\"\047[:space:]]/, "", v); v = tolower(v)
    if (n == "GATEWAY_ALLOWED_USERS") {
      m = split(v, parts, ",")
      for (i = 1; i <= m; i++) if (parts[i] == "*") on[n] = 1
    } else if (v != "" && v != "false" && v != "0" && v != "no" && v != "off") on[n] = 1
  }
  END { for (n in on) print n }' "$f"
REMOTE
}
OPEN_NAMES=$(open_access_names) \
  || { echo "ABORT: could not read ~/.hermes/.env on the VPS to check for allow-all switches. Nothing was written."; exit 1; }
if [ -n "$OPEN_NAMES" ]; then
  echo "ABORT: ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)), so users outside the allowlist could use the bot. Remove it (or ask the user to), then re-run. Nothing was written."
  exit 1
fi

# A platforms.google_chat block in config.yaml wins over the env: an explicit enabled:false disables the platform whatever the env says,
# and extra.project_id / subscription_name / service_account_json / http_events_url / allowed_users / allow_from are read BEFORE the env values.
CFG_OUT=$(remote 'hermes -p default config get platforms.google_chat --json 2>&1') && CFG_RC=0 || CFG_RC=$?
if [ "$CFG_RC" != 0 ]; then
  case "$CFG_OUT" in
    *"Config key not set"*) CFG_OUT="" ;;
    *) echo "ABORT: could not read platforms.google_chat from the VPS config. Nothing was written."; exit 1 ;;
  esac
fi
if printf '%s' "$CFG_OUT" | grep -qE '"enabled": *false'; then
  echo "ABORT: platforms.google_chat.enabled is false in config.yaml. An explicit disable beats the env, so nothing would connect. Re-enable it deliberately (hermes -p default config set platforms.google_chat.enabled true), then re-run. Nothing was written."
  exit 1
fi
SHADOW=$(printf '%s' "$CFG_OUT" | grep -oE '"(project_id|subscription_name|service_account_json|http_events_url|allowed_users|allow_from|group_allow_from)"' | tr -d '"' | sort -u | tr '\n' ' ' || true)
if [ -n "$SHADOW" ]; then
  echo "ABORT: platforms.google_chat in config.yaml already sets: $SHADOW. Those keys are read before the env values this skill writes, so the result would not be what you asked for. Remove them (hermes -p default config unset platforms.google_chat.extra.<key>) and re-run. Nothing was written."
  exit 1
fi

# The Google libraries (PM extras google + google-chat) are installed by the gateway on first start; that needs lazy installs to be allowed.
lazy_env_off() {  # exit 0 when ~/.hermes/.env sets HERMES_DISABLE_LAZY_INSTALLS to 1/true/yes
  remote 'bash -s' <<'REMOTE'
f="$HOME/.hermes/.env"
[ -f "$f" ] || exit 1
awk '
  {
    line = $0
    sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); sub(/[[:space:]]*=[[:space:]]*/, "=", line)
    if (line !~ /^HERMES_DISABLE_LAZY_INSTALLS=/) next
    v = line; sub(/^[^=]*=/, "", v); gsub(/[\"\047[:space:]]/, "", v); v = tolower(v)
    if (v == "1" || v == "true" || v == "yes") found = 1
  }
  END { exit !found }' "$f"
REMOTE
}
LAZY=$(remote 'hermes -p default config get security.allow_lazy_installs 2>/dev/null' | tr -d '[:space:]' | tr 'A-Z' 'a-z') || LAZY=""
LAZY_OFF=0
{ [ "$LAZY" = false ] || lazy_env_off; } && LAZY_OFF=1
if [ "$LAZY_OFF" = 1 ] && [ "${GOOGLE_CHAT_DEPS_PREINSTALLED:-0}" != "1" ]; then
  echo "ABORT: lazy installs are off on the VPS (security.allow_lazy_installs / HERMES_DISABLE_LAZY_INSTALLS), so the gateway cannot install the Google libraries (extras google and google-chat) on first start. Install them yourself, then re-run with GOOGLE_CHAT_DEPS_PREINSTALLED=1. Nothing was written."
  exit 1
fi

# Where the key file will live. The name carries a checksum of the key, so a FORCE=1 re-run with a NEW key never overwrites the file the
# previous .env points at (rollback restores .env, so the old key keeps working); the same key reuses the same name.
VPS_HOME=$(remote 'printf %s "$HOME"') || VPS_HOME=""
printf '%s' "$VPS_HOME" | grep -qE '^/[A-Za-z0-9_./-]+$' \
  || { echo "ABORT: could not determine a safe home directory on the VPS. Nothing was written."; exit 1; }
SA_SUM=$(cksum < "$SA_KEY_LOCAL_PATH" | cut -d' ' -f1)
SA_REMOTE="$VPS_HOME/.hermes/google-chat-sa-$SA_SUM.json"
SA_PREEXISTED=$(remote "[ -e '$SA_REMOTE' ] && echo 1 || echo 0")
if [ "$SA_PREEXISTED" = 1 ]; then
  remote "cmp -s - '$SA_REMOTE'" < "$SA_KEY_LOCAL_PATH" \
    || { echo "ABORT: $SA_REMOTE already exists with different content; refusing to overwrite it. Nothing was written."; exit 1; }
fi
echo "VPS look-over passed: no open-access switch, no overriding platforms.google_chat block; key file will be $SA_REMOTE."
```

**3c. Live Google check, run from the VPS.** The VPS signs a short-lived JWT with the service-account key,
exchanges it at Google's token endpoint, and then reads your subscription (`GET .../v1/<subscription>`),
which is the REST form of the `subscriptions.get` that Hermes makes at start (`adapter.py:612-628`). Both
calls are read-only. The key arrives on ssh stdin, the signing key touches the VPS only as a mode-600 temp file
that is removed at once, and the access token is never printed. Needs `openssl` on the VPS.

```bash
gchat_preflight() {  # gchat_preflight SUBSCRIPTION [REMOTE_KEY_FILE]: the key comes on stdin unless a key file on the VPS is named
  { cat <<'REMOTE_SCRIPT'
main() {
  command -v openssl >/dev/null 2>&1 || { echo "ERR no-openssl"; return 3; }
  if [ -n "${SA_FILE:-}" ]; then j=$(cat "$SA_FILE") || { echo "ERR key-file"; return 4; }; else j=$(cat); fi
  email=$(printf '%s' "$j" | sed -n 's/.*"client_email" *: *"\([^"]*\)".*/\1/p' | head -n1)
  uri=$(printf '%s' "$j" | sed -n 's/.*"token_uri" *: *"\([^"]*\)".*/\1/p' | head -n1)
  key=$(printf '%s' "$j" | sed -n 's/.*"private_key" *: *"\([^"]*\)".*/\1/p' | head -n1)
  printf '%s' "$j" | grep -q '"type" *: *"service_account"' || { echo "ERR key-file"; return 4; }
  [ -n "$email" ] && [ -n "$key" ] || { echo "ERR key-file"; return 4; }
  [ "$uri" = "https://oauth2.googleapis.com/token" ] || { echo "ERR token-uri"; return 4; }
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  now=$(date +%s)
  hdr=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
  cl=$(printf '{"iss":"%s","sub":"%s","aud":"%s","scope":"https://www.googleapis.com/auth/pubsub","iat":%s,"exp":%s}' "$email" "$email" "$uri" "$now" "$((now + 3000))" | b64url)
  kf=$(mktemp) || { echo "ERR key-file"; return 4; }
  chmod 600 "$kf"
  printf '%b' "$key" > "$kf"
  sig=$(printf '%s.%s' "$hdr" "$cl" | openssl dgst -sha256 -sign "$kf" | b64url)
  rm -f "$kf"
  [ -n "$sig" ] || { echo "ERR key-file"; return 4; }
  body=$(printf 'url = "%s"\ndata = "grant_type=urn%%3Aietf%%3Aparams%%3Aoauth%%3Agrant-type%%3Ajwt-bearer&assertion=%s.%s.%s"\n' "$uri" "$hdr" "$cl" "$sig" | curl -sS --max-time 15 --config -) || { echo "ERR unreachable"; return 2; }
  tok=$(printf '%s' "$body" | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p' | head -n1)
  if [ -z "$tok" ]; then echo "ERR token:$(printf '%s' "$body" | sed -n 's/.*"error" *: *"\([^"]*\)".*/\1/p' | head -n1)"; return 5; fi
  code=$(printf 'header = "Authorization: Bearer %s"\n' "$tok" | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - "https://pubsub.googleapis.com/v1/$SUB") || { echo "ERR unreachable"; return 2; }
  echo "HTTP $code"
}
main
REMOTE_SCRIPT
    [ -n "${2:-}" ] || cat
  } | remote "SUB='$1' SA_FILE='${2:-}' bash -s"
}
PF=$(gchat_preflight "$GOOGLE_CHAT_SUBSCRIPTION_NAME" < "$SA_KEY_LOCAL_PATH" 2>/dev/null) || true
case "$PF" in
  "HTTP 200") echo "Google accepted the service-account key and the subscription is readable." ;;
  "HTTP 403") echo "ABORT: the key signs in but may not read the subscription. Grant the service account Pub/Sub Subscriber AND Pub/Sub Viewer on the SUBSCRIPTION (Hermes calls subscriptions.get at start). Nothing was written."; exit 1 ;;
  "HTTP 404") echo "ABORT: Google says the subscription does not exist (check the path and that it is a pull subscription in that project). Nothing was written."; exit 1 ;;
  "HTTP "*) echo "ABORT: unexpected answer from Pub/Sub ($PF). Nothing was written."; exit 1 ;;
  "ERR no-openssl") echo "ABORT: openssl is not installed on the VPS, which the live check needs. Nothing was written."; exit 1 ;;
  "ERR key-file") echo "ABORT: the key file is not a usable service-account key (missing client_email or private_key). Nothing was written."; exit 1 ;;
  "ERR token-uri") echo "ABORT: the key's token_uri is not https://oauth2.googleapis.com/token; refusing to send a signed request elsewhere. Nothing was written."; exit 1 ;;
  "ERR token:"*) echo "ABORT: Google rejected the service-account key (${PF#ERR token:}). Typical causes: the key was deleted or disabled, or the VPS clock is wrong. Nothing was written."; exit 1 ;;
  *) echo "ABORT: the VPS could not complete the Google check (${PF:-no answer}); check its outbound HTTPS to oauth2.googleapis.com and pubsub.googleapis.com. Nothing was written."; exit 1 ;;
esac
```

What this proves and what it cannot: the key is valid, the VPS reaches Google, and the service account can
read the subscription. It cannot see whether `chat-api-push@system.gserviceaccount.com` holds Publisher on the
topic (the service account has no right to read the topic's policy), whether the Chat app points at that
topic, or who can see the app. Those are human checks; the symptom of a missing Publisher binding is a
connected bot that never receives anything and a subscription whose backlog stays at zero.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
USERS_N=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" | tr ',' '\n' | grep -c .)
if [ -n "$GOOGLE_CHAT_HOME_CHANNEL" ]; then
  HOME_LINE="Send ONE test message to $GOOGLE_CHAT_HOME_CHANNEL with 'hermes send --to google_chat'"
else
  HOME_LINE="No home-space message (GOOGLE_CHAT_HOME_CHANNEL not set)"
fi
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) local checks, VPS look-over, live Google token plus subscription read. Nothing written yet.
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME (restored automatically if anything below fails)
  2. Upload the service-account key to $SA_REMOTE (mode 600, over ssh stdin); removed again on failure
  3. Write GOOGLE_CHAT_ALLOWED_USERS ($USERS_N e-mail(s)) and GOOGLE_CHAT_HOME_CHANNEL (${GOOGLE_CHAT_HOME_CHANNEL:-none}) via 'hermes -p default config set'
  4. Write GOOGLE_CHAT_SERVICE_ACCOUNT_JSON (the PATH only), GOOGLE_CHAT_PROJECT_ID, then GOOGLE_CHAT_SUBSCRIPTION_NAME LAST; chmod 600 ~/.hermes/.env
  5. Verify the keys landed (counts only) and the key file is mode 600
  6. Reload: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
     (the first start installs the Google libraries and can take a while; the restart is refused when live sessions exist unless GW_INTERRUPT=1 is set)
  7. Verify: gateway log shows google_chat connected, and the stored key file still reads the subscription
  8. $HOME_LINE
  9. Human step afterwards: message the app from an allowlisted account

The service-account key is NEVER printed in plaintext.
EOF
```

Wait for explicit confirmation (or `AUTO_APPROVE=1`). If the user declines: `echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, upload the key, then write (allowlist first, subscription last)

The snapshot covers `.env` and `config.yaml`. The key file is a new file under a checksum-derived name, so
rollback restores `.env` to the old key path and `gc_fail` removes the file this run created (never one that
already existed). Each value travels as ONE line on ssh stdin and is read by `read -r` on the VPS; no value
starts with `-`. `config set` routes UPPER_SNAKE names to `~/.hermes/.env` (`hermes_cli/config.py:3417-3440`).

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state (or an earlier unfinished run left one: run rollback, then re-run). Nothing was written."; exit 1; }

sa_cleanup() { [ "$SA_PREEXISTED" = 1 ] || remote "rm -f '$SA_REMOTE' '$SA_REMOTE.tmp'"; }
gc_fail() {  # gc_fail MESSAGE: restore .env and config.yaml, remove the key file this run created, leave the shell
  echo "$1" >&2
  if rollback; then
    sa_cleanup
  else
    echo "rollback did not complete: the key file $SA_REMOTE stays where it is until the snapshot is restored." >&2
  fi
  exit 1
}

if [ "$SA_PREEXISTED" != 1 ]; then
  remote "umask 077; mkdir -p \"\$HOME/.hermes\" && cat > '$SA_REMOTE.tmp' && chmod 600 '$SA_REMOTE.tmp' && mv -f '$SA_REMOTE.tmp' '$SA_REMOTE'" < "$SA_KEY_LOCAL_PATH" \
    || gc_fail "FAIL: could not upload the service-account key."
fi

# put KEY VALUE: KEY is a fixed name from this skill; VALUE goes over stdin only.
put() {
  printf '%s\n' "$2" \
    | remote "IFS= read -r v && hermes -p default config set $1 \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env"
}

put GOOGLE_CHAT_ALLOWED_USERS "$GOOGLE_CHAT_ALLOWED_USERS" \
  || gc_fail "FAIL: could not write GOOGLE_CHAT_ALLOWED_USERS."
if [ -n "$GOOGLE_CHAT_HOME_CHANNEL" ]; then
  put GOOGLE_CHAT_HOME_CHANNEL "$GOOGLE_CHAT_HOME_CHANNEL" || gc_fail "FAIL: could not write GOOGLE_CHAT_HOME_CHANNEL."
fi
put GOOGLE_CHAT_SERVICE_ACCOUNT_JSON "$SA_REMOTE" \
  || gc_fail "FAIL: could not write GOOGLE_CHAT_SERVICE_ACCOUNT_JSON."
put GOOGLE_CHAT_PROJECT_ID "$GOOGLE_CHAT_PROJECT_ID" \
  || gc_fail "FAIL: could not write GOOGLE_CHAT_PROJECT_ID."
put GOOGLE_CHAT_SUBSCRIPTION_NAME "$GOOGLE_CHAT_SUBSCRIPTION_NAME" \
  || gc_fail "FAIL: could not write GOOGLE_CHAT_SUBSCRIPTION_NAME."
```

Verify the write (counts, the non-secret allowlist and the key path only):

```bash
COUNT=$(remote 'grep -cE "^(GOOGLE_CHAT_PROJECT_ID|GOOGLE_CHAT_SUBSCRIPTION_NAME|GOOGLE_CHAT_SERVICE_ACCOUNT_JSON|GOOGLE_CHAT_ALLOWED_USERS)=." ~/.hermes/.env 2>/dev/null; true')
GOT_USERS=$(remote 'sed -n "s/^GOOGLE_CHAT_ALLOWED_USERS=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
GOT_KEY=$(remote 'sed -n "s/^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
if [ "$COUNT" != "4" ] || [ "$GOT_USERS" != "$GOOGLE_CHAT_ALLOWED_USERS" ] || [ "$GOT_KEY" != "$SA_REMOTE" ]; then
  gc_fail "FAIL: Google Chat settings did not land (key count ${COUNT:-0}, need 4; or the stored allowlist or key path differs). Rolling back."
fi
case "$GOT_USERS" in
  *'*'*) gc_fail "FAIL: the stored allowlist contains a wildcard (*). Rolling back." ;;
esac
MODE=$(remote 'stat -c %a ~/.hermes/.env 2>/dev/null || stat -f %Lp ~/.hermes/.env')
[ "$MODE" = "600" ] || gc_fail "FAIL: ~/.hermes/.env is mode ${MODE:-?}, not 600. Rolling back."
KMODE=$(remote "stat -c %a '$SA_REMOTE' 2>/dev/null || stat -f %Lp '$SA_REMOTE'")
[ "$KMODE" = "600" ] || gc_fail "FAIL: the key file is mode ${KMODE:-?}, not 600. Rolling back."
OPEN_NAMES=$(open_access_names) || OPEN_NAMES="(unreadable .env)"
if [ -n "$OPEN_NAMES" ]; then
  gc_fail "FAIL: after the write, ~/.hermes/.env turns on open access ($(echo $OPEN_NAMES)). Rolling back."
fi
echo "Google Chat settings confirmed in ~/.hermes/.env (mode 600); key file mode 600."
```

---

## Step 6 — reload through the native gateway lifecycle

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a
ready gateway with a new `instance_id`. A refusal because of live sessions is reported, not overridden. The
first start also installs the Google libraries; if that outlasts the readiness window the reload fails, the
run rolls back, and a re-run is quicker once the install has finished. A successful install can also ask for
one more restart ("restart Hermes to activate it"); a second run of this skill (`FORCE=1`) handles that.

```bash
gw_reload >/dev/null || gc_fail "FAIL: gateway did not restart ready. Rolling back."
```

---

## Step 7 — verify the adapter is connected (poll up to 60 s)

Evidence, in order: the gateway log says Google Chat connected (runner: `✓ google_chat connected`; adapter:
`[GoogleChat] Connected; project=..., inbound=pubsub`; failures: `✗ google_chat failed to connect`,
`[GoogleChat] Config validation failed`, `subscription.get failed`, `Pub/Sub stream died`, and the startup
summary `... failed to start and are parked`), and the key file the `.env` points to still signs in and reads
the subscription. The latest status-bearing line wins, so an older success cannot mask a later failure.

```bash
CONNECTED=0
for i in $(seq 1 12); do
  LOG_STATUS=0
  PLATFORM_LOG=$(remote "hermes -p default logs gateway -n 300 2>&1") || LOG_STATUS=$?
  if [ "$LOG_STATUS" = 0 ] && printf '%s\n' "$PLATFORM_LOG" | awk '
    {
      line = tolower($0)
      if (line !~ /google_?chat/) next
      if (line ~ /disconnected|failed to connect|google_chat error|fatal google_chat adapter error|parked|non-retryable|no adapter (available )?for|config validation failed|subscription\.get failed|stream died|reconnect failed|could not be installed|not installed|\(degraded\)/) connected = 0
      else if (line ~ /google_chat connected|\[googlechat\] connected;/) connected = 1
    }
    END { exit !connected }'; then
    CONNECTED=1
    break
  fi
  sleep 5
done
[ "$CONNECTED" = "1" ] || gc_fail "FAIL: Google Chat did not appear as connected in the gateway log within 60s. Rolling back."
echo "OK: gateway log reports Google Chat connected."

STORED_KEY=$(remote 'sed -n "s/^GOOGLE_CHAT_SERVICE_ACCOUNT_JSON=//p" ~/.hermes/.env | tail -n1' | tr -d "\"'\r")
[ "$STORED_KEY" = "$SA_REMOTE" ] || gc_fail "FAIL: the stored key path changed after the reload. Rolling back."
PF2=$(gchat_preflight "$GOOGLE_CHAT_SUBSCRIPTION_NAME" "$SA_REMOTE" 2>/dev/null) || true
[ "$PF2" = "HTTP 200" ] || gc_fail "FAIL: the key file stored on the VPS could not read the subscription (${PF2:-no answer}). Rolling back."
echo "OK: the stored key file still reads the subscription."
```

Optional: the home-space message uses the native `hermes send` (a standalone Chat REST post with the same
service account; the app must already be a member of that space) and posts one message.

```bash
if [ -n "$GOOGLE_CHAT_HOME_CHANNEL" ]; then
  remote 'hermes -p default send --to google_chat "hstack: platform-google-chat setup check (safe to ignore)"' >/dev/null \
    || gc_fail "FAIL: the test message to the Google Chat home space failed (wrong GOOGLE_CHAT_HOME_CHANNEL, or the app is not a member of that space). Rolling back; re-run without GOOGLE_CHAT_HOME_CHANNEL and set it later."
  echo "OK: one test message was sent to the Google Chat home space."
fi
finish || exit 1
echo "Google Chat is configured and the gateway reports it connected. A real message from an allowlisted user is still the only proof of the inbound path."
```

---

## Step 8 — human smoke test and day-2

```bash
FIRST_USER=$(printf '%s' "$GOOGLE_CHAT_ALLOWED_USERS" | cut -d',' -f1)
cat <<EOF
SMOKE TEST — from the allowlisted Workspace account $FIRST_USER:
  1. Open Google Chat, search for the app by the name set in the Chat API Configuration page, and send it a direct message ("hello").
  2. Expect a "thinking" marker and then the reply. The first message after adding the app also lets Hermes learn the bot's own user ID.

If it stays silent, in this order:
  - hermes -p default logs gateway -n 100 on the VPS: look for "[GoogleChat]" lines.
  - In the GCP console, Pub/Sub, the subscription, Metrics: a backlog that stays at zero while you message the bot means Google is not
    publishing, i.e. chat-api-push@system.gserviceaccount.com lacks Pub/Sub Publisher on the TOPIC, or the app's connection points at another topic.
  - A backlog that grows means Hermes is not pulling: check the key and the Subscriber and Viewer grants on the subscription.
  - The app must be visible to that user (publish scope) and the sender's e-mail must be in GOOGLE_CHAT_ALLOWED_USERS exactly.
EOF
```

Add or remove people later without hand-editing: an unknown user who messages the app receives a pairing code,
and you approve it (approval also adds the e-mail to the allowlist; `hermes_cli/pairing.py`, `gateway/pairing.py:62-160`).

```bash
remote 'hermes -p default pairing list'
# approve a code the user was shown:  remote 'hermes -p default pairing approve google_chat <CODE>'
```

---

## Rollback

Defined once, in Step 0. It runs automatically (`rollback; exit 1`, or `gc_fail` in Steps 5-7) on every failure after `snapshot`.
It does not delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/platform-google-chat/` (a file that did
  not exist before is removed, so a first run leaves nothing behind; a `FORCE=1` re-run gets its previous working values back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `platform-google-chat.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.
- the key file this run uploaded is removed (`gc_fail`), but only after the restore succeeded and only if it did not exist before. If the rollback itself
  could not complete (gateway not ready), the file stays so the recovery point and its files remain consistent; delete it by hand once no `.env` references it.

Failures before `snapshot` (Steps 1-3, a declined dry run) wrote nothing. If a run is interrupted after `snapshot` (crash, Ctrl-C),
the snapshot dir is left in place and the next `snapshot` refuses to run; call `rollback` first. A key file left behind by such a crash
is `~/.hermes/google-chat-sa-<checksum>.json`; delete it by hand if no `.env` references it.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The previous key file (if any) was never touched, so the restored `.env` works again; the newer key file stays on the VPS, unreferenced,
until you delete it. The `.prev` folder holds the previous `.env` at mode 600; delete it once you no longer need the undo.

To remove Google Chat entirely (destructive, only if the user asks), then reload with `gw_reload`:

```bash
for k in GOOGLE_CHAT_SUBSCRIPTION_NAME GOOGLE_CHAT_PROJECT_ID GOOGLE_CHAT_SERVICE_ACCOUNT_JSON GOOGLE_CHAT_ALLOWED_USERS GOOGLE_CHAT_HOME_CHANNEL; do
  remote "hermes -p default config unset $k >/dev/null 2>&1 || true"
done
gw_reload
```

Then delete the key file on the VPS and delete or disable the key in GCP (IAM, Service Accounts, Keys) so the exposed secret is dead.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Looking for a `GOOGLE_CHAT_ENABLED` switch | It does not exist in v0.22.5: project plus subscription in the env enable the platform, and only `platforms.google_chat.enabled: false` blocks it | Step 3b refuses over an explicit disable; the skill never writes `GOOGLE_CHAT_ENABLED` |
| 2 | `GOOGLE_CHAT_ALLOW_ALL_USERS`, `GATEWAY_ALLOW_ALL_USERS` or a `*` in an allowlist | Everyone the app is visible to can drive the bot | Step 3 refuses before any write and Step 5 re-checks after it (names only) |
| 3 | A TOPIC path in `GOOGLE_CHAT_SUBSCRIPTION_NAME`, or a project that differs from `GOOGLE_CHAT_PROJECT_ID` | Hermes pulls subscriptions and rejects a project mismatch (`adapter.py:477-502`) | Step 3a validates the shape and the project match |
| 4 | `chat-api-push@system.gserviceaccount.com` lacks Publisher on the topic | The bot connects but never receives anything; the subscription backlog stays at zero | Human check; this skill cannot read the topic policy (Step 3c explains, Step 8 gives the symptom) |
| 5 | The service account lacks Subscriber or Viewer on the SUBSCRIPTION | Step 3c returns 403; at runtime the adapter stops with `subscription_permission` | Grant both roles on the subscription, not project-wide |
| 6 | Chat app visibility or Configuration page not set (connection = Cloud Pub/Sub with the topic) | Allowlisted users cannot find the app, or Google publishes to nothing | Human step; Gmail-only accounts cannot host Chat apps |
| 7 | HTTP callback mode (`GOOGLE_CHAT_HTTP_EVENTS_URL`) | It needs public ingress through the api_server platform and more settings | Out of scope; this skill sets up Pub/Sub pull only |
| 8 | Inline JSON, or the key file readable by others | The key is a long-lived secret | The skill stores a PATH to a mode-600 file and never writes the key to `.env` or `config.yaml` |
| 9 | `GOOGLE_APPLICATION_CREDENTIALS` also set | `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` is read first (`adapter.py:1619-1630`) so it wins, but a different account in the other variable confuses humans | Keep them equal or unset the other |
| 10 | Pub/Sub client (extra `google-chat`) not installed | First start installs it via PM; lazy installs off or no package-index access means `missing_deps` | Step 3b refuses when lazy installs are off; the log shows `could not be installed` or `not installed` |
| 11 | First start slower than the readiness window | The install runs inside startup, so `gw_reload` can fail and roll back | Re-run: the install has finished, so the second start is fast |
| 12 | A `platforms.google_chat.extra.*` block in `config.yaml` | `extra` project, subscription, key and allowlists are read before the env values | Step 3b aborts and names the keys |
| 13 | `echo >> .env`, or the key in `config.yaml`, an ssh argument or a URL | Merge risk and leaks into `ps` / git | `config set` over stdin; the key is streamed with `cat >` into a mode-600 file |
| 14 | Replies over 4000 characters, one session per thread | Long answers are split into several messages; memory does not cross threads | Platform behavior (`adapter.py` `_MAX_TEXT_LENGTH`), not a fault |
| 15 | Native file attachments | They need a per-user OAuth step (each user sends the bot its `setup-files` chat command in their DM) that this skill does not set up | Optional, human, see the upstream guide |
| 16 | The signing key sits in a temp file for a moment during the Step 3c check | Anyone who can read the VPS as root could read it | `mktemp` creates it at mode 600 and it is removed right after signing |
| 17 | A crashed earlier run left `~/.hermes/.hstack-backup/platform-google-chat/` behind | `snapshot` refuses so a half-written state is never captured as known-good | Run `rollback`, then re-run |
| 18 | `hermes config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` there at that moment sees it (the values here are not secrets; the local ssh argv stays clean) | Accepted; the write output is discarded |
| 19 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later | Re-run the Step 0 block first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes `0.22.5` verified on the VPS host
- [ ] Idempotency scan ran (stored setup safe, or `FORCE=1`), and an unsafe stored setup aborted
- [ ] HARD GATE passed with nothing written: e-mail-only allowlist (no `*`), valid project and subscription (same project), a service-account key of the right shape, no open-access switch, no overriding or disabling `platforms.google_chat` block, lazy installs allowed (or `GOOGLE_CHAT_DEPS_PREINSTALLED=1`)
- [ ] The live check from the VPS succeeded BEFORE the snapshot: Google token issued and `subscriptions.get` returned 200
- [ ] Dry run shown to the user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken immediately before the first write; key file uploaded at mode 600 under a new name; allowlist written before the subscription; `.env` mode 600; no key material in `.env` or `config.yaml`
- [ ] Gateway reloaded with `gw_reload` (ready, new instance)
- [ ] Gateway log reports `google_chat connected`; the stored key file still reads the subscription; `finish` ran
- [ ] If `GOOGLE_CHAT_HOME_CHANNEL` was set, `hermes send --to google_chat` delivered one test message
- [ ] Any failure after the snapshot restored the prior `.env` and `config.yaml` and removed only the key file this run created
- [ ] Human, outside this skill: topic Publisher binding, Chat app Configuration and visibility, and an allowlisted user got a reply

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repo root.

- Env names and enablement: `plugins/platforms/google_chat/plugin.yaml` (`requires_env`, `optional_env`); in `plugins/platforms/google_chat/adapter.py`: `_validate_config`, `_env_inbound_*`, `_check_for_registry`, `_is_connected`, `_env_enablement` `:1581-1630`, and `register` `:1774-1812` (`cron_deliver_env_var="GOOGLE_CHAT_HOME_CHANNEL"` `:1790`, `allowed_users_env="GOOGLE_CHAT_ALLOWED_USERS"` `:1792`, `allow_all_env="GOOGLE_CHAT_ALLOW_ALL_USERS"` `:1793`). No `GOOGLE_CHAT_ENABLED` anywhere. Enablement pass: `gateway/config_env.py:164-225,286-297`; explicit disable `gateway/config_env.py:192-194`; activation evidence by the `GOOGLE_CHAT_` prefix `gateway/platform_activation.py:124-131`. `extra` wins over env: `plugins/platforms/google_chat/adapter.py:477-502`.
- Credentials (`plugins/platforms/google_chat/adapter.py`): `_load_sa_credentials_from` `:257-292` (path or inline JSON, `_SACredentialError` kinds), scopes `:143`, `_load_sa_credentials` `:457-475`; seeded from `GOOGLE_CHAT_SERVICE_ACCOUNT_JSON` then `GOOGLE_APPLICATION_CREDENTIALS` `:1619-1630`.
- Inbound and logs (`plugins/platforms/google_chat/adapter.py`): pull vs HTTP `:477-502`; `_check_subscription` `:612-628` (NotFound / PermissionDenied fatal); `connect` and the `"[GoogleChat] Connected; project=..."` line `:630-676`; supervisor `:699-740`. HTTP events are served by the api_server platform: `gateway/platforms/api_server.py:1544`. Runner lines `gateway/run_startup.py:1335,1352,1355`, startup summaries `gateway/run_startup.py:1440-1470`, `gateway/run_adapters.py:375-376`; `hermes logs gateway` includes the `gateway.*` loggers (`hermes_logging.py:306-311`).
- Dependencies: `ensure_google_chat_deps` in `plugins/platforms/google_chat/adapter.py:194-215` (extras `google` and `google-chat`), `pm/extras.py:188-250`, `pm/install.py:164-189`, default `hermes_cli/config_defaults.py:1811`, `pyproject.toml:360-368` (`google-chat` extra) and `:503-534` (`[all]` has `google`, not `google-chat`).
- Authorization: sender e-mail is the user ID `plugins/platforms/google_chat/adapter.py:992`; `gateway/authz_mixin.py:86-87` (`*` and exact match), `gateway/authz_mixin.py:631-714` (allow-all, pairing store, default deny), `gateway/authz_mixin.py:751-757` (pairing DMs; Google Chat does not declare `allowlist_suppresses_pairing`); pairing CLI `hermes_cli/pairing.py`, `gateway/pairing.py:62-160`.
- `config set/get/unset`: `hermes_cli/config.py:3417-3440` (env routing, value not echoed), `hermes_cli/config.py:3536-3581` (`get`, `--json`, "Config key not set"), `hermes_cli/config.py:3589-3640` (`unset`). `hermes send`: `hermes_cli/send_cmd.py:194-240`; home channel `tools/send_message_tool.py:208-255,400-413`; standalone sender `plugins/platforms/google_chat/adapter.py:1714-1771` (target must match `spaces/<id>` or `users/<id>`, `:1695`).
- Upstream setup guide (IAM roles and Configuration page): `website/docs/user-guide/messaging/google_chat.md:37-176`.

**Not verified:** nothing was run against a real Hermes, GCP project, Workspace or Chat client. The Google check is the standard service-account JWT-bearer grant (RS256, scope `https://www.googleapis.com/auth/pubsub`) plus a `GET` of the subscription resource, the REST form of what Hermes does through the client library; it is public Google API behavior, not Hermes source, and it was never sent to Google (the offline test verifies the JWT's signature and claims against a locally generated key). Behaviour of every `hermes` command in the offline tests is a stub written from the source's output strings (the argparse syntax is real). The Publisher binding for `chat-api-push`, the Chat app Configuration and visibility, and message delivery are human steps that this skill cannot check from the VPS. The `hermes pm install` route exists but is not called because the offline parser harness does not cover it.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway failure modes.
