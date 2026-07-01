---
name: integration-aws
description: Connect AWS (EC2, S3, Lambda, and all 15000+ AWS APIs) to a self-hosted Hermes Agent over SSH, via the managed AWS MCP server reached through the SigV4-signing mcp-proxy-for-aws stdio proxy. Idempotent and rollback-safe. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI).
---

# /integration-aws — connect AWS to a remote Hermes (SSH-first)

You are the engineer connecting AWS to a self-hosted Hermes agent on the user's VPS.
You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of them) work over
SSH as root against the VPS. Every command runs on the VPS, not on the local machine.
The user only does the two things a machine cannot: mint the IAM credentials and pick
the operating region.

**Honest auth picture (verified 2026-06):** AWS does NOT fit the plain bearer-header
HTTP MCP pattern. AWS ships a first-party **managed remote MCP server**
(`https://aws-mcp.<region>.api.aws/mcp`, GA 2026-05) but it authenticates with **IAM
SigV4**, not a static bearer token — the MCP spec only standardizes OAuth 2.1, which
is why the shim exists. You reach it through a small **stdio proxy**
(`mcp-proxy-for-aws`, run via `uvx`) that signs each request with AWS credentials.
So the wiring is: install `uvx` inside the container, register the proxy as a
**stdio command MCP** in Hermes, and put AWS credentials in `~/.hermes/.env`. The
hosted `aws-mcp.api.aws` URL CANNOT be wired straight into a bearer-header HTTP MCP
flow — it will 401 every time.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$AWS_KEY` | AWS access key ID (`AKIA...` long-term or `ASIA...` temporary) | <https://console.aws.amazon.com/iam/home#/security_credentials> or IAM → Users → `<user>` → Security credentials → Create access key |
| `$AWS_SECRET` | AWS secret access key | Shown ONCE at key creation — copy immediately |
| `$AWS_TOKEN` | AWS session token (only if temporary creds) | From `aws sts ...`, SSO, or assumed role |
| `$OP_REGION` | Default operating region (e.g. `us-east-1`) | User's choice |
| `$ENDPOINT` | MCP endpoint region URL | `https://aws-mcp.us-east-1.api.aws/mcp` or `https://aws-mcp.eu-central-1.api.aws/mcp` |

**Credential preference:** temporary credentials (with session token, short-lived) >
long-term `AKIA` keys. AWS explicitly discourages long-term keys. Whatever you use,
scope the IAM principal to **least privilege** (read-only is a sane default).

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

Expected: `0.15.x` or `0.17.x`. If Hermes runs in a container, capture the agent
container name for later steps:

```bash
AGENT=$(ssh "$VPS_USER@$VPS_IP" "docker ps --filter name=hermes --format '{{.Names}}' | head -1")
```

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "hermes mcp list 2>/dev/null | grep -ci aws" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "AWS is already wired. Set FORCE=1 to rewire."
  exit 0
fi
```

Also remove any conflicting older AWS servers — AWS recommends the managed server
replace them, and duplicate tools confuse the agent:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes mcp remove aws-api-mcp-server 2>/dev/null || true"
ssh "$VPS_USER@$VPS_IP" "hermes mcp remove aws-knowledge-mcp-server 2>/dev/null || true"
```

---

## Step 3 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Ensure 'uvx' is installed for the hermes user inside the container
  2. Write AWS_ACCESS_KEY_ID    (length ${#AWS_KEY},    prefix ${AWS_KEY:0:4}...)
     Write AWS_SECRET_ACCESS_KEY (length ${#AWS_SECRET}, prefix ${AWS_SECRET:0:4}...)
     Write AWS_SESSION_TOKEN     (length ${#AWS_TOKEN},  prefix ${AWS_TOKEN:0:4}...) [if set]
     Write AWS_REGION=$OP_REGION
     via 'hermes config set' into ~/.hermes/.env
  3. chmod 600 ~/.hermes/.env
  4. Register MCP: hermes mcp add aws --command uvx --arg mcp-proxy-for-aws==1.6.2 --arg $ENDPOINT --arg --metadata --arg AWS_REGION=$OP_REGION
  5. Reload gateway: hermes gateway stop && hermes gateway run
  6. Verify in logs: grep -i "registered.*aws"
  7. Smoke test: call_aws sts get-caller-identity → expect a JSON identity

Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 4 — write the AWS credentials (chmod 600, no echo, no logging)

The proxy signs each request with credentials inherited from the environment. Write
them via `hermes config set` so they land in `~/.hermes/.env` (or `/opt/data/.env`
inside the container) and the proxy subprocess inherits them. Never `echo >>`,
never `config.yaml`, never chat.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set AWS_ACCESS_KEY_ID '$AWS_KEY'"
ssh "$VPS_USER@$VPS_IP" "hermes config set AWS_SECRET_ACCESS_KEY '$AWS_SECRET'"
if [ -n "$AWS_TOKEN" ]; then
  ssh "$VPS_USER@$VPS_IP" "hermes config set AWS_SESSION_TOKEN '$AWS_TOKEN'"
fi
ssh "$VPS_USER@$VPS_IP" "hermes config set AWS_REGION '$OP_REGION'"
ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns count of names only, NEVER the values):

```bash
WROTE=$(ssh "$VPS_USER@$VPS_IP" "grep -cE '^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)=' ~/.hermes/.env" || echo 0)
[ "$WROTE" -ge 3 ] || { echo "FAIL: AWS keys not written. Rolling back."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, write directly with a
> `|`-delimited sed (AWS secrets contain `/+=` — slash delimiter will break):
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   f=~/.hermes/.env
>   set_kv() { grep -q \"^\$1=\" \"\$f\" && sed -i \"s|^\$1=.*|\$1=\$2|\" \"\$f\" || printf '%s=%s\n' \"\$1\" \"\$2\" >> \"\$f\"; }
>   set_kv AWS_ACCESS_KEY_ID '$AWS_KEY'
>   set_kv AWS_SECRET_ACCESS_KEY '$AWS_SECRET'
>   set_kv AWS_REGION '$OP_REGION'
>   chmod 600 \"\$f\"
> "
> ```

**Safe defaults — strongly recommended:** add the proxy's safety flags so blast
radius is bounded by default. The proxy reads these from the env:

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set READ_OPERATIONS_ONLY 'true'"
ssh "$VPS_USER@$VPS_IP" "hermes config set REQUIRE_MUTATION_CONSENT 'true'"
```

---

## Step 5 — register the MCP server

AWS is a **stdio command** server (Hermes spawns the proxy, which holds the
HTTPS+SigV4 connection to AWS). Path A is preferred. Path B is the no-proxy
fallback if `uvx` cannot be installed in the container.

### Path A (preferred) — `mcp-proxy-for-aws` as a stdio MCP

First, ensure `uvx` is available to the hermes user inside the container:

```bash
ssh "$VPS_USER@$VPS_IP" "
  docker exec -u hermes '$AGENT' sh -c 'command -v uvx' \
    || docker exec -u hermes '$AGENT' sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
  docker exec -u hermes '$AGENT' sh -c 'export PATH=\$HOME/.local/bin:\$PATH; uvx --version'
"
```

Then register the stdio command. Pin the proxy version (`==1.6.2` here; check
<https://pypi.org/project/mcp-proxy-for-aws/> for current — `@latest` can pull a
breaking change mid-deploy):

```bash
ssh "$VPS_USER@$VPS_IP" "
  hermes mcp add aws \
    --command uvx \
    --arg 'mcp-proxy-for-aws==1.6.2' \
    --arg '$ENDPOINT' \
    --arg '--metadata' \
    --arg 'AWS_REGION=$OP_REGION'
"
```

The proxy inherits `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` / `AWS_REGION` from `~/.hermes/.env` (step 4) — do NOT
duplicate them in `config.yaml`.

If the Hermes build's `mcp add` does not accept `--command/--arg`, edit
`config.yaml` to add a stdio entry directly (no secrets here):

```yaml
aws:
  command: uvx
  args:
    - mcp-proxy-for-aws==1.6.2
    - https://aws-mcp.us-east-1.api.aws/mcp
    - --metadata
    - AWS_REGION=us-east-1
  enabled: true
```

If `uvx` is only at `~/.local/bin`, use the absolute path
(`/home/hermes/.local/bin/uvx`) in the command — PATH may not be inherited by
the spawned subprocess.

### Path B (fallback) — direct AWS REST when no stdio proxy is possible

If the Hermes build is HTTP-MCP-only and cannot spawn a stdio command, drop down
to raw SigV4-signed REST against the AWS API for the specific service you need.
The hosted `https://aws-mcp.api.aws/mcp` URL CANNOT be used with a bearer token —
it is SigV4-only. Use the AWS SDK or `aws` CLI from inside the container; the
credentials are already in `~/.hermes/.env`.

---

## Step 6 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT reliably re-read `.env`. Always use stop + run.

```bash
ssh "$VPS_USER@$VPS_IP" "hermes gateway stop || true"
sleep 3
ssh "$VPS_USER@$VPS_IP" "hermes gateway run --daemon"
sleep 10   # first run downloads the proxy via uvx; allow extra time
```

First connection can take a minute or more while `uvx` fetches
`mcp-proxy-for-aws`.

---

## Step 7 — verify registration in logs (poll up to 30s)

```bash
REGISTERED=0
for i in $(seq 1 6); do
  if ssh "$VPS_USER@$VPS_IP" "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered.*tool.*aws|MCP server.*aws.*(ok|ready)|call_aws"; then
    REGISTERED=1
    echo "OK: aws registered in gateway logs."
    break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: aws not in logs after 30s. Rolling back."; rollback; exit 1; }
```

Expect a line registering the `aws` MCP server and its tools (e.g. `call_aws`,
`search_documentation`, `read_documentation`).

---

## Step 8 — live API smoke test (inside the container, so creds stay on the VPS)

The cleanest end-to-end proof is `sts get-caller-identity` — it exercises
credentials, proxy startup, SigV4 signing, and tool registration, with zero
side effects and no IAM permissions required.

```bash
HTTP=$(ssh "$VPS_USER@$VPS_IP" "
  docker exec -u hermes '$AGENT' sh -c '
    export PATH=\$HOME/.local/bin:\$PATH
    curl -sS -o /tmp/aws-smoke.json -w \"%{http_code}\" \
      https://sts.$OP_REGION.amazonaws.com/ \
      --aws-sigv4 \"aws:amz:$OP_REGION:sts\" \
      --user \"\$AWS_ACCESS_KEY_ID:\$AWS_SECRET_ACCESS_KEY\" \
      -H \"x-amz-security-token: \$AWS_SESSION_TOKEN\" \
      -d \"Action=GetCallerIdentity&Version=2011-06-15\"
  '
")
case "$HTTP" in
  200) echo "OK: AWS credentials valid; SigV4 reachable." ;;
  401|403) echo "FAIL: credentials invalid or expired. Re-check Step 4."; rollback; exit 1 ;;
  *)   echo "WARN: unexpected HTTP $HTTP from STS. Check manually." ;;
esac
```

End-to-end agent proof from chat:

```
@<agent> using aws, run sts get-caller-identity
```

A JSON identity (account ID + ARN) proves credentials, proxy, SigV4, and tool
registration all work together. `What AWS regions are available?` is a lighter
docs-only check needing no write perms.

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "hermes mcp remove aws 2>/dev/null || true"
  ssh "$VPS_USER@$VPS_IP" "
    hermes config unset AWS_ACCESS_KEY_ID 2>/dev/null || sed -i '/^AWS_ACCESS_KEY_ID=/d' ~/.hermes/.env
    hermes config unset AWS_SECRET_ACCESS_KEY 2>/dev/null || sed -i '/^AWS_SECRET_ACCESS_KEY=/d' ~/.hermes/.env
    hermes config unset AWS_SESSION_TOKEN 2>/dev/null || sed -i '/^AWS_SESSION_TOKEN=/d' ~/.hermes/.env
    hermes config unset AWS_REGION 2>/dev/null || sed -i '/^AWS_REGION=/d' ~/.hermes/.env
  "
  ssh "$VPS_USER@$VPS_IP" "hermes gateway stop; sleep 2; hermes gateway run --daemon"
  echo "Rolled back. AWS is no longer wired."
}
```

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Wiring `aws-mcp.api.aws` as a bearer-header HTTP MCP | SigV4-only; bearer token is rejected with 401 | Use the stdio proxy (Path A) — `mcp-proxy-for-aws` signs each call |
| 2 | Temporary credentials expire mid-session | STS/SSO/assumed-role sessions are short-lived (1–12h) → `ExpiredTokenException`, every tool call fails | Refresh creds, rewrite step 4, reload gateway. Prefer roles + refresh over `AKIA` |
| 3 | `InvalidSignatureException` | Host clock skew (SigV4 is time-sensitive) OR creds scoped to wrong region/service | `timedatectl`/NTP sync on host; confirm `AWS_REGION` matches the operating region |
| 4 | `uvx` missing in the container | Proxy is a Hermes subprocess; if `uv` is not on hermes-user PATH the server fails to start with no obvious MCP error | Step 5 Path A installs+probes `uvx`; if PATH not inherited, use `/home/hermes/.local/bin/uvx` absolute path |
| 5 | Blast radius from `call_aws` | The tool can hit all 15000+ AWS APIs with whatever IAM allows, including destructive ones | Least-privilege IAM (read-only default) + set `READ_OPERATIONS_ONLY=true` and `REQUIRE_MUTATION_CONSENT=true` (step 4) |
| 6 | Connect region vs operating region confusion | Endpoint region picks the managed server; `--metadata AWS_REGION` picks where ops run; without it, defaults silently to `us-east-1` | Always pass `--metadata AWS_REGION=$OP_REGION`; can differ from endpoint region |
| 7 | Conflicting older servers (`aws-api-mcp-server`, `aws-knowledge-mcp-server`) | Duplicate tools confuse the agent; AWS recommends the managed server replace both | Step 2 removes both before registering |
| 8 | Secret in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`, via `config set` |
| 9 | `echo >>` to append secrets | If prior line has no trailing newline, two values merge | Always `hermes config set`; sed fallback uses `|` delimiter (AWS secrets contain `/+=`) |
| 10 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Always `stop` + `run` |
| 11 | Container vs host confusion | Skill assumed wrong layer; `whoami; hostname` would have caught it | Step 1 checks both paths; capture `$AGENT` for in-container steps |
| 12 | Pinning `mcp-proxy-for-aws@latest` | A breaking change mid-deploy ruins reproducibility | Pin explicit version (`==1.6.2`); bump deliberately after testing |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode); conflicting older AWS MCPs removed
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] `uvx` available to the hermes user inside the container
- [ ] AWS credentials in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] `READ_OPERATIONS_ONLY=true` and `REQUIRE_MUTATION_CONSENT=true` set (or IAM principal already least-privilege)
- [ ] MCP registered via Path A (stdio `mcp-proxy-for-aws`, pinned version) or REST documented via Path B
- [ ] Gateway reloaded with `stop` + `run` (NOT restart)
- [ ] Logs show `registered N tool(s) for 'aws'` (or `call_aws`) within 30s
- [ ] Smoke test: `sts:GetCallerIdentity` returned `200` with an identity
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)
- [ ] Credentials rotated if any value was exposed in chat or shell history

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, SigV4, and stdio-proxy failure modes.
