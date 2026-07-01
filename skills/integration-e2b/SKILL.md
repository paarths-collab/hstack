---
name: integration-e2b
description: Connect E2B (secure code interpreter sandboxes — Python/JS execution in isolated containers per call, filesystem, package install, jupyter kernels) to a self-hosted Hermes Agent over SSH. Uses E2B_API_KEY. Path A official stdio MCP via SDK wrapper; Path B direct REST against api.e2b.dev. Refuses long-lived sandbox handles by default. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-e2b — connect E2B code interpreter to a remote Hermes (SSH-first)

You are the engineer connecting E2B (managed code interpreter — isolated Linux sandboxes,
one per agent call, with Python/JS/shell, package install, jupyter kernels, filesystem
access) to a self-hosted Hermes agent on the user's VPS. You (the AI agent — Hermes, Claude
Code, Codex, Cursor, Gemini, OpenClaw, any of them) work over SSH as root against the VPS.
The user does one thing a machine cannot: mint the API key at https://e2b.dev/dashboard.

Everything else — key storage, live sandbox creation verification, MCP registration,
gateway reload, live code execution smoke test — runs on the VPS via SSH, idempotently
with a rollback path.

**Honest auth picture (verified 2026-06):** E2B uses **API-key auth** via `E2B_API_KEY`.
The old "access tokens" path was deprecated: no new tokens can be generated after
July 1 2026, and all existing tokens stop working August 1 2026. Use API keys.

Sources:
- https://e2b.dev/docs/api-key
- https://github.com/e2b-dev/code-interpreter
- https://github.com/e2b-dev/e2b

**Two paths:**

- **Path A (default) — official SDK-wrapper stdio MCP.** Runs the E2B Python or JS SDK
  as an MCP server via `uvx` or `npx`. Full sandbox lifecycle (create, exec, filesystem,
  destroy).
- **Path B (opt-in) — direct REST** against `https://api.e2b.dev` with `Authorization:
  Bearer <API_KEY>`. Same capabilities, no MCP indirection. Use if the SDK approach is
  too heavy.

**Why this matters for AI agents:** any agent that generates Python/JS code to solve a
task needs a safe place to run it. E2B gives you a container per call — no persistent
state between calls unless you keep the sandbox alive (which is a cost knob).

**Cost knob — sandbox lifetime:** by default sandboxes are ephemeral (spun up + torn
down per call, ~1s cold start). Long-lived sandboxes cost per-second while alive. Refuse
`KEEP_ALIVE_MINUTES` > 15 unless `LONG_LIVED_ACKNOWLEDGED=1` is set.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$E2B_API_KEY` | API key (`e2b_...` prefix) | https://e2b.dev/dashboard → API Keys → Create |
| `$E2B_TEMPLATE` *(optional)* | Sandbox template ID (custom images) | https://e2b.dev/dashboard → Templates. Default: `base` |
| `$KEEP_ALIVE_MINUTES` *(optional)* | How long to keep a sandbox alive after last use (default 5, max 15 unless `LONG_LIVED_ACKNOWLEDGED=1`) | Cost knob |
| `$LONG_LIVED_ACKNOWLEDGED` *(required if `KEEP_ALIVE_MINUTES` > 15)* | Set to `1` to acknowledge per-second billing | Cost gate |
| `$WIRE_PATH` *(optional)* | `A` (stdio MCP, default) or `B` (direct REST) | A requires `uvx` on VPS |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + Path A prereqs

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

if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires uvx on the VPS. Install: pip install uv"; exit 1; }
fi
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci e2b" || echo 0)
HAS_KEY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^E2B_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$HAS_KEY" = "1" ] && [ "${FORCE:-0}" != "1" ]; then
  if [ "${WIRE_PATH:-A}" = "A" ] && [ "$ALREADY" -gt 0 ]; then
    echo "E2B already wired (Path A). Set FORCE=1 to rewire."; exit 0
  fi
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    echo "E2B key present (Path B). Set FORCE=1 to rewire."; exit 0
  fi
fi
```

---

## Step 3 — HARD GATE (key format + long-lived acknowledgment + live API verify)

```bash
# Key format: e2b_<alphanumeric>
printf '%s' "$E2B_API_KEY" | grep -qE '^e2b_[A-Za-z0-9]+$' \
  || { echo "ABORT: E2B_API_KEY must start with 'e2b_'."; exit 1; }
[ "${#E2B_API_KEY}" -ge 30 ] \
  || { echo "ABORT: E2B_API_KEY looks too short."; exit 1; }

# Cost gate — refuse long-lived sandboxes without explicit ack
KEEP_ALIVE=${KEEP_ALIVE_MINUTES:-5}
if [ "$KEEP_ALIVE" -gt 15 ] && [ "${LONG_LIVED_ACKNOWLEDGED:-0}" != "1" ]; then
  echo "ABORT: KEEP_ALIVE_MINUTES=$KEEP_ALIVE > 15 requires LONG_LIVED_ACKNOWLEDGED=1."
  echo "Long-lived sandboxes bill per-second while alive. Confirm you understand the cost."
  exit 1
fi

# Live API verify — GET /sandboxes (list active sandboxes; empty result is OK)
HTTP=$(curl -sS -o /tmp/e2b.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $E2B_API_KEY" \
  'https://api.e2b.dev/sandboxes' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    ACTIVE=$(grep -oE '"sandboxID":"[^"]+"' /tmp/e2b.json | wc -l | tr -d ' ')
    echo "E2B API OK. Active sandboxes: $ACTIVE (each idle sandbox costs per-second)." ;;
  401|403) echo "ABORT: 401/403 — key rejected. Re-check https://e2b.dev/dashboard → API Keys."; exit 1 ;;
  *) echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/e2b.json | head -3; exit 1 ;;
esac
rm -f /tmp/e2b.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
KEEP_ALIVE=${KEEP_ALIVE_MINUTES:-5}
TEMPLATE=${E2B_TEMPLATE:-base}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write E2B_API_KEY (length ${#E2B_API_KEY}, prefix e2b_) via 'hermes config set'
    2. Write E2B_TEMPLATE ($TEMPLATE)
    3. Write E2B_KEEP_ALIVE_MINUTES ($KEEP_ALIVE)
    4. chmod 600 ~/.hermes/.env

  Path A (SDK-wrapper stdio MCP):
    5. Register MCP: hermes mcp add e2b --command uvx --args e2b-mcp-server
       --env E2B_API_KEY=\${E2B_API_KEY}
    6. Reload gateway: stop + run
    7. Verify in logs: grep "registered.*e2b"

  Path B (direct REST):
    5. No MCP registration; generic HTTP tool reads E2B_API_KEY
    6. Reload gateway: stop + run
    7. Smoke test: POST /sandboxes to create + immediately DELETE — expect 201 + 204

Key is NEVER printed in plaintext beyond a length + prefix.
Cost: sandbox lifetime $KEEP_ALIVE min — $([ "$KEEP_ALIVE" -gt 15 ] && echo "LONG-LIVED (per-second billing)" || echo "short (cost-safe default)")
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set E2B_API_KEY '$E2B_API_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set E2B_TEMPLATE '${E2B_TEMPLATE:-base}'"
ssh "$VPS_USER@$VPS_IP" "hermes config set E2B_KEEP_ALIVE_MINUTES '${KEEP_ALIVE_MINUTES:-5}'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^E2B_API_KEY=e2b_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: E2B key not written. Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put the API key in `config.yaml`.

---

## Step 6 — register the MCP (Path A) or document REST (Path B)

### Path A — SDK-wrapper stdio MCP

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add e2b \
      --command 'uvx' \
      --args 'e2b-mcp-server' \
      --env 'E2B_API_KEY=\${E2B_API_KEY},E2B_TEMPLATE=\${E2B_TEMPLATE}'
  "
fi
```

### Path B — direct REST

Generic HTTP tool reads env and uses:

- **Base URL:** `https://api.e2b.dev`
- **Auth:** `Authorization: Bearer ${E2B_API_KEY}`
- **Endpoints:**
  - `POST /sandboxes` — create sandbox (returns `sandboxID`)
  - `GET  /sandboxes` — list active
  - `POST /sandboxes/{id}/exec` — run a command
  - `POST /sandboxes/{id}/files/write` — upload file
  - `GET  /sandboxes/{id}/files/read?path=...` — read file
  - `DELETE /sandboxes/{id}` — destroy sandbox
  - `POST /sandboxes/{id}/keepalive` — extend lifetime

For Jupyter-style code execution, prefer the `e2b_code_interpreter` package which wraps
these endpoints and returns structured cell outputs.

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify + live sandbox create/destroy smoke test

```bash
if [ "${WIRE_PATH:-A}" = "A" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*e2b|MCP server.*e2b.*(ok|ready)"; then
      REGISTERED=1; echo "OK: e2b MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: e2b not in logs after 30s. Rolling back."; rollback; exit 1; }
fi

# Live smoke — create + immediately destroy sandbox (minimal cost)
SANDBOX_ID=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS --max-time 20 -X POST 'https://api.e2b.dev/sandboxes' \
    -H \"Authorization: Bearer \$E2B_API_KEY\" \
    -H 'Content-Type: application/json' \
    -d '{\"template\":\"'\"\$E2B_TEMPLATE\"'\"}' \
  | grep -oE '\"sandboxID\":\"[^\"]+\"' | head -1 | cut -d'\"' -f4
")
if [ -n "$SANDBOX_ID" ]; then
  echo "OK: E2B sandbox created ($SANDBOX_ID). Destroying immediately to save cost..."
  ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null --max-time 10 -X DELETE \
      \"https://api.e2b.dev/sandboxes/$SANDBOX_ID\" \
      -H \"Authorization: Bearer \$E2B_API_KEY\"
  "
  echo "OK: sandbox destroyed."
else
  echo "FAIL: could not create test sandbox. Rolling back."; rollback; exit 1
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "A" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove e2b 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^E2B_API_KEY=/d;
            /^E2B_TEMPLATE=/d;
            /^E2B_KEEP_ALIVE_MINUTES=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the key at https://e2b.dev/dashboard if compromised."
  echo "IMPORTANT: manually destroy any lingering sandboxes at https://e2b.dev/dashboard → Sandboxes → Kill."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Long-lived sandboxes eating credits overnight | Per-second billing while sandbox is alive; forgotten sandbox = surprise bill | Step 3 refuses `KEEP_ALIVE_MINUTES>15` without `LONG_LIVED_ACKNOWLEDGED=1`; agent tools must call DELETE at end of use |
| 2 | Agent doesn't destroy sandboxes after use | Zombie sandboxes accumulate | Wrap sandbox creation in a with-block / defer; monitor active count at dashboard |
| 3 | Using the deprecated access-token flow | Access tokens stop working Aug 1 2026 | Step 3 refuses non-`e2b_` prefixes |
| 4 | Executing untrusted code with network access | Sandbox has internet — data exfiltration possible | Set `internetAccess:false` on sandbox creation for code-only tasks |
| 5 | Uploading secrets to sandbox filesystem | Sandbox lifetime > secret sensitivity | Never write secrets into sandbox; pass via env at exec time |
| 6 | Free-tier concurrent-sandbox limits | Bursty agent runs hit concurrency cap → 429 | Serialize sandbox creates; upgrade if needed |
| 7 | Key in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 8 | Custom template with vulnerable base image | Template pulls persist across all sandboxes from it | Pin template image versions; rebuild periodically |
| 9 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 10 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 11 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 12 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 13 | Assuming sandbox persists across agent turns | Ephemeral by default; state resets on destroy | Set `keep_alive` explicitly, and pass sandboxID across turns |
| 14 | Sandbox timeout mid-execution | Default 5min timeout; long-running code gets killed | Extend timeout in sandbox creation for known-long jobs; or split into steps |
| 15 | Community MCP wrappers claiming E2B support | Some are stale (still use deprecated tokens) | This skill wires only the official `e2b-mcp-server` package |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Path A: `uvx` present on VPS
- [ ] Idempotency check ran (skipped if already wired, unless `FORCE=1`)
- [ ] HARD GATE passed: key starts with `e2b_` + ≥30 chars; `KEEP_ALIVE_MINUTES ≤15` OR `LONG_LIVED_ACKNOWLEDGED=1`; live `/sandboxes` returned 200
- [ ] Dry-run shown to user; cost mode (short vs long-lived) called out; user approved (or `AUTO_APPROVE=1`)
- [ ] Env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: stdio MCP registered with `E2B_API_KEY=${E2B_API_KEY}` indirection
- [ ] Path B: REST surface documented (base + Bearer + endpoints)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'e2b'` within 30s
- [ ] Smoke test: sandbox created + destroyed successfully from VPS
- [ ] User told about zombie-sandbox risk; recommends monitoring active count
- [ ] User told: for untrusted code, set `internetAccess:false` at sandbox creation
- [ ] Rollback function defined; manual sandbox-kill instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, sandbox
lifecycle, and E2B billing failure modes.
