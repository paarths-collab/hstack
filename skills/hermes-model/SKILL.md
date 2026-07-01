---
name: hermes-model
description: Configure the Hermes model and provider with an API key over SSH, validate context window, and detect silent capability degradation. Use when setting up or changing which LLM a remote, self-hosted Hermes uses. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-model — configure provider + model on a remote Hermes (SSH-first)

You are the engineer configuring the LLM provider and model for a self-hosted Hermes
agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. Every command runs on the VPS, not
on the local machine.

Do everything autonomously; stop only for the one thing a machine cannot do: mint the
provider API key in the provider's dashboard.

**Honest auth picture (verified 2026-06):** the unattended path requires a real provider
API key (OpenRouter is easiest; OpenAI/Anthropic also fine). Never use `hermes setup
--portal` in a headless flow — it triggers an interactive OAuth that hangs the SSH
session. A missing key is NOT caught at config time; it surfaces only at first inference
call, so we explicitly smoke-test inference at the end. Auxiliary capabilities (vision,
web summarization, compression) silently degrade when their backing provider isn't keyed
— this skill reports which capabilities are active vs degraded.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$OPENROUTER_API_KEY` | Provider API key (`sk-or-...` for OpenRouter; `sk-...` for OpenAI; `sk-ant-...` for Anthropic) | <https://openrouter.ai/keys> (or provider equivalent) |
| `$HERMES_MODEL` | Model id (default `deepseek/deepseek-v4`; or e.g. `anthropic/claude-sonnet-4`) | Provider model catalogue. **Must be a frontier model with >=64K context** — small/local models hallucinate tool calls and Hermes startup is rejected below 64K. |

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

Also confirm we are on the host, not a container — keys added inside a container are
invisible to the host's sshd, and `~/.hermes/.env` on a container is ephemeral:

```bash
ssh "$VPS_USER@$VPS_IP" "whoami; hostname"
# Expect: root@<readable-name>. If hostname is a 12-char hex string, you're inside a
# container — exit out before continuing.
```

---

## Step 2 — idempotency check (skip if already configured to this model)

```bash
CURRENT=$(ssh "$VPS_USER@$VPS_IP" "hermes config show 2>/dev/null | awk -F= '/^model[[:space:]]*[:=]/{print \$2}' | tr -d ' \"'" || echo "")
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OPENROUTER_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$CURRENT" = "$HERMES_MODEL" ] && [ "$HAS_KEY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Model already set to $HERMES_MODEL and key present. Set FORCE=1 to reconfigure."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write OPENROUTER_API_KEY (length ${#OPENROUTER_API_KEY}, prefix ${OPENROUTER_API_KEY:0:7}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Set model: hermes config set model $HERMES_MODEL
  4. Enable prompt caching: hermes config set prompt_caching.enabled true
  5. Finalize: hermes setup --non-interactive (NEVER --portal in headless mode)
  6. Reload gateway: hermes gateway stop && hermes gateway run
  7. Smoke test: hermes -z 'reply with the single word OK' → expect 'OK'
  8. Capability check: report vision / web-summary / compression status

The API key is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set OPENROUTER_API_KEY '$OPENROUTER_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OPENROUTER_API_KEY=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: OPENROUTER_API_KEY not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — provider keys can contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^OPENROUTER_API_KEY=' ~/.hermes/.env || printf 'OPENROUTER_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^OPENROUTER_API_KEY=.*|OPENROUTER_API_KEY=$OPENROUTER_API_KEY|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — apply model + provider config (Path A preferred; Path B fallback)

There is no MCP server to register here — this is a Hermes core config change. Pick the
path that matches the Hermes build on the VPS.

### Path A (preferred) — `hermes config set` + `hermes setup --non-interactive`

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  hermes config set model '$HERMES_MODEL'
  hermes config set prompt_caching.enabled true
  hermes setup --non-interactive
"
```

`prompt_caching.enabled true` is a free cost win on providers that support it
(Anthropic, OpenRouter pass-through). Read config back with `hermes config show` —
there is no `config get`.

### Path B (fallback) — direct edit of `~/.hermes/config.yaml`

If the Hermes build lacks `config set` for the `model` key, edit the YAML directly. The
key is `model:` at the top level; pipe delimiter for sed because some model ids contain
`/`:

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  grep -q '^model:' ~/.hermes/config.yaml \
    && sed -i 's|^model:.*|model: $HERMES_MODEL|' ~/.hermes/config.yaml \
    || printf 'model: %s\n' '$HERMES_MODEL' >> ~/.hermes/config.yaml
  hermes setup --non-interactive
"
```

Never put the API key in `config.yaml` — it goes only in `~/.hermes/.env`. Never use
`hermes setup --portal` in a headless run; it opens an interactive OAuth flow that
hangs forever over SSH.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify config + startup in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "model.*${HERMES_MODEL}|gateway.*(ready|started)|provider.*loaded"; then
    REGISTERED=1
    echo "OK: gateway started with model=$HERMES_MODEL."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: gateway did not report model in logs after 30s. Rolling back."; rollback; exit 1; }

# Also confirm the model the runtime sees matches what we set (catches the billing-mode trap).
SHOWN=$(ssh "$VPS_USER@$VPS_IP" "hermes config show 2>/dev/null | grep -i '^model'" || echo "")
echo "Runtime config: $SHOWN"
```

---

## Step 8 — live LLM smoke test (the grep-safe end-to-end check)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  out=\$(hermes -z 'reply with the single word OK' 2>&1)
  printf '%s' \"\$out\" | grep -qi '\\bOK\\b' && echo 200 || {
    printf '%s' \"\$out\" | grep -qiE 'unauthor|invalid.*key|401' && echo 401
    printf '%s' \"\$out\" | grep -qiE 'forbidden|quota|billing|403'    && echo 403
    echo 599
  } | head -1
")
case "$HTTP" in
  200) echo "OK: model $HERMES_MODEL responded." ;;
  401) echo "FAIL: API key rejected. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: key valid but no quota/scope (billing-mode trap?). Check provider dashboard."; exit 1 ;;
  *)   echo "WARN: inference smoke test returned $HTTP. Check 'hermes logs' manually." ;;
esac
```

### Capability check (the #1 silent-failure gotcha)

After the smoke test succeeds, report which auxiliary capabilities are live vs silently
degraded based on which keys are present:

```bash
ssh "$VPS_USER@$VPS_IP" '
  ENV=~/.hermes/.env
  has(){ grep -q "^$1=" "$ENV" 2>/dev/null && echo active || echo "DEGRADED (missing $1)"; }
  echo "vision           : $(has OPENROUTER_API_KEY)"
  echo "web-summarization: $(has OPENROUTER_API_KEY)"
  echo "compression      : $(has OPENROUTER_API_KEY)"
'
```

If any are `DEGRADED`, offer to add an OpenRouter key to cover the gaps — these features
fail silently (no error, just dropped context / blank summaries) when their backing
provider isn't keyed. Also: the compression/vision aux model's context must be **>= the
main model's** (and **>=64K**) or summarization silently truncates.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes config unset OPENROUTER_API_KEY 2>/dev/null || \
    sed -i '/^OPENROUTER_API_KEY=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset model 2>/dev/null || \
    sed -i '/^model:/d' ~/.hermes/config.yaml"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Model + provider key removed."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `hermes setup --portal` in a headless / SSH run | Triggers an interactive OAuth flow that hangs forever | Always `--non-interactive`; mint the key out-of-band |
| 2 | Defaulting to a local / small model | They hallucinate tool calls and Hermes rejects models <64K context at startup | Frontier model only; `>=64K` context window |
| 3 | Aux model (vision / web / compression) context < main model | Summarization silently truncates and drops conversation context | Aux model context must be `>=` main model and `>=64K` |
| 4 | `/model` slash command used to add a new provider | In-session `/model` only switches **already-configured** providers | Adding a provider requires `hermes config set` in terminal |
| 5 | Looking for `hermes config get` | There is no `config get` subcommand | Use `hermes config show` and grep |
| 6 | Billing-mode trap | A subscription plan can silently flip to per-token API billing; calls then 403 | Re-check provider dashboard on any 403; capability check in Step 8 |
| 7 | Missing key not caught at config time | Hermes does not validate the key during `setup`; only first inference call fails | Step 8's `hermes -z` smoke test is mandatory |
| 8 | Auxiliary capabilities silently degrade | If the provider behind vision/web/compression isn't keyed, calls return nothing — no error | Run the capability check; offer to add OpenRouter to cover gaps |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 10 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 11 | API key in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 12 | sed with `/` delimiter on model ids / tokens | Model ids contain `/` (`anthropic/claude-sonnet-4`); keys contain `/+=` | Always use `\|` delimiter |
| 13 | Container vs host confusion | `.env` written inside a container is ephemeral; key invisible to host sshd | Always `whoami; hostname` first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Host vs container confirmed (`whoami; hostname` shows host, not hex container id)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `OPENROUTER_API_KEY` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Model set via Path A (`hermes config set model`) or Path B (yaml edit); `prompt_caching.enabled true`
- [ ] `hermes setup --non-interactive` ran cleanly (no `--portal` used)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show gateway ready with the configured model within 30s
- [ ] Smoke test: `hermes -z 'reply with OK'` returned `OK` (HTTP 200 equivalent)
- [ ] Capability check reported vision / web-summary / compression status; degraded items surfaced to user
- [ ] Rollback function defined and proven (re-run with `FORCE=1` reconfigures cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and provider failure modes.
