---
name: integration-aws
description: Connect AWS (EC2, S3, Lambda, and all 15000+ AWS APIs) to a running Hermes agent via the managed AWS MCP Server, reached through the SigV4-signing mcp-proxy-for-aws stdio proxy. Use when the user wants Hermes to query or operate their AWS account.
---

# /integration-aws — wire AWS into Hermes

You are the engineer connecting AWS to a running Hermes agent. AWS does NOT fit the plain
`/hermes-mcp-add` bearer-header path. AWS ships a first-party **managed remote MCP server**
(`https://aws-mcp.<region>.api.aws/mcp`), but it authenticates with **IAM SigV4**, not a bearer
token. You reach it through a small local **stdio proxy** (`mcp-proxy-for-aws`, run via `uvx`)
that signs each request with your AWS credentials. So the wiring is: install the proxy inside the
container, register it as a **command (stdio) MCP** in Hermes, and put the AWS credentials in
`/opt/data/.env`. Do everything autonomously; stop only for the AWS credentials (a machine cannot
mint them) and the target region.

## Before you start — gather (ask once)

1. **AWS credentials.** The proxy uses the standard AWS credential chain (boto3), so any of these
   work, in order of preference:
   - **Temporary credentials (preferred):** an access key ID + secret + **session token** from
     `aws sts ...`, SSO, or an assumed role. Short-lived, so safer. The IAM console for keys is at
     https://console.aws.amazon.com/iam/home#/security_credentials (root) or
     **IAM → Users → <user> → Security credentials → Create access key** for an IAM user.
   - **Long-term IAM access key** (only if temporary creds are not an option): an access key ID
     (prefixed `AKIA...`) + secret access key. Minted at the same console path. The secret is shown
     **once** — copy it immediately. AWS explicitly discourages long-term keys; prefer the above.
   - Create a dedicated IAM principal scoped to least privilege (read-only is a good default — see
     Pitfalls for the `READ_OPERATIONS_ONLY` proxy flag).
2. **Default AWS region** for operations, e.g. `us-east-1`. The proxy takes this as a `--metadata
   AWS_REGION=<region>` flag; without it, all operations default to `us-east-1`.
3. **Which MCP endpoint region** to connect to. Two exist (the connect region can differ from the
   operating region):
   - US East (N. Virginia): `https://aws-mcp.us-east-1.api.aws/mcp`
   - Europe (Frankfurt): `https://aws-mcp.eu-central-1.api.aws/mcp`
4. **Agent container name** — `docker ps --format '{{.Names}}' | grep hermes` on the host.

Set shell vars from answers (do NOT log the secret/token):
```bash
AGENT=<container-name>                              # e.g. hermes-agent-mxlc-hermes-agent-1
ENDPOINT=https://aws-mcp.us-east-1.api.aws/mcp      # MCP server endpoint region
OP_REGION=us-east-1                                 # default region for AWS operations
AWS_KEY=<AKIA... or ASIA...>                        # access key id
AWS_SECRET=<secret access key>                      # never log this
AWS_TOKEN=<session token, if temporary creds>       # empty for long-term keys
```

This is a verified first-party AWS MCP server (GA 2026-05). It went GA after pinning was set; the
proxy is versioned, so pin the version you test with rather than trusting `@latest` blindly.

---

## Step 1 — confirm the proxy and credentials work on the host first

Before touching the container, prove the credential set is valid and the proxy can sign. `uvx`
(from `uv`) runs the proxy without a global install. The proxy reads the standard AWS env vars.

```bash
# uv must be present on the host; install once if missing:
command -v uvx || curl -LsSf https://astral.sh/uv/install.sh | sh

# Sanity-check the credentials sign a real AWS call (proves SigV4 will work):
AWS_ACCESS_KEY_ID="$AWS_KEY" \
AWS_SECRET_ACCESS_KEY="$AWS_SECRET" \
AWS_SESSION_TOKEN="$AWS_TOKEN" \
AWS_REGION="$OP_REGION" \
  aws sts get-caller-identity
```

A JSON block with `Account`, `Arn`, `UserId` means the credentials authenticate. `No AWS
credentials found` or `UnrecognizedClientException` means the key/secret/token is wrong or expired
— fix before continuing. (If `aws` is not installed on the host, skip this and rely on the in-chat
verify in the last section; the env-var check below still applies.)

---

## Step 2 — make `uvx` available inside the container

The proxy runs as a Hermes-spawned subprocess **inside the agent container**, so `uv`/`uvx` must
exist there. Check, and install into the hermes user's path if missing:

```bash
docker exec -u hermes "$AGENT" sh -c 'command -v uvx' \
  || docker exec -u hermes "$AGENT" sh -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'

# Confirm it resolves on PATH for the hermes user:
docker exec -u hermes "$AGENT" sh -c 'export PATH="$HOME/.local/bin:$PATH"; uvx --version'
```

If `uvx` is only at `~/.local/bin`, note the absolute path (`/home/hermes/.local/bin/uvx`) — you
may need to use it explicitly in the command registration in step 4.

---

## Step 3 — write the AWS credentials into `/opt/data/.env` (chmod 600)

The proxy signs with credentials from the environment. Put them in the Hermes runtime env file so
the proxy subprocess inherits them. Use `hermes config set` (preferred) or direct `sed`-style
writes — never `echo >>`, never `config.yaml`, never chat.

```bash
docker exec -u hermes "$AGENT" hermes config set AWS_ACCESS_KEY_ID "$AWS_KEY"
docker exec -u hermes "$AGENT" hermes config set AWS_SECRET_ACCESS_KEY "$AWS_SECRET"
# Only if using temporary credentials:
[ -n "$AWS_TOKEN" ] && docker exec -u hermes "$AGENT" hermes config set AWS_SESSION_TOKEN "$AWS_TOKEN"
docker exec -u hermes "$AGENT" hermes config set AWS_REGION "$OP_REGION"

# Lock the file down — it now holds AWS credentials:
docker exec "$AGENT" sh -c 'chmod 600 /opt/data/.env'
```

If `hermes config set` is unavailable, write directly with `|`-delimited `sed` (secrets contain
`/+=`), creating the line if absent:
```bash
docker exec "$AGENT" sh -c '
  f=/opt/data/.env
  set_kv() { grep -q "^$1=" "$f" && sed -i "s|^$1=.*|$1=$2|" "$f" || printf "%s=%s\n" "$1" "$2" >> "$f"; }
  set_kv AWS_ACCESS_KEY_ID "'"$AWS_KEY"'"
  set_kv AWS_SECRET_ACCESS_KEY "'"$AWS_SECRET"'"
  set_kv AWS_REGION "'"$OP_REGION"'"
  chmod 600 "$f"'
```

Verify the keys landed (prints names only, never values):
```bash
docker exec "$AGENT" sh -c 'grep -cE "^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION)=" /opt/data/.env'
# expect 3 (or 4 with a session token)
```

---

## Step 4 — register the proxy as a command (stdio) MCP in Hermes

This is the one place AWS departs from `/hermes-mcp-add`: that skill wires **remote HTTP** MCP
servers with a bearer header. AWS is a **stdio command** server (Hermes spawns the proxy, which
holds the HTTPS+SigV4 connection to AWS). Register the command, not a URL:

```bash
docker exec -u hermes "$AGENT" hermes mcp add aws \
  --command uvx \
  --arg "mcp-proxy-for-aws==1.6.2" \
  --arg "$ENDPOINT" \
  --arg "--metadata" \
  --arg "AWS_REGION=$OP_REGION"
```

If your Hermes `mcp add` does not accept `--command/--arg`, edit `config.yaml` to add a stdio
entry directly (no secrets here — credentials stay in `.env`):
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
The proxy inherits `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` /
`AWS_REGION` from the `/opt/data/.env` you wrote in step 3 — do not duplicate them in `config.yaml`.

Pin the proxy version (`==1.6.2` here, or whatever is current — check
https://pypi.org/project/mcp-proxy-for-aws/). `@latest` can pull a breaking change mid-deploy.

---

## Step 5 — reload the gateway and verify (follow /hermes-mcp-add for the reload pattern)

Reuse the `/hermes-mcp-add` reload discipline: **`gateway stop` + `gateway run`**, not `restart`
(env changes are not always re-read on restart):
```bash
docker exec -u hermes "$AGENT" hermes gateway stop
sleep 3
docker exec -d -u hermes "$AGENT" hermes gateway run
sleep 10   # first run downloads the proxy via uvx; allow extra time
```

First connection can take a minute or more while `uvx` fetches `mcp-proxy-for-aws`.

---

## Pitfalls

- **Not a bearer token — SigV4.** AWS MCP authenticates with IAM SigV4, not a static header token.
  The MCP spec only standardizes OAuth 2.1, which is exactly why the `mcp-proxy-for-aws` shim
  exists: it converts the stdio MCP stream into SigV4-signed HTTPS. You cannot wire the
  `aws-mcp.api.aws` URL straight into the HTTP `/hermes-mcp-add` flow with a bearer header — it will
  401. Use the stdio proxy.
- **Temporary credentials expire.** Session tokens (from SSO/STS/assumed roles) are short-lived
  (often 1 hour, up to 12). When they expire you get `ExpiredTokenException` and every tool call
  fails. Refresh the creds, rewrite `/opt/data/.env` (step 3), and reload the gateway. Long-term
  `AKIA` keys do not expire but are a standing security risk — AWS recommends against them.
- **`InvalidSignatureException`.** Usually clock skew on the host (SigV4 is time-sensitive) or
  credentials scoped to the wrong region/service. Sync the host clock (`timedatectl`/NTP) and
  confirm `AWS_REGION` is set.
- **`uvx` missing in the container.** The proxy is a subprocess Hermes spawns; if `uv` is not on the
  hermes user's PATH the server fails to start with no obvious MCP error. Verify step 2; use the
  absolute `/home/hermes/.local/bin/uvx` path in the command if PATH is not inherited.
- **Blast radius.** `call_aws` can hit all 15000+ AWS APIs with the supplied IAM permissions —
  including destructive ones. Scope the IAM principal tightly. The proxy supports
  `READ_OPERATIONS_ONLY=true` (read-only) and `REQUIRE_MUTATION_CONSENT=true` (approve writes);
  set them in `/opt/data/.env` for a safe default. Prefer a read-only IAM policy regardless.
- **Region: connect vs operate.** The endpoint region picks which managed server you reach; the
  `--metadata AWS_REGION` picks where operations run. They can differ. Without `AWS_REGION`,
  operations silently default to `us-east-1`.
- **Conflicting older servers.** If the user previously wired `aws-api-mcp-server` or
  `aws-knowledge-mcp-server`, remove them — AWS recommends the managed server replace both, and
  duplicate tools confuse the agent.

## Verify

After the gateway restarts, confirm the server registered and a real call returns data.

```bash
docker exec -u hermes "$AGENT" hermes logs 2>&1 \
  | grep -iE "registered.*tool|MCP server|aws" | tail -8
```
Expect a line registering the `aws` MCP server and its tools (e.g. `call_aws`,
`search_documentation`, `read_documentation`).

End-to-end proof from the chat interface:
```
@<agent> using aws, run sts get-caller-identity
```
A JSON identity (account ID + ARN) proves credentials, proxy, SigV4, and tool registration all
work. `What AWS regions are available?` is a lighter docs-only check that does not need write perms.

If logs show the proxy starting but calls fail, re-run `aws sts get-caller-identity` with the same
env vars from step 1 — if that fails too, the credentials (not the wiring) are the problem.

## Definition of done

- [ ] `uvx` is available to the hermes user inside the container (step 2 passes).
- [ ] AWS credentials live only in `/opt/data/.env` (chmod 600); `config.yaml` holds the stdio
      command/args only — no keys, no secrets, nothing in chat.
- [ ] The `aws` stdio MCP (mcp-proxy-for-aws, pinned version) is registered and `hermes logs` shows
      its tools registered.
- [ ] A real call (`sts get-caller-identity` via chat) returns the account identity.
- [ ] IAM principal is least-privilege (read-only default, or `READ_OPERATIONS_ONLY=true`); creds
      rotated if any value was exposed in chat or shell history.

See `reference/TROUBLESHOOTING.md` for gateway reload, env-not-picked-up, and stdio-proxy startup failure modes.
