---
name: <skill-name>
description: <one-sentence what it does + when to use it>
---

# /<skill-name> — <short title>

You are the engineer doing <X> for the user. The agent (Hermes, Codex, Claude Code,
Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.
Every command in this skill runs on the VPS, not on the local machine.

Do everything autonomously; stop only for things a machine cannot do (mint a token,
scan a QR code, send the first message).

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$<SECRET>` | The integration's API token | `<mint-url-here>` |

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
    docker exec "$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: a version string like `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci '<skill-name>'" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Already wired. Re-run with FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write \$<SECRET> (length: ${#<SECRET>}) to ~/.hermes/.env via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add <skill-name> --url <URL> --auth ...
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep "registered.*<skill-name>"

The secret will NEVER be printed in plaintext.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed to Step 4.

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set <SECRET_NAME> '$<SECRET>'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Failure detection (don't trust the write — verify):

```bash
ssh "$VPS_USER@$VPS_IP" "grep -q '^<SECRET_NAME>=' ~/.hermes/.env" \
  || { echo "FAIL: secret not written. Rolling back."; bash <(declare -f rollback); exit 1; }
```

---

## Step 5 — register the MCP server (or REST endpoint if no MCP exists)

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add <skill-name> \
    --url '<MCP_URL>' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject real token with pipe delimiter (tokens often contain /+=)
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$<SECRET>\"'|g' ~/.hermes/config.yaml"
```

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT re-read `.env` reliably. Use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 7 — verify registration in logs (within 30s)

```bash
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -100" \
       | grep -qiE "registered .* '<skill-name>'|MCP server.*<skill-name>.*ok"; then
    echo "OK: <skill-name> registered."
    break
  fi
  [ "$i" = "6" ] && { echo "FAIL: did not appear in logs after 30s. Rolling back."; bash <(declare -f rollback); exit 1; }
  sleep 5
done
```

---

## Step 8 — live tool-call smoke test

```bash
# Replace with a real, side-effect-free call: /me, /ping, list-1-item.
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}\n' \
    -X GET '<REST_BASE>/me' \
    -H \"Authorization: Bearer \$<SECRET_NAME>\"
"
```

`200` = wired. `401` = bad token. `403` = scope missing.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove <skill-name> 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset <SECRET_NAME> 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. <skill-name> is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 4 | sed with `/` delimiter on tokens | Tokens contain `/+=`; sed breaks | Use `\|` delimiter |
| 5 | Container vs host confusion | Skill assumed wrong layer | Always check `whoami; hostname` first |
| 6 | Skipping the verify step | "Silent success" — config written, never picked up | Always wait + grep logs |
| 7 | <integration-specific pitfall> | <why> | <fix> |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Secret written to `~/.hermes/.env`, file is `chmod 600`
- [ ] Secret NOT in `config.yaml` and NOT echoed in chat
- [ ] MCP registered via `hermes mcp add`; gateway reloaded with stop+run
- [ ] Logs show `registered N tool(s) for '<skill-name>'` within 30s
- [ ] Live tool-call smoke test returned `200`
- [ ] Rollback function defined and tested

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
