---
name: hermes-integrate
description: Wire one or many integrations into a running Hermes agent over SSH. Presents the catalog by category, collects one secret per chosen integration, then runs each /integration-<name> skill in sequence using the shared SSH-first pattern. Use when the user wants to connect several apps at once rather than one at a time. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /hermes-integrate — connect many apps to a remote Hermes (SSH-first orchestrator)

You are the engineer connecting the user's apps to their self-hosted Hermes agent on a
VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work
over SSH as root against the VPS. Every command in this skill runs on the VPS, not on
the local machine.

Each individual integration has its own skill (`/integration-<name>`) that knows the exact
endpoint, auth shape, MCP availability, and pitfalls. This skill is the **orchestrator**:
it presents the catalog, collects secrets in one batch, then invokes each per-integration
skill in series so gateway reloads do not interleave.

Do everything autonomously; stop only for things a machine cannot do — minting tokens,
sharing pages, scanning a QR.

**Honest auth picture (verified 2026-06):** Some integrations (Notion hosted MCP,
Google Workspace, Microsoft 365, Salesforce) are **OAuth-only** at the remote-MCP layer
and reject static bearer tokens. Their per-integration skills route around this by using
the stdio MCP (Path A) or the REST API directly (Path B). The orchestrator does not need
to know which path was taken — it only needs each token in `~/.hermes/.env` and each MCP
or REST shim registered exactly once.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user, typically `root` | User's hosting dashboard |
| `$CHOSEN` | Comma-separated list of integration names | Pick from the catalog in Step 1 |
| `$<TOKEN_n>` | One API token per chosen integration | Each per-integration skill names a mint URL |

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

## Step 2 — present the catalog and collect picks (one batch)

Show this table and ask which services to connect. Most users pick 3–5; nobody connects
the whole catalog in one shot. Accept names ("notion, github, stripe") or categories
("all CRM").

| Category | Available integrations |
|----------|----------------------|
| CRM | hubspot · salesforce · pipedrive · zoho-crm |
| Docs & Notes | notion · google-workspace · microsoft-365 |
| Dev | github · gitlab · bitbucket |
| Project mgmt | jira · linear · asana · clickup · monday · trello · airtable |
| Cloud infra | aws · gcp · azure · digitalocean · hetzner · cloudflare · vercel · netlify · railway · render |
| Payments | stripe · paypal · razorpay |
| Commerce | shopify · woocommerce · webflow · wordpress |
| Email & marketing | mailchimp · brevo · sendgrid · postmark |
| Comms & support | twilio · sendbird · intercom · zendesk · freshdesk |
| Forms & scheduling | typeform · tally · calendly · zoom |
| Search & AI | brave-search · tavily · exa |

After they pick, parse into `$CHOSEN` (comma-separated, lowercase, no spaces). For each
name in `$CHOSEN`, ask for that integration's token in the same message (don't drip-feed
prompts — one batch is the whole user-attention budget for this skill).

---

## Step 3 — per-integration idempotency check (skip anything already wired)

```bash
TO_WIRE=""
for NAME in $(echo "$CHOSEN" | tr ',' ' '); do
  ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci \"$NAME\"" || echo 0)
  if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
    echo "SKIP: $NAME already wired. Set FORCE=1 to rewire."
  else
    TO_WIRE="$TO_WIRE $NAME"
  fi
done
TO_WIRE=$(echo "$TO_WIRE" | xargs)
[ -z "$TO_WIRE" ] && { echo "Nothing to do. All chosen integrations already wired."; exit 0; }
echo "Will wire: $TO_WIRE"
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  For each of: $TO_WIRE
    1. Write its token (length only, never the value) to ~/.hermes/.env via 'hermes config set'
    2. chmod 600 ~/.hermes/.env
    3. Register MCP (Path A) or document REST shim (Path B) per integration skill
    4. Reload gateway ONCE at the end (stop + run, NOT restart)
    5. Verify each registration in logs: grep -i "registered.*<name>"
    6. Smoke test each: real API call → expect 200

Tokens are NEVER printed in plaintext.
Integrations are wired in series — no two gateway reloads overlap.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), proceed.

---

## Step 5 — write all secrets at once (chmod 600, no echo, no logging)

For every chosen integration, the per-integration skill names its env var
(e.g. `NOTION_TOKEN`, `GITHUB_TOKEN`, `STRIPE_API_KEY`). Collect them into `$SECRETS_JSON`
as `NAME=VAR=value` lines, then write all in one round-trip:

```bash
for LINE in $SECRETS_LINES; do
  NAME=$(echo "$LINE" | cut -d= -f1)
  VAR=$(echo "$LINE" | cut -d= -f2)
  VAL=$(echo "$LINE" | cut -d= -f3-)
  ssh "$VPS_USER@$VPS_IP" "hermes config set '$VAR' '$VAL'"
done
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify each one was written (returns `1`, NEVER the value):

```bash
for LINE in $SECRETS_LINES; do
  VAR=$(echo "$LINE" | cut -d= -f2)
  WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c \"^${VAR}=\" ~/.hermes/.env" || echo 0)
  [ "$WROTE" = "1" ] || { echo "FAIL: $VAR not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build lacks `config set`, fall back to the safe sed pattern
> (pipe delimiter; tokens may contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^VAR=' ~/.hermes/.env || printf 'VAR=\n' >> ~/.hermes/.env
>   sed -i 's|^VAR=.*|VAR=VALUE|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 6 — register each integration in series (Path A preferred, Path B fallback)

For each `NAME` in `$TO_WIRE`, invoke the per-integration skill. The orchestrator does
**not** call `gateway stop/run` between integrations — it batches the reload at Step 7.
Each per-integration skill should be invoked in `--no-reload` mode if it supports it;
otherwise tolerate the reload churn.

```bash
for NAME in $TO_WIRE; do
  echo "=== Wiring $NAME ==="
  # Run the per-integration skill. Each one does its own:
  #   - Path A (preferred): hermes mcp add <NAME> ... (stdio or HTTP MCP)
  #   - Path B (fallback):  document REST base URL + auth header for HTTP shim
  # The skill returns nonzero if registration fails; we roll back the whole batch.
  /integration-$NAME --no-reload --secret-already-written \
    || { echo "FAIL: /integration-$NAME failed. Rolling back batch."; rollback; exit 1; }
done
```

> **Run integrations in series, not parallel.** Each per-integration skill writes to
> `~/.hermes/config.yaml` via `hermes mcp add`. Two parallel writers will clobber each
> other's edits. Always sequential.

---

## Step 7 — reload the gateway ONCE (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run, and only after
all integrations are registered.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify every registration in logs (poll up to 30s per integration)

```bash
for NAME in $TO_WIRE; do
  REGISTERED=0
  for i in $(seq 1 6); do
    if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -400" \
         | grep -qiE "registered.*tool.*${NAME}|MCP server.*${NAME}.*(ok|ready)"; then
      REGISTERED=1
      echo "OK: $NAME registered in gateway logs."
      break
    fi
    sleep 5
  done
  [ "$REGISTERED" = "1" ] || { echo "FAIL: $NAME not in logs after 30s. Rolling back."; rollback; exit 1; }
done
```

---

## Step 9 — live smoke test per integration

Each per-integration skill defines its own side-effect-free probe (e.g. `/v1/search` for
Notion, `/user` for GitHub, `/v1/account` for Stripe). Run them in series from inside the
VPS so tokens never leave the host:

```bash
for NAME in $TO_WIRE; do
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "/integration-$NAME --smoke-test" 2>/dev/null | tail -1)
  case "$HTTP" in
    200) echo "OK: $NAME live API reachable and token valid." ;;
    401) echo "FAIL: $NAME token invalid. Re-mint and re-run with FORCE=1."; rollback; exit 1 ;;
    403) echo "FAIL: $NAME token valid but missing scope. Re-mint with correct scopes."; exit 1 ;;
    *)   echo "WARN: $NAME returned HTTP $HTTP. Check manually." ;;
  esac
done
```

A `200` with empty results means the token works but nothing is shared/scoped yet — not
a wiring failure, a user step (each per-integration skill calls out its own equivalent
of Notion's "+ Add Connections").

---

## Rollback (auto-runs on any failure above)

Roll back the **entire batch** — partial wiring leaves the gateway in an inconsistent
state.

```bash
rollback() {
  for NAME in $TO_WIRE; do
    ssh "$VPS_USER@$VPS_IP" "hermes mcp remove $NAME 2>/dev/null || true"
  done
  for LINE in $SECRETS_LINES; do
    VAR=$(echo "$LINE" | cut -d= -f2)
    ssh "$VPS_USER@$VPS_IP" "hermes config unset '$VAR' 2>/dev/null || sed -i '/^${VAR}=/d' ~/.hermes/.env"
  done
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. None of $TO_WIRE are wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Running per-integration skills in **parallel** | Each writes `config.yaml`; parallel writes clobber | Always sequential; orchestrator enforces with a `for` loop |
| 2 | Reloading the gateway **between** integrations | Each reload is ~5s; N reloads = N×5s downtime and race window | Reload ONCE at the end (Step 7) |
| 3 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 4 | `echo >> .env` instead of `config set` | Can merge a new line onto a prior unterminated line | Always `hermes config set` |
| 5 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 6 | sed with `/` delimiter on tokens | Tokens contain `/+=`; sed breaks | Use `\|` delimiter |
| 7 | Container vs host confusion | Skill assumed wrong layer | Always `whoami; hostname` first; if hex hostname, you are inside a container |
| 8 | Two `.env` files | Compose-level `.env` is Docker-only; secrets must go in the Hermes runtime `.env` | `/opt/data/.env` (container) or `~/.hermes/.env` (host) |
| 9 | OAuth-only services wired with a static token | Hosted MCPs for Notion/Google/M365/Salesforce reject bearer tokens | Per-integration skill picks Path A (stdio) or Path B (REST) |
| 10 | Token scope mismatch | A 401 in logs = wrong token or missing scope, not wrong wiring | Each per-integration skill documents required scopes |
| 11 | Hermes not running when SSH connects | First call hangs forever | Step 1 has a hard version check that exits early |
| 12 | Partial wiring on failure | Half-wired gateway with orphan MCP entries and dangling env vars | `rollback` removes the entire batch atomically |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x)
- [ ] User confirmed `$CHOSEN`; no extra integrations were wired
- [ ] Per-integration idempotency check passed (or `FORCE=1` overrode) for every name
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Every token written to `~/.hermes/.env` via `hermes config set`, `chmod 600`
- [ ] No token in `config.yaml` and no token echoed in chat
- [ ] Each `/integration-<name>` skill ran to completion in series (no parallelism)
- [ ] Gateway reloaded **once** with `stop` + `run` (NOT restart) at the end
- [ ] Logs show `registered N tool(s) for '<name>'` within 30s for every chosen integration
- [ ] Live smoke test returned `200` for every chosen integration
- [ ] Rollback function defined and proven (re-running with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
