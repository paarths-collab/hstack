---
name: hermes-model
description: Configure the Hermes model and provider with an API key over SSH, validate context window, and detect silent capability degradation. Use when setting up or changing which LLM a remote, self-hosted Hermes uses. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-model — configure provider + model on a remote Hermes (SSH-first)

You are the engineer configuring the LLM provider and model for a self-hosted Hermes
agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. The bash blocks in this skill run on
YOUR machine (possibly macOS, bash 3.2) and reach the VPS through the `remote` helper.

Do everything autonomously; stop only for the one thing a machine cannot do: mint the
provider API key in the provider's dashboard.

**Current native surface (v0.22.5 candidate, checked against tagged source).** For
attended setup, prefer `hermes -p default model` or `hermes -p default setup --portal`. Do not start an
OAuth wizard in a noninteractive SSH session. This skill keeps a bounded BYOK path
for OpenRouter, Anthropic, OpenAI and DeepSeek, writes credentials over stdin, and
uses native `config set` for provider/model state. Native provider switching clears
stale route settings; do not bypass it with an awk rewrite of YAML. Inference and
auxiliary tool capabilities must be verified separately; the presence of one
provider key does not prove vision, browser, compression or web access.

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
# fails puts the previous working value back), then reload the gateway.
rollback() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 0; }
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
hermes -p default gateway stop
sleep 2
hermes -p default gateway ensure --json --timeout 60 >/dev/null
sleep 3
status_rc=0
st=$(hermes -p default gateway status 2>&1) || status_rc=$?
if [ "$status_rc" != 0 ] || printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
  echo "rollback: files restored, but the gateway did NOT come back — start it manually (hermes -p default gateway start) and check hermes -p default logs"
  exit 1
fi
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
REMOTE
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
the last check.

Snapshots are staged privately, checked byte for byte, and published with a completion marker and checksums. Rollback validates the entire recovery point before changing live files and keeps it active if restoration fails. An older or incomplete snapshot without the marker is preserved for manual recovery; do not treat its files as a verified backup. A leftover `.creating` directory means snapshot creation is active or was interrupted: inspect that process before clearing the lock.
This candidate lifecycle recipe assumes the exclusive default profile and its one host gateway. Inspect other profiles and live work first: the current gateway can serve multiple profiles, so stop/start is not isolated to one bot. Do not use `--force`, `--all` or `--yes` to evade a refusal. Named-profile and shared-host deployment remain outside this recipe.


**Tagged CLI surface.** v0.22.5 supports `gateway ensure --json --timeout 60`;
`gateway run` is foreground and has no `--daemon` flag. Native `config set` and
`-z` inference are supported by the tagged parsers. These checks prove syntax,
not a real target's runtime or provider compatibility.

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
remote '
  set -e
  command -v hermes >/dev/null 2>&1 || { echo "FAIL: Hermes is not installed for the host account"; exit 1; }
  [ ! -e /.dockerenv ] && [ ! -e /run/.containerenv ] || { echo "FAIL: this recipe requires the host installation owner"; exit 1; }
  v=$(hermes -p default --version)
  printf "%s\n" "$v" | grep -Eq "(^|[^0-9])0[.]22[.]5([^0-9]|$)" \
    || { echo "FAIL: this recipe requires the explicit v0.22.5 compatibility candidate"; exit 1; }
  printf "%s\n" "$v"
' || { echo "ABORT: candidate host installation not confirmed. Nothing was written."; exit 1; }
```

This candidate recipe targets v0.22.5. A version banner is not evidence that provider inference works.

Also confirm we are on the host, not a container — keys added inside a container are
invisible to the host's sshd, and `~/.hermes/.env` on a container is ephemeral:

```bash
remote "whoami; hostname"
# Expect: root@<readable-name>. If hostname is a 12-char hex string, you're inside a
# container — exit out before continuing.
```

---

## Step 2 — idempotency check (skip if already configured to this model)

```bash
HAS_KEY=$(remote "grep -c '^$MODEL_KEYVAR=' ~/.hermes/.env 2>/dev/null || true")
CFG=$(remote 'hermes -p default config show 2>/dev/null || true')
if [ "${HAS_KEY:-0}" -gt 0 ] \
   && printf '%s\n' "$CFG" | grep -qwF -- "$HERMES_MODEL" \
   && printf '%s\n' "$CFG" | grep -qwF -- "$PROVIDER_ID" \
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
  1. Write $MODEL_KEYVAR (length ${#MODEL_API_KEY}, prefix ${MODEL_API_KEY:0:4}...) via 'hermes -p default config set'
  2. chmod 600 ~/.hermes/.env
  3. Set provider + model: hermes -p default config set model.provider $PROVIDER_ID ; model.default $HERMES_MODEL
  4. Reload gateway: hermes -p default gateway stop && hermes -p default gateway ensure --json --timeout 60
  5. Smoke test: hermes -p default -z 'reply with the single word OK' → expect 'OK'
  8. Capability check: report vision / web-summary / compression status

The API key is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`). Declining: `exit 1`, nothing written.

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

HARD GATE: the format check in `validate_inputs` already passed. This skill documents no
side-effect-free vendor endpoint, so there is **no live pre-write check** here — the live
check is Step 8's inference smoke test, which rolls back on a rejected key AND on an
inconclusive result (fail closed).

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

> If your Hermes build has no `config set` subcommand, use this fallback instead of the
> write above (same stdin transport; no sed, so keys containing `/+=|&` are safe):
> ```bash
> printf '%s\n' "$MODEL_API_KEY" | remote "IFS= read -r v; f=\$HOME/.hermes/.env; touch \$f; chmod 600 \$f
>   { grep -v '^$MODEL_KEYVAR=' \$f || true; } > \$f.new
>   printf '%s=%s\n' $MODEL_KEYVAR \"\$v\" >> \$f.new
>   chmod 600 \$f.new && mv \$f.new \$f" \
>   || { echo "FAIL: could not write $MODEL_KEYVAR."; rollback; exit 1; }
> ```

---

## Step 5 — apply model + provider config through the native writer

There is no MCP server to register here — this is a Hermes core config change. Pick the
path that matches the Hermes build on the VPS. The model id and provider id are not
secrets; they were validated in Step 0 and are passed as an explicit env prefix (the
heredoc is quoted, so nothing expands locally).

### Path A (preferred) — native `hermes -p default config set`

`config set` sends dotted names (`model.provider`, `model.default`) to `config.yaml` and
`UPPER_SNAKE` names to `.env` (Hermes docs, CLI reference).

```bash
apply_model_path_a() {
  remote "MODEL_ID=$(printf %q "$HERMES_MODEL") PROVIDER_ID=$(printf %q "$PROVIDER_ID") bash -s" <<'REMOTE'
set -e
hermes -p default config set model.provider "$PROVIDER_ID"
hermes -p default config set model.default "$MODEL_ID"
REMOTE
}
```

Native `config set` performs schema/route handling. Configure prompt caching separately
only when the current provider/model supports it; this skill does not enable unrelated
features or rerun the full setup wizard.

### Path B — retired manual YAML fallback

A native config failure is a compatibility or configuration error. Preserve the snapshot
and roll back; do not overwrite YAML to evade the native validator.

```bash
apply_model_path_b() {
  echo "Manual model YAML fallback is disabled; inspect the native config error." >&2
  return 1
}
```

Apply through the native configuration path; roll back on failure:

```bash
apply_model_path_a || { echo "FAIL: could not apply model config."; rollback; exit 1; }
```

Never put the API key in `config.yaml` — it goes only in `~/.hermes/.env`. Never use
`hermes -p default setup --portal` in a headless run; it opens an interactive OAuth flow that
hangs forever over SSH.

---

## Step 6 — reload through the supported native lifecycle

Stop the existing runtime, then let `gateway ensure` resolve its supervisor and wait for readiness. A refusal due to live work or a supervisor conflict must not be bypassed.

```bash
remote "hermes -p default gateway stop" || { echo "FAIL: gateway stop refused; preserving recovery point."; rollback; exit 1; }
sleep 2
remote "hermes -p default gateway ensure --json --timeout 60 >/dev/null" || { echo "FAIL: gateway did not start."; rollback; exit 1; }
sleep 5
```

---

## Step 7 — verify config + startup in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  LOG=$(remote "hermes -p default logs 2>&1 | tail -200")
  if printf '%s\n' "$LOG" | grep -qiF -- "$HERMES_MODEL" \
     || printf '%s\n' "$LOG" | grep -qiE "gateway.*(ready|started)|provider.*loaded"; then
    REGISTERED=1
    echo "OK: gateway started with model=$HERMES_MODEL."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gateway did not report model in logs after 30s. Rolling back."; rollback; exit 1; }

# Also confirm the model the runtime sees matches what we set (catches the billing-mode trap).
SHOWN=$(remote "hermes -p default config show 2>/dev/null | grep -i '^model'" || echo "")
echo "Runtime config: $SHOWN"
```

---

## Step 8 — live LLM smoke test (successful command and exact reply)

```bash
HTTP=$(remote 'bash -s' <<'REMOTE'
# A diagnostic can echo the prompt (including OK); only a successful, exact reply counts.
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
is not a capability test. Use native `hermes tools` / provider setup when a user wants
auxiliary features, then test the relevant operation separately.

```bash
echo "Verified: configured provider/model completed inference."
echo "Unverified: auxiliary tools and messaging delivery require their own checks."
finish || exit 1
```

---

## Rollback (auto-runs on any failure above)

`rollback()` is defined once, in **Step 0**, and is called as `rollback; exit 1` from every
failure after the snapshot. It restores the exact pre-skill `~/.hermes/.env` and
`config.yaml` from `~/.hermes/.hstack-backup/hermes-model` (it restores; it does not
delete, so a failed `FORCE=1` re-run puts the previously working key and model back) and
reloads the gateway with stop + native ensure, then checks `hermes -p default gateway status`: if the gateway is not
reported running it prints `files restored, but the gateway did NOT come back` and exits
non-zero (start it by hand with `hermes -p default gateway start` and check `hermes -p default logs`).

Manual undo after a successful run: `cp ~/.hermes/.hstack-backup/hermes-model.prev/.env ~/.hermes/.env`
and `cp ~/.hermes/.hstack-backup/hermes-model.prev/config.yaml ~/.hermes/config.yaml`,
then `hermes -p default gateway stop && hermes -p default gateway ensure --json --timeout 60`.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | OAuth wizard in a noninteractive SSH session | It requires human input | Use native attended setup, or the bounded BYOK path |
| 2 | Assuming local models are unsupported | Current Hermes has managed local models | Use native `hermes -p default model` for local runtime configuration |
| 3 | Inferring auxiliary capability from one key | Tool Gateway and provider features have separate configuration | Test the actual requested operation |
| 4 | Manual YAML fallback after native refusal | It bypasses schema, endpoint and route cleanup | Preserve the snapshot and inspect the native error |
| 5 | Misreporting key persistence as inference | Config writes do not test a provider request | Require a successful exact-response inference command |
| 6 | Sending a key through SSH argv | Process listings and logs can expose it | Use stdin transport and suppress key-write output |
| 7 | Starting a second foreground dispatcher | Shared gateway state and tokens can conflict | Use native readiness, respecting the existing owner |
| 8 | Stopping a shared host gateway casually | Multiple profiles can share one gateway | Require exclusive-default scope and inspect live work |
| 9 | Printing `config show` indiscriminately | Unexpected custom config can contain sensitive values | Inspect only necessary non-secret fields |
| 10 | Treating an offline stub as real compatibility | The stub models assumed behavior | Keep tagged-parser and live target evidence separate |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Inputs validated locally (`validate_inputs`): provider allowlist, key format, model id
- [ ] Hermes candidate version inspected; live compatibility remains independently verified
- [ ] Host vs container confirmed (`whoami; hostname` shows host, not hex container id)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; `rollback` (Step 0) restores rather than deletes
- [ ] The provider's key (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`) in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Provider + model set through native `config set`; no manual YAML fallback
- [ ] No interactive setup wizard or unrelated capability configuration was run
- [ ] Gateway reloaded with `stop` + `ensure` (NOT restart)
- [ ] Logs show gateway ready with the configured model within 30s
- [ ] Smoke test: `hermes -p default -z 'reply with OK'` returned `OK` (HTTP 200 equivalent); a 401, 403 or inconclusive result rolled back
- [ ] Auxiliary capabilities reported unverified until tested individually
- [ ] `finish` called; re-run with `FORCE=1` reconfigures cleanly

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and provider failure modes.

Source: [v0.22.5 config handler](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/config.py), [gateway parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/gateway.py).
