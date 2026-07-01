---
name: integration-mailchimp
description: Connect Mailchimp (email marketing — campaigns, audiences, lists, automations) and optionally Mandrill (transactional) to a self-hosted Hermes Agent over SSH. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-mailchimp — connect Mailchimp to a remote Hermes (SSH-first)

You are the engineer connecting Mailchimp to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over SSH
as root against the VPS. The user only does the two things a machine cannot: mint the API
key in the Mailchimp UI, and (for transactional) enable the **AI Agents** permission group
on a restricted Mandrill key.

Everything else — token storage, MCP/REST registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Mailchimp ships **one** official hosted remote MCP
server, and it covers **Transactional Messaging only** (the Mandrill product) at
`https://mandrillapp.com/mcp` with bearer auth. There is **no first-party remote MCP for the
Marketing API** (campaigns, audiences, lists, automations). For Marketing API work we wire
the REST surface directly (Path B). Community MCPs exist (Pipeworx, cyanheads, Apify, Zapier)
but are not first-party and are not wired here by default. Path A in this skill = Mandrill
MCP for transactional; Path B = Marketing REST for campaigns/audiences. Run either or both.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$MC_KEY` | Marketing API key — `32hex-<dc>`, e.g. `abc...def-us21` (Path B) | <https://admin.mailchimp.com/account/api> → **Create A Key** |
| `$MANDRILL_KEY` | Mandrill transactional key (Path A only) | Mandrill app → **Settings → SMTP & API Info** |
| AI Agents permission | Required if Mandrill key is restricted (Path A) | Mandrill UI → toggle **AI Agents** permission group on the key |

Derive the data center from the marketing key suffix (Path B):

```bash
MC_DC=$(printf '%s' "$MC_KEY" | awk -F- '{print $NF}')   # e.g. us21
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

---

## Step 2 — idempotency check (skip if already wired)

Check for either the Mandrill MCP (Path A) or the Marketing REST env vars (Path B):

```bash
ALREADY_A=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci mandrill" || echo 0)
ALREADY_B=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MAILCHIMP_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if { [ "$ALREADY_A" -gt 0 ] || [ "$ALREADY_B" -gt 0 ]; } && [ "${FORCE:-0}" != "1" ]; then
  echo "Mailchimp/Mandrill already wired (A=$ALREADY_A B=$ALREADY_B). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:

  Path B (Marketing REST, if \$MC_KEY set):
    1. Write MAILCHIMP_API_KEY (length ${#MC_KEY}, prefix ${MC_KEY:0:4}...) via 'hermes config set'
    2. Write MAILCHIMP_DC=${MC_DC} via 'hermes config set'
    3. chmod 600 ~/.hermes/.env
    4. Smoke test: GET https://${MC_DC}.api.mailchimp.com/3.0/ping → expect 200

  Path A (Mandrill MCP, if \$MANDRILL_KEY set):
    5. Write MCP_MANDRILL_API_KEY (length ${#MANDRILL_KEY}, prefix ${MANDRILL_KEY:0:4}...) via 'hermes config set'
    6. Register MCP: hermes mcp add mandrill --url https://mandrillapp.com/mcp --auth Bearer
    7. Verify in logs: grep -i "registered.*mandrill"

  Final:
    8. Reload gateway: hermes gateway stop && hermes gateway run (NOT restart)

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secrets (chmod 600, no echo, no logging)

Path B (Marketing) — write both the key and the data center:

```bash
if [ -n "$MC_KEY" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MAILCHIMP_API_KEY '$MC_KEY'"
  ssh "$VPS_USER@$VPS_IP" "hermes config set MAILCHIMP_DC '$MC_DC'"
fi
```

Path A (Mandrill):

```bash
if [ -n "$MANDRILL_KEY" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set MCP_MANDRILL_API_KEY '$MANDRILL_KEY'"
fi
```

Always lock the env file:

```bash
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each var landed (returns `1`, NEVER the value):

```bash
[ -n "$MC_KEY" ] && {
  WROTE_K=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MAILCHIMP_API_KEY=' ~/.hermes/.env" || echo 0)
  WROTE_D=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MAILCHIMP_DC=' ~/.hermes/.env" || echo 0)
  [ "$WROTE_K" = "1" ] && [ "$WROTE_D" = "1" ] \
    || { echo "FAIL: Marketing vars not written. Rolling back."; rollback; exit 1; }
}
[ -n "$MANDRILL_KEY" ] && {
  WROTE_M=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^MCP_MANDRILL_API_KEY=' ~/.hermes/.env" || echo 0)
  [ "$WROTE_M" = "1" ] \
    || { echo "FAIL: Mandrill var not written. Rolling back."; rollback; exit 1; }
}
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern. The `|`
> delimiter is mandatory — Mailchimp keys contain `-` and Mandrill keys may contain `/+=`:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^MAILCHIMP_API_KEY=' ~/.hermes/.env || printf 'MAILCHIMP_API_KEY=\n' >> ~/.hermes/.env
>   grep -q '^MAILCHIMP_DC='      ~/.hermes/.env || printf 'MAILCHIMP_DC=\n'      >> ~/.hermes/.env
>   sed -i 's|^MAILCHIMP_API_KEY=.*|MAILCHIMP_API_KEY=$MC_KEY|' ~/.hermes/.env
>   sed -i 's|^MAILCHIMP_DC=.*|MAILCHIMP_DC=$MC_DC|'           ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

Never `echo >>` — it can merge onto a prior line without a trailing newline and silently
corrupt the env file. Never put secrets in `config.yaml`.

---

## Step 5 — register the integration surfaces

### Path A (preferred for transactional) — official Mandrill MCP (hosted, bearer auth)

Verified shape:

- **URL:** `https://mandrillapp.com/mcp`
- **Auth:** `Authorization: Bearer ${MCP_MANDRILL_API_KEY}`
- **Coverage:** transactional only (`call_api`, `diagnose_failed_send`, `build_template`, ...).
  Does **not** see campaigns/audiences/lists.

```bash
if [ -n "$MANDRILL_KEY" ]; then
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add mandrill \
      --url 'https://mandrillapp.com/mcp' \
      --auth-header 'Authorization' \
      --auth-scheme 'Bearer' \
      --placeholder-token 'placeholder'
  "
  # Inject real token with pipe delimiter (Mandrill keys may contain /+=)
  ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$MCP_MANDRILL_API_KEY\"'|g' ~/.hermes/config.yaml"
fi
```

If the Mandrill key is **restricted**, you must enable the **AI Agents** permission group in
the Mandrill UI first or every `tools/call` returns an auth error even though `initialize`
succeeds.

### Path B (fallback for Marketing — no first-party MCP exists) — REST surface

Point a generic HTTP/tool capability at the REST base. The data center is part of the host:

- **Base URL:** `https://${MAILCHIMP_DC}.api.mailchimp.com/3.0`
- **Auth header:** `Authorization: Bearer ${MAILCHIMP_API_KEY}` (HTTP Basic also accepted;
  username is anything, password is the full key including suffix)
- **Content type:** `Content-Type: application/json`

Common endpoints:

| Action | Method + path |
|---|---|
| List audiences | `GET /lists` |
| Add subscriber | `POST /lists/{list_id}/members` |
| Update subscriber | `PATCH /lists/{list_id}/members/{subscriber_hash}` |
| List campaigns | `GET /campaigns` |
| Send campaign | `POST /campaigns/{campaign_id}/actions/send` |
| Campaign report | `GET /reports/{campaign_id}` |
| Search members | `GET /search-members?query=...` |

> `subscriber_hash` is the **lowercased MD5** of the email. Mailchimp rejects raw emails on
> member endpoints.

**Opt-in community MCP (only if the user vets it):** community servers exist (Pipeworx,
cyanheads, Apify, Zapier). They are not first-party and proxy the account key. If the user
explicitly wants one wired, run `/hermes-mcp-add` against the chosen URL with the user's
chosen bearer scheme; do not assume the auth shape, probe it.

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

Only required if Path A (Mandrill MCP) was wired. Path B is REST-only and has no MCP
registration log line.

```bash
if [ -n "$MANDRILL_KEY" ]; then
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
         | grep -qiE "registered.*tool.*mandrill|MCP server.*mandrill.*(ok|ready)"; then
      REGISTERED=1
      echo "OK: mandrill registered in gateway logs."
      break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] \
    || { echo "FAIL: mandrill not in logs after 30s. Rolling back."; rollback; exit 1; }
fi
```

---

## Step 8 — live API smoke test (inside the container so tokens stay on the VPS)

### Path B (Marketing) — `/3.0/ping`

```bash
if [ -n "$MC_KEY" ]; then
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w '%{http_code}' \
      -H \"Authorization: Bearer \$MAILCHIMP_API_KEY\" \
      \"https://\$MAILCHIMP_DC.api.mailchimp.com/3.0/ping\"
  ")
  case "$HTTP" in
    200) echo "OK: Mailchimp Marketing API reachable, key + DC valid." ;;
    401) echo "FAIL: marketing key invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
    403) echo "FAIL: key valid but no scope on this account."; exit 1 ;;
    000) echo "FAIL: DNS failure — MAILCHIMP_DC '$MC_DC' likely wrong."; rollback; exit 1 ;;
    *)   echo "WARN: unexpected HTTP $HTTP from Mailchimp Marketing API." ;;
  esac

  # Confirm list scope too
  ssh "$VPS_USER@$VPS_IP" "
    curl -sS -o /dev/null -w 'lists: %{http_code}\n' \
      -H \"Authorization: Bearer \$MAILCHIMP_API_KEY\" \
      \"https://\$MAILCHIMP_DC.api.mailchimp.com/3.0/lists?count=1\"
  "
fi
```

`200` on `/ping` returns `"health_status":"Everything's Chimpy!"` (visible with `-o -`).

### Path A (Transactional) — Mandrill MCP via gateway logs + chat test

The MCP was verified in Step 7. An end-to-end chat call (`@<agent> using mandrill, send a
test transactional email to <addr>`) is the final live check.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove mandrill 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    hermes config unset MAILCHIMP_API_KEY 2>/dev/null || sed -i '/^MAILCHIMP_API_KEY=/d' ~/.hermes/.env
    hermes config unset MAILCHIMP_DC      2>/dev/null || sed -i '/^MAILCHIMP_DC=/d'      ~/.hermes/.env
    hermes config unset MCP_MANDRILL_API_KEY 2>/dev/null || sed -i '/^MCP_MANDRILL_API_KEY=/d' ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Mailchimp/Mandrill is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using the marketing key without its data center suffix | Base URL is `https://<dc>.api.mailchimp.com/3.0`; missing `dc` returns DNS failure (`000`) or 404 | Always split on `-` and store `MAILCHIMP_DC` alongside the key |
| 2 | Expecting the official MCP to cover campaigns | `mandrillapp.com/mcp` is **Transactional only**; Marketing API has no first-party MCP | Path A for transactional; Path B (REST) for marketing |
| 3 | Passing raw email to `/lists/.../members/{hash}` | Endpoint expects lowercased MD5 of the email | Hash with `md5(lower(email))` before the call |
| 4 | Restricted Mandrill key with no AI Agents permission | `initialize` succeeds, `tools/call` 401s | Toggle **AI Agents** permission group in the Mandrill UI |
| 5 | Sending campaigns from a non-verified domain | Mailchimp blocks send with cryptic 400 | Verify the sending domain (DKIM/SPF) in Mailchimp before testing send |
| 6 | Rate limits | Marketing API limits at 10 simultaneous connections per account; bursts get `429` | Serialize bulk member adds; use batch operations (`POST /batches`) for >1000 ops |
| 7 | Wiring an unvetted community MCP | Community servers proxy your account key; a bad one exfiltrates the audience | Only wire community MCPs the user explicitly approves; prefer REST until then |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >>` instead of `hermes config set` | Can merge onto a prior line without trailing newline; silently corrupts env | Always `hermes config set` |
| 10 | Secret in `config.yaml` instead of `~/.hermes/.env` | World-readable; not loaded by Hermes runtime | Only `~/.hermes/.env`, `chmod 600` |
| 11 | sed with `/` delimiter on tokens | Keys contain `-/+=`; sed breaks or rewrites wrong span | Always use `\|` delimiter |
| 12 | Container vs host confusion | Skill assumed wrong layer; SSH keys added inside container vanish on the host | Step 1 has a hard host/container check |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Path B: `MAILCHIMP_API_KEY` and `MAILCHIMP_DC` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Path A: `MCP_MANDRILL_API_KEY` in `~/.hermes/.env`; `mandrillapp.com/mcp` registered; **AI Agents** permission enabled if restricted
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Path A: logs show `registered N tool(s) for 'mandrill'` within 30s
- [ ] Path B: `GET /3.0/ping` from inside the container returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, MCP, and data-center suffix failure modes.
