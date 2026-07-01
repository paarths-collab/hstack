---
name: integration-postmark
description: Connect Postmark (transactional email) to a self-hosted Hermes Agent over SSH using a static Server API token. Use when any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini) needs to send transactional emails, dispatch template emails, list templates, or pull delivery stats. Idempotent and rollback-safe.
---

# /integration-postmark — connect Postmark to a remote Hermes (SSH-first)

You are the engineer connecting Postmark to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Mint the Server API token in the Postmark dashboard.
2. Verify a Sender Signature or sending Domain (without this, every send is rejected).

Everything else — token storage, MCP registration, gateway reload, verification — runs
on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Postmark Labs (ActiveCampaign) ships an official
**stdio** MCP server at `@activecampaign/postmark-mcp`
(<https://github.com/ActiveCampaign/postmark-mcp>). There is **no hosted/remote HTTP MCP
endpoint** for Postmark — do not try to wire `mcp.postmarkapp.com`; it does not exist. Auth
is a static **Server API token** passed via `POSTMARK_SERVER_TOKEN`; every REST call carries
it as the `X-Postmark-Server-Token` header (NOT `Authorization: Bearer`). Perfect fit for a
headless agent: no OAuth dance, no user redirect.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$POSTMARK_SERVER_TOKEN` | Server-scoped API token (NOT Account, NOT SMTP) | <https://account.postmarkapp.com/servers> → pick Server → **API Tokens** tab → copy |
| `$POSTMARK_FROM_ADDRESS` | Verified From address | Postmark dashboard → Sender Signatures or Domains (must be confirmed) |

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

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci postmark" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Postmark is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write POSTMARK_SERVER_TOKEN (length ${#POSTMARK_SERVER_TOKEN}, prefix ${POSTMARK_SERVER_TOKEN:0:4}...) via 'hermes config set'
  2. Write POSTMARK_FROM_ADDRESS=$POSTMARK_FROM_ADDRESS via 'hermes config set'
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add postmark --command npx --args -y,@activecampaign/postmark-mcp
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*postmark"
  7. Smoke test: GET https://api.postmarkapp.com/templates?count=1 -> expect 200

The token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set POSTMARK_SERVER_TOKEN '$POSTMARK_SERVER_TOKEN'"
ssh "$VPS_USER@$VPS_IP" "hermes config set POSTMARK_FROM_ADDRESS '$POSTMARK_FROM_ADDRESS'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each landed (returns `1` per var, NEVER the value):

```bash
WROTE_TOKEN=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^POSTMARK_SERVER_TOKEN=' ~/.hermes/.env" || echo 0)
WROTE_FROM=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^POSTMARK_FROM_ADDRESS=' ~/.hermes/.env" || echo 0)
[ "$WROTE_TOKEN" = "1" ] && [ "$WROTE_FROM" = "1" ] \
  || { echo "FAIL: Postmark env not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter — Postmark tokens are UUID-shaped but always use `|` to stay safe):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^POSTMARK_SERVER_TOKEN=' ~/.hermes/.env || printf 'POSTMARK_SERVER_TOKEN=\n' >> ~/.hermes/.env
>   sed -i 's|^POSTMARK_SERVER_TOKEN=.*|POSTMARK_SERVER_TOKEN=$POSTMARK_SERVER_TOKEN|' ~/.hermes/.env
>   grep -q '^POSTMARK_FROM_ADDRESS=' ~/.hermes/.env || printf 'POSTMARK_FROM_ADDRESS=\n' >> ~/.hermes/.env
>   sed -i 's|^POSTMARK_FROM_ADDRESS=.*|POSTMARK_FROM_ADDRESS=$POSTMARK_FROM_ADDRESS|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the Postmark MCP server

Pick the path that matches the Hermes build on the VPS. Path A is preferred.

### Path A (preferred) — official stdio MCP server with static token

The official server `@activecampaign/postmark-mcp` reads `POSTMARK_SERVER_TOKEN` and
exposes `send_email`, `send_email_with_template`, `list_templates`, and
`get_delivery_stats` as MCP tools. It is a **local stdio** server (run with `npx`), so it
is added as a command-based MCP — NOT via the HTTP probe flow (Postmark has no HTTP MCP).

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add postmark \
    --command npx \
    --args '-y,@activecampaign/postmark-mcp' \
    --env 'POSTMARK_SERVER_TOKEN=\${POSTMARK_SERVER_TOKEN}' \
    --env 'DEFAULT_SENDER_EMAIL=\${POSTMARK_FROM_ADDRESS}' \
    --env 'DEFAULT_MESSAGE_STREAM=outbound'
"
```

`DEFAULT_MESSAGE_STREAM` should be `outbound` for transactional traffic; only set it to
`broadcast` if the Server is configured for broadcast streams. The token stays in
`~/.hermes/.env` and is referenced via `${POSTMARK_SERVER_TOKEN}` indirection — never
inlined.

> Flag names (`--command` / `--args` / `--env`) vary by Hermes version. If unsure, run
> `hermes mcp add --help` first and match its stdio syntax. If the build is HTTP-MCP-only
> and cannot spawn a stdio command, use Path B.

### Path B (fallback) — generic HTTP tool against the Postmark REST API

If the Hermes build is HTTP-MCP-only and cannot launch a stdio command, point a generic
HTTP/tool capability at the REST API directly:

- **Base URL:** `https://api.postmarkapp.com`
- **Auth header:** `X-Postmark-Server-Token: ${POSTMARK_SERVER_TOKEN}` (case-insensitive)
- **Accept:** `application/json`
- **Content-Type:** `application/json`

Common endpoints:

- `POST /email` — single transactional send (body needs `From`, `To`, `Subject`,
  `TextBody` and/or `HtmlBody`, optional `MessageStream`).
- `POST /email/withTemplate` — templated send (body needs `From`, `To`,
  `TemplateId` or `TemplateAlias`, and `TemplateModel`).
- `POST /email/batch` — up to 500 messages in one call.
- `GET  /templates` — list templates on the Server.
- `GET  /stats/outbound` — delivery stats (supports `fromdate`, `todate`, `tag`).

Do **not** swap in `Authorization: Bearer ...` — Postmark rejects it. The token goes in
`X-Postmark-Server-Token` and **only** there.

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
       | grep -qiE "registered.*tool.*postmark|MCP server.*postmark.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: postmark registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: postmark not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test (token stays on the VPS)

`GET /templates?count=1` is cheap, side-effect-free, and proves the token is valid AND
scoped to the right Server (Account tokens fail here):

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Accept: application/json' \
    -H \"X-Postmark-Server-Token: \$POSTMARK_SERVER_TOKEN\" \
    'https://api.postmarkapp.com/templates?count=1&offset=0'
")
case "$HTTP" in
  200) echo "OK: Postmark API reachable and token valid." ;;
  401) echo "FAIL: token invalid or empty. Re-check Step 4."; rollback; exit 1 ;;
  422) echo "FAIL: token wrong scope (ErrorCode 10 = Account token, not Server). Re-mint."; rollback; exit 1 ;;
  403) echo "FAIL: token rejected (likely Account-scoped). Re-mint a Server token."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from Postmark API. Check manually." ;;
esac
```

Optional: a real send to a recipient you control (uses the verified From address):

```bash
ssh "$VPS_USER@$VPS_IP" "
  curl -sS -X POST 'https://api.postmarkapp.com/email' \
    -H 'Accept: application/json' \
    -H 'Content-Type: application/json' \
    -H \"X-Postmark-Server-Token: \$POSTMARK_SERVER_TOKEN\" \
    -d \"{\\\"From\\\":\\\"\$POSTMARK_FROM_ADDRESS\\\",\\\"To\\\":\\\"\$POSTMARK_FROM_ADDRESS\\\",\\\"Subject\\\":\\\"hermes wiring check\\\",\\\"TextBody\\\":\\\"ok\\\",\\\"MessageStream\\\":\\\"outbound\\\"}\"
"
```

Expect `"ErrorCode":0` and a `MessageID`. Anything else — read `Message` for the cause.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove postmark 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset POSTMARK_SERVER_TOKEN 2>/dev/null || \
    sed -i '/^POSTMARK_SERVER_TOKEN=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset POSTMARK_FROM_ADDRESS 2>/dev/null || \
    sed -i '/^POSTMARK_FROM_ADDRESS=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Postmark is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using the Account API token instead of the Server token | Account tokens authenticate `/servers`, `/domains`, etc. — they get `401`/`422` (ErrorCode 10) on `/email` and `/templates` | Mint under a specific Server -> API Tokens tab; smoke test in Step 8 catches this |
| 2 | Sending from an unverified address | Postmark blocks the send with `ErrorCode 400`/`422`; nothing reaches the inbox | Verify a Sender Signature or Domain BEFORE first send; use that as `POSTMARK_FROM_ADDRESS` |
| 3 | Wrong message stream | Token scoped to an `outbound` Server sending on a `broadcast` stream (or vice versa) returns `422` | Set `DEFAULT_MESSAGE_STREAM=outbound` for transactional; only use `broadcast` if the Server is broadcast-configured |
| 4 | Trying to wire a remote MCP URL | None exists for Postmark; people invent `mcp.postmarkapp.com` and registration fails with DNS / 404 | Use stdio (Path A) or REST (Path B); never an HTTP MCP URL |
| 5 | Using `Authorization: Bearer` against the Postmark REST API | Postmark rejects it — the token MUST go in `X-Postmark-Server-Token` | Always `X-Postmark-Server-Token: $POSTMARK_SERVER_TOKEN` |
| 6 | Hard rate ceiling on sandbox accounts | Unconfirmed Postmark accounts cap at 100 emails total and only to the signup address | Confirm the account and verify a Sender Signature before agent goes live |
| 7 | Sending HTML without a `TextBody` fallback | Some providers junk HTML-only mail; deliverability drops | Always include `TextBody` (or both) on `/email` calls |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >> .env` instead of `config set` | Can merge onto a prior line without a trailing newline | Always `hermes config set` (or the sed-fallback pattern) |
| 10 | Secret in `config.yaml` or compose-level `.env` | Wrong file -> world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 11 | sed with `/` delimiter on tokens | Some tokens contain `/+=`; sed breaks | Always use `\|` delimiter |
| 12 | Container vs host confusion when adding SSH keys | Keys added inside a container are invisible to host sshd | Always `whoami; hostname` first; exit container before adding keys |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `POSTMARK_SERVER_TOKEN` and `POSTMARK_FROM_ADDRESS` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] From address confirmed as a verified Sender Signature or sits on a verified Domain
- [ ] MCP registered via Path A (stdio) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'postmark'` within 30s
- [ ] Smoke test: `GET /templates?count=1` from the VPS returned `200`
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
