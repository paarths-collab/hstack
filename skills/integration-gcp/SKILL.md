---
name: integration-gcp
description: Connect Google Cloud (BigQuery, Cloud SQL, Cloud Storage, Cloud Run, Logging, Compute, etc.) to a running Hermes agent via Google's managed remote MCP servers. Use when the user wants their agent to query data, inspect infra, or operate Google Cloud resources.
---

# /integration-gcp — wire Google Cloud into a running Hermes agent

You are the engineer connecting Google Cloud to a running Hermes agent. Google ships
first-party **managed remote MCP servers** (one HTTPS endpoint per product), so the happy path
is the standard `/hermes-mcp-add` flow. The one twist that defines this whole skill: Google
Cloud MCP auth is an **OAuth2 / IAM short-lived bearer token**, not a static API key. The token
expires every hour. Plan for refresh from step one — do not pretend a key injected once stays
valid.

Honesty note (verified 2026-06): Google Cloud MCP is first-party and remote, but there is
**no static long-lived API key** for it. The credential is a Google OAuth2 access token
(`Authorization: Bearer <token>`) tied to IAM. Google's own docs state: "if you use an ADC
generated bearer token for authentication, then you need to re-authenticate every hour to
refresh your access token." API keys exist only for a few keyless services (e.g. Maps), not for
the Cloud data/infra MCP servers.

## Before you start — gather (ask once)

1. **GCP project ID** — e.g. `my-project-123456`. Find it at https://console.cloud.google.com (project picker, top bar) or `gcloud config get-value project`.
2. **Which product(s)** to connect. Each is its own MCP endpoint. Verified base URLs:
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
   Full list: https://docs.cloud.google.com/mcp/supported-products
3. **A service account + JSON key** for the agent's identity (production). Mint it in the host
   shell (steps below). The user must grant it the IAM roles for the product (e.g.
   `roles/bigquery.dataViewer`). A machine cannot decide which roles you intend.

Set shell vars from answers (run on the **VPS host**, not inside a container — see CLAUDE.md):
```bash
AGENT=<container-name>                         # docker ps --format '{{.Names}}' | grep hermes
PROJECT=<gcp-project-id>
URL=https://bigquery.googleapis.com/mcp        # the product endpoint from the list above
NAME=gcp-bigquery                              # → env var MCP_GCP_BIGQUERY_API_KEY
SA=hermes-mcp@${PROJECT}.iam.gserviceaccount.com
```

---

## Step 1 — create the service account and grant IAM roles (host)

Authenticate gcloud once, then create the identity the agent will act as. Service accounts are
the right choice for an unattended agent; user ADC tokens are for local testing only.

```bash
gcloud auth login                              # interactive: a machine cannot complete this
gcloud config set project "$PROJECT"

gcloud iam service-accounts create hermes-mcp \
  --display-name="Hermes agent MCP" || true    # ok if it already exists

# Grant least-privilege roles for the product you are connecting (example: BigQuery read).
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA}" \
  --role="roles/bigquery.dataViewer"
```

Enable the product's API if it is not already on (idempotent):
```bash
gcloud services enable bigquery.googleapis.com --project "$PROJECT"
```

---

## Step 2 — mint a bearer token and stage the SA key (host)

The MCP server takes a Google OAuth2 access token in `Authorization: Bearer <token>`. Generate
one by impersonating the service account. This token is short-lived (~1 hour) — that is
expected; step 5 automates refresh.

```bash
# Stage the SA key file inside the container's persistent data dir, chmod 600.
gcloud iam service-accounts keys create /tmp/hermes-sa.json --iam-account="$SA"
docker cp /tmp/hermes-sa.json "$AGENT":/opt/data/gcp-sa.json
docker exec "$AGENT" sh -c "chmod 600 /opt/data/gcp-sa.json"
rm -f /tmp/hermes-sa.json     # do not leave the key on the host disk

# Mint a fresh access token from that key (this is the value injected as the MCP secret).
TOKEN=$(gcloud auth print-access-token --impersonate-service-account="$SA")
```

Confirm the token authenticates against the chosen endpoint before wiring it in:
```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}' \
  "$URL"
# 200 → token + endpoint good. 401/403 → IAM role or API-enable missing (step 1).
```

---

## Step 3 — register the MCP via /hermes-mcp-add

Do not hand-roll the registration. Run the **/hermes-mcp-add** procedure with these inputs; it
handles the probe matrix, placeholder-token registration, safe `sed` injection (with the `|`
delimiter), `gateway stop`+`run` reload, and log verification:

- **URL** = `$URL` (the product endpoint, e.g. `https://bigquery.googleapis.com/mcp`)
- **Name** = `$NAME` (e.g. `gcp-bigquery`)
- **Auth shape** = `header`, header name `Authorization`, value `Bearer <token>`
- **Env var** it generates = `MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY`
  (e.g. `gcp-bigquery` → `MCP_GCP_BIGQUERY_API_KEY`), living in `/opt/data/.env`
- **Secret value** = the `$TOKEN` from step 2

The resulting `config.yaml` block looks like:
```yaml
gcp-bigquery:
  url: https://bigquery.googleapis.com/mcp
  headers:
    Authorization: Bearer ${MCP_GCP_BIGQUERY_API_KEY}
  enabled: true
```

The bearer token lands only in `/opt/data/.env` (chmod 600), never in `config.yaml`, never in
chat.

---

## Step 4 — verify tools registered (handled by /hermes-mcp-add, confirm here)

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server '${NAME}'" | tail -5
```

Then trigger a real call from the chat interface, e.g.:
```
@<agent> using gcp-bigquery, list my datasets in project <PROJECT>
```

---

## Step 5 — keep the token fresh (the part everyone forgets)

The injected token dies in ~1 hour and tool calls start returning 401. Automate refresh with a
host cron that re-mints and re-injects, then reloads the gateway. Use `hermes config set` or the
mcp-add `sed` pattern — never `echo >>`.

```bash
ENV_VAR="MCP_$(echo "$NAME" | tr '[:lower:]-' '[:upper:]_')_API_KEY"

cat > /usr/local/bin/hermes-gcp-token-refresh.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
TOKEN=\$(gcloud auth print-access-token --impersonate-service-account="${SA}")
docker exec "${AGENT}" sh -c \
  "sed -i 's|^${ENV_VAR}=.*|${ENV_VAR}=\${TOKEN}|' /opt/data/.env && chmod 600 /opt/data/.env"
docker exec -u hermes "${AGENT}" hermes gateway stop || true
sleep 3
docker exec -d -u hermes "${AGENT}" hermes gateway run
EOF
chmod 700 /usr/local/bin/hermes-gcp-token-refresh.sh

# Refresh every 45 min (safely inside the ~60 min token lifetime).
( crontab -l 2>/dev/null; echo "*/45 * * * * /usr/local/bin/hermes-gcp-token-refresh.sh >> /var/log/hermes-gcp-refresh.log 2>&1" ) | crontab -
```

Prefer this over baking the raw SA key into Hermes: the key never leaves `/opt/data` and only
short-lived tokens hit the agent runtime. Use `/hermes-cron` if you want this managed as a
Hermes-native job instead of a host crontab.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating the credential as a static API key | It is a 1-hour OAuth2 access token; tool calls start 401-ing after an hour | Set up the refresh cron in step 5 before declaring done |
| 2 | Expecting a long-lived key from the console | Cloud data/infra MCP servers are OAuth/IAM only — no static key exists for them | Use service-account impersonation + `print-access-token` |
| 3 | Running gcloud/whoami inside a container | SSH keys and gcloud auth added in a container are invisible to the host | `whoami; hostname` check (CLAUDE.md); operate on the host |
| 4 | 403 even with a valid token | IAM role not granted, or the product API not enabled | `add-iam-policy-binding` (step 1) + `gcloud services enable` |
| 5 | Wrong endpoint base path | Cloud Storage is `/storage/mcp`, not `/mcp`; AI Platform uses sub-paths | Copy URLs verbatim from the step-2 list / supported-products doc |
| 6 | SA key left on host disk or in chat | Long-lived key is the highest-value secret here | `docker cp` into `/opt/data`, `chmod 600`, `rm` the host copy |
| 7 | Quota/rate limits on the underlying API | MCP calls consume the same project quota as the REST API | Watch Cloud Monitoring; request quota bumps per product |

---

## Verify

- [ ] `curl ... initialize` against the endpoint with the bearer token returns `200`.
- [ ] `hermes logs` shows `registered N tool(s)` for `$NAME`.
- [ ] A real chat call (e.g. list datasets / buckets / services) returns data, or a valid empty result.
- [ ] After ~1 hour the call still works (refresh cron is doing its job) — re-test once.

## Definition of done

- [ ] Service account created with least-privilege IAM role(s); product API enabled.
- [ ] MCP registered via /hermes-mcp-add; token only in `/opt/data/.env` (chmod 600), not in `config.yaml` or chat.
- [ ] SA key staged at `/opt/data/gcp-sa.json` (chmod 600); no copy left on the host.
- [ ] Token-refresh cron installed and verified surviving the 1-hour expiry.
- [ ] A real tool call returns live Google Cloud data.

See reference/TROUBLESHOOTING.md for gateway reload and bearer-token failure modes.
