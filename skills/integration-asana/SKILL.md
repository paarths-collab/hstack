---
name: integration-asana
description: Connect Asana (team task management) to a self-hosted Hermes Agent over SSH so it can read and create tasks, projects, and comments. Wires the REST API with a static Personal Access Token. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-asana — connect Asana to a remote Hermes (SSH-first)

You are the engineer connecting Asana to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Personal Access Token in the Asana UI.
2. Confirm the workspace GID the agent should operate in.

Everything else — token storage, MCP/REST registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Asana ships a first-party remote MCP at
`https://mcp.asana.com/v2/mcp` (streamable HTTP), but it is **OAuth-only** — it requires
a browser handshake against a registered client ID/secret and rejects static bearer tokens.
A headless Hermes container cannot complete that flow unattended. The V1 beta endpoint
`https://mcp.asana.com/sse` is deprecated and shuts down 2026-05-11 — do not use it.
So we do NOT wire the hosted MCP. We use the **REST API with a Personal Access Token (PAT)**
— a static credential that needs no browser and is perfect for headless self-hosted agents.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$ASANA_ACCESS_TOKEN` | Personal Access Token (treat as opaque) | <https://app.asana.com/0/my-apps> → "Personal access tokens" → "Create new token" → agree to API terms → name it `hermes-agent` → copy once |
| `$ASANA_WORKSPACE_GID` | The workspace the agent will operate in | Captured automatically in Step 1 from `GET /users/me` |

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

While we have a shell open, validate the PAT against the live REST API. The base is
`https://app.asana.com/api/1.0`; the PAT goes in `Authorization: Bearer <token>`.

```bash
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w 'users/me = %{http_code}\n' \
    -H 'Authorization: Bearer $ASANA_ACCESS_TOKEN' \
    https://app.asana.com/api/1.0/users/me
"
```

- `200` → token valid; capture the workspace GID for later writes.
- `401` → token wrong, revoked, or has stray whitespace. Abort, do not store.

Capture the workspace GID (most write endpoints need it):

```bash
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -H 'Authorization: Bearer $ASANA_ACCESS_TOKEN' \
    'https://app.asana.com/api/1.0/users/me?opt_fields=workspaces.name,workspaces.gid' \
    | head -c 800
"
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci asana" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Asana is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write ASANA_ACCESS_TOKEN (length ${#ASANA_ACCESS_TOKEN}, prefix ${ASANA_ACCESS_TOKEN:0:4}...) via 'hermes config set'
  2. chmod 600 ~/.hermes/.env
  3. Register tool: REST API at https://app.asana.com/api/1.0 (Path B — no static-token MCP exists)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep -i "registered.*asana"
  6. Smoke test: GET https://app.asana.com/api/1.0/users/me -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set ASANA_ACCESS_TOKEN '$ASANA_ACCESS_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^ASANA_ACCESS_TOKEN=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: ASANA_ACCESS_TOKEN not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — PATs are opaque and may contain `/`, `+`, `=`; **never use
> `echo >>`** which merges onto the previous line if it lacks a trailing newline):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^ASANA_ACCESS_TOKEN=' ~/.hermes/.env || printf 'ASANA_ACCESS_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^ASANA_ACCESS_TOKEN=.*|ASANA_ACCESS_TOKEN=$ASANA_ACCESS_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Asana tool

Asana does NOT have a first-party static-token MCP server. Pick the path that matches the
Hermes build on the VPS. Path B is the recommended default; Path A is only for users who
have vetted a third-party MCP server and want stdio tools.

### Path A (optional) — community stdio MCP server with static token

A widely used community server is `roychri/mcp-server-asana`
(<https://github.com/roychri/mcp-server-asana>), which authenticates with an Asana PAT via the
`ASANA_ACCESS_TOKEN` env var. It is a stdio/Node server, not a hosted HTTP endpoint. Treat
it as third-party and audit before using.

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add asana \
    --command npx \
    --args '-y,@roychri/mcp-server-asana' \
    --env 'ASANA_ACCESS_TOKEN=\${ASANA_ACCESS_TOKEN}'
"
```

The flag names vary by Hermes version. If unsure, run `hermes mcp add --help` first and
match its stdio syntax. The token stays in `~/.hermes/.env` and is referenced via
`${ASANA_ACCESS_TOKEN}` indirection — never inlined.

### Path B (recommended default) — generic HTTP tool against the Asana REST API

- **Base URL:** `https://app.asana.com/api/1.0`
- **Auth header:** `Authorization: Bearer ${ASANA_ACCESS_TOKEN}`
- **Content type:** `Content-Type: application/json`
- **Common endpoints:**
  - `GET /users/me` — identity + workspaces
  - `GET /workspaces` — list workspaces
  - `GET /projects?workspace=<gid>` — list projects
  - `GET /tasks?assignee=me&workspace=<gid>` — my tasks
  - `POST /tasks` with `{"data":{"workspace":"<gid>","name":"...","assignee":"me"}}`

Do NOT try to register `https://mcp.asana.com/v2/mcp` with a bearer token — that endpoint
is OAuth-only and will return an auth error. Do NOT register the deprecated
`https://mcp.asana.com/sse` either (shuts down 2026-05-11).

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

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*asana|MCP server.*asana.*(ok|ready)|tool.*asana.*loaded"; then
    REGISTERED=1
    echo "OK: asana registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: asana not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (inside the container so the token stays on the VPS)

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X GET 'https://app.asana.com/api/1.0/users/me' \
    -H \"Authorization: Bearer \$ASANA_ACCESS_TOKEN\"
")
case "$HTTP" in
  200) echo "OK: Asana API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but no scope. PAT has full user access — confirm workspace membership."; exit 1 ;;
  429) echo "WARN: rate-limited. Respect Retry-After header and retry."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Asana API. Check manually." ;;
esac
```

`200` with a body identifying the authenticated user means the token works. Prove it
end-to-end from chat:

```
@<agent> list my Asana tasks in <workspace>
```

A valid empty list is a pass — every layer worked.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove asana 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset ASANA_ACCESS_TOKEN 2>/dev/null || \
    sed -i '/^ASANA_ACCESS_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Asana is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring the hosted `mcp.asana.com/v2/mcp` with a token | It is **OAuth-only**; needs registered client ID/secret + browser handshake; bearer tokens are rejected | Use REST (Path B) or the community stdio server (Path A) |
| 2 | Wiring the deprecated `mcp.asana.com/sse` | V1 beta endpoint shuts down 2026-05-11 | Do not use; pin Path B |
| 3 | PAT acts as the whole user across all workspaces | No per-scope restrictions on a PAT; carries full access of the human who minted it | Mint from a dedicated service user with access only to needed workspace/projects |
| 4 | Token treated as a parseable string | PATs are opaque; Asana may change the format | Treat as a password; never pattern-match or split |
| 5 | Silently expired token returns `401` | PATs are persistent by default, but Enterprise+ admins can enforce expiry | Watch for sudden `401`s; rotate proactively |
| 6 | Missing `workspace` GID on writes | Most write endpoints (`POST /tasks`) require it | Capture in Step 1; reuse from `$ASANA_WORKSPACE_GID` |
| 7 | Rate limits (`429 Too Many Requests`) | Per-token rate limits; free tier lower than paid | Respect `Retry-After` header; back off and retry |
| 8 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env` (`/opt/data/.env` inside container), `chmod 600`, via `config set` |
| 9 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 10 | `echo >> .env` instead of `config set` | Merges onto a prior line without trailing newline; key is silently invalid | Always `hermes config set`; sed-fallback uses `printf` then `sed -i` |
| 11 | sed with `/` delimiter on tokens | PATs may contain `/`, `+`, `=` | Always use `\|` delimiter |
| 12 | Container vs host confusion | Skill assumed wrong layer; SSH keys added inside container are invisible to host sshd | Always check `whoami; hostname` first |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] PAT validated against `https://app.asana.com/api/1.0/users/me` (returns `200`)
- [ ] Workspace GID captured for later writes
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `ASANA_ACCESS_TOKEN` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Tool registered via Path A (community stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'asana'` within 30s
- [ ] Smoke test: `GET /users/me` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)
- [ ] OAuth-only MCP caveat communicated to the user (no static-token first-party MCP as of 2026-06)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
