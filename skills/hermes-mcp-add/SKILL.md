---
name: hermes-mcp-add
description: Meta-skill for wiring ANY remote HTTP MCP server into a self-hosted Hermes agent over SSH. Probes the endpoint to discover the correct auth shape, writes the secret safely, registers the MCP, reloads the gateway, and verifies. Use when no integration-specific skill exists yet and you need to wire an arbitrary HTTP MCP into Hermes. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-mcp-add — wire any remote HTTP MCP into a remote Hermes (SSH-first)

You are the engineer wiring an arbitrary remote HTTP MCP server into a self-hosted Hermes
agent on the user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini,
any of them) work over SSH as root against the VPS. Every command runs on the VPS, not on
the local machine.

This skill is the **meta-tutorial** behind every `integration-*` skill: the probe matrix,
the placeholder-token trick, the `|`-delimiter sed, and the stop+run gateway reload are
the same in every concrete integration. Use this skill when no purpose-built integration
skill exists yet for the target service.

Do everything autonomously; stop only for things a machine cannot do: minting the token,
confirming the MCP URL, and (for OAuth-only MCPs) the browser consent step.

**Honest auth picture:** MCP servers vary wildly in how they accept credentials — path
token, bare URL + bearer header, custom header, query parameter, OAuth-only. **Never
trust the supplied URL form.** Always run the probe matrix in Step 5 first; the server's
own responses are the authoritative spec.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MCP_NAME` | Short identifier for this MCP in Hermes (lowercase, alnum + `-`) | User picks; e.g. `max-mcp`, `linear`, `posthog` |
| `$MCP_URL` | Base MCP endpoint, no token suffix | Vendor docs; e.g. `https://max-mcp.digitalcrew.tech/mcp` |
| `$MCP_TOKEN` | API/bearer token for the server | Vendor's dashboard or API-keys page |

Derive the env var name Hermes will generate:

```bash
ENV_VAR="MCP_$(echo "$MCP_NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
# e.g. max-mcp → MCP_MAX_MCP_API_KEY
```

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

Also confirm you are on the **host**, not inside a container — `whoami; hostname` should
show the VPS hostname, not a hex string. SSH keys added inside a container are invisible
to the host's sshd; everything downstream silently breaks if you skipped this.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci \"$MCP_NAME\"" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "$MCP_NAME is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Probe $MCP_URL with 5 auth variants (path-token, bare, bearer header, x-api-key, query)
  2. Probe tools/list without auth — confirm auth is actually enforced
  3. Write $ENV_VAR (length ${#MCP_TOKEN}, prefix ${MCP_TOKEN:0:4}...) via 'hermes config set'
  4. chmod 600 ~/.hermes/.env
  5. Register MCP via 'hermes mcp add $MCP_NAME --url $MCP_URL --auth header' (placeholder token)
  6. Reload gateway: hermes gateway stop && hermes gateway run
  7. Verify in logs: grep "registered.*$MCP_NAME"
  8. Smoke test: tools/list call to $MCP_URL with real bearer → expect 200 / JSON-RPC result

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set \"$ENV_VAR\" '$MCP_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c \"^$ENV_VAR=\" ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: $ENV_VAR not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with the
> pipe delimiter (tokens often contain `/`, `+`, `=` — `/`-delimited sed breaks on them):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q \"^$ENV_VAR=\" ~/.hermes/.env || printf '%s=\n' \"$ENV_VAR\" >> ~/.hermes/.env
>   sed -i \"s|^$ENV_VAR=.*|$ENV_VAR=$MCP_TOKEN|\" ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — probe the endpoint to find the correct auth shape

Run the 5-variant probe matrix on the VPS. **Let the server tell you what works** — docs
and user-supplied URL forms are unreliable. A 200 + JSON-RPC `result` block means that
variant handles the handshake; 404/HTML means the path doesn't exist; 401/403 means the
route exists but auth is wrong.

```bash
ssh "$VPS_USER@$VPS_IP" "
  TOK=\"\$$ENV_VAR\"
  H='Accept: application/json, text/event-stream'
  C='Content-Type: application/json'
  INIT='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'

  curl -sS -o /tmp/probe_a -w 'A path-token  = %{http_code}\n' -X POST -H \"\$H\" -H \"\$C\" -d \"\$INIT\" \"$MCP_URL/\$TOK\"
  curl -sS -o /tmp/probe_b -w 'B bare        = %{http_code}\n' -X POST -H \"\$H\" -H \"\$C\" -d \"\$INIT\" \"$MCP_URL\"
  curl -sS -o /tmp/probe_c -w 'C bearer      = %{http_code}\n' -X POST -H \"\$H\" -H \"\$C\" -H \"Authorization: Bearer \$TOK\" -d \"\$INIT\" \"$MCP_URL\"
  curl -sS -o /tmp/probe_d -w 'D x-api-key   = %{http_code}\n' -X POST -H \"\$H\" -H \"\$C\" -H \"X-API-Key: \$TOK\" -d \"\$INIT\" \"$MCP_URL\"
  curl -sS -o /tmp/probe_e -w 'E query-token = %{http_code}\n' -X POST -H \"\$H\" -H \"\$C\" -d \"\$INIT\" \"$MCP_URL?token=\$TOK\"
"
```

`initialize` succeeding is NOT enough — many servers accept the handshake unauthenticated
and only enforce auth on `tools/call`. Re-probe with a real `tools/list` call (no auth)
and read the error; the server's response is the spec:

```bash
ssh "$VPS_USER@$VPS_IP" "
  H='Accept: application/json, text/event-stream'
  C='Content-Type: application/json'
  INIT='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'

  curl -sS -D /tmp/probe_headers -o /tmp/probe_init -X POST -H \"\$H\" -H \"\$C\" -d \"\$INIT\" \"$MCP_URL\"
  SID=\$(grep -i mcp-session-id /tmp/probe_headers | tr -d '\r' | awk '{print \$2}')

  curl -sS -X POST -H \"\$H\" -H \"\$C\" -H \"Mcp-Session-Id: \$SID\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}' \"$MCP_URL\"
"
```

Pick the variant from {A, B+C, D, E} that returns a successful authed `tools/list`. That
determines whether Path A or Path B below applies.

---

## Step 6 — register the MCP server

Pick the path that matches what the probe matrix revealed.

### Path A (preferred) — `hermes mcp add` with placeholder token

Use a **placeholder** in the interactive prompt, not the real token. Reason: tokens piped
through `docker exec` or non-TTY shells can mangle `/`, `+`, `=` characters. The placeholder
guarantees the config block and env var name are generated correctly; the real value is
already in `~/.hermes/.env` from Step 4 and gets referenced via env indirection.

```bash
ssh "$VPS_USER@$VPS_IP" "
  printf 'y\nAuthorization\nplaceholder\n' | \
    hermes mcp add \"$MCP_NAME\" \
      --url \"$MCP_URL\" \
      --auth header
"
```

This writes to `config.yaml`:

```yaml
<mcp-name>:
  url: <mcp-url>
  headers:
    Authorization: Bearer ${MCP_<NAME>_API_KEY}
  enabled: true
```

If the CLI reports `Connected! Found N tool(s)`, registration succeeded.

If the server needs a custom header (e.g. `X-API-Key` from probe D) or path-token (probe A),
pass `--auth-header 'X-API-Key' --auth-scheme ''` or embed the token in the URL itself
(then no `--auth` flag needed). Match what the probe matrix proved.

### Path B (fallback) — generic HTTP tool against the REST API

If the build is MCP-incompatible or the service has no MCP server at all, register the
service as a plain HTTP tool. Reuse the same `~/.hermes/.env` secret; document the base
URL, required headers (some APIs need version pins, e.g. `Notion-Version: 2025-09-03`),
and known scope requirements in the integration's own follow-up skill.

Do NOT try to register an OAuth-only MCP endpoint with a static bearer token — it will
return 401 forever. The honest fix is Path B or the vendor's stdio server.

---

## Step 7 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

> If env changes still don't appear after stop+run (test:
> `ssh "$VPS_USER@$VPS_IP" "hermes config get $ENV_VAR"`), the container's compose-level
> env is stale. Fix: `docker compose down && docker compose up -d` on the host. Only
> needed when the var lives in the compose `.env`, not in `~/.hermes/.env`.

---

## Step 8 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*$MCP_NAME|MCP server.*$MCP_NAME.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: $MCP_NAME registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: $MCP_NAME not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Success looks like:

```
INFO tools.mcp_tool: MCP server '<name>' (HTTP): registered N tool(s): mcp_<name>_<tool1>, ...
```

---

## Step 9 — live API smoke test

Make a real authed `tools/list` call from the VPS. The token stays on the host.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  TOK=\"\$$ENV_VAR\"
  H='Accept: application/json, text/event-stream'
  C='Content-Type: application/json'
  INIT='{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"0\"}}}'

  curl -sS -D /tmp/smoke_h -o /tmp/smoke_init -X POST -H \"\$H\" -H \"\$C\" \
    -H \"Authorization: Bearer \$TOK\" -d \"\$INIT\" \"$MCP_URL\"
  SID=\$(grep -i mcp-session-id /tmp/smoke_h | tr -d '\r' | awk '{print \$2}')

  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H \"\$H\" -H \"\$C\" -H \"Mcp-Session-Id: \$SID\" \
    -H \"Authorization: Bearer \$TOK\" \
    -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}' \"$MCP_URL\"
")
case "$HTTP" in
  200) echo "OK: $MCP_NAME MCP reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but scope missing. Check vendor permissions."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from $MCP_URL. Check manually." ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove \"$MCP_NAME\" 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset \"$ENV_VAR\" 2>/dev/null || \
    sed -i \"/^$ENV_VAR=/d\" ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. $MCP_NAME is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Trusting the supplied URL form | Docs say `/mcp/<token>`; server returns 404 (Next.js HTML). Path didn't exist. | Always run the probe matrix (Step 5) |
| 2 | Stopping at `initialize` success | Handshake is often unauthenticated; auth is enforced on `tools/call` | Probe `tools/list` without auth |
| 3 | Piping the real token through `printf \| docker exec` | Special chars (`/+= `) mangle or truncate in non-TTY pipes | Placeholder in CLI; real value lives in `~/.hermes/.env` |
| 4 | sed with `/` delimiter on tokens | Tokens contain `/`, `+`, `=`; sed expression breaks | Always use `\|` delimiter |
| 5 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` for the running process | Use `gateway stop` + `gateway run` |
| 6 | Editing the wrong `.env` | Two files exist: compose `.env` (platform config) and `~/.hermes/.env` or `/opt/data/.env` (Hermes runtime). MCP secrets must go in the Hermes one. | Always `hermes config set`; verify path is `~/.hermes/.env` |
| 7 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline; mangles env | Always `hermes config set` |
| 8 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`; `config.yaml` shows `${MCP_..._API_KEY}` placeholder only |
| 9 | Skipping `chmod 600` | Bearer creds world-readable | Always `chmod 600 ~/.hermes/.env` after writing |
| 10 | Wiring an OAuth-only MCP with a bearer token | Endpoint rejects all bearers; loops forever | Use Path B (REST) or the vendor's stdio server |
| 11 | SSH key added inside a container | Host sshd never sees it; "Permission denied" loop | Always check `whoami; hostname` first — must be host, not hex container ID |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Probe matrix run; correct auth variant identified
- [ ] `$ENV_VAR` written to `~/.hermes/.env`, file is `chmod 600`
- [ ] Secret NOT in `config.yaml` and NOT echoed in chat
- [ ] MCP registered via Path A (`hermes mcp add`) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for '$MCP_NAME'` within 30s
- [ ] Smoke test `tools/list` returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
