---
name: integration-datadog
description: Connect Datadog (metrics, logs, events, monitors, incidents) to a self-hosted Hermes agent over SSH. Uses site-aware REST API with DD-API-KEY + DD-APPLICATION-KEY headers. Refuses the shipped Datadog Agent daemon (out of scope). Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and any AI agent.
---

# /integration-datadog — connect Datadog to a remote Hermes (SSH-first)

You are the engineer connecting Datadog to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command in this skill runs on the VPS, not on the
local machine.

Do everything autonomously; stop only for things a machine cannot do — minting the API
key and Application key in the Datadog UI, and picking the correct site.

**Honest picture (verified 2026-06):** Datadog ships **no first-party MCP server**.
The REST API is site-scoped — Datadog runs isolated regions (`datadoghq.com` US1,
`us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu` EU1, `ddog-gov.com` US1-Gov,
`ap1.datadoghq.com` AP1). Using the wrong site returns `403 Forbidden — API key not
authorized for this region`. Auth is **two headers, not Bearer**:

- `DD-API-KEY: <32-char hex>` — allows event/metric/log **submit**
- `DD-APPLICATION-KEY: <40-char hex>` — additionally allows monitor/dashboard/incident
  **query and mutation**

Datadog's *Agent* (the daemon that ships host metrics + APM traces) is out of scope for
this skill — that's a systems concern, not an integration wiring. Wire the Agent
separately via Datadog's own installer if the user wants host telemetry. This skill
covers the *API* surface an AI agent uses to emit events, submit custom metrics, query
monitors, and page on-call.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$DD_SITE` | Datadog site: `datadoghq.com` (US1) / `us3.datadoghq.com` / `us5.datadoghq.com` / `datadoghq.eu` / `ap1.datadoghq.com` / `ddog-gov.com` | Bottom-left of Datadog UI, or the domain in the browser URL bar |
| `$DD_API_KEY` | 32-char hex, submit-only | Organization Settings -> API Keys -> **New Key** |
| `$DD_APP_KEY` | 40-char hex, adds query + mutation scope | Personal Settings -> Application Keys -> **New Key** (scope to `metrics_read`, `monitors_read`, `monitors_write`, `events_write`, `logs_write` minimum) |
| `$WRITES_ACKNOWLEDGED` | Set to `1` to confirm the Application key has monitor/incident write scope and the agent may create/mute monitors | Consent gate — monitor mutations can page on-call staff |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^DD_API_KEY=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Datadog is already wired (DD_API_KEY present). Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate credential format AND live Datadog API pre-flight

Do NOT write anything until all checks pass.

```bash
[ "${WRITES_ACKNOWLEDGED:-0}" = "1" ] || {
  echo "ABORT: WRITES_ACKNOWLEDGED=1 required. Monitor mutations page on-call. Set the Application key's scope narrowly if you don't want that."; exit 1;
}

# Format
echo "$DD_API_KEY" | grep -qE '^[a-f0-9]{32}$' || { echo "ABORT: DD_API_KEY must be 32 lowercase hex chars."; exit 1; }
echo "$DD_APP_KEY" | grep -qE '^[a-f0-9]{40}$' || { echo "ABORT: DD_APP_KEY must be 40 lowercase hex chars."; exit 1; }
case "$DD_SITE" in
  datadoghq.com|us3.datadoghq.com|us5.datadoghq.com|datadoghq.eu|ap1.datadoghq.com|ddog-gov.com) ;;
  *) echo "ABORT: DD_SITE must be one of the six valid Datadog sites (got '$DD_SITE'). Copy from the URL bar of your Datadog UI."; exit 1 ;;
esac

DD_HOST="https://api.$DD_SITE"

# Pre-flight 1: API key validation (cheap, submit-scope)
HTTP=$(curl -sS -o /tmp/dd-validate.json -w "%{http_code}" \
  -H "DD-API-KEY: $DD_API_KEY" \
  "$DD_HOST/api/v1/validate")
case "$HTTP" in
  200) echo "OK: DD_API_KEY valid for site $DD_SITE." ;;
  403) echo "ABORT: 403 — API key not authorized for site $DD_SITE. Confirm the site in Datadog UI bottom-left."; rm -f /tmp/dd-validate.json; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP on /v1/validate."; cat /tmp/dd-validate.json; rm -f /tmp/dd-validate.json; exit 1 ;;
esac
rm -f /tmp/dd-validate.json

# Pre-flight 2: App key validation via a read that requires both keys
HTTP=$(curl -sS -o /tmp/dd-monitors.json -w "%{http_code}" \
  -H "DD-API-KEY: $DD_API_KEY" \
  -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "$DD_HOST/api/v1/monitor?page_size=1")
case "$HTTP" in
  200) echo "OK: DD_APP_KEY has monitors_read scope." ;;
  403) echo "ABORT: 403 — Application key missing monitors_read scope. Regenerate with the scopes listed in gather table."; rm -f /tmp/dd-monitors.json; exit 1 ;;
  *)   echo "ABORT: unexpected HTTP $HTTP on /v1/monitor."; cat /tmp/dd-monitors.json; rm -f /tmp/dd-monitors.json; exit 1 ;;
esac
rm -f /tmp/dd-monitors.json
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write DD_API_KEY  (length ${#DD_API_KEY}, prefix ${DD_API_KEY:0:4}...)
     Write DD_APP_KEY  (length ${#DD_APP_KEY}, prefix ${DD_APP_KEY:0:4}...)
     Write DD_SITE     ($DD_SITE)
  2. chmod 600 ~/.hermes/.env
  3. Document REST surface at /opt/data/datadog-rest.md (events, metrics, logs, monitors, incidents)
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify env loaded: env | grep -c '^DD_' inside the gateway
  6. Smoke test: GET /v1/validate from inside Hermes -> expect 200
  7. Emit one hstack.integration.wired event via /v1/events -> confirm 202

Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 5 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes config set DD_API_KEY '$DD_API_KEY'
  hermes config set DD_APP_KEY '$DD_APP_KEY'
  hermes config set DD_SITE    '$DD_SITE'
  chmod 600 ~/.hermes/.env
"
```

Verify each landed (returns `1` per line, NEVER the value):

```bash
for K in DD_API_KEY DD_APP_KEY DD_SITE; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$K=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $K not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with
> `|` delimiter — Datadog keys are hex but keep the pattern uniform:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'DD_API_KEY=$DD_API_KEY' 'DD_APP_KEY=$DD_APP_KEY' 'DD_SITE=$DD_SITE'; do
>     K=\${KV%%=*}
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 6 — document the REST surface (no MCP exists)

```bash
ssh "$VPS_USER@$VPS_IP" "mkdir -p /opt/data && cat > /opt/data/datadog-rest.md" <<'DOC'
# Datadog REST surface (wired via Hermes generic HTTP tool)

**Site-scoped host:** `https://api.${DD_SITE}` — using the wrong site returns 403.

**Auth headers (both required for query/mutation):**
- `DD-API-KEY: ${DD_API_KEY}`
- `DD-APPLICATION-KEY: ${DD_APP_KEY}` (submit-only endpoints accept API key alone)

## Events — narrative signal for humans

`POST /api/v1/events`
```json
{"title":"hstack: agent restarted","text":"gateway stop+run after Datadog wire","tags":["source:hermes-agent"]}
```
Success: `202 Accepted`.

## Metrics — custom time series

`POST /api/v2/series` (v2, JSON)
```json
{"series":[{"metric":"hermes.msg.count","type":1,"points":[{"timestamp":1720000000,"value":42}],"tags":["platform:telegram"]}]}
```
`type`: `0`=unspecified, `1`=count, `2`=rate, `3`=gauge. Success: `202`.

## Logs — structured log intake

`POST https://http-intake.logs.${DD_SITE}/api/v2/logs`  (note: separate host)
```json
[{"ddsource":"hermes","service":"gateway","ddtags":"env:prod","message":"…","hostname":"vps-1"}]
```
Header: `DD-API-KEY` only (log intake does not need App Key). Success: `202`.

## Monitors — read + mute + trigger

- `GET /api/v1/monitor?page_size=100` — list.
- `GET /api/v1/monitor/{id}` — read one.
- `POST /api/v1/monitor/{id}/mute` — silence (optional `end` unix ts).
- `POST /api/v1/monitor/{id}/unmute` — unsilence.
- `POST /api/v1/monitor` — create. Requires `monitors_write` scope.

## Incidents — page and update on-call

- `POST /api/v2/incidents` — create. Body: `{"data":{"type":"incidents","attributes":{"title":"…","customer_impact_scope":"…"}}}`
- `PATCH /api/v2/incidents/{id}` — update.
- `POST /api/v2/incidents/{id}/timeline` — post narrative updates.

## Dashboards — read (for context) + create

- `GET /api/v1/dashboard` — list.
- `GET /api/v1/dashboard/{id}` — full JSON model.
- `POST /api/v1/dashboard` — create.

## Common failure modes to surface in agent replies

| Code | Meaning | Fix |
|------|---------|-----|
| 400  | Malformed payload (bad tag chars, missing required field) | Datadog tags: lowercase, `[a-z0-9_./-]`, max 200 chars |
| 403  | Wrong site OR missing App Key scope | Verify `DD_SITE`; check the App Key's scopes in Personal Settings |
| 404  | Monitor/incident ID not found (or wrong site) | Confirm ID exists in this site's org |
| 429  | Rate limited | Datadog rate limits differ per endpoint; back off with `X-RateLimit-Reset` header |
DOC
ssh "$VPS_USER@$VPS_IP" "chmod 644 /opt/data/datadog-rest.md"
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 2
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — verify env is loaded inside the gateway

```bash
LOADED=$(ssh "$VPS_USER@$VPS_IP" '
  AGENT=$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)
  if [ -n "$AGENT" ]; then
    docker exec "$AGENT" env | grep -cE "^DD_(API_KEY|APP_KEY|SITE)="
  else
    hermes gateway env 2>/dev/null | grep -cE "^DD_(API_KEY|APP_KEY|SITE)="
  fi
')
[ "$LOADED" = "3" ] || { echo "FAIL: expected 3 DD_* vars in gateway env, saw $LOADED. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (inside the VPS so credentials stay there)

Two checks: `/v1/validate` (API key), then emit one `hstack.integration.wired` event.

```bash
RES=$(ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  H="https://api.$DD_SITE"
  V=$(curl -sS -o /dev/null -w "%{http_code}" -H "DD-API-KEY: $DD_API_KEY" "$H/api/v1/validate")
  E=$(curl -sS -o /dev/null -w "%{http_code}" \
        -H "DD-API-KEY: $DD_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"title\":\"hstack.integration.wired\",\"text\":\"Datadog reachable from Hermes\",\"tags\":[\"source:hstack\",\"skill:integration-datadog\"]}" \
        "$H/api/v1/events")
  echo "validate=$V event=$E"
')
echo "$RES"
case "$RES" in
  *validate=200*event=202*) echo "OK: Datadog reachable and event emitted. Check Events Explorer." ;;
  *validate=200*)           echo "WARN: validate OK but event emit failed. Investigate."; rollback; exit 1 ;;
  *)                        echo "FAIL: Datadog unreachable from Hermes. Rolling back."; rollback; exit 1 ;;
esac
```

---

## Rate limits and capacity planning

Datadog rate-limits per endpoint class, not globally. Every response includes
`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds until
the window resets), and `X-RateLimit-Period` (window size in seconds). Read them
before writing retry logic.

| Endpoint class | Default limit (per org) | Reset | Notes |
|---|---|---|---|
| `POST /api/v1/events` | 1,000 / hour | rolling 3600s | 429 with `Retry-After`; consider `POST /api/v2/events` for higher throughput plans |
| `POST /api/v2/series` (metrics) | 3,600 / hour on the free/pro plans, 60,000+ on enterprise | rolling 3600s | Batch metrics into a single call — up to 3.2 MB payload, no per-series cap |
| Log intake `POST /api/v2/logs` | 5 MB / request, 1,000 logs / request | per request | No hourly cap; billed by ingestion GB — the real cost gate |
| `GET /api/v1/monitor` | 60 / hour | rolling 3600s | Deceptively low; cache monitor lists locally when you can |
| `POST /api/v1/monitor` (create/update/mute) | 60 / hour | rolling 3600s | Mutations share the read budget |
| `POST /api/v2/incidents` | 100 / hour | rolling 3600s | An incident storm can hit this fast |

**Retry pattern the agent should follow when it hits `429`:**

```bash
# Read Retry-After from the response header; fall back to Reset epoch delta.
retry_after=$(curl -sSD - -o /dev/null -H "DD-API-KEY: $DD_API_KEY" \
                "$DD_HOST/api/v1/events" | grep -i '^Retry-After:' | awk '{print $2}' | tr -d '\r')
sleep "${retry_after:-30}"
```

**Ingestion-cost gate (metrics + logs):** Datadog bills logs by ingested GB and
metrics by custom-metric-count. Agents that emit one metric per message on a
Telegram bot with 50k msgs/day can trip the free-tier metric cap in one
afternoon. Cap emission at the agent side: sample logs, aggregate metrics into
5-min buckets, dedupe events by title within a rolling window.

**Long-term storage vs live view:** Events retained 15 days, metrics 15 months
at 1-min resolution then rolled up, logs 15 days by default (indexable), 30 days
in Live Search cold storage. If an agent needs to correlate against events > 15
days old, snapshot to `integration-r2` weekly rather than expecting Datadog to
retain them.

---

## Worked debugging scenarios

### Scenario A — "Datadog was working, then this morning every call returns 403"

Symptoms: no config changes on the VPS side; the smoke test in Step 9 now fails
with `validate=403`.

Diagnosis order:

1. **Rotate check.** Did anyone rotate the API or App key in the Datadog UI without
   pushing the new value via `hermes config set`? Ask, then check
   Organization Settings → API Keys → sort by "Modified" desc.
2. **Site mismatch after org migration.** Datadog sometimes migrates enterprise
   orgs between sites (US1 → US5). The old `DD_SITE` value is stale.
   `curl -H "DD-API-KEY:$DD_API_KEY" https://api.us5.datadoghq.com/api/v1/validate`
   — if that returns 200, update `DD_SITE`.
3. **App Key scope revoked.** Personal Settings → Application Keys → check the
   key's scopes. A collaborator with admin rights can prune scopes.
4. **Account suspension.** Overdue invoice → org-wide 403 from all endpoints.
   Datadog does not clearly communicate this on the API; check billing.

Once fixed: `hermes config set DD_SITE 'us5.datadoghq.com'`, then
`hermes gateway stop && hermes gateway run` (never `restart`).

### Scenario B — "Metrics show up in Events Explorer but not in dashboards"

Root cause is almost always the tag namespace. Datadog silently accepts
mis-typed tags but you can't filter dashboards on them.

Debug:

```bash
# List tag keys emitted in the last 10 min
ssh "$VPS_USER@$VPS_IP" '
  set -a; . ~/.hermes/.env; set +a
  curl -sS -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    "https://api.$DD_SITE/api/v1/tags/hosts" | python3 -m json.tool | grep source
'
```

If you see `source:hstack` and `source:Hstack`, you have case drift. Tags are
case-sensitive in filters but lowercase-normalized in some UI views — a nasty
mismatch. Fix: sanitize all tag emit code to `tr '[:upper:]' '[:lower:]'`.

### Scenario C — "Monitor mute worked but the monitor still alerted"

Datadog has two mute mechanisms: (a) `POST /v1/monitor/{id}/mute` — mutes the
monitor globally, (b) `POST /v1/monitor/{id}/mute?scope=env:staging` —
mutes only the scope. Passing an empty scope string is treated as (a); passing
a malformed scope silently mutes nothing. Confirm with:

```bash
curl -sS -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  "https://api.$DD_SITE/api/v1/monitor/$MONITOR_ID" | python3 -m json.tool | grep -A2 '"options"'
```

The response block will show `"silenced": {}` when nothing is muted. If your
mute call returned 200 but the block is `{}`, the scope was malformed.

### Scenario D — "Log intake returns 202 but logs never appear"

Two independent causes worth checking in order:

1. **Wrong intake host.** Skills using `api.$DD_SITE/api/v2/logs` — that's the
   Public API, not intake. Real intake is `http-intake.logs.$DD_SITE`. The
   Public API accepts your call and drops it.
2. **Log index filter drops the log.** Logs → Configuration → Indexes.
   Filters run before indexing; a filter with a typo silently drops matching
   logs. Add a temporary catch-all index to isolate.

---

## Credential rotation procedure

Datadog credentials come in three flavors, each with distinct rotation
mechanics:

**API key (`DD_API_KEY`) — 32-char hex, submit-scope:**

1. Datadog UI → Organization Settings → API Keys → **New Key**. Copy the value.
2. On the VPS: `hermes config set DD_API_KEY '<new>'`.
3. `hermes gateway stop && sleep 2 && hermes gateway run --daemon`.
4. Re-run Step 9's smoke test; confirm `validate=200`.
5. Back in the UI, disable the old key. Wait 10 minutes to confirm no other
   integration was silently using it (log intake, agent daemon, external
   collectors will 403 loudly), then delete it.

**Application key (`DD_APP_KEY`) — 40-char hex, adds query + mutation scope:**

1. UI → Personal Settings → Application Keys → **New Key**. Match the scopes
   listed in the gather table exactly: `metrics_read`, `monitors_read`,
   `monitors_write`, `events_write`, `logs_write`. Do NOT grant "all scopes."
2. On the VPS: `hermes config set DD_APP_KEY '<new>'`.
3. `hermes gateway stop && sleep 2 && hermes gateway run --daemon`.
4. Re-run Step 9's smoke test AND
   `curl -H "DD-API-KEY:$DD_API_KEY" -H "DD-APPLICATION-KEY:$DD_APP_KEY" $DD_HOST/api/v1/monitor?page_size=1`
   — needs 200 for query scope confirmation.
5. Delete the old key in the UI.

**Site (`DD_SITE`) — rare, but sometimes forced by an enterprise migration:**

1. New site announced by Datadog support → new keys minted on the new site.
2. Rotate `DD_API_KEY`, `DD_APP_KEY`, AND `DD_SITE` in the same
   `hermes config set` batch, then a single gateway stop+run.
3. Update `DD_SITE` references in every skill's `/opt/data/*-rest.md` if they
   hard-coded the old site (they should reference `${DD_SITE}` — grep to
   confirm).

**Rotation-triggered blast-radius review:** After any rotation, check that the
old key doesn't appear in `~/.hermes/logs/*.log` or `/var/log/*` on the VPS.
If it does, purge the file (the token is worthless once revoked, but grep-scans
by future security auditors will flag it as a live-looking secret).

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    for K in DD_API_KEY DD_APP_KEY DD_SITE; do
      hermes config unset \$K 2>/dev/null || sed -i \"/^\$K=/d\" ~/.hermes/.env
    done
    rm -f /opt/data/datadog-rest.md
    hermes gateway stop; sleep 2; hermes gateway run --daemon
  "
  echo "Rolled back. Datadog is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wrong site | US1 keys on EU1 return 403; the error message barely hints at it. | Read `DD_SITE` from the UI bottom-left; validate against the six-site allowlist. |
| 2 | Bearer auth | Datadog rejects Bearer. Auth is via `DD-API-KEY` + `DD-APPLICATION-KEY` headers. | Never send `Authorization:`; use the two DD headers. |
| 3 | Missing App Key on query | `/v1/monitor` returns 403 with only API key. | Add `DD-APPLICATION-KEY` to any query/mutation call. |
| 4 | Log intake on wrong host | Logs go to `http-intake.logs.$DD_SITE`, NOT `api.$DD_SITE`. Silently drops. | Use the doc's host table; grep for `http-intake.logs` in the REST doc. |
| 5 | App Key with over-broad scope | Compromise = write access to every monitor. | Scope narrowly: `metrics_read`, `monitors_read`, `events_write`, add `_write` only where needed. |
| 6 | Tag character rules | Datadog tags must be lowercase `[a-z0-9_./-]`, max 200 chars. Bad tags → 400. | Sanitize tag values client-side. |
| 7 | Confusing with the Datadog Agent daemon | The daemon is a separate install for host telemetry; this skill only wires the API. | Document this explicitly; point at Datadog's installer for the daemon. |
| 8 | `gateway restart` for env changes | Restart doesn't reliably re-read `.env`. | Always `stop` + `run`. |
| 9 | Storing keys in `config.yaml` | World-readable; can't rotate without restart. | Only `~/.hermes/.env`, `chmod 600`. |
| 10 | sed with `/` delimiter | Keys are hex — safe, but keep pattern uniform. | Always `\|` delimiter. |
| 11 | Container vs host confusion | Env on host but Hermes in container. | Step 1 detects layer; verify env inside gateway (Step 8). |
| 12 | Emitting events without tags | Datadog Events Explorer is unfiltered — ops can't correlate. | Always tag: `source:hermes-agent`, `env:prod`, `skill:…`. |
| 13 | Monitor mutate without approval | Auto-mute can hide real outages. | Require `WRITES_ACKNOWLEDGED=1`; log every mutate. |
| 14 | Log intake at `api.$DD_SITE/api/v2/logs` | Public API accepts and drops; intake host is `http-intake.logs.$DD_SITE`. | Use the doc's host table; grep the REST doc for `http-intake.logs`. |
| 15 | Ingesting one metric per message | Custom-metric count trips the free-tier cap within a day on any bot with real traffic. | Aggregate into 5-min buckets; sample logs; dedupe events by title. |
| 16 | Mute call with malformed `scope=` param | Datadog returns 200 but the monitor stays unmuted. | Verify the `silenced:` block on the monitor; retry with a validated scope string. |
| 17 | Case-drift on tags (`source:hstack` vs `source:Hstack`) | Filters are case-sensitive; UI is not. Dashboards show empty, Events Explorer shows data. | Lowercase all tag values client-side before emit. |
| 18 | Monitor list endpoint deceptively rate-limited (60/hr) | An agent that polls monitors every minute exhausts the budget in an hour. | Cache monitor list locally; refresh on webhook, not on poll. |
| 19 | Enterprise site migration (`us1` → `us5`) breaks old keys | 403 with a misleading "not authorized" message. | Re-mint keys on the new site; update `DD_SITE`; grep for hard-coded old-site URLs. |
| 20 | Trial expiring silently downgrades scopes | An App Key that had `monitors_write` on trial loses it when the org reverts to Pro. | Monitor billing; alert on trial-end 14 days out. |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] `WRITES_ACKNOWLEDGED=1` consent gate passed
- [ ] Format checks passed for API key (32 hex), App key (40 hex), site (six-allow-list)
- [ ] Live pre-flight: `/v1/validate` returned `200`
- [ ] Live pre-flight: `/v1/monitor?page_size=1` returned `200` (App Key scope check)
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `DD_API_KEY`, `DD_APP_KEY`, `DD_SITE` in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `/opt/data/datadog-rest.md` written with events/metrics/logs/monitors/incidents + error table
- [ ] Gateway reloaded with `stop` + `run` (NOT `restart`)
- [ ] Env verified: 3 `DD_*` vars visible inside gateway
- [ ] Hermes-side smoke test: `validate=200` and `event=202` returned
- [ ] `hstack.integration.wired` event visible in Datadog Events Explorer
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and REST failure modes.
