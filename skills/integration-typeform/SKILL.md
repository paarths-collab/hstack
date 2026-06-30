---
name: integration-typeform
description: Connect Typeform (forms, surveys, NPS) to a self-hosted Hermes Agent over SSH using a static tfp_ personal access token. No first-party MCP — uses REST API (Path A, default) or community stdio MCP pinned by SHA (Path B). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-typeform — connect Typeform to a remote Hermes (SSH-first)

You are the engineer connecting Typeform to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user does one thing a machine cannot: mint a `tfp_` personal
access token at https://admin.typeform.com/user/tokens with the right scopes.

Everything else — credential storage, live API verification, gateway reload, smoke test —
runs on the VPS via SSH, idempotently with a rollback path.

**Honest auth picture (verified 2026-06):** Typeform's official APIs (Create, Responses,
Webhooks) use a **static personal access token** (`tfp_...`) sent as `Authorization: Bearer`.
**No first-party Typeform MCP server is verified.**

- **Path A (default — REST):** generic HTTP tool layer hits `https://api.typeform.com`. Zero
  third-party code in the trust path.
- **Path B (opt-in — community stdio MCP):** `github.com/dscovr/typeform-mcp` exposes
  forms/responses as MCP tools. NOT first-party — review source + pin by commit SHA before
  trusting.

Hosted third-party "Typeform MCP" services (Gumloop, viaSocket) require sending the `tfp_`
token to a vendor — defeats self-hosting. This skill does NOT wire them.

**Scopes matter:** the token inherits the minting user's workspace access AND the scopes
checked at mint time. Typical scopes: `forms:read`, `responses:read`, `webhooks:read`,
`webhooks:write`; add `forms:write` only if Hermes will create forms.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$TYPEFORM_TOKEN` | Personal access token starting with `tfp_` | https://admin.typeform.com/user/tokens → Generate new token → name + scopes → copy ONCE |
| `$WIRE_PATH` *(optional)* | `A` (REST, default) or `B` (community stdio MCP) | B requires `uvx` on the VPS |
| `$TYPEFORM_MCP_SHA` *(Path B only)* | Commit SHA of `dscovr/typeform-mcp` to pin | Inspect the repo before adopting; copy a recent reviewed SHA |

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
HAS_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TYPEFORM_TOKEN=tfp_' ~/.hermes/.env 2>/dev/null" || echo 0)
ALREADY_MCP=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci typeform" || echo 0)
if [ "$HAS_TOKEN" = "1" ] && [ "${WIRE_PATH:-A}" = "A" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Typeform already wired (Path A). Set FORCE=1 to rewire."; exit 0
fi
if [ "$HAS_TOKEN" = "1" ] && [ "${WIRE_PATH:-A}" = "B" ] && [ "$ALREADY_MCP" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Typeform already wired (Path B). Set FORCE=1 to rewire."; exit 0
fi
```

---

## Step 3 — HARD GATE (token format + live `/me` verify)

```bash
# Token format
printf '%s' "$TYPEFORM_TOKEN" | grep -qE '^tfp_[A-Za-z0-9_-]+$' \
  || { echo "ABORT: TYPEFORM_TOKEN must start with 'tfp_'."; exit 1; }

# Live /me check (proves token + workspace access)
HTTP=$(curl -sS -o /tmp/tf.json -w '%{http_code}' --max-time 10 \
  -H "Authorization: Bearer $TYPEFORM_TOKEN" \
  'https://api.typeform.com/me' 2>/dev/null) || HTTP=000
case "$HTTP" in
  200)
    EMAIL=$(grep -oE '"email":"[^"]+"' /tmp/tf.json | head -1 | cut -d'"' -f4)
    echo "Typeform OK. Token belongs to: $EMAIL" ;;
  401) echo "ABORT: 401 — token rejected."; exit 1 ;;
  403) echo "ABORT: 403 — token has no workspace access. Re-mint from a user who owns the target workspace."; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP."; cat /tmp/tf.json | head -3; exit 1 ;;
esac
rm -f /tmp/tf.json

# Path B: require uvx on the VPS + a pinned SHA
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1" \
    || { echo "ABORT: Path B requires uvx on the VPS. Install: pip install uv"; exit 1; }
  [ -n "${TYPEFORM_MCP_SHA:-}" ] \
    || { echo "ABORT: Path B requires \$TYPEFORM_MCP_SHA (a reviewed commit SHA, NOT 'main')."; exit 1; }
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-A}
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN

  Always:
    1. Write TYPEFORM_TOKEN (length ${#TYPEFORM_TOKEN}, prefix tfp_) via 'hermes config set'
    2. chmod 600 ~/.hermes/.env

  Path A (REST):
    3. No MCP server to register; generic HTTP tool layer reads env var
    4. Reload gateway: stop + run
    5. Smoke test: GET /me and GET /forms?page_size=1 — expect 200

  Path B (community stdio MCP, pinned to SHA ${TYPEFORM_MCP_SHA:-<unset>}):
    3. Register MCP: hermes mcp add typeform --command uvx --args --from,git+https://...@$TYPEFORM_MCP_SHA,typeform-mcp
    4. Reload gateway: stop + run
    5. Verify in logs: grep "registered.*typeform"

Token is NEVER printed in plaintext beyond a length + prefix.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write the token (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set TYPEFORM_TOKEN '$TYPEFORM_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^TYPEFORM_TOKEN=tfp_' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: token not written. Rolling back."; rollback; exit 1; }
```

> Sed fallback (pipe delimiter):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^TYPEFORM_TOKEN=' ~/.hermes/.env || printf 'TYPEFORM_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^TYPEFORM_TOKEN=.*|TYPEFORM_TOKEN=$TYPEFORM_TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>`. Never put the token in `config.yaml`. Never send to a hosted 3rd-party MCP.

---

## Step 6 — wire the chosen path

### Path A (REST — default)

Generic HTTP tool layer reads `TYPEFORM_TOKEN` and calls:

- **Base URL:** `https://api.typeform.com`
- **Auth:** `Authorization: Bearer ${TYPEFORM_TOKEN}`
- **Content-Type:** `application/json`

Common endpoints:
- `GET /me` — token-validity probe
- `GET /forms` — list forms in workspace
- `GET /forms/{form_id}` — read form structure
- `GET /forms/{form_id}/responses?page_size=50` — fetch submissions (paginate via `before`/`after`)
- `PUT /forms/{form_id}/webhooks/{tag}` — register webhook for real-time submission events

### Path B (community stdio MCP, opt-in)

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add typeform \
      --command 'uvx' \
      --args '--from,git+https://github.com/dscovr/typeform-mcp@$TYPEFORM_MCP_SHA,typeform-mcp' \
      --env 'TYPEFORM_TOKEN=\${TYPEFORM_TOKEN}'
  "
fi
```

Pin by SHA, not `main` — community packages can land malicious code in `main` between
reviews.

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify

```bash
if [ "${WIRE_PATH:-A}" = "B" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs gateway -n 200 2>&1" \
         | grep -qiE "registered.*tool.*typeform|MCP server.*typeform"; then
      REGISTERED=1; echo "OK: typeform MCP registered."; break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: typeform not in logs. Rolling back."; rollback; exit 1; }
fi

# Smoke test for both paths
HTTP_ME=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$TYPEFORM_TOKEN\" \
    'https://api.typeform.com/me'
")
HTTP_FORMS=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H \"Authorization: Bearer \$TYPEFORM_TOKEN\" \
    'https://api.typeform.com/forms?page_size=1'
")
echo "Smoke: /me=$HTTP_ME, /forms=$HTTP_FORMS (both should be 200)."
[ "$HTTP_ME" = "200" ] || { echo "FAIL: /me from VPS returned $HTTP_ME. Rolling back."; rollback; exit 1; }
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  if [ "${WIRE_PATH:-A}" = "B" ]; then
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove typeform 2>/dev/null || true"
  fi
  ssh "$VPS_USER@$VPS_IP" "sed -i '/^TYPEFORM_TOKEN=/d' ~/.hermes/.env && chmod 600 ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the token at https://admin.typeform.com/user/tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Sending token to hosted 3rd-party "Typeform MCP" (Gumloop, viaSocket) | Leaks `tfp_` to a vendor; defeats self-hosting | This skill refuses to wire hosted 3rd-party MCPs |
| 2 | Token scopes too narrow | Calls return 403 on otherwise-valid endpoints | At mint, check `forms:read`, `responses:read`, plus `webhooks:*` if needed |
| 3 | Token from a user without workspace access | 403 even with correct scopes | Mint from a user who owns/joins target workspace; Step 3 catches via `/me` |
| 4 | Hardcoding form IDs | IDs differ across staging/prod copies | Resolve via `GET /forms`; store in Hermes memory |
| 5 | Polling instead of webhooks | Burns rate limit; misses fast submissions | `PUT /forms/{id}/webhooks/{tag}` for real-time |
| 6 | Token in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 7 | Path B with `@main` instead of pinned SHA | Supply-chain risk | This skill requires `$TYPEFORM_MCP_SHA` |
| 8 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 9 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 10 | sed with `/` delimiter | Universal rule | Always `\|` delimiter |
| 11 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 12 | Confusing Typeform with Tally / Google Forms | Different APIs and tokens | This skill is Typeform-only; `tfp_` prefix is the marker |
| 13 | Rate limits (per-user, per-token) | Bursty pulls 429 | Use webhooks for events; paginate, don't loop |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if already wired for chosen path, unless `FORCE=1`)
- [ ] HARD GATE passed: token starts with `tfp_`; live `/me` returned 200 with an email; Path B → uvx present + SHA pinned
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] `TYPEFORM_TOKEN` written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path A: no MCP registration; generic HTTP tool documented
- [ ] Path B: stdio MCP registered with pinned SHA; logs show `registered N tool(s)` within 30s
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: `/me` AND `/forms?page_size=1` from inside container both returned 200
- [ ] Rollback function defined; token revocation URL included
- [ ] User informed that hosted 3rd-party MCPs (Gumloop/viaSocket) are NOT wired

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, scope,
and Typeform workspace-access failure modes.
