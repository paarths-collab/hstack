---
name: integration-gcp
description: Connect Google Cloud (BigQuery, Cloud SQL, Cloud Storage, Cloud Run, Logging, Compute, etc.) to a self-hosted Hermes Agent over SSH. Wires Google's first-party managed remote MCP servers with a short-lived OAuth2 bearer token + auto-refresh cron. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and Gemini CLI.
---

# /integration-gcp — connect Google Cloud to a remote Hermes (SSH-first)

You are the engineer connecting Google Cloud to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. The user only does the two things a machine cannot:

1. Complete the interactive `gcloud auth login` (one-time).
2. Decide which IAM roles the agent should have.

Everything else — service-account creation, token minting, MCP registration, gateway reload,
refresh cron, verification — runs on the VPS via SSH, idempotently.

**Honest auth picture (verified 2026-06):** Google ships first-party **managed remote MCP
servers** (one HTTPS endpoint per product), so the happy path is the standard `/hermes-mcp-add`
flow. The twist that defines this skill: Google Cloud MCP auth is an **OAuth2 / IAM short-lived
bearer token**, not a static API key. The token expires every hour. Plan for refresh from step
one — do not pretend a key injected once stays valid. Google's own docs state: "if you use an
ADC generated bearer token for authentication, then you need to re-authenticate every hour to
refresh your access token." API keys exist only for a few keyless services (e.g. Maps), not for
the Cloud data/infra MCP servers.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$GCP_PROJECT` | GCP project ID, e.g. `my-project-123456` | <https://console.cloud.google.com> project picker, or `gcloud config get-value project` |
| `$GCP_PRODUCT` | Which product MCP to wire (one of the URLs below) | See list below |
| `$GCP_ROLE` | IAM role(s) to grant the SA, e.g. `roles/bigquery.dataViewer` | User decides; machine cannot |

Verified product MCP base URLs:

- BigQuery — `https://bigquery.googleapis.com/mcp`
- Cloud SQL — `https://sqladmin.googleapis.com/mcp`
- Cloud Storage — `https://storage.googleapis.com/storage/mcp`
- Cloud Run — `https://run.googleapis.com/mcp`
- Cloud Logging — `https://logging.googleapis.com/mcp`
- Cloud Monitoring — `https://monitoring.googleapis.com/mcp`
- Compute Engine — `https://compute.googleapis.com/mcp`
- GKE — `https://container.googleapis.com/mcp`
- Firestore — `https://firestore.googleapis.com/mcp`
- Spanner — `https://spanner.googleapis.com/mcp`
- AlloyDB — `https://alloydb.googleapis.com/mcp`
- Pub/Sub — `https://pubsub.googleapis.com/mcp`

Full list: <https://docs.cloud.google.com/mcp/supported-products>

Derived names (set locally for the rest of the skill):

```bash
NAME="gcp-$(echo "$GCP_PRODUCT" | sed 's|https://||;s|\.googleapis\.com.*||;s|/.*||')"
# e.g. NAME=gcp-bigquery
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"
SA_EMAIL="hermes-mcp@${GCP_PROJECT}.iam.gserviceaccount.com"
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

Also confirm we are operating on the **VPS host**, not a nested container — gcloud auth added
inside a container is invisible to the host (see CLAUDE.md SSH section):

```bash
ssh "$VPS_USER@$VPS_IP" 'whoami; hostname'
# Expect: root@<readable-name>, NOT root@<hex-string>
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci '$NAME'" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "$NAME is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Create service account $SA_EMAIL (idempotent) and grant $GCP_ROLE
  2. Enable the product API on project $GCP_PROJECT
  3. Mint SA key → /opt/data/gcp-sa.json (chmod 600); delete host copy
  4. Mint short-lived access token; write \$$ENV_VAR (length only) via 'hermes config set'
  5. chmod 600 ~/.hermes/.env
  6. Register MCP: hermes mcp add $NAME --url $GCP_PRODUCT (header Authorization: Bearer)
  7. Reload gateway: hermes gateway stop && hermes gateway run
  8. Verify in logs: grep "registered.*$NAME"
  9. Smoke test: POST $GCP_PRODUCT initialize → expect 200
 10. Install /usr/local/bin/hermes-gcp-token-refresh.sh + cron every 45 min

The bearer token is NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the secret (chmod 600, no echo, no logging)

First, mint the SA + token on the VPS host. The `gcloud auth login` is the one interactive
step — if creds are not already present, the user must complete it.

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  gcloud config set project '$GCP_PROJECT'
  gcloud iam service-accounts create hermes-mcp --display-name='Hermes agent MCP' 2>/dev/null || true
  gcloud projects add-iam-policy-binding '$GCP_PROJECT' \
    --member='serviceAccount:$SA_EMAIL' \
    --role='$GCP_ROLE' >/dev/null
  API=\$(echo '$GCP_PRODUCT' | sed 's|https://||;s|/.*||')
  gcloud services enable \"\$API\" --project '$GCP_PROJECT' >/dev/null
"
```

Stage the SA key inside the agent's data dir, never on host disk:

```bash
ssh "$VPS_USER@$VPS_IP" "
  set -e
  AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
  gcloud iam service-accounts keys create /tmp/hermes-sa.json --iam-account='$SA_EMAIL'
  docker cp /tmp/hermes-sa.json \"\$AGENT\":/opt/data/gcp-sa.json
  docker exec \"\$AGENT\" sh -c 'chmod 600 /opt/data/gcp-sa.json'
  rm -f /tmp/hermes-sa.json
"
```

Mint the short-lived token and write it via `hermes config set` (never `echo >>`):

```bash
TOKEN=$(ssh "$VPS_USER@$VPS_IP" "gcloud auth print-access-token --impersonate-service-account='$SA_EMAIL'")
ssh "$VPS_USER@$VPS_IP" "hermes config set $ENV_VAR '$TOKEN'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1`, NEVER the value):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$ENV_VAR=' ~/.hermes/.env" || echo 0)
[ "$WROTE" = "1" ] || { echo "FAIL: $ENV_VAR not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern
> (pipe delimiter; OAuth tokens contain `/+=`):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   grep -q '^$ENV_VAR=' ~/.hermes/.env || printf '$ENV_VAR=\n' >> ~/.hermes/.env
>   sed -i 's|^$ENV_VAR=.*|$ENV_VAR=$TOKEN|' ~/.hermes/.env
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 5 — register the MCP server

Pick the path that matches your Hermes build. Path A is preferred.

### Path A (preferred) — Google's first-party managed remote MCP

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add $NAME \
    --url '$GCP_PRODUCT' \
    --auth-header 'Authorization' \
    --auth-scheme 'Bearer' \
    --placeholder-token 'placeholder'
"
# Inject real token with pipe delimiter (OAuth tokens contain /+=)
ssh "$VPS_USER@$VPS_IP" "sed -i 's|placeholder|'\"\$$ENV_VAR\"'|g' ~/.hermes/config.yaml" 2>/dev/null || true
```

The resulting `config.yaml` block looks like:

```yaml
gcp-bigquery:
  url: https://bigquery.googleapis.com/mcp
  headers:
    Authorization: Bearer ${MCP_GCP_BIGQUERY_API_KEY}
  enabled: true
```

The bearer token lands only in `~/.hermes/.env` (chmod 600), never in `config.yaml`, never in
chat.

### Path B (fallback) — generic HTTP tool against the product REST API

If the Hermes build cannot register remote MCP endpoints, hit the product's REST API directly:

- **Base URL:** the product's googleapis.com base, e.g. `https://bigquery.googleapis.com/bigquery/v2`
- **Auth header:** `Authorization: Bearer ${MCP_GCP_<PRODUCT>_API_KEY}`
- **Content type:** `Content-Type: application/json`

The refresh cron in Step 8 keeps the bearer valid for both paths.

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
       | grep -qiE "registered.*tool.*$NAME|MCP server.*$NAME.*(ok|ready)"; then
    REGISTERED=1
    echo "OK: $NAME registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: $NAME not in logs after 30s. Rolling back."; rollback; exit 1; }
```

---

## Step 8 — live API smoke test + install refresh cron

Smoke-test the endpoint with the freshly-injected token:

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  curl -sS -o /dev/null -w '%{http_code}' \
    -X POST '$GCP_PRODUCT' \
    -H \"Authorization: Bearer \$$ENV_VAR\" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"probe\",\"version\":\"0\"}}}'
")
case "$HTTP" in
  200) echo "OK: $GCP_PRODUCT reachable and token valid." ;;
  401) echo "FAIL: token invalid or expired. Re-check Step 4."; rollback; exit 1 ;;
  403) echo "FAIL: token valid but IAM role $GCP_ROLE missing, or product API not enabled."; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from $GCP_PRODUCT. Check manually." ;;
esac
```

Now install the refresh cron — the token dies in ~1 hour, so calls will start 401-ing without
this step. This is the part everyone forgets:

```bash
ssh "$VPS_USER@$VPS_IP" "cat > /usr/local/bin/hermes-gcp-token-refresh.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
TOKEN=\\\$(gcloud auth print-access-token --impersonate-service-account='$SA_EMAIL')
hermes config set $ENV_VAR \"\\\$TOKEN\"
chmod 600 ~/.hermes/.env
hermes gateway stop || true
sleep 3
hermes gateway run --daemon
EOF
chmod 700 /usr/local/bin/hermes-gcp-token-refresh.sh
( crontab -l 2>/dev/null; echo '*/45 * * * * /usr/local/bin/hermes-gcp-token-refresh.sh >> /var/log/hermes-gcp-refresh.log 2>&1' ) | crontab -
"
```

`*/45` keeps refresh safely inside the ~60 min token lifetime. Use `/hermes-cron` if you'd
rather have this managed as a Hermes-native job.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove $NAME 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "hermes config unset $ENV_VAR 2>/dev/null || \
    sed -i '/^$ENV_VAR=/d' ~/.hermes/.env"
  ssh "$VPS_USER@$VPS_IP" "crontab -l 2>/dev/null | grep -v hermes-gcp-token-refresh | crontab - || true"
  ssh "$VPS_USER@$VPS_IP" "rm -f /usr/local/bin/hermes-gcp-token-refresh.sh"
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. $NAME is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating the credential as a static API key | It is a 1-hour OAuth2 access token; calls start 401-ing after an hour | Refresh cron in Step 8 is non-optional |
| 2 | Expecting a long-lived key from the console | Cloud data/infra MCP servers are OAuth/IAM only — no static key exists | Service-account impersonation + `print-access-token` |
| 3 | Running gcloud / SSH commands inside a container | gcloud auth added in a container is invisible to the host | `whoami; hostname` check (Step 1); operate on the host |
| 4 | 403 even with a valid token | IAM role not granted, or the product API not enabled | `add-iam-policy-binding` + `gcloud services enable` (Step 4) |
| 5 | Wrong endpoint base path | Cloud Storage is `/storage/mcp`, not `/mcp`; AI Platform uses sub-paths | Copy URLs verbatim from the supported-products list |
| 6 | SA key left on host disk or in chat | Long-lived key is the highest-value secret here | `docker cp` into `/opt/data`, `chmod 600`, `rm` host copy |
| 7 | Quota/rate limits on underlying API | MCP calls consume the same project quota as the REST API | Watch Cloud Monitoring; request quota bumps per product |
| 8 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 9 | `echo >> .env` instead of `config set` | Can merge onto a prior line without a trailing newline | Always `hermes config set`, never `echo >>` |
| 10 | Secret in `config.yaml` or compose-level `.env` | Wrong file → world-readable or not loaded by runtime | Only `~/.hermes/.env`, `chmod 600` |
| 11 | sed with `/` delimiter on tokens | OAuth tokens contain `/+=`; sed breaks | Always use `\|` delimiter |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x); confirmed on host (not container)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Service account `$SA_EMAIL` created with least-privilege IAM role; product API enabled
- [ ] SA key staged at `/opt/data/gcp-sa.json` (chmod 600); no copy left on host
- [ ] `$ENV_VAR` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] MCP registered via Path A (managed remote) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for '$NAME'` within 30s
- [ ] Smoke test: `initialize` POST against `$GCP_PRODUCT` returned `200`
- [ ] Refresh cron installed at `/usr/local/bin/hermes-gcp-token-refresh.sh`, runs `*/45`
- [ ] Rollback function defined (removes MCP, unsets env, drops cron, restarts gateway)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and bearer-token failure modes.
