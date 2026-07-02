---
name: integration-obsidian
description: Connect an Obsidian vault to a self-hosted Hermes agent over SSH. Obsidian is a local desktop app — this skill picks between three honest paths: (A) vault-file mode via git/rclone/Syncthing on the VPS (preferred for headless agents), (B) the community Local REST API plugin over a private tunnel (Tailscale / Cloudflare Tunnel), (C) the mcp-obsidian stdio wrapper. Idempotent and rollback-safe. Works from Claude Code, Codex, Cursor, Hermes itself, and any AI agent.
---

# /integration-obsidian — connect an Obsidian vault to a remote Hermes (SSH-first)

You are the engineer connecting an Obsidian vault to a self-hosted Hermes agent on the
user's VPS. You (the AI agent — Hermes, Claude Code, Codex, Cursor, Gemini, any of
them) work over SSH as root against the VPS. Every command in this skill runs on the
VPS, not on the user's laptop.

Do everything autonomously; stop only for things a machine cannot do — installing the
Local REST API plugin in the desktop app, starting an OS-level tunnel (Tailscale /
Cloudflare Tunnel), or granting the git remote push access.

**Honest picture (verified 2026-06):** Obsidian ships **no first-party MCP** and no
first-party API. Two community pieces exist:

- **Local REST API plugin** (`coddingtonbear/obsidian-local-rest-api`) — HTTPS server
  running *inside the desktop app*, default `https://127.0.0.1:27124` (self-signed
  cert) or `http://127.0.0.1:27123`. Bearer-auth. **Only reachable when the desktop
  app is open** — kills the connection when the user closes their laptop.
- **`mcp-obsidian`** (MarkusPfundstein/mcp-obsidian) — stdio MCP wrapper around the
  Local REST API. Same reachability constraint.

Neither is viable for a *always-on* VPS agent unless the user pipes their laptop's
`localhost` to the VPS via a private tunnel. So Path A (vault-as-files on the VPS)
is the default for headless deployments — the agent reads and writes markdown, and
Obsidian on the laptop syncs via git / Obsidian Sync / Syncthing / iCloud. Pick per
the user's sync tool.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$OBSIDIAN_PATH` | Path selector: `A` (vault-file), `B` (Local REST via tunnel), or `C` (mcp-obsidian) | Ask the user |
| `$OBSIDIAN_VAULT_DIR` | (Path A) Absolute vault dir on the VPS (e.g. `/opt/data/vault`) | User's choice |
| `$OBSIDIAN_SYNC_MODE` | (Path A) `git` \| `syncthing` \| `rclone` \| `manual` | User's choice; `git` is easiest to automate |
| `$OBSIDIAN_GIT_REMOTE` | (Path A + git) `git@github.com:user/vault.git` (private repo) | User's provider |
| `$OBSIDIAN_API_URL` | (Path B/C) Tunneled URL, e.g. `https://vault.tail-xxxx.ts.net:27124` or `http://obsidian.laptop.internal:27123` | Tailscale MagicDNS / Cloudflare Tunnel dashboard |
| `$OBSIDIAN_API_KEY` | (Path B/C) API key from Local REST API plugin settings | Obsidian desktop -> Settings -> Community plugins -> Local REST API -> API Key |
| `$OBSIDIAN_TLS_MODE` | (Path B/C) `insecure` (self-signed cert, default plugin behavior) \| `strict` (user installed the plugin's CA cert on the VPS) | Advanced users only pick `strict` |
| `$WRITES_ACKNOWLEDGED` | Set to `1` to confirm the agent may CREATE and MODIFY notes (Path A auto-commits, Path B/C uses PATCH endpoints) | Consent gate — data destination is user notes |

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
ALREADY=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^OBSIDIAN_PATH=' ~/.hermes/.env 2>/dev/null" || echo 0)
if [ "$ALREADY" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  PREV=$(ssh "$VPS_USER@$VPS_IP" "grep '^OBSIDIAN_PATH=' ~/.hermes/.env | cut -d= -f2")
  echo "Obsidian is already wired via Path $PREV. Set FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate + live pre-flight per chosen path

Do NOT write anything until the checks for the chosen path pass.

```bash
[ "${WRITES_ACKNOWLEDGED:-0}" = "1" ] || {
  echo "ABORT: WRITES_ACKNOWLEDGED=1 required. The agent will create and modify notes in the vault."; exit 1;
}

case "$OBSIDIAN_PATH" in
  A|B|C) ;;
  *) echo "ABORT: OBSIDIAN_PATH must be A, B, or C."; exit 1 ;;
esac
```

### Path A — vault-as-files

```bash
if [ "$OBSIDIAN_PATH" = "A" ]; then
  [ -n "$OBSIDIAN_VAULT_DIR" ] || { echo "ABORT: OBSIDIAN_VAULT_DIR required."; exit 1; }
  case "$OBSIDIAN_SYNC_MODE" in
    git|syncthing|rclone|manual) ;;
    *) echo "ABORT: OBSIDIAN_SYNC_MODE must be git|syncthing|rclone|manual."; exit 1 ;;
  esac
  # If git mode, verify remote access without cloning yet
  if [ "$OBSIDIAN_SYNC_MODE" = "git" ]; then
    [ -n "$OBSIDIAN_GIT_REMOTE" ] || { echo "ABORT: OBSIDIAN_GIT_REMOTE required for git sync."; exit 1; }
    ssh "$VPS_USER@$VPS_IP" "GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' git ls-remote '$OBSIDIAN_GIT_REMOTE' HEAD" >/dev/null 2>&1 \
      || { echo "ABORT: cannot reach $OBSIDIAN_GIT_REMOTE from VPS. Add the VPS SSH key as a deploy key on the vault repo first."; exit 1; }
    echo "OK: git remote reachable from VPS."
  fi
fi
```

### Path B — Local REST API over tunnel

```bash
if [ "$OBSIDIAN_PATH" = "B" ]; then
  [ -n "$OBSIDIAN_API_URL" ] || { echo "ABORT: OBSIDIAN_API_URL required."; exit 1; }
  [ "${#OBSIDIAN_API_KEY}" -ge 20 ] || { echo "ABORT: OBSIDIAN_API_KEY too short."; exit 1; }
  case "$OBSIDIAN_TLS_MODE" in insecure|strict) ;; *) OBSIDIAN_TLS_MODE=insecure ;; esac
  CURL_TLS=$([ "$OBSIDIAN_TLS_MODE" = "insecure" ] && echo "-k" || echo "")
  # Live pre-flight: GET / on the plugin returns a small JSON status block
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "curl -sS $CURL_TLS -o /tmp/obs-preflight.json -w '%{http_code}' \
    -H 'Authorization: Bearer $OBSIDIAN_API_KEY' '$OBSIDIAN_API_URL/'" 2>/dev/null || echo 000)
  case "$HTTP" in
    200) echo "OK: Local REST API reachable at $OBSIDIAN_API_URL." ;;
    401|403) echo "ABORT: $HTTP — API key rejected. Copy from Obsidian -> Settings -> Local REST API."; exit 1 ;;
    000) echo "ABORT: no response. Confirm the tunnel is up AND Obsidian desktop is running with the plugin enabled."; exit 1 ;;
    *)   echo "ABORT: unexpected HTTP $HTTP from Obsidian API."; exit 1 ;;
  esac
  ssh "$VPS_USER@$VPS_IP" "rm -f /tmp/obs-preflight.json"
fi
```

### Path C — mcp-obsidian stdio wrapper

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  # Path C is Path B + an MCP wrapper — reuse Path B's checks
  [ -n "$OBSIDIAN_API_URL" ] || { echo "ABORT: OBSIDIAN_API_URL required (mcp-obsidian wraps the same REST API)."; exit 1; }
  [ "${#OBSIDIAN_API_KEY}" -ge 20 ] || { echo "ABORT: OBSIDIAN_API_KEY too short."; exit 1; }
  # Same pre-flight against the underlying REST API
  CURL_TLS=$([ "${OBSIDIAN_TLS_MODE:-insecure}" = "insecure" ] && echo "-k" || echo "")
  HTTP=$(ssh "$VPS_USER@$VPS_IP" "curl -sS $CURL_TLS -o /dev/null -w '%{http_code}' \
    -H 'Authorization: Bearer $OBSIDIAN_API_KEY' '$OBSIDIAN_API_URL/'" 2>/dev/null || echo 000)
  [ "$HTTP" = "200" ] || { echo "ABORT: underlying REST API not reachable ($HTTP). Fix Path B first."; exit 1; }
  echo "OK: underlying REST API reachable — mcp-obsidian can wrap it."
fi
```

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. Write OBSIDIAN_PATH ($OBSIDIAN_PATH) + path-specific config to ~/.hermes/.env
  2. chmod 600 ~/.hermes/.env
$( [ "$OBSIDIAN_PATH" = "A" ] && echo "  3. Prepare vault dir $OBSIDIAN_VAULT_DIR; set up $OBSIDIAN_SYNC_MODE sync" )
$( [ "$OBSIDIAN_PATH" = "A" ] && [ "$OBSIDIAN_SYNC_MODE" = "git" ] && echo "     Clone $OBSIDIAN_GIT_REMOTE into $OBSIDIAN_VAULT_DIR (if empty)" )
$( [ "$OBSIDIAN_PATH" = "A" ] && echo "     Document filesystem contract at /opt/data/obsidian-vault.md" )
$( [ "$OBSIDIAN_PATH" = "B" ] && echo "  3. Document REST surface at /opt/data/obsidian-rest.md" )
$( [ "$OBSIDIAN_PATH" = "C" ] && echo "  3. Register MCP: hermes mcp add obsidian --command uvx --args mcp-obsidian" )
$( [ "$OBSIDIAN_PATH" = "C" ] && echo "     Warm the uvx cache once to avoid first-call timeout" )
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify env loaded: env | grep -c '^OBSIDIAN_' inside the gateway
  6. Path-specific smoke test (write test-note.md, verify visible; or GET /vault/)

Secrets are NEVER printed in plaintext.
EOF
```

Wait for user confirmation (or skip if `AUTO_APPROVE=1`).

---

## Step 5 — write the secrets (chmod 600, no echo, no logging)

```bash
ssh "$VPS_USER@$VPS_IP" "hermes config set OBSIDIAN_PATH '$OBSIDIAN_PATH'"

case "$OBSIDIAN_PATH" in
  A)
    ssh "$VPS_USER@$VPS_IP" "
      hermes config set OBSIDIAN_VAULT_DIR '$OBSIDIAN_VAULT_DIR'
      hermes config set OBSIDIAN_SYNC_MODE '$OBSIDIAN_SYNC_MODE'
      $( [ -n "$OBSIDIAN_GIT_REMOTE" ] && echo "hermes config set OBSIDIAN_GIT_REMOTE '$OBSIDIAN_GIT_REMOTE'" )
    "
    ;;
  B|C)
    ssh "$VPS_USER@$VPS_IP" "
      hermes config set OBSIDIAN_API_URL '$OBSIDIAN_API_URL'
      hermes config set OBSIDIAN_API_KEY '$OBSIDIAN_API_KEY'
      hermes config set OBSIDIAN_TLS_MODE '${OBSIDIAN_TLS_MODE:-insecure}'
    "
    ;;
esac

ssh "$VPS_USER@$VPS_IP" "chmod 600 ~/.hermes/.env"
```

Verify (returns `1` per key, NEVER values):

```bash
case "$OBSIDIAN_PATH" in
  A) KEYS="OBSIDIAN_PATH OBSIDIAN_VAULT_DIR OBSIDIAN_SYNC_MODE" ;;
  B|C) KEYS="OBSIDIAN_PATH OBSIDIAN_API_URL OBSIDIAN_API_KEY OBSIDIAN_TLS_MODE" ;;
esac
for K in $KEYS; do
  N=$(ssh "$VPS_USER@$VPS_IP" "grep -c '^$K=' ~/.hermes/.env" || echo 0)
  [ "$N" = "1" ] || { echo "FAIL: $K not written. Rolling back."; rollback; exit 1; }
done
```

> If your Hermes build has no `config set` subcommand, use the safe sed pattern with
> the `|` delimiter — API URLs contain `/` and vault paths may contain spaces:
> ```bash
> ssh "$VPS_USER@$VPS_IP" "
>   for KV in 'OBSIDIAN_PATH=$OBSIDIAN_PATH' …; do
>     K=\${KV%%=*}
>     grep -q \"^\$K=\" ~/.hermes/.env || printf '%s\n' \"\$K=\" >> ~/.hermes/.env
>     sed -i \"s|^\$K=.*|\$KV|\" ~/.hermes/.env
>   done
>   chmod 600 ~/.hermes/.env
> "
> ```

---

## Step 6 — path-specific setup

### Path A — provision vault dir + sync

```bash
if [ "$OBSIDIAN_PATH" = "A" ]; then
  ssh "$VPS_USER@$VPS_IP" "mkdir -p '$OBSIDIAN_VAULT_DIR' && chmod 700 '$OBSIDIAN_VAULT_DIR'"
  if [ "$OBSIDIAN_SYNC_MODE" = "git" ]; then
    ssh "$VPS_USER@$VPS_IP" "
      cd '$OBSIDIAN_VAULT_DIR'
      if [ ! -d .git ]; then
        git clone '$OBSIDIAN_GIT_REMOTE' .
      else
        git fetch --all --prune && git pull --ff-only
      fi
      # nightly auto-pull + auto-commit + auto-push
      cat > /usr/local/bin/obsidian-vault-sync <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd '$OBSIDIAN_VAULT_DIR'
git fetch --all --prune
git pull --ff-only || true
if [ -n \"\$(git status --porcelain)\" ]; then
  git add -A
  git -c user.name='hermes-agent' -c user.email='agent@hermes.local' commit -m \"hermes sync \$(date -u +%FT%TZ)\"
  git push
fi
SH
      chmod +x /usr/local/bin/obsidian-vault-sync
      # cron @ 15-min cadence
      (crontab -l 2>/dev/null | grep -v obsidian-vault-sync; echo '*/15 * * * * /usr/local/bin/obsidian-vault-sync >> /var/log/obsidian-vault-sync.log 2>&1') | crontab -
    "
    echo "OK: git sync wired at 15-min cadence."
  fi
  ssh "$VPS_USER@$VPS_IP" "mkdir -p /opt/data && cat > /opt/data/obsidian-vault.md" <<DOC
# Obsidian vault filesystem contract

**Path A — vault-as-files.** The agent works with the vault as a plain directory.

- **Vault root:** \`$OBSIDIAN_VAULT_DIR\`
- **Sync mode:** \`$OBSIDIAN_SYNC_MODE\`
- **File layout:** standard Obsidian — one \`.md\` per note, folders map to Obsidian folders,
  \`.obsidian/\` holds config, attachments in \`attachments/\` (or wherever the user configured).
- **Frontmatter:** YAML block at file top for tags/aliases/dates. Preserve it on edits.
- **Wikilinks:** \`[[Note Title]]\` — resolve by scanning \`.md\` filenames case-insensitively.
- **Never touch:** \`.obsidian/workspace*.json\` (per-device UI state, causes sync conflicts).
$( [ "$OBSIDIAN_SYNC_MODE" = "git" ] && echo "- **Auto-sync:** /usr/local/bin/obsidian-vault-sync runs every 15 min via cron." )
DOC
fi
```

### Path B — document the REST surface

```bash
if [ "$OBSIDIAN_PATH" = "B" ]; then
  ssh "$VPS_USER@$VPS_IP" "mkdir -p /opt/data && cat > /opt/data/obsidian-rest.md" <<'DOC'
# Obsidian Local REST API surface (wired via Hermes generic HTTP tool)

**Base URL:** ${OBSIDIAN_API_URL} (tunneled to the user's laptop; requires desktop app running)
**Auth:** `Authorization: Bearer ${OBSIDIAN_API_KEY}`
**TLS:** ${OBSIDIAN_TLS_MODE} — with `insecure`, curl needs `-k` (self-signed cert).

## Read

- `GET /vault/` — list all files/folders in the vault (recursive).
- `GET /vault/{path}` — read a note. `Accept: application/vnd.olrapi.note+json` returns parsed frontmatter + content.
- `GET /active/` — the currently focused note in the desktop app.
- `GET /periodic/{daily|weekly|monthly}/` — periodic notes (if the Periodic Notes plugin is on).
- `POST /search/simple/` — body: `{"query":"..."}` — filename + content search.

## Write

- `POST /vault/{path}` — create a note (fails if exists).
- `PUT /vault/{path}` — create or overwrite.
- `PATCH /vault/{path}` — insert content at heading/block. Headers:
  `Operation: append|prepend|replace`, `Target-Type: heading|block|frontmatter`, `Target: <heading name>`.
- `DELETE /vault/{path}` — remove a note.

## Common failure modes to surface in agent replies

| Code | Meaning | Fix |
|------|---------|-----|
| 000  | No response | Desktop app is closed OR tunnel is down. |
| 401  | Bearer rejected | Rotate API key in plugin settings; env may be stale. |
| 404  | Path missing | List `/vault/` to find the actual filename (case-sensitive). |
| 405  | Method not allowed | Some endpoints are GET-only (e.g. `/active/`); use `PATCH` for edits. |
| 500  | Plugin exception | Check the desktop app's dev console; often malformed markdown. |
DOC
  ssh "$VPS_USER@$VPS_IP" "chmod 644 /opt/data/obsidian-rest.md"
fi
```

### Path C — register the mcp-obsidian stdio MCP

```bash
if [ "$OBSIDIAN_PATH" = "C" ]; then
  # Warm uvx cache
  ssh "$VPS_USER@$VPS_IP" "
    AGENT=\$(docker ps --filter name=hermes --format '{{.Names}}' | head -1)
    if [ -n \"\$AGENT\" ]; then
      docker exec \"\$AGENT\" sh -c 'uvx mcp-obsidian --help' >/dev/null 2>&1 || true
    else
      uvx mcp-obsidian --help >/dev/null 2>&1 || true
    fi
  "
  ssh "$VPS_USER@$VPS_IP" "
    hermes mcp add obsidian \
      --command uvx \
      --args 'mcp-obsidian' \
      --env 'OBSIDIAN_API_KEY=\${OBSIDIAN_API_KEY}' \
      --env 'OBSIDIAN_HOST=\${OBSIDIAN_API_URL}'
  "
fi
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
    docker exec "$AGENT" env | grep -c "^OBSIDIAN_"
  else
    hermes gateway env 2>/dev/null | grep -c "^OBSIDIAN_"
  fi
')
[ "$LOADED" -ge 2 ] || { echo "FAIL: expected >=2 OBSIDIAN_* vars in gateway env, saw $LOADED. Rolling back."; rollback; exit 1; }
```

---

## Step 9 — live smoke test (path-specific)

```bash
case "$OBSIDIAN_PATH" in
  A)
    STAMP=$(ssh "$VPS_USER@$VPS_IP" 'date -u +%FT%TZ')
    ssh "$VPS_USER@$VPS_IP" "printf 'hermes wire test %s\n' '$STAMP' > '$OBSIDIAN_VAULT_DIR/.hermes-wire-test.md'"
    OK=$(ssh "$VPS_USER@$VPS_IP" "[ -f '$OBSIDIAN_VAULT_DIR/.hermes-wire-test.md' ] && echo ok || echo fail")
    [ "$OK" = "ok" ] || { echo "FAIL: could not write test note. Rolling back."; rollback; exit 1; }
    ssh "$VPS_USER@$VPS_IP" "rm '$OBSIDIAN_VAULT_DIR/.hermes-wire-test.md'"
    echo "OK: Path A vault write succeeded."
    ;;
  B|C)
    HTTP=$(ssh "$VPS_USER@$VPS_IP" '
      set -a; . ~/.hermes/.env; set +a
      TLS_FLAG=$([ "$OBSIDIAN_TLS_MODE" = "insecure" ] && echo "-k" || echo "")
      curl -sS $TLS_FLAG -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $OBSIDIAN_API_KEY" "$OBSIDIAN_API_URL/vault/"
    ')
    case "$HTTP" in
      200) echo "OK: Hermes-side GET /vault/ returned 200." ;;
      401) echo "FAIL: 401 from inside Hermes — env not loaded or key rotated."; rollback; exit 1 ;;
      000) echo "FAIL: tunnel down or desktop app closed."; rollback; exit 1 ;;
      *)   echo "WARN: unexpected HTTP $HTTP. Investigate manually." ;;
    esac
    ;;
esac
```

---

## Rollback (auto-runs on any failure above)

```bash
rollback() {
  ssh "$VPS_USER@$VPS_IP" "
    for K in OBSIDIAN_PATH OBSIDIAN_VAULT_DIR OBSIDIAN_SYNC_MODE OBSIDIAN_GIT_REMOTE OBSIDIAN_API_URL OBSIDIAN_API_KEY OBSIDIAN_TLS_MODE; do
      hermes config unset \$K 2>/dev/null || sed -i \"/^\$K=/d\" ~/.hermes/.env
    done
    hermes mcp remove obsidian 2>/dev/null || true
    rm -f /opt/data/obsidian-rest.md /opt/data/obsidian-vault.md
    (crontab -l 2>/dev/null | grep -v obsidian-vault-sync) | crontab - 2>/dev/null || true
    rm -f /usr/local/bin/obsidian-vault-sync
    hermes gateway stop; sleep 2; hermes gateway run --daemon
  "
  echo "Rolled back. Obsidian is no longer wired. (Vault dir left in place — remove manually if desired.)"
}
```

The rollback **does not delete `$OBSIDIAN_VAULT_DIR`** — the vault is user data, potentially syncing to their laptop. Removal is manual.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Assuming Obsidian has a hosted API | It doesn't. It's a desktop app; all "APIs" are community plugins running on the user's laptop. | Default to Path A for headless VPS agents. |
| 2 | Path B without a tunnel | `localhost:27124` on a laptop is unreachable from the VPS. | Require Tailscale / Cloudflare Tunnel / SSH reverse-tunnel URL. |
| 3 | Path B while desktop app is closed | Plugin dies with the app; agent gets connection refused. | Detect `000` in smoke test; tell the user to keep the app open (or switch to Path A). |
| 4 | Self-signed cert breaks curl | Default plugin cert isn't trusted → HTTPS fails without `-k`. | Store `OBSIDIAN_TLS_MODE=insecure` and always pass `-k` unless the user installed the plugin's CA. |
| 5 | Writing to `.obsidian/workspace*.json` | Per-device UI state; corrupts sync. | Never PATCH under `.obsidian/`; document as excluded. |
| 6 | Git sync + Obsidian Sync at the same time | Two writers race, produce merge conflicts. | Pick one sync mode; Path A's cron pull-then-push assumes exclusive write. |
| 7 | Git remote unreachable from VPS | HTTPS-only clone using a token stored somewhere fragile; or SSH key not registered as deploy key. | Pre-flight `git ls-remote` in Step 3; require deploy-key setup. |
| 8 | Attachments path assumptions | Users configure attachments in a custom folder; hardcoding `attachments/` breaks image inserts. | Read the vault's `.obsidian/app.json` `attachmentFolderPath`. |
| 9 | Wikilinks case-sensitivity | Obsidian resolves case-insensitively; naive filesystem lookups don't. | Case-fold when resolving `[[Foo]]` → `Foo.md` vs `foo.md`. |
| 10 | Frontmatter mangling | PATCH-append inside frontmatter block yields invalid YAML. | Use `Target-Type: frontmatter` on Path B, or parse-then-write on Path A. |
| 11 | `gateway restart` for env changes | Restart doesn't reliably re-read `.env`. | Always `stop` + `run`. |
| 12 | Storing API key in `config.yaml` | World-readable; can't rotate without restart. | Only `~/.hermes/.env`, `chmod 600`. |
| 13 | sed with `/` delimiter | API URLs contain `/`, vault paths may contain `/`. | Always `\|` delimiter. |
| 14 | Container vs host confusion (Path A) | Vault dir mounted on host, invisible to Hermes in container. | Bind-mount `$OBSIDIAN_VAULT_DIR` into the container; verify via Step 8 env check. |
| 15 | `uvx` cold start (Path C) | First MCP call after boot hangs while uv fetches mcp-obsidian. | Warm the cache once in Step 6. |
| 16 | Committing `.env` to the vault repo (Path A) | If `.hermes/.env` lives inside the vault dir by accident, the vault repo leaks secrets. | Keep `.hermes` outside `$OBSIDIAN_VAULT_DIR`; add `.env` to vault's `.gitignore` defensively. |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (0.15.x / 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] `WRITES_ACKNOWLEDGED=1` consent gate passed
- [ ] Path picked (A / B / C) and validated per its checklist
- [ ] Path A: `git ls-remote` succeeded from VPS OR non-git sync tool documented
- [ ] Path B/C: live GET on `$OBSIDIAN_API_URL/` returned 200 with the bearer token
- [ ] Dry-run shown; user approved (or `AUTO_APPROVE=1`)
- [ ] Path-specific env vars in `~/.hermes/.env`, `chmod 600`, **not** in `config.yaml` or chat
- [ ] Path A: vault dir provisioned; `obsidian-vault-sync` cron installed if git mode
- [ ] Path A: `/opt/data/obsidian-vault.md` filesystem contract written
- [ ] Path B: `/opt/data/obsidian-rest.md` REST surface written
- [ ] Path C: `hermes mcp add obsidian` registered; `uvx` cache warmed
- [ ] Gateway reloaded with `stop` + `run` (NOT `restart`)
- [ ] Env verified: ≥2 `OBSIDIAN_*` vars visible inside gateway
- [ ] Smoke test passed: vault write (A) or `GET /vault/` = 200 (B/C)
- [ ] Rollback function defined and proven (re-run with `FORCE=1` rewires cleanly)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
