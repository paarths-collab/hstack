---
name: integration-tally
description: Connect Tally Forms (creation, editing, submission retrieval) to a self-hosted Hermes Agent over SSH via Tally's official remote MCP server using a static tly- API key. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-tally — connect Tally Forms to a remote Hermes (SSH-first)

You are the engineer connecting Tally Forms to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does one thing a machine cannot: mint the `tly-` API key
in the Tally dashboard.

Everything else — key storage, MCP probe + registration, gateway reload, smoke test —
runs on the VPS via SSH, idempotently with a rollback.

**Honest auth picture (verified 2026-06):** Tally ships an **official first-party** remote
MCP at `https://api.tally.so/mcp` with **two** auth modes:

- **OAuth (interactive):** for desktop clients (Claude Desktop, Cursor). NOT usable for a
  headless agent — opens a browser handoff.
- **Static `tly-` API key bearer:** `Authorization: Bearer tly-...`. Perfect for self-hosted.

This skill wires the bearer path. Sources:
- https://developers.tally.so/api-reference/mcp
- https://developers.tally.so/api-reference/api-keys

**Key lifecycle:** A `tly-` key inherits the permissions of the user who created it. If
that user leaves the org, the key dies. Always mint under a long-lived service-account user.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TALLY_TOKEN` | API key starting with `tly-` | https://tally.so/settings/api-keys → Create API key (shown ONCE) |

Confirm SSH access:

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
    HERMES="$(command -v hermes)"
  elif [ -x "$HOME/.local/bin/hermes" ]; then
    HERMES="$HOME/.local/bin/hermes"
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
    HERMES="docker exec $AGENT hermes"
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
  echo "Using: $HERMES"
  $HERMES --version
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first."; exit 1; }
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci tally" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_TALLY_API_KEY=tly-' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Tally already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE (token format + live MCP probe)

```bash
# Token format
printf '%s' "$TALLY_TOKEN" | grep -qE '^tly-[A-Za-z0-9_-]+$' \
  || { echo "ABORT: TALLY_TOKEN must start with 'tly-' (Tally API keys)."; exit 1; }

# Live MCP probe with bearer
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
RESP=$(curl -sS --max-time 15 \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TALLY_TOKEN" \
  -d "$INIT" \
  'https://api.tally.so/mcp' 2>/dev/null) || true
if printf '%s' "$RESP" | grep -q '"result"'; then
  echo "Tally MCP OK: initialize returned a result."
elif printf '%s' "$RESP" | grep -qi 'unauthor\|invalid'; then
  echo "ABORT: Tally MCP rejected the token. Re-check the value."
  exit 1
else
  echo "ABORT: unexpected response from Tally MCP."
  echo "$RESP" | head -3
  exit 1
fi

# Also verify the key works against /tools/list (some MCPs gate auth only on tool calls)
TOOLS_RESP=$(curl -sS --max-time 15 \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TALLY_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  'https://api.tally.so/mcp' 2>/dev/null) || true
TOOL_COUNT=$(printf '%s' "$TOOLS_RESP" | grep -oE '"name":"[^"]+"' | wc -l | tr -d ' ')
echo "Tally MCP tools available: $TOOL_COUNT"
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write MCP_TALLY_API_KEY (length ${#TALLY_TOKEN}, prefix ${TALLY_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register MCP: hermes mcp add tally --url https://api.tally.so/mcp --auth-header Authorization --auth-scheme Bearer
  4. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)
  5. Verify in logs: grep "registered.*tally"
  6. Smoke test: initialize from inside the container — expect 200

Token is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the secret (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_TALLY_API_KEY '$TALLY_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_TALLY_API_KEY=tly-' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
echo "Tally token confirmed in ~/.hermes/.env."
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MCP_TALLY_API_KEY=' ~/.hermes/.env || printf 'MCP_TALLY_API_KEY=\n' >> ~/.hermes/.env
>   sed -i 's|^MCP_TALLY_API_KEY=.*|MCP_TALLY_API_KEY=$TALLY_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the key in `config.yaml`.

---

## Step 6 — register the Tally MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add tally \
    --url 'https://api.tally.so/mcp' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|\${MCP_TALLY_API_KEY}|g' ~/.hermes/config.yaml"
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
       | grep -qiE "registered.*tool.*tally|MCP server.*tally.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: tally MCP registered."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: tally not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live MCP smoke test (from inside the container, never logs the key)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -H \"Authorization: Bearer \$MCP_TALLY_API_KEY\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"verify\",\"version\":\"0\"}}}' \
    'https://api.tally.so/mcp'
")
case "$HTTP" in
  200) echo "OK: Tally MCP reachable and token works." ;;
  401) echo "FAIL: token rejected (401). Re-check Step 5."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove tally 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^MCP_TALLY_API_KEY=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Tally unwired. Revoke the key at https://tally.so/settings/api-keys if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using OAuth for headless agent | OAuth requires interactive browser handoff | Use API-key path; OAuth is for desktop clients |
| 2 | Key minted under a user who later leaves the org | Key dies; calls 401 silently | Mint under a long-lived service-account user |
| 3 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600`; `${MCP_TALLY_API_KEY}` indirection in yaml |
| 4 | Lost key (Tally shows it once) | No recovery possible | Mint a new key at `/settings/api-keys` |
| 5 | Wrong env file (compose .env vs Hermes runtime) | Tokens in the wrong file don't load | Always `~/.hermes/.env` (host) or `/opt/data/.env` (container) |
| 6 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 7 | `echo >> .env` | Merge risk on missing trailing newline | Always `hermes config set` (Step 5), or the sed pattern |
| 8 | sed with `/` delimiter | Universal rule — tokens may contain special chars | Always `\|` delimiter |
| 9 | Permissions inherit from creator | Restricted user → restricted agent reach | Use a workspace-admin or service-account user when minting |
| 10 | Confusing Tally with other form services (Typeform, Tally is its own MCP) | Wrong base URL | This skill targets only `https://api.tally.so/mcp` |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Rate limits | Bursty calls 429 | Throttle; back off |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: token starts with `tly-`; live MCP `initialize` returned a result; `tools/list` enumerated N tools
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `MCP_TALLY_API_KEY` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] `config.yaml` references `${MCP_TALLY_API_KEY}` (no plaintext)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'tally'` within 30s
- [ ] Smoke test: `initialize` from inside the container returned `200`
- [ ] Rollback function defined; key revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP
failure modes.
