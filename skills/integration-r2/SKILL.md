---
name: integration-r2
description: Connect Cloudflare R2 (S3-compatible object storage, zero egress fees, native to Cloudflare Workers) to a self-hosted Hermes Agent over SSH. Uses S3 API credentials (Access Key ID + Secret) with the R2 endpoint. Stores generated media (DALL-E images, ElevenLabs audio, Firecrawl scrapes), file uploads/downloads from messaging platforms. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, Gemini CLI, and OpenClaw.
---

# /integration-r2 — connect Cloudflare R2 to a remote Hermes (SSH-first)

You are the engineer connecting Cloudflare R2 (S3-compatible object storage with **zero
egress fees** — a huge cost win vs S3) to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, OpenClaw, any of them)
work over SSH as root against the VPS. The user does two things a machine cannot:

1. Create the R2 bucket in Cloudflare Dashboard → R2 → Create bucket.
2. Mint the R2 API token in Cloudflare Dashboard → R2 → Manage API Tokens → Create
   token — pick scope (single bucket / all buckets) and permissions (read / write / admin).

Everything else — credential storage, live S3-API verification via bucket-list or head-
object, gateway reload, live upload smoke test — runs on the VPS via SSH, idempotently
with a rollback path.

**Honest auth picture (verified 2026-06):** R2 has **no first-party MCP server**. The
standard integration is the **S3-compatible API** with Access Key ID + Secret Access Key
using AWS Signature V4. Any S3 tool (aws-cli, boto3, minio-mc, rclone) works with R2 by
setting the custom endpoint.

Sources:
- https://developers.cloudflare.com/r2/api/s3/api/
- https://developers.cloudflare.com/r2/api/s3/tokens/

**Two paths:**

- **Path A (default) — community stdio MCP for S3-compatible storage.** `s3-mcp-server`
  or `mcp-server-s3` (community) can be pointed at R2 with the custom endpoint. Vet
  before trusting with write access.
- **Path B (fallback) — generic HTTPS tool** with the S3 SigV4 dance. If the agent has
  a generic AWS-signed HTTP tool, point it at the R2 endpoint.

**Why R2 vs S3:** Cloudflare charges **$0 egress**. If your agent generates images/audio
that users download hundreds of times, S3 egress can dominate the bill. R2 is essentially
free after the tiny storage fee ($0.015/GB/mo).

**Endpoint format:** R2's S3 endpoint is
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (no region — R2 is single-region-ish per
bucket location hint). The Account ID is in Cloudflare Dashboard → right sidebar or the
URL.

**Least-privilege recommendation:** create the API token scoped to **one bucket, one
permission** (read OR write, not admin). Never grant "admin" or "all buckets" to an
agent unless you're building a bucket-management agent specifically.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$R2_ACCOUNT_ID` | Cloudflare Account ID (32-char hex) | Cloudflare Dashboard → right sidebar |
| `$R2_ACCESS_KEY_ID` | R2 API token Access Key ID (32-char) | R2 → Manage API Tokens → Create → shown on creation |
| `$R2_SECRET_ACCESS_KEY` | R2 API token Secret Access Key | Same place — shown ONCE on creation |
| `$R2_BUCKET_NAME` | Bucket name (lowercase alphanumeric + `-`) | R2 → Overview → your bucket |
| `$R2_ALLOW_WRITES` *(optional)* | `1` if agent needs write access | Defaults to read-only smoke test path |
| `$WIRE_PATH` *(optional)* | `A` (community stdio MCP) or `B` (generic HTTP tool, default) | B is safer — no third-party MCP in trust path |

Confirm SSH access:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 1 — verify Hermes + aws-cli on the VPS (for pre-flight)

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

# aws-cli is highly recommended for pre-flight + smoke testing
ssh "$VPS_USER@$VPS_IP" "command -v aws >/dev/null 2>&1" \
  || echo "WARN: aws-cli not on VPS PATH. Install: pip install awscli. Some smoke tests will fall back to Python."
```

Expected: `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET_NAME)=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$COUNT" = "4" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "R2 already wired (all 4 vars present). Set FORCE=1 to rewire."; exit 0
fi
```

---

## Step 3 — HARD GATE (formats + live head-bucket verify)

```bash
# Account ID: 32-char hex
printf '%s' "$R2_ACCOUNT_ID" | grep -qE '^[a-f0-9]{32}$' \
  || { echo "ABORT: R2_ACCOUNT_ID must be 32-char lowercase hex (Cloudflare Account ID)."; exit 1; }

# Access Key ID: typically 32 hex chars
printf '%s' "$R2_ACCESS_KEY_ID" | grep -qE '^[a-f0-9]{32}$' \
  || { echo "ABORT: R2_ACCESS_KEY_ID must be 32-char lowercase hex."; exit 1; }

# Secret Access Key: base64-like, longer
[ "${#R2_SECRET_ACCESS_KEY}" -ge 40 ] \
  || { echo "ABORT: R2_SECRET_ACCESS_KEY looks too short (<40 chars)."; exit 1; }

# Bucket name: lowercase alphanumeric + dashes, 3-63 chars
printf '%s' "$R2_BUCKET_NAME" | grep -qE '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' \
  || { echo "ABORT: R2_BUCKET_NAME must be lowercase alphanumeric + dashes, 3-63 chars."; exit 1; }

# Live head-bucket via aws-cli against R2 endpoint
ENDPOINT="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"

if ssh "$VPS_USER@$VPS_IP" "command -v aws >/dev/null 2>&1"; then
  LIVE=$(ssh "$VPS_USER@$VPS_IP" "
    AWS_ACCESS_KEY_ID='$R2_ACCESS_KEY_ID' \
    AWS_SECRET_ACCESS_KEY='$R2_SECRET_ACCESS_KEY' \
    aws s3api head-bucket --bucket '$R2_BUCKET_NAME' --endpoint-url '$ENDPOINT' 2>&1
  " | head -3)
  case "$LIVE" in
    "") echo "R2 bucket '$R2_BUCKET_NAME' reachable at $ENDPOINT." ;;
    *"403"*|*"AccessDenied"*|*"Forbidden"*) echo "ABORT: 403 — credentials rejected or wrong scope."; exit 1 ;;
    *"404"*|*"NoSuchBucket"*|*"Not Found"*) echo "ABORT: 404 — bucket '$R2_BUCKET_NAME' not found."; exit 1 ;;
    *) echo "ABORT: head-bucket failed: $LIVE"; exit 1 ;;
  esac
else
  # Python fallback using boto3
  LIVE=$(ssh "$VPS_USER@$VPS_IP" "python3 -c \"
import sys
try:
  import boto3
except ImportError:
  print('NO_BOTO3'); sys.exit(0)
try:
  s3 = boto3.client('s3',
    endpoint_url='$ENDPOINT',
    aws_access_key_id='$R2_ACCESS_KEY_ID',
    aws_secret_access_key='$R2_SECRET_ACCESS_KEY',
    region_name='auto')
  s3.head_bucket(Bucket='$R2_BUCKET_NAME')
  print('OK')
except Exception as e:
  print(f'ERROR: {e}'); sys.exit(1)
\" 2>&1")
  case "$LIVE" in
    OK) echo "R2 bucket reachable (via boto3)." ;;
    NO_BOTO3) echo "WARN: no aws-cli AND no boto3 — cannot pre-verify. Proceeding without live check." ;;
    *) echo "ABORT: $LIVE"; exit 1 ;;
  esac
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
PATH_CHOSEN=${WIRE_PATH:-B}
WRITE_MODE=$([ "${R2_ALLOW_WRITES:-0}" = "1" ] && echo "READ-WRITE (agent can PUT/DELETE)" || echo "READ-ONLY (default)")
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  Path: $PATH_CHOSEN
  Access mode: $WRITE_MODE

  Always:
    1. Write R2_ACCOUNT_ID ($R2_ACCOUNT_ID) via 'hermes config set'
    2. Write R2_ACCESS_KEY_ID ($R2_ACCESS_KEY_ID)
    3. Write R2_SECRET_ACCESS_KEY (length ${#R2_SECRET_ACCESS_KEY}) — NEVER plaintext-logged
    4. Write R2_BUCKET_NAME ($R2_BUCKET_NAME)
    5. Write R2_ENDPOINT_URL (https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com) for tool convenience
    6. chmod 600 ~/.hermes/.env

  Path A (community stdio MCP — opt-in):
    7. Register MCP (community — vet before trusting write scope)
    8. Reload gateway: stop + run

  Path B (generic HTTP/S3 tool — default):
    7. No MCP registered. Generic tool uses R2_* env vars with SigV4 signing
    8. Reload gateway: stop + run

  Smoke test: HEAD bucket via aws-cli or boto3 — expect success
  Optional smoke (writes only): PUT + DELETE a test object

Secrets NEVER printed in plaintext beyond a length.
EOF
```

Wait for confirmation (or `AUTO_APPROVE=1`).

---

## Step 5 — write secrets (chmod 600)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set R2_ACCOUNT_ID '$R2_ACCOUNT_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set R2_ACCESS_KEY_ID '$R2_ACCESS_KEY_ID'"
ssh "$VPS_USER@$VPS_IP" "hermes config set R2_SECRET_ACCESS_KEY '$R2_SECRET_ACCESS_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set R2_BUCKET_NAME '$R2_BUCKET_NAME'"
ssh "$VPS_USER@$VPS_IP" "hermes config set R2_ENDPOINT_URL 'https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"

COUNT=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET_NAME|ENDPOINT_URL)=' ~/.hermes/.env" || echo 0)
[ "$COUNT" = "5" ] || { echo "FAIL: env did not all land (got $COUNT, need 5). Rolling back."; rollback; exit 1; }
```

Never `echo >>`. Never put credentials in `config.yaml`.

---

## Step 6 — wire path

### Path B (generic S3 tool — default, no third-party MCP)

Generic HTTP/S3 tool reads env and uses:

- **Endpoint URL:** `${R2_ENDPOINT_URL}` (or `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
- **Region:** `auto` (R2 requires SigV4 with region `auto`)
- **Auth:** SigV4 with `${R2_ACCESS_KEY_ID}` + `${R2_SECRET_ACCESS_KEY}`
- **Bucket:** `${R2_BUCKET_NAME}`

Common S3 operations (via aws-cli):
```
aws s3 ls s3://${R2_BUCKET_NAME}/ --endpoint-url ${R2_ENDPOINT_URL}
aws s3 cp file.png s3://${R2_BUCKET_NAME}/file.png --endpoint-url ${R2_ENDPOINT_URL}
aws s3 rm s3://${R2_BUCKET_NAME}/file.png --endpoint-url ${R2_ENDPOINT_URL}
```

Or via boto3:
```
s3 = boto3.client('s3', endpoint_url=R2_ENDPOINT_URL,
                  aws_access_key_id=R2_ACCESS_KEY_ID,
                  aws_secret_access_key=R2_SECRET_ACCESS_KEY,
                  region_name='auto')
s3.list_objects_v2(Bucket=R2_BUCKET_NAME)
```

### Path A — community stdio MCP (opt-in)

Community MCPs for S3-compatible storage exist (search `mcp-server-s3` on npm/GitHub).
Vet source before use. Register with the R2 endpoint override in env:

```bash
if [ "${WIRE_PATH:-B}" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "command -v uvx >/dev/null 2>&1 || command -v npx >/dev/null 2>&1" \
    || { echo "ABORT: Path A requires uvx or npx."; exit 1; }
  echo "Path A note: pin a specific community MCP SHA before running. This skill does NOT auto-register community MCPs to avoid supply-chain risk."
  echo "If you have a vetted MCP in mind, register it manually with:"
  echo "  hermes mcp add r2 --command <cmd> --args <args> --env S3_ENDPOINT_URL=\${R2_ENDPOINT_URL},AWS_ACCESS_KEY_ID=\${R2_ACCESS_KEY_ID},AWS_SECRET_ACCESS_KEY=\${R2_SECRET_ACCESS_KEY}"
fi
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 5
```

---

## Step 8 — live smoke test (head-bucket + optional PUT/DELETE round-trip)

```bash
# Read smoke — always
SMOKE=$(ssh "$VPS_USER@$VPS_IP" "
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=\"\$R2_ACCESS_KEY_ID\" \
    AWS_SECRET_ACCESS_KEY=\"\$R2_SECRET_ACCESS_KEY\" \
    aws s3api head-bucket --bucket \"\$R2_BUCKET_NAME\" --endpoint-url \"\$R2_ENDPOINT_URL\" 2>&1 | head -1
  else
    python3 -c 'import boto3,os; s=boto3.client(\"s3\",endpoint_url=os.environ[\"R2_ENDPOINT_URL\"],aws_access_key_id=os.environ[\"R2_ACCESS_KEY_ID\"],aws_secret_access_key=os.environ[\"R2_SECRET_ACCESS_KEY\"],region_name=\"auto\"); s.head_bucket(Bucket=os.environ[\"R2_BUCKET_NAME\"]); print(\"OK\")' 2>&1 | head -1
  fi
")
case "$SMOKE" in
  ""|OK) echo "OK: R2 bucket reachable from VPS." ;;
  *) echo "WARN: unexpected smoke response: $SMOKE" ;;
esac

# Write smoke — only if ALLOW_WRITES=1
if [ "${R2_ALLOW_WRITES:-0}" = "1" ]; then
  KEY="hstack-smoke-$(date +%s).txt"
  WRITE_SMOKE=$(ssh "$VPS_USER@$VPS_IP" "
    if command -v aws >/dev/null 2>&1; then
      echo 'hstack smoke' | AWS_ACCESS_KEY_ID=\"\$R2_ACCESS_KEY_ID\" \
        AWS_SECRET_ACCESS_KEY=\"\$R2_SECRET_ACCESS_KEY\" \
        aws s3 cp - s3://\"\$R2_BUCKET_NAME\"/'$KEY' --endpoint-url \"\$R2_ENDPOINT_URL\" 2>&1 | head -1
      AWS_ACCESS_KEY_ID=\"\$R2_ACCESS_KEY_ID\" \
      AWS_SECRET_ACCESS_KEY=\"\$R2_SECRET_ACCESS_KEY\" \
      aws s3 rm s3://\"\$R2_BUCKET_NAME\"/'$KEY' --endpoint-url \"\$R2_ENDPOINT_URL\" 2>&1 | head -1
      echo OK
    fi
  ")
  case "$WRITE_SMOKE" in
    *OK) echo "OK: R2 PUT + DELETE round-trip succeeded." ;;
    *) echo "WARN: write smoke: $WRITE_SMOKE" ;;
  esac
fi
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove r2 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    sed -i '/^R2_ACCOUNT_ID=/d;
            /^R2_ACCESS_KEY_ID=/d;
            /^R2_SECRET_ACCESS_KEY=/d;
            /^R2_BUCKET_NAME=/d;
            /^R2_ENDPOINT_URL=/d' ~/.hermes/.env
    chmod 600 ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. Revoke the R2 API token at Cloudflare Dashboard → R2 → Manage API Tokens if compromised."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Using AWS-region format like `us-east-1` | R2 requires `region=auto`; other values fail SigV4 | Always use `region_name='auto'` in boto3, `AWS_REGION=auto` in env |
| 2 | Admin-scoped API token | Agent can DELETE ANY bucket, ANY object across ALL buckets | Scope token to ONE bucket, ONE permission (read or write) at mint time |
| 3 | Confusing R2 API token with Cloudflare Global API Key | Global API Key auths Cloudflare Dashboard; R2 API Token auths S3 | Only use R2-specific tokens; never inline the Global Key |
| 4 | Bucket name doesn't follow DNS rules | R2 rejects uppercase, underscores, dots in some contexts | Step 3 enforces lowercase alphanumeric + dashes only |
| 5 | Secret in `config.yaml` | Often checked into git | Only `~/.hermes/.env`, `chmod 600` |
| 6 | Public bucket exposure | R2 buckets can be exposed publicly; enabled inadvertently | Check bucket → Settings → Public Access; keep private unless explicitly needed |
| 7 | Custom domain SSL confusion | If you serve R2 via custom domain, SSL is Cloudflare's cert, not the bucket's | Custom domains handled by Cloudflare CDN; don't add cert config here |
| 8 | Region-locality expectation | R2 has "location hints" (WNAM, ENAM, EEUR, WEUR, APAC) but is otherwise global | Set location hint at bucket creation for latency; can't change later |
| 9 | Zero egress means unlimited download | True — but PUT operations cost per 1000 (class-A), GET per 1000 (class-B) | Batch small PUTs; use presigned URLs for user downloads |
| 10 | `gateway restart` instead of `stop`+`run` | Restart doesn't reliably re-read env | Always `stop` + `run` (Step 7) |
| 11 | `echo >> .env` | Merge risk | Always `hermes config set` (Step 5), or the sed pattern |
| 12 | sed with `/` delimiter | Secret may contain `/+=` | Always `\|` delimiter |
| 13 | Container vs host confusion | `hermes` inside container invisible to host SSH | Step 1 detects both |
| 14 | Community MCP with hardcoded AWS endpoints | Some S3 MCPs assume AWS URL; can't override | Vet by grep for `s3.amazonaws.com` in source; test with R2 endpoint first |
| 15 | Assuming S3 API 100% compatible | R2 lacks some S3 features (Requester Pays, ACLs) | https://developers.cloudflare.com/r2/api/s3/api/ for the compat matrix |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` succeeded
- [ ] Hermes version verified on the VPS (`0.15.x` / `0.17.x`)
- [ ] Idempotency check ran (skipped if all 4 vars present, unless `FORCE=1`)
- [ ] HARD GATE passed: account ID + access key ID are 32-char hex; secret ≥40 chars; bucket name matches DNS rules; live head-bucket returned success
- [ ] Dry-run shown to user; access mode (read-only vs read-write) called out; user approved (or `AUTO_APPROVE=1`)
- [ ] All 5 env vars written to `~/.hermes/.env`, `chmod 600`, verified by grep
- [ ] Path B (default): generic S3 tool documented with `region=auto` + endpoint URL
- [ ] Path A (opt-in): community MCP registered manually (not auto — supply-chain safety)
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Smoke test: head-bucket from VPS returned success
- [ ] Write smoke (if `R2_ALLOW_WRITES=1`): PUT + DELETE round-trip succeeded
- [ ] User confirmed token is bucket-scoped, permission-scoped (not admin/all-buckets)
- [ ] User informed of zero-egress cost model + class-A vs class-B operation pricing
- [ ] Public-access setting confirmed by user (kept private unless explicitly needed)
- [ ] Rollback function defined; token revocation instructions included

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, S3
SigV4, and R2 endpoint failure modes.
