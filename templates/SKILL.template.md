---
name: <skill-name>
description: <one-sentence what it does + when to use it>
---

# /<skill-name> — <short title>

You are the engineer doing <X> for the user. The agent (Hermes, Codex, Claude Code,
Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0,
which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Secrets are generated or pasted locally, validated locally, and travel
to the VPS only over ssh STDIN. Run all blocks in ONE shell session — later steps call the
Step 0 functions.

Do everything autonomously; stop only for things a machine cannot do (mint a token,
scan a QR code, send the first message).

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$<SECRET>` | The integration's API token | `<mint-url-here>` |

Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=<skill-name>
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
# A leftover snapshot means an earlier run wrote something and never finished or rolled
# back. Snapshotting now would capture that half-written state as "known good".
if [ -d "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$d" && chmod 700 "$HOME/.hermes/.hstack-backup" "$d"
for f in .env config.yaml; do
  rm -f "$d/$f" "$d/$f.absent"
  if [ -f "$HOME/.hermes/$f" ]; then cp -p "$HOME/.hermes/$f" "$d/$f"; else : > "$d/$f.absent"; fi
done
chmod 600 "$d"/* 2>/dev/null || true
REMOTE
}

# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), then reload the gateway.
rollback() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 0; }
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then cp -p "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then rm -f "$HOME/.hermes/$f"; fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
rm -rf "$d.prev"; mv "$d" "$d.prev"
hermes gateway stop || true; sleep 2; hermes gateway run --daemon || true
sleep 3
st=$(hermes gateway status 2>&1 || true)
if printf '%s' "$st" | grep -qiE 'not running|not active|inactive|stopped|dead|failed' \
   || ! printf '%s' "$st" | grep -qiE 'running|active|started|online'; then
  echo "rollback: files restored, but the gateway did NOT come back — start it manually (hermes gateway start) and check hermes logs"
  exit 1
fi
echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
REMOTE
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; rm -rf \"\$d.prev\"; [ -d \"\$d\" ] && mv \"\$d\" \"\$d.prev\"; true"
}
```

Rules for calling them (every skill follows these):

- A failure BEFORE `snapshot` (SSH check, Hermes check, idempotency, credential format,
  live preflight, user declining the dry run) is `exit 1` with
  `ABORT: ... Nothing was written.` — it does NOT call `rollback`.
- `snapshot` runs immediately before the first write. If it fails, abort. It REFUSES when a
  snapshot dir already exists (a crashed run): run `rollback` first, then re-run.
- Every failure AFTER `snapshot` is `rollback; exit 1`.
- The last step calls `finish` after the smoke test passes.
- `rollback` RESTORES the pre-skill state; it never just deletes keys. Never define a
  second `rollback()` later in the file and never use `bash <(declare -f rollback)` (that
  defines the function in a child shell and runs nothing).

**Unverified CLI surface.** Upstream's CLI docs list `hermes gateway run|start|stop|restart|status|install`. `hermes gateway run --daemon` and `hermes mcp add|remove|list` are NOT in those docs: they are this repo's declared adapter surface, unverified against upstream. If a call fails with "unknown option/command", check `hermes gateway --help` / `hermes mcp --help` on the VPS and adapt; the hard-gate and rollback logic does not depend on the exact flags.

---

## Step 1 — verify Hermes is reachable on the VPS

```bash
remote '
  set -e
  if command -v hermes >/dev/null 2>&1; then
    hermes --version
  elif docker ps --format "{{.Names}}" | grep -q hermes; then
    docker exec "$(docker ps --filter name=hermes --format "{{.Names}}" | head -1)" hermes --version
  else
    echo "FAIL: hermes not found on host or in container"; exit 1
  fi
' || { echo "ABORT: Hermes is not installed/running. Run /hermes-install first. Nothing was written."; exit 1; }
```

Expected: a version string like `0.15.x` or `0.17.x`.

---

## Step 2 — idempotency check (skip if already wired)

```bash
ALREADY=$(remote "hermes mcp list 2>/dev/null | grep -ci '<skill-name>' || true")
if [ "${ALREADY:-0}" -gt 0 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Already wired. Re-run with FORCE=1 to rewire."
  exit 0
fi
```

---

## Step 3 — HARD GATE: validate the credential BEFORE anything is written

Two checks, both before `snapshot` and before the dry run. If either fails, nothing has
touched the VPS and the skill stops.

**3a. Format check (local, no network).** Reject empty values and any character that could
break a curl config line or a `.env` line (whitespace, quotes, backslash, `$`, newline).
Add the vendor's documented prefix check here.

```bash
secret_chars_ok() {  # LC_ALL=C so non-ASCII letters are never treated as alphanumerics
  local LC_ALL=C
  case "$1" in ""|*[!A-Za-z0-9_.~+/=-]*) return 1 ;; esac
  return 0
}
secret_chars_ok "$<SECRET>" \
  || { echo "ABORT: <SECRET> is empty or has characters a token never contains (spaces, quotes, newline). Nothing was written."; exit 1; }
case "$<SECRET>" in <expected_prefix>*) ;; *)
  echo "ABORT: <SECRET> does not start with <expected_prefix>. Nothing was written."; exit 1 ;;
esac
```

**3b. Live vendor preflight, run from the VPS** (proves the server's egress works too).
The secret travels over ssh STDIN as a curl config, so it never appears in argv, a URL on
a command line, or a quoted remote string. Use an endpoint the skill already documents
that has no side effects (`/me`, `/user`, `/ping`, list-1-item).

```bash
CODE=$(printf 'header = "Authorization: Bearer %s"\n' "$<SECRET>" \
  | remote "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - '<REST_BASE>/me'")
[ "$CODE" = "200" ] || { echo "ABORT: <vendor> rejected the credential (HTTP ${CODE:-none}). Nothing was written."; exit 1; }
```

Other auth shapes — only the `printf` line changes:

- URL-embedded token (Telegram style): `printf 'url = "https://api.example.com/bot%s/getMe"\n' "$<SECRET>" | remote "curl -fsS --max-time 15 --config -"`
- Basic auth: `printf 'user = "%s:%s"\n' "$USER_ID" "$<SECRET>"`
- Custom header: `printf 'header = "X-Api-Key: %s"\n' "$<SECRET>"`
- Extra non-secret headers or a request body go on the `curl` command line, not in the config.

If the vendor documents no side-effect-free endpoint, keep 3a and say in one line here
that no live pre-write check exists. Do not fake one.

---

## Step 4 — DRY RUN preview (always show before writing)

```bash
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  0. (already passed) credential format + live <vendor> preflight, nothing written yet
  1. Snapshot ~/.hermes/.env and config.yaml to ~/.hermes/.hstack-backup/$SKILL_NAME
  2. Write <SECRET_NAME> (length: ${#<SECRET>}) to ~/.hermes/.env via 'hermes config set', chmod 600
  3. Register MCP: hermes mcp add <skill-name> --url <URL> --auth ...
  4. Reload gateway: hermes gateway stop && hermes gateway run
  5. Verify in logs: grep "registered.*<skill-name>"
  6. Smoke test with the value read back from ~/.hermes/.env on the VPS
  Any failure after step 1 restores the snapshot.

The secret will NEVER be printed in plaintext.
EOF
```

Show it to the user. Continue only on an explicit yes (or `AUTO_APPROVE=1`). If the user
declines: `echo "ABORT: user declined. Nothing was written."; exit 1`.

---

## Step 5 — snapshot, then write the secret (chmod 600, over stdin, no logging)

```bash
snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
printf '%s\n' "$<SECRET>" \
  | remote 'IFS= read -r v && hermes config set <SECRET_NAME> "$v" >/dev/null 2>&1 && chmod 600 ~/.hermes/.env' \
  || { echo "FAIL: could not write <SECRET_NAME>."; rollback; exit 1; }
```

Verify the write (prints a count, never the value):

```bash
WROTE=$(remote "grep -c '^<SECRET_NAME>=' ~/.hermes/.env || true")
[ "$WROTE" = "1" ] || { echo "FAIL: <SECRET_NAME> not written exactly once (found ${WROTE:-0})."; rollback; exit 1; }
```

> If your Hermes build has no `config set` subcommand, replace the write above with this
> (drops any old line, appends the new one with a guaranteed newline, chmod 600):
> ```bash
> printf '%s\n' "$<SECRET>" | remote 'IFS= read -r v; umask 077
>   { grep -v "^<SECRET_NAME>=" ~/.hermes/.env 2>/dev/null; printf "<SECRET_NAME>=%s\n" "$v"; } > ~/.hermes/.env.new \
>     && mv ~/.hermes/.env.new ~/.hermes/.env && chmod 600 ~/.hermes/.env' \
>   || { echo "FAIL: could not write <SECRET_NAME>."; rollback; exit 1; }
> ```

---

## Step 6 — register the MCP server (or REST endpoint if no MCP exists)

```bash
if [ "${FORCE:-0}" = "1" ]; then remote "hermes mcp remove <skill-name> >/dev/null 2>&1 || true"; fi
remote "hermes mcp add <skill-name> --url '<MCP_URL>' --auth-header 'Authorization' --auth-scheme 'Bearer' --placeholder-token 'placeholder'" \
  || { echo "FAIL: hermes mcp add."; rollback; exit 1; }
# Swap the placeholder for the ${VAR} indirection. \$ keeps the braces literal on the
# remote side — config.yaml must hold the text ${<SECRET_NAME>}, never the secret, and
# never an unset remote variable expanded to an empty string.
remote "sed -i 's|placeholder|\${<SECRET_NAME>}|g' ~/.hermes/config.yaml" \
  || { echo "FAIL: could not set the \${<SECRET_NAME>} indirection."; rollback; exit 1; }
```

Check that the plaintext secret did not land in `config.yaml` (and is still in `.env`):

```bash
remote 'v=$(sed -n "s/^<SECRET_NAME>=//p" ~/.hermes/.env | tail -n1); v=${v#\"}; v=${v%\"}
  [ -n "$v" ] && ! grep -qF -- "$v" ~/.hermes/config.yaml' \
  || { echo "FAIL: secret missing from .env or found in config.yaml."; rollback; exit 1; }
```

---

## Step 7 — reload the gateway (stop + run, NOT restart)

`gateway restart` does NOT re-read `.env` reliably. Use stop + run.

```bash
remote "hermes gateway stop || true"
sleep 2
remote "hermes gateway run --daemon" || { echo "FAIL: gateway did not start."; rollback; exit 1; }
sleep 5
```

---

## Step 8 — verify registration in logs (within 30s)

```bash
REGISTERED=0
for i in 1 2 3 4 5 6; do
  if remote "hermes logs 2>&1 | tail -200" \
       | grep -qiE "registered .* '<skill-name>'|MCP server.*<skill-name>.*ok"; then
    REGISTERED=1; echo "OK: <skill-name> registered."; break
  fi
  sleep 5
done
[ "$REGISTERED" = "1" ] || { echo "FAIL: <skill-name> not in logs after 30s."; rollback; exit 1; }
```

---

## Step 9 — live tool-call smoke test (value read back from `~/.hermes/.env`)

The ssh shell is non-interactive and has NOT loaded `~/.hermes/.env`, so `$<SECRET_NAME>`
would be empty there. Read the value from the file explicitly — this also proves it
persisted. Replace the URL with a real, side-effect-free call.

```bash
CODE=$(remote 'bash -s' <<'REMOTE'
v=$(sed -n 's/^<SECRET_NAME>=//p' ~/.hermes/.env | tail -n1)
v=${v#\"}; v=${v%\"}
printf 'header = "Authorization: Bearer %s"\n' "$v" \
  | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --config - '<REST_BASE>/me'
REMOTE
)
[ "$CODE" = "200" ] || { echo "FAIL: smoke test returned HTTP ${CODE:-none} (401 = bad token, 403 = scope missing)."; rollback; exit 1; }
echo "OK: <vendor> reachable with the token stored on the VPS."
finish
```

`finish` keeps the pre-skill state as `~/.hermes/.hstack-backup/<skill-name>.prev` for a
manual undo (see Rollback).

---

## Rollback

Defined once, in Step 0. It runs automatically (`rollback; exit 1`) on every failure after
`snapshot`. It does not delete keys; it RESTORES the exact pre-skill state:

- `~/.hermes/.env` and `~/.hermes/config.yaml` are copied back from
  `~/.hermes/.hstack-backup/<skill-name>/` (a file that did not exist before is removed,
  so a first-time run leaves nothing behind; a `FORCE=1` re-run gets its previous working
  value back);
- `.env` is set to `chmod 600`;
- the snapshot moves to `<skill-name>.prev` and the gateway is reloaded with stop + run, then
  `hermes gateway status` is checked. If the gateway is not reported running, `rollback` prints
  `files restored, but the gateway did NOT come back` and exits non-zero: start it by hand
  (`hermes gateway start`) and check `hermes logs`.

Failures before `snapshot` (format check, live preflight, declined dry run) wrote nothing,
so there is nothing to roll back.
If a run is interrupted after `snapshot` (crash, Ctrl-C), the snapshot dir is left in place and
the next `snapshot` refuses to run; call `rollback` first to restore the pre-crash state.

To undo a run that already finished (the snapshot was kept as `.prev`), with the Step 0
functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

If your Hermes build keeps MCP registrations outside `config.yaml`, also run
`hermes mcp remove <skill-name>` on the VPS. The `.prev` folder holds the previous `.env`
(including old secrets) at mode 600; delete it once you no longer need the undo.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | `gateway restart` to pick up env | Restart does NOT reliably re-read `.env` | Use `stop` + `run` |
| 2 | `echo >> .env` instead of `config set` | Can merge onto a prior line without trailing newline | Always `hermes config set` (or the documented `grep -v` + `printf` fallback) |
| 3 | Token in `config.yaml` instead of `.env` | World-readable; not loaded by runtime | Only `~/.hermes/.env`, `chmod 600`; `config.yaml` holds `${VAR}` only |
| 4 | Injecting the secret with `sed 's/.../'"$VAR"'/'` | Tokens contain `/+=`; and `'\"\$VAR\"'` expands an unset REMOTE variable to an empty string | Never inject the value. Use the remote-literal `\${VAR}` with the `\|` delimiter |
| 5 | Container vs host confusion | Skill assumed wrong layer | Always check `whoami; hostname` first |
| 6 | Skipping the verify step | "Silent success" — config written, never picked up | Always wait + grep logs |
| 7 | Writing before the live preflight passes | A typo'd or revoked token replaces a working one | Step 3 runs before `snapshot`; failures there write nothing |
| 8 | Smoke test uses `\$TOKEN` over ssh | The ssh shell never loaded `.env`: empty header, false `401`, rollback of a good token | Read the value from `~/.hermes/.env` on the VPS (Step 9) |
| 9 | Secret in ssh argv, a URL, or a single-quoted remote string | Leaks into `ps`; breaks on tokens containing `'` | Send it over STDIN (`printf ... \| remote ...`, curl `--config -`) |
| 10 | `rollback` that deletes instead of restoring, or defined after it is called | A failed `FORCE=1` re-run destroys the working value; or rollback never runs | Define `snapshot`/`rollback`/`finish` in Step 0; rollback restores the snapshot |
| 11 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `rollback: command not found` | Re-run the Step 0 block first |
| 12 | GNU-only flags in LOCAL commands | macOS ships bash 3.2 / BSD tools: `base64 -w0`, `sed -i` on local files, `readlink -f`, `date -d` fail | Keep GNU flags inside `remote` strings only (the VPS is Linux) |
| 13 | Re-running after a crashed or interrupted run | A leftover `~/.hermes/.hstack-backup/<skill>` means that run wrote something and never finished; snapshotting again would record its half-written files as "known good" | `snapshot` refuses and aborts. Run `rollback` first (restores the state from before that run), then re-run |
| 14 | Bare `hermes` over ssh: `hermes: command not found` | Non-login ssh shells do not have `~/.local/bin` on PATH, where the Hermes installer puts the binary | `remote()` (Step 0) exports `PATH="$HOME/.local/bin:$PATH"` for every call; never bypass it with a raw `ssh` for hermes commands |
| 15 | `hermes config set KEY value` puts the value in the `hermes` process argv on the VPS while it runs | Anyone who can read `/proc` or `ps` on the VPS during that moment sees it (the local ssh argv stays clean because the value travels over stdin) | Accepted for the primary path; the documented `grep -v` + `printf` fallback avoids it entirely. Output of the write is discarded so Hermes can never echo the value into chat |
| 16 | <integration-specific pitfall> | <why> | <fix> |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on VPS (0.15.x or 0.17.x)
- [ ] Idempotency check passed (or `FORCE=1` overrode)
- [ ] HARD GATE passed: credential format OK and the live vendor preflight returned `200` BEFORE any write
- [ ] Dry-run shown to user; user approved (or `AUTO_APPROVE=1`)
- [ ] Snapshot taken before the first write; no write happened before the live preflight passed
- [ ] Secret written to `~/.hermes/.env` over stdin, file is `chmod 600`
- [ ] `config.yaml` holds only `${<SECRET_NAME>}`; secret NOT in `config.yaml` and NOT echoed in chat
- [ ] MCP registered via `hermes mcp add`; gateway reloaded with stop+run
- [ ] Logs show `registered N tool(s) for '<skill-name>'` within 30s
- [ ] Live smoke test (value read back from `~/.hermes/.env`) returned `200`
- [ ] `finish` ran; rollback restores the pre-skill `.env`/`config.yaml` (a failed `FORCE=1` re-run keeps the old working value)

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway and MCP failure modes.
