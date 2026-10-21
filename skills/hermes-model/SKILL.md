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

**Honest auth picture (verified 2026-06):** the unattended path requires a real provider
API key. OpenRouter is easiest; Anthropic, OpenAI and DeepSeek direct keys also work.
Each provider has its own fixed key name that Hermes reads (`OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` — see the Hermes docs,
"Environment Variables" and "AI Providers" pages at hermes-agent.nousresearch.com/docs);
a key stored under any other name is ignored. Never use `hermes setup --portal` in a
headless flow — it triggers an interactive OAuth that hangs the SSH session. A missing key
is NOT caught at config time; it surfaces only at first inference call, so we explicitly
smoke-test inference at the end. Auxiliary capabilities (vision, web summarization,
compression) silently degrade when their backing provider isn't keyed — this skill reports
which capabilities are active vs degraded.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MODEL_PROVIDER` | `openrouter` \| `anthropic` \| `openai` \| `deepseek` (default `openrouter`) | User choice |
| `$MODEL_API_KEY` | API key for that provider; written as `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` (`sk-or-...` OpenRouter, `sk-ant-...` Anthropic). Legacy: `$OPENROUTER_API_KEY` is still accepted for `openrouter`. | <https://openrouter.ai/keys> (or the provider's dashboard) |
| `$HERMES_MODEL` | Exact model id for that provider — no default, ask the user. Documented forms: vendor-prefixed on OpenRouter (`anthropic/claude-sonnet-4`), bare on Anthropic (`claude-sonnet-4-6`). OpenAI / DeepSeek ids: copy from the provider catalogue (not verified here). **Must be a frontier model with >=64K context** — small/local models hallucinate tool calls and Hermes startup is rejected below 64K. | Provider model catalogue |

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
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
# A leftover snapshot means an earlier run wrote something and never finished or rolled
# back. Snapshotting now would capture that half-written state as "known good".
if [ -d "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$d" && chmod 700 "$HOME/.hermes/.hstack-backup" "$d"
for f in .env config.yaml; do
  rm -f "$d/$f" "$d/$f.absent"
  if [ -f "$HOME/.hermes/$f" ]; then cp -p "$HOME/.hermes/$f" "$d/$f"; else : > "$d/$f.absent"; fi
done
chmod 600 "$d"/* 2>/dev/null || true
REMOTE
}

# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), then reload the gateway.
rollback() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 0; }
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then cp -p "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then rm -f "$HOME/.hermes/$f"; fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
rm -rf "$d.prev"; mv "$d" "$d.prev"
hermes gateway stop || true; sleep 2; hermes gateway run --daemon || true
sleep 3
st=$(hermes gateway status 2>&1 || true)
if printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
  echo "rollback: files restored, but the gateway did NOT come back — start it manually (hermes gateway start) and check hermes logs"
  exit 1
fi
echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
REMOTE
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; rm -rf \"\$d.prev\"; [ -d \"\$d\" ] && mv \"\$d\" \"\$d.prev\"; true"
}

validate_inputs || exit 1
```

Rules for calling them: failures **before** `snapshot` (Steps 1-4 up to the snapshot, the
user declining the dry run) just `exit 1` with "Nothing was written" — they do not call
`rollback`. Every failure **after** `snapshot` does `rollback; exit 1`. `finish` runs after
the last check.

**Unverified CLI surface.** Upstream's CLI docs list `hermes gateway run|start|stop|restart|status|install`. `hermes gateway run --daemon` is NOT in those docs: they are this repo's declared adapter surface, unverified against upstream. If a call fails with "unknown option/command", check `hermes gateway --help` on the VPS and adapt; the hard-gate and rollback logic does not depend on the exact flags.

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
remote '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    docker exec "$AGENT" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first. Nothing was written."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

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
CFG=$(remote 'hermes config show 2>/dev/null || true')
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
  1. Write $MODEL_KEYVAR (length ${#MODEL_API_KEY}, prefix ${MODEL_API_KEY:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Set provider + model: hermes config set model.provider $PROVIDER_ID ; model.default $HERMES_MODEL
  4. Enable prompt caching: hermes config set prompt_caching.enabled true
  5. Finalize: hermes setup --non-interactive (NEVER --portal in headless mode)
  6. Reload gateway: hermes gateway stop && hermes gateway run
  7. Smoke test: hermes -z 'reply with the single word OK' → expect 'OK'
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
  | remote "IFS= read -r v && hermes config set $MODEL_KEYVAR \"\$v\" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env" \
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

## Step 5 — apply model + provider config (Path A preferred; Path B fallback)

There is no MCP server to register here — this is a Hermes core config change. Pick the
path that matches the Hermes build on the VPS. The model id and provider id are not
secrets; they were validated in Step 0 and are passed as an explicit env prefix (the
heredoc is quoted, so nothing expands locally).

### Path A (preferred) — `hermes config set` + `hermes setup --non-interactive`

`config set` sends dotted names (`model.provider`, `model.default`) to `config.yaml` and
`UPPER_SNAKE` names to `.env` (Hermes docs, CLI reference).

```bash
apply_model_path_a() {
  remote "MODEL_ID=$(printf %q "$HERMES_MODEL") PROVIDER_ID=$(printf %q "$PROVIDER_ID") bash -s" <<'REMOTE'
set -e
hermes config set model.provider "$PROVIDER_ID"
hermes config set model.default "$MODEL_ID"
hermes config set prompt_caching.enabled true
hermes setup --non-interactive
REMOTE
}
```

`prompt_caching.enabled true` is a free cost win on providers that support it
(Anthropic, OpenRouter pass-through). Read config back with `hermes config show`
(read-only; do not parse it for writes).

### Path B (fallback) — direct edit of `~/.hermes/config.yaml`

If the Hermes build rejects `config set` for the `model.*` keys, rewrite the top-level
`model:` block in the YAML directly (documented keys: `model.default`, `model.provider`).
The old block is dropped and the new one appended; values are passed with `printf %s`, so
no sed delimiter issue arises with `/` in model ids:

```bash
apply_model_path_b() {
  remote "MODEL_ID=$(printf %q "$HERMES_MODEL") PROVIDER_ID=$(printf %q "$PROVIDER_ID") bash -s" <<'REMOTE'
set -e
f=$HOME/.hermes/config.yaml
touch "$f"
awk '/^model:/{skip=1; next} skip && /^[[:space:]]/{next} {skip=0; print}' "$f" > "$f.new"
printf 'model:\n  default: %s\n  provider: %s\n' "$MODEL_ID" "$PROVIDER_ID" >> "$f.new"
cat "$f.new" > "$f"; rm -f "$f.new"
hermes setup --non-interactive
REMOTE
}
```

Apply (Path A first, Path B only if A fails, rollback if both fail):

```bash
apply_model_path_a || { echo "Path A failed; trying Path B."; apply_model_path_b; } \
  || { echo "FAIL: could not apply model config."; rollback; exit 1; }
```

Never put the API key in `config.yaml` — it goes only in `~/.hermes/.env`. Never use
`hermes setup --portal` in a headless run; it opens an interactive OAuth flow that
hangs forever over SSH.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
remote "hermes gateway stop || true"
sleep 2
remote "hermes gateway run --daemon" || { echo "FAIL: gateway did not start."; rollback; exit 1; }
sleep 5
```

---

## Step 7 — verify config + startup in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  LOG=$(remote "hermes logs 2>&1 | tail -200")
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
SHOWN=$(remote "hermes config show 2>/dev/null | grep -i '^model'" || echo "")
echo "Runtime config: $SHOWN"
```

---

## Step 8 — live LLM smoke test (the grep-safe end-to-end check)

```bash
HTTP=$(remote 'bash -s' <<'REMOTE'
out=$(hermes -z 'reply with the single word OK' 2>&1)
if printf '%s' "$out" | grep -qiw 'OK'; then echo 200
elif printf '%s' "$out" | grep -qiE 'unauthor|invalid.*key|401'; then echo 401
elif printf '%s' "$out" | grep -qiE 'forbidden|quota|billing|403'; then echo 403
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

After the smoke test succeeds, report which auxiliary capabilities are live vs silently
degraded based on which keys are present:

```bash
remote '
  ENV=~/.hermes/.env
  has(){ grep -q "^$1=" "$ENV" 2>/dev/null && echo active || echo "DEGRADED (missing $1)"; }
  echo "vision           : $(has OPENROUTER_API_KEY)"
  echo "web-summarization: $(has OPENROUTER_API_KEY)"
  echo "compression      : $(has OPENROUTER_API_KEY)"
'
finish
```

If any are `DEGRADED`, offer to add an OpenRouter key to cover the gaps — these features
fail silently (no error, just dropped context / blank summaries) when their backing
provider isn't keyed. Also: the compression/vision aux model's context must be **>= the
main model's** (and **>=64K**) or summarization silently truncates.

---

## Rollback (auto-runs on any failure above)

`rollback()` is defined once, in **Step 0**, and is called as `rollback; exit 1` from every
failure after the snapshot. It restores the exact pre-skill `~/.hermes/.env` and
`config.yaml` from `~/.hermes/.hstack-backup/hermes-model` (it restores; it does not
delete, so a failed `FORCE=1` re-run puts the previously working key and model back) and
reloads the gateway with stop + run, then checks `hermes gateway status`: if the gateway is not
reported running it prints `files restored, but the gateway did NOT come back` and exits
non-zero (start it by hand with `hermes gateway start` and check `hermes logs`).

Manual undo after a successful run: `cp ~/.hermes/.hstack-backup/hermes-model.prev/.env ~/.hermes/.env`
and `cp ~/.hermes/.hstack-backup/hermes-model.prev/config.yaml ~/.hermes/config.yaml`,
then `hermes gateway stop && hermes gateway run --daemon`.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `hermes setup --portal` in a headless / SSH run | Triggers an interactive OAuth flow that hangs forever | Always `--non-interactive`; mint the key out-of-band |
| 2 | Defaulting to a local / small model | They hallucinate tool calls and Hermes rejects models <64K context at startup | Frontier model only; `>=64K` context window |
| 3 | Aux model (vision / web / compression) context < main model | Summarization silently truncates and drops conversation context | Aux model context must be `>=` main model and `>=64K` |
| 4 | `/model` slash command used to add a new provider | In-session `/model` only switches **already-configured** providers | Adding a provider requires `hermes config set` in terminal |
| 5 | Looking for `hermes config get` | The older skills claimed it does not exist; the current Hermes CLI reference lists it, but this skill relies only on `config show` | Use `hermes config show` and grep |
| 6 | Billing-mode trap | A subscription plan can silently flip to per-token API billing; calls then 403 | Re-check provider dashboard on any 403; capability check in Step 8 |
| 7 | Missing key not caught at config time | Hermes does not validate the key during `setup`; only first inference call fails | Step 8's `hermes -z` smoke test is mandatory |
| 8 | Auxiliary capabilities silently degrade | If the provider behind vision/web/compression isn't keyed, calls return nothing — no error | Run the capability check; offer to add OpenRouter to cover gaps |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 10 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the stdin fallback in Step 4) |
| 11 | API key in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 12 | Interpolating the key or model id into a sed script / argv | Keys contain `/+=|&`; model ids contain `/`; a quote breaks the remote command and the key shows in `ps` | Key over ssh stdin; model/provider ids validated locally and passed as an env prefix |
| 13 | Container vs host confusion | `.env` written inside a container is ephemeral; key invisible to host sshd | Always `whoami; hostname` first |
| 14 | Writing a generic or invented key name (`openai_API_KEY`, `${PROVIDER}_API_KEY`) | Hermes reads only the fixed names; the key is silently ignored and inference fails at first call | Use the per-provider names in Step 0 (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`) |
| 15 | Provider id mismatch (`openai` vs `openai-api`) | Hermes documents the direct OpenAI provider as `openai-api`; a made-up id selects nothing | Step 0 maps `openai` to `openai-api`; `anthropic`, `deepseek`, `openrouter` are used as-is |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Inputs validated locally (`validate_inputs`): provider allowlist, key format, model id
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Host vs container confirmed (`whoami; hostname` shows host, not hex container id)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; `rollback` (Step 0) restores rather than deletes
- [ ] The provider's key (`OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`) in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Provider + model set via Path A (`hermes config set model.provider` / `model.default`) or Path B (yaml edit); `prompt_caching.enabled true`
- [ ] `hermes setup --non-interactive` ran cleanly (no `--portal` used)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show gateway ready with the configured model within 30s
- [ ] Smoke test: `hermes -z 'reply with OK'` returned `OK` (HTTP 200 equivalent); a 401, 403 or inconclusive result rolled back
- [ ] Capability check reported vision / web-summary / compression status; degraded items surfaced to user
- [ ] `finish` called; re-run with `FORCE=1` reconfigures cleanly

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and provider failure modes.
