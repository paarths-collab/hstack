---
name: hermes-model
description: Configure the Hermes model and provider with an API key over SSH on Hermes v0.22.5, reload the gateway natively, and prove it with an exact-reply inference test that rolls back on failure. Use when setting up or changing which LLM a remote, self-hosted Hermes uses. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-model — configure provider + model on a remote Hermes (SSH-first)

You are the engineer configuring the LLM provider and model for a self-hosted Hermes
agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. The bash blocks in this skill run on
YOUR machine (possibly macOS, bash 3.2) and reach the VPS through the `remote` helper.

Do everything autonomously; stop only for the one thing a machine cannot do: mint the
provider API key in the provider's dashboard.

**Native surface (Hermes v0.22.5, source-verified, not run live).** For attended setup, prefer `hermes -p default model`
(interactive picker) or `hermes -p default setup model`; `setup --portal` is an OAuth login and must not be started in a
noninteractive SSH session. This skill keeps a bounded BYOK path for OpenRouter, Anthropic, OpenAI and DeepSeek:

1. the key is written to `~/.hermes/.env` over ssh stdin with `hermes config set` (never argv, never `config.yaml`);
2. the provider and model are written with `hermes config set model.provider` / `model.default`. Native provider switching
   clears the previous provider's stale route (`model.base_url`, `model.api_mode`); do not bypass it with a hand-written YAML edit;
3. the gateway is reloaded ONCE with `gw_reload` (native `gateway restart --detach`, then `gateway ensure --json` until ready);
4. the result is read back with `config get` and proven with `hermes -p default -z '...'`, whose reply must be exactly `OK`.

Inference and auxiliary tool capabilities are verified separately: one provider key does not prove vision, browser,
compression or web access.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MODEL_PROVIDER` | `openrouter` \| `anthropic` \| `openai` \| `deepseek` (default `openrouter`) | User choice |
| `$MODEL_API_KEY` | API key for that provider; written as `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` (`sk-or-...` OpenRouter, `sk-ant-...` Anthropic). Legacy: `$OPENROUTER_API_KEY` is still accepted for `openrouter`. | <https://openrouter.ai/keys> (or the provider's dashboard) |
| `$HERMES_MODEL` | Exact model id for that provider — no default, ask the user. Documented forms: vendor-prefixed on OpenRouter (`anthropic/claude-sonnet-4`), bare on Anthropic (`claude-sonnet-4-6`). OpenAI / DeepSeek ids: copy from the provider catalogue (not verified here). Choose a model suitable for the task and available on the selected provider. Hermes also supports native local models; this bounded BYOK recipe does not configure that runtime. | Provider model catalogue |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers and input validation (define before anything can fail)

Run every block of this skill in ONE shell session: later steps call these functions. If
your harness starts a fresh shell per command, re-run this block first. It makes no
remote call until `validate_inputs` has passed.

```bash
SKILL_NAME=hermes-model

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

# validate_inputs: allowlist the provider, check the key and model-id formats, and derive
# the fixed env-var name and provider id. Nothing unexpected is ever sent to the VPS.
validate_inputs() {
  MODEL_PROVIDER="${MODEL_PROVIDER:-openrouter}"
  MODEL_API_KEY="${MODEL_API_KEY:-${OPENROUTER_API_KEY:-}}"
  case "$MODEL_PROVIDER" in
    openrouter) MODEL_KEYVAR=OPENROUTER_API_KEY; PROVIDER_ID=openrouter; KEY_RE='^sk-or-[A-Za-z0-9._~+/=-]{8,}$' ;;
    anthropic)  MODEL_KEYVAR=ANTHROPIC_API_KEY;  PROVIDER_ID=anthropic;  KEY_RE='^sk-ant-[A-Za-z0-9._~+/=-]{8,}$' ;;
    openai)     MODEL_KEYVAR=OPENAI_API_KEY;     PROVIDER_ID=openai-api; KEY_RE='^[A-Za-z0-9._~+/=-]{16,255}$' ;;
    deepseek)   MODEL_KEYVAR=DEEPSEEK_API_KEY;   PROVIDER_ID=deepseek;   KEY_RE='^[A-Za-z0-9._~+/=-]{16,255}$' ;;
    *) echo "ABORT: MODEL_PROVIDER must be openrouter|anthropic|openai|deepseek. Nothing was written."; return 1 ;;
  esac
  [[ "$MODEL_API_KEY" =~ $KEY_RE ]] \
    || { echo "ABORT: MODEL_API_KEY does not look like a $MODEL_PROVIDER key. Nothing was written."; return 1; }
  # A Claude Code OAuth token (sk-ant-oat...) is not an API key: Hermes sends ANTHROPIC_API_KEY as x-api-key, which rejects it (hermes_cli/auth.py:208-213).
  case "$MODEL_PROVIDER:$MODEL_API_KEY" in
    anthropic:sk-ant-oat*) echo "ABORT: that is a Claude Code OAuth token (sk-ant-oat...), not an Anthropic API key; create an API key in the Anthropic Console. Nothing was written."; return 1 ;;
  esac
  [[ "$HERMES_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$ ]] \
    || { echo "ABORT: HERMES_MODEL is empty or has unexpected characters. Nothing was written."; return 1; }
  [[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
    || { echo "ABORT: VPS_IP / VPS_USER look malformed. Nothing was written."; return 1; }
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

validate_inputs || exit 1
```

Rules for calling them: failures **before** `snapshot` (Steps 1-4 up to the snapshot, the
user declining the dry run) just `exit 1` with "Nothing was written" — they do not call
`rollback`. Every failure **after** `snapshot` does `rollback; exit 1`. `finish` runs after
the last check. `rollback` RESTORES the pre-skill `.env` and `config.yaml`; it never just deletes keys.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.

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
  multiplex mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml and MCP changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  `gateway run` is the foreground command.
  There is no `--daemon` flag.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: Hermes is not installed for the host account"; exit 1; }
  [ ! -e /.dockerenv ] && [ ! -e /run/.containerenv ] || { echo "FAIL: this recipe requires the host installation owner"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the host account (a container-only install is not supported here). Run /hermes-install first. Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was written."; exit 1; }
printf '%s\n' "$HERMES_BANNER"
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The procedure is checked against the
v0.22.5 source; it has not been run against a live host, and a version banner is not evidence that provider inference works.

Also confirm we are on the host, not a container — keys added inside a container are
invisible to the host's sshd, and `~/.hermes/.env` on a container is ephemeral:

```bash
remote "whoami; hostname"
# Expect: root@<readable-name>. If hostname is a 12-char hex string, you're inside a
# container — exit out before continuing.
```

---

## Step 2 — idempotency check (skip if already configured to this model)

`config get KEY` prints the resolved value and exits 1 with `Config key not set: KEY` when nothing is stored
(`hermes_cli/config.py:3536-3581`), so the comparison is exact: a longer id that merely contains the requested one does not count.

```bash
HAS_KEY=$(remote "grep -c '^$MODEL_KEYVAR=' ~/.hermes/.env 2>/dev/null || true")
CUR_MODEL=$(remote 'hermes -p default config get model.default 2>/dev/null' || true)
CUR_PROVIDER=$(remote 'hermes -p default config get model.provider 2>/dev/null' || true)
if [ "${HAS_KEY:-0}" -gt 0 ] \
   && [ "$CUR_MODEL" = "$HERMES_MODEL" ] \
   && [ "$CUR_PROVIDER" = "$PROVIDER_ID" ] \
   && [ "${FORCE:-0}" != "1" ]; then
  echo "Model already set to $HERMES_MODEL ($PROVIDER_ID) and key present. Set FORCE=1 to reconfigure."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) local input validation. No side-effect-free vendor endpoint is used before writing; the live check is step 7
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write $MODEL_KEYVAR (length ${#MODEL_API_KEY}, prefix ${MODEL_API_KEY:0:4}...) via 'hermes -p default config set' over ssh stdin, chmod 600
  3. Set model.provider $PROVIDER_ID and model.default $HERMES_MODEL via 'hermes -p default config set'
  4. Reload gateway ONCE: hermes -p default gateway restart --detach, then gateway ensure --json --timeout 60 until ready with a new instance
  5. Read back: hermes -p default config get model.default and model.provider (must equal what was set)
  6. Smoke test: hermes -p default -z 'reply with the single word OK' (one tiny provider request) -> the reply must be exactly OK
  7. Report which capabilities were NOT verified (vision, browser, compression, web, messaging delivery)
  Any failure after step 1 restores the snapshot and reloads the gateway.

The API key is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`). Declining: `echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

HARD GATE: the format check in `validate_inputs` already passed. This skill documents no
side-effect-free vendor endpoint, so there is **no live pre-write check** here — the live
check is Step 8's inference smoke test, which rolls back on a rejected key AND on an
inconclusive result (fail closed).

`config set` sends an UPPER_SNAKE name to `~/.hermes/.env` (credential-shaped names such as `*_API_KEY` through the credential
lifecycle that also rotates any `config.yaml` mirror of the old key) and never echoes the value
(`hermes_cli/config.py:3416-3438`, `:871-881`). Its output is discarded anyway.

The key travels over ssh **stdin** (never argv, a URL, or a quoted remote string):

```bash
snapshot || { echo "ABORT: could not snapshot ~/.hermes state. Nothing was written."; exit 1; }

printf '%s\n' "$MODEL_API_KEY" \
  | remote "IFS= read -r v && hermes -p default config set $MODEL_KEYVAR \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env" \
  || { echo "FAIL: could not write $MODEL_KEYVAR."; rollback; exit 1; }
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(remote "grep -c '^$MODEL_KEYVAR=' ~/.hermes/.env || true")
[ "${WROTE:-0}" = "1" ] || { echo "FAIL: $MODEL_KEYVAR not written. Rolling back."; rollback; exit 1; }
```

---

## Step 5 — apply model + provider config through the native writer

There is no MCP server to register here — this is a Hermes core config change. The model id and provider id are not
secrets; they were validated in Step 0 and are passed as an explicit env prefix (the heredoc is quoted, so nothing expands
locally). `config set` writes dotted names (`model.provider`, `model.default`) to `config.yaml` and, when the provider changes,
clears the previous provider's `model.base_url` / `model.api_mode` so the new key is never posted to the old endpoint
(`hermes_cli/config.py:3398`, `:3480-3498`). Provider first, then model.

```bash
apply_model() {
  remote "MODEL_ID=$(printf %q "$HERMES_MODEL") PROVIDER_ID=$(printf %q "$PROVIDER_ID") bash -s" <<'REMOTE'
set -e
hermes -p default config set model.provider "$PROVIDER_ID"
hermes -p default config set model.default "$MODEL_ID"
REMOTE
}
apply_model || { echo "FAIL: could not apply model config."; rollback; exit 1; }
```

A native refusal is a compatibility or configuration error: the skill rolls back and stops. It never falls back to editing
`config.yaml` by hand (that would bypass the schema, route and secret handling). Prompt caching and other features are configured
separately, only when the selected provider/model supports them; this skill does not rerun the setup wizard.

Never put the API key in `config.yaml` — it goes only in `~/.hermes/.env`. Never run `hermes -p default setup --portal` in a
headless session; it is an interactive OAuth login and hangs over SSH.

---

## Step 6 — reload the gateway (once)

`gw_reload` (Step 0) restarts the default-profile gateway and returns only when `gateway ensure` reports a ready gateway with a new
`instance_id`. A refusal because of live sessions is reported with the `GW_INTERRUPT=1` hint, not overridden. `-z` in Step 8 goes
through this gateway, so it is reloaded before the inference test, not after it.

```bash
gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
```

---

## Step 7 — verify the stored model natively (`config get`)

Readiness of the gateway is already proven by `gw_reload`. This step proves the stored provider and model are exactly what was
requested, using the same resolver Hermes uses (`hermes_cli/config.py:3536-3581`). It replaces scraping the log for the model name,
which is not a documented contract.

```bash
GOT_MODEL=$(remote 'hermes -p default config get model.default') \
  && GOT_PROVIDER=$(remote 'hermes -p default config get model.provider') \
  || { echo "FAIL: could not read back the model config (config get failed). Rolling back."; rollback; exit 1; }
if [ "$GOT_MODEL" != "$HERMES_MODEL" ] || [ "$GOT_PROVIDER" != "$PROVIDER_ID" ]; then
  echo "FAIL: stored model/provider differ from what was set (model.default=$GOT_MODEL model.provider=$GOT_PROVIDER). Rolling back."
  rollback; exit 1
fi
echo "OK: model.default=$GOT_MODEL model.provider=$GOT_PROVIDER"
```

---

## Step 8 — live LLM smoke test (successful command and exact reply)

`hermes -z PROMPT` is one-shot mode: it prints ONLY the final response text on stdout (no banner, spinner or session line) and
auto-bypasses approvals, so it can never hang on a prompt (`hermes_cli/_parser.py:148-153`; on the gateway path the session is created
unattended, `hermes_cli/gateway_chat.py:235`, `hermes_cli/gateway_chat_view.py:52`, `:307`). At v0.22.5 it does not run an agent in
the calling process: it attaches to this profile's gateway, starting one if none is ready, and creates a session there
(`hermes_cli/main.py:3022-3029`, `hermes_cli/gateway_chat_startup.py:33-48`, `hermes_cli/gateway_client.py:262-299`) — which is why
Step 6 reloads first. Its exit code is 0 only for a completed turn, 2 for a failed or partial one, 1 when no text came back and 130 on
interrupt (`hermes_cli/oneshot.py:92-107`; the gateway path applies the same rule, `hermes_cli/gateway_chat_view.py:543-544`). A
diagnostic can echo the prompt (including `OK`), so only exit 0 AND a stdout of exactly `OK` counts.

```bash
HTTP=$(remote 'bash -s' <<'REMOTE'
# A diagnostic can echo the prompt (including OK); only a successful (exit 0), exact reply counts.
rc=0
out=$(hermes -p default -z 'reply with the single word OK' 2>&1) || rc=$?
if printf '%s' "$out" | grep -qiE 'unauthor|invalid.*key|401'; then echo 401
elif printf '%s' "$out" | grep -qiE 'forbidden|quota|billing|403'; then echo 403
elif [ "$rc" = 0 ] && [ "$(printf '%s' "$out" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d')" = OK ]; then echo 200
else echo 599; fi
REMOTE
)
case "$HTTP" in
  200) echo "OK: model $HERMES_MODEL responded." ;;
  401) echo "FAIL: API key rejected. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: key valid but no quota/scope (billing-mode trap?). Check provider dashboard, then re-run."; rollback; exit 1 ;;
  *)   echo "FAIL: could not confirm the key works (the inference test returned no recognisable reply: $HTTP). Rolling back; re-run when the network/provider is reachable."; rollback; exit 1 ;;
esac
```

### Capability check (the #1 silent-failure gotcha)

After the smoke test succeeds, report exactly what was verified. Provider-key presence
is not a capability test. Use `hermes -p default tools` / provider setup when a user wants
auxiliary features, then test the relevant operation separately.

```bash
echo "Verified: configured provider/model completed inference."
echo "Unverified: auxiliary tools and messaging delivery require their own checks."
finish || exit 1
```

---

## Rollback (auto-runs on any failure above)

`rollback()` is defined once, in **Step 0**, and is called as `rollback; exit 1` from every failure after the snapshot. It does not
delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from `~/.hermes/.hstack-backup/hermes-model/` (a file that did not exist
  before is removed, so a first-time run leaves nothing behind; a `FORCE=1` re-run gets its previous working key and model back);
- `.env` is set to `chmod 600`;
- the gateway is reloaded with `gw_reload` (restart, then `gateway ensure --json` must report `ready` with a new instance), and only
  then does the snapshot move to `hermes-model.prev`. If the gateway does not come back ready, `rollback` prints
  `files restored, but the gateway did NOT come back`, keeps the snapshot and exits non-zero: look at
  `hermes -p default gateway status` and `hermes -p default logs gateway`, fix the fault, and run `rollback` again. A restart refused
  because of live sessions is the same case: retry with `GW_INTERRUPT=1` only if interrupting them is acceptable.

Failures before `snapshot` (input validation, version gate, declined dry run) wrote nothing, so there is nothing to roll back. If a run
is interrupted after `snapshot`, the next `snapshot` refuses to run; call `rollback` first.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0 functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

The `.prev` folder holds the previous `.env` (including the old key) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | OAuth wizard in a noninteractive SSH session | `setup --portal` and `hermes model` need a human | Use `hermes model` attended, or the bounded BYOK path here |
| 2 | Assuming local models are unsupported | Current Hermes has managed local models | Use native `hermes -p default model` for local runtime configuration |
| 3 | Inferring auxiliary capability from one key | Tool Gateway and provider features have separate configuration | Test the actual requested operation |
| 4 | Manual YAML edit after a native refusal | It bypasses schema, endpoint and route cleanup (a stale `model.base_url` sends the new key to the old endpoint) | The skill rolls back; inspect the native `config set` error |
| 5 | Misreporting key persistence as inference | Config writes do not test a provider request | Require exit 0 AND an exact `OK` from `-z` |
| 6 | Sending a key through SSH argv | Process listings and logs can expose it | Stdin transport; `config set` output discarded |
| 7 | Running `-z` before the gateway is ready | At v0.22.5 `-z` goes through the gateway and starts one if none is ready, so it can exercise a stale or half-started instance | Step 6 (`gw_reload`) comes before Step 8 |
| 8 | Stopping a shared host gateway casually | Multiple profiles can share one gateway | Exclusive-default scope; a live-session refusal is reported, `GW_INTERRUPT=1` is the deliberate override |
| 9 | Printing `config show` | Prints the whole config; custom keys can hold secrets | Single-key `config get` (credential-shaped values are masked unless `--raw`) |
| 10 | Treating an offline stub as real compatibility | The stub models assumed behavior | Keep source citations and live target evidence separate |
| 11 | Using a Claude Code OAuth token (`sk-ant-oat...`) as `ANTHROPIC_API_KEY` | It is not an API key and is rejected as `x-api-key` | `validate_inputs` refuses it; create a Console API key |
| 12 | Substring checks for "already set" | `anthropic/claude-sonnet-4` is inside `anthropic/claude-sonnet-4-5` | Step 2 compares `config get` output exactly |
| 13 | `provider` and `model` that do not belong together | The key is valid but the provider has no such model: `-z` fails, rollback runs | Take the model id from the provider catalogue; vendor-prefixed on OpenRouter, bare on Anthropic |
| 14 | Re-running after a crashed run | A leftover `~/.hermes/.hstack-backup/hermes-model` means that run wrote something | `snapshot` refuses; run `rollback` first, then re-run |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Inputs validated locally (`validate_inputs`): provider allowlist, key format (OAuth token refused for Anthropic), model id
- [ ] Hermes version banner names 0.22.5 on the host (ABORT otherwise)
- [ ] Host vs container confirmed (`whoami; hostname` shows host, not hex container id)
- [ ] Idempotency check passed (exact `config get` comparison, or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; `rollback` (Step 0) restores rather than deletes
- [ ] The provider's key (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`) in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Provider + model set through native `config set`; no manual YAML fallback; no setup wizard run
- [ ] Gateway reloaded exactly once with `gw_reload` (ready, new instance); never `stop`, `gateway run` or a foreground command
- [ ] `config get model.default` / `model.provider` read back exactly what was set
- [ ] Smoke test: `hermes -p default -z 'reply with the single word OK'` exited 0 and printed exactly `OK`; a 401, 403 or inconclusive result rolled back
- [ ] Auxiliary capabilities reported unverified until tested individually
- [ ] `finish` called; re-run with `FORCE=1` reconfigures cleanly

---

## Verified against Hermes v0.22.5

Read in the v0.22.5 source (tag `v0.22.5`, commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to the repository root.

| Claim used by this skill | Source |
|---|---|
| `config set KEY VALUE [--force]`; an UPPER_SNAKE name goes to `~/.hermes/.env` (credential-shaped names via the credential lifecycle), never `config.yaml`; the key value is not echoed | `hermes_cli/subcommands/config.py:27-34`, `hermes_cli/config.py:871-881`, `:3398`, `:3416-3438` |
| Dotted names (`model.provider`, `model.default`) go to `config.yaml`; a provider change drops the old provider's `model.base_url` / `api_mode` | `hermes_cli/config.py:3466-3498` |
| `config get KEY` prints the resolved value; unset key exits 1 with `Config key not set: KEY`; credential values are masked unless `--raw` | `hermes_cli/subcommands/config.py:20-25`, `hermes_cli/config.py:3536-3581` |
| Provider ids and key variables: `openai-api` / `OPENAI_API_KEY`, `anthropic` / `ANTHROPIC_API_KEY`, `deepseek` / `DEEPSEEK_API_KEY`; `openrouter` is resolved specially with `OPENROUTER_API_KEY` and the only declared key prefix `sk-or-` | `hermes_cli/auth.py:178`, `:214`, `:222`, `:323`, `:1522`, `:1653`; `hermes_cli/providers.py:34`, `:55` |
| `sk-ant-oat...` is a Claude Code OAuth token, not usable as an API key; only `ANTHROPIC_API_KEY` / `ANTHROPIC_TOKEN` are literal API keys | `hermes_cli/auth.py:208-213` |
| `-z PROMPT`: stdout is only the final reply; approvals auto-bypassed (unattended session) | `hermes_cli/_parser.py:148-153`, `hermes_cli/gateway_chat.py:235`, `hermes_cli/gateway_chat_view.py:52`, `:307` |
| `-z` attaches to (and if needed starts) the profile gateway and creates the session there | `hermes_cli/main.py:3022-3029`, `hermes_cli/gateway_chat_startup.py:33-48`, `hermes_cli/gateway_chat.py:162-170`, `:336-390`, `hermes_cli/gateway_client.py:262-299` |
| `-z` exit codes: 0 completed, 2 failed/partial, 1 no text, 130 interrupted | `hermes_cli/oneshot.py:92-107`, `hermes_cli/gateway_chat_view.py:543-544` |
| `setup --portal` is an OAuth login; `hermes model` is an interactive picker | `hermes_cli/subcommands/setup.py:34-37`, `hermes_cli/subcommands/model.py:11-13` |
| Gateway restart / ensure / instance semantics | the "Gateway lifecycle" list in Step 0 |

Every `hermes ...` invocation in this file is also checked by `tests/skills/static.test.mjs` against the vendored v0.22.5 argparse
builders (syntax only).

**Unverified.** Nothing here was run against a real Hermes host or a real provider: the provider endpoint, the key's quota, whether the
chosen model id exists for the key, and the wording of runtime error text (the 401/403 classification in Step 8 is a text heuristic that
fails closed to "could not confirm", never to success) are assumptions. The behaviour of the offline stub is written down in
`tests/skills/stubs/hermes`; it is not evidence about the real CLI.

See [docs/reference/TROUBLESHOOTING.md](../../docs/reference/TROUBLESHOOTING.md) for gateway and provider failure modes.
