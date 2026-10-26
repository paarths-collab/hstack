---
name: hermes-status
description: "Read-only dashboard for a self-hosted Hermes v0.22.5 over SSH: version, hermes status, gateway status, memory provider, cron jobs, sessions, pairing and recent logs, shown as the native commands print them. Use when the user asks if their agent is ok. It starts, stops and writes nothing. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI)."
---

# /hermes-status — read-only dashboard for a remote Hermes (SSH-first)

You are the engineer looking at a self-hosted Hermes agent on the user's VPS. The agent (Hermes, Claude Code, Codex,
Cursor, Gemini CLI — whichever ran you) works over SSH as root against the VPS.

**This skill is read-only.** It runs the native report commands and shows what they print. It does not start, stop or
restart the gateway, does not write any file or marker, does not read `~/.hermes/.env`, and never turns a command's text into a
pass/fail verdict. In particular:

- `gateway status` prints `✗ Gateway is not running` when the gateway is stopped, and that line contains the word `running`. Its text,
  and the `Gateway:` row of `hermes status`, are **informational**: they come from a process and service scan, not from a readiness probe.
  Quote them; do not summarize them as "healthy".
- A real readiness check is `gateway ensure --json`, but `ensure` **starts a gateway when none is running**. A read-only skill must not
  do that, so the `gw_ready` and `gw_reload` helpers are defined in Step 0 only to keep the shared helper block identical across skills.
  This skill never calls them. If the user wants a verdict stronger than "a process exists", say so and offer `/hermes-restart`
  (restarts) or `/hermes-fix` (diagnoses, then repairs with consent).
- Model calls and `doctor` are opt-in (Step 6) because they are not free of side effects: see there.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine (possibly macOS, bash 3.2) and reaches the VPS
through the `remote` helper from Step 0, which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Run all
blocks in ONE shell session.

**Honest picture.** Checked against the Hermes v0.22.5 source (see "Verified against Hermes v0.22.5"). Not run against a real host: the
offline tests drive these blocks against a stub whose command syntax is the real v0.22.5 argparse and whose output is invented.

---

## Before you start — gather (ask once, in one batch)

| Variable | What | Where to get it |
|----------|------|-----------------|
| `$VPS_IP` | IP/hostname of the VPS running Hermes | User's hosting dashboard |
| `$VPS_USER` | SSH user (typically `root`) | User's hosting dashboard |
| `$DEEP` (optional) | `1` = also run `hermes status --deep` (Step 6) | Leave unset unless asked |
| `$RUN_DOCTOR` (optional) | `1` = also run `hermes doctor` (Step 6) | Leave unset unless asked |
| `$SMOKE_MODEL` (optional) | `1` = also make one model call with `hermes -z` (Step 6) | Leave unset unless asked |

No secrets are needed. Confirm SSH access before doing anything:

```bash
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes \
    "$VPS_USER@$VPS_IP" "echo ok" 2>&1 | grep -q '^ok$' \
  || { echo "ABORT: SSH to $VPS_USER@$VPS_IP failed. Run /setup-ssh-keys first. Nothing was changed."; exit 1; }
```

---

## Step 0 — helpers (define first, so nothing can fail before they exist)

```bash
# Run every block of this skill in ONE shell session: later steps call these functions.
# If your harness starts a fresh shell per command, re-run this block first.
SKILL_NAME=hermes-status
# Non-login ssh shells miss ~/.local/bin, where the Hermes installer puts `hermes`.
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
# gw_ready [SECONDS]: native readiness. Succeeds only when `gateway ensure --json` exits 0 and reports "state":"ready"
# (the transient pending/draining codes 5 and 6 are retried twice). It never greps `gateway status` text, because the stopped
# gateway prints "✗ Gateway is not running", which contains "running".
gw_ready() {
  remote "T=${1:-60} bash -s" <<'REMOTE'
n=0
while :; do
  out=$(hermes -p default gateway ensure --json --timeout "$T") && rc=0 || rc=$?
  [ "$rc" = 0 ] && break
  n=$((n + 1))
  { [ "$rc" = 5 ] || [ "$rc" = 6 ]; } && [ "$n" -lt 3 ] || { printf '%s\n' "$out" >&2; exit 1; }
  sleep 3
done
case $out in *'"state":"ready"'*) printf '%s\n' "$out" ;; *) printf '%s\n' "$out" >&2; exit 1 ;; esac
REMOTE
}
# gw_reload: restart the default-profile gateway natively and require a ready gateway with a NEW instance_id.
# `--detach` keeps `restart` from running the gateway inside the ssh shell when no service is installed. With live
# sessions and no terminal, restart refuses; GW_INTERRUPT=1 adds -y and interrupts them deliberately (never set by default).
# Side effect: the pre-restart `ensure` read that captures the old instance_id STARTS a gateway when none is running (ensure never
# installs a service, but it does start one). A reload implies the gateway should run, so that is accepted; read-only skills never call gw_reload.
gw_reload() {
  local old new out interrupt
  interrupt=""
  if [ "${GW_INTERRUPT:-0}" = 1 ]; then interrupt=1; fi
  # Keep an endpoint identity even when ensure exits 6 (draining/restart_wait).
  out=$(remote 'hermes -p default gateway ensure --json --timeout 10 2>/dev/null') || :
  old=$(printf '%s\n' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  remote "hermes -p default gateway restart --detach${interrupt:+ -y}" \
    || { echo "gw_reload: gateway restart failed or was refused (live sessions? re-run with GW_INTERRUPT=1 only if interrupting them is acceptable)." >&2; return 1; }
  out=$(gw_ready) || return 1
  new=$(printf '%s' "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p')
  if [ -n "$old" ] && [ "$new" = "$old" ]; then echo "gw_reload: the gateway instance did not change, so it was not restarted." >&2; return 1; fi
  printf '%s\n' "$out"
}
```

Only `remote` is used here. `gw_ready` and `gw_reload` are kept byte-identical with the other skills and are **not called**: `ensure` starts a
gateway. This skill has no `snapshot`/`rollback`/`finish` because it writes nothing.

---

## Step 1 — verify Hermes v0.22.5 is reachable on the VPS

```bash
HERMES_BANNER=$(remote '
  set -e
  command -v hermes >/dev/null 2>&1 \
    || { echo "FAIL: hermes not found on the VPS host PATH; container-only installations are outside this procedure"; exit 1; }
  hermes -p default --version
') || { echo "ABORT: Hermes is not installed on the VPS host account (container-only installs are unsupported). Run /hermes-install first. Nothing was changed."; exit 1; }
printf '%s\n' "$HERMES_BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' || {
  echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $HERMES_BANNER). Nothing was changed."; exit 1;
}
echo "--- version ---"
echo "$HERMES_BANNER"
```

Expected: a banner naming Hermes `0.22.5` (`HERMES_VERSION` in `VERSIONS.txt`). If it names another version, stop: the output formats below
are only checked for 0.22.5.

---

## Step 2 — what will run (preview; nothing is changed)

A health check needs no idempotency marker: every command below is a read, so running it twice is harmless. Do not write a "last checked"
file; the old copy of this skill did, and a read-only skill must not.

```bash
cat <<EOF
READ-ONLY checks on $VPS_USER@$VPS_IP (Hermes 0.22.5):
  1. hermes status --full             (every section, keys redacted)
  2. hermes gateway status            (informational text)
  3. hermes gateway list              (which profiles have a gateway process)
  4. hermes memory status             (memory provider configuration)
  5. hermes cron list                 (scheduled jobs)
  6. hermes sessions stats / list     (session store, read-only)
  7. hermes pairing list              (pending and approved users)
  8. hermes logs gateway -n 30, logs errors -n 20, and the hermes process list (pid, uptime, rss)
  Opt-in only: DEEP=${DEEP:-0} (status --deep), RUN_DOCTOR=${RUN_DOCTOR:-0} (doctor), SMOKE_MODEL=${SMOKE_MODEL:-0} (one model call)

Nothing is started, stopped, written or deleted. No credential file is read.
EOF
```

---

## Step 3 — overall and gateway

```bash
echo "--- hermes status --full (every section, keys redacted) ---"
remote 'hermes -p default status --full' || echo "(hermes status exited $?)"
echo "--- gateway status (informational text, not a readiness probe) ---"
remote 'hermes -p default gateway status' || echo "(gateway status exited $?)"
echo "--- gateway list (profiles and whether each has a gateway process) ---"
remote 'hermes -p default gateway list' || echo "(gateway list exited $?)"
```

How to read it (quote the lines, do not rewrite them as a verdict):

- `Gateway:` / `Status:` rows of `hermes status` and `✓ Gateway is running` / `✗ Gateway is not running` of `gateway status` say whether a
  gateway process or service was found (`hermes_cli/status.py:213-243,373-380`, `hermes_cli/gateway.py:5579-5650`).
- `gateway status` also appends a **"Recent gateway health:"** block, running or stopped, read from the gateway's own state file:
  a fatal platform error, a stale `gateway_state.json` whose process is gone, a stale heartbeat (event loop wedged, "restart the gateway"),
  a startup failure, or "draining" (`hermes_cli/gateway.py:4698-4750`). Those lines are the native wedge detection; report them.
- Stopped gateway: say it is stopped and offer `/hermes-restart`; do not start it from here.

---

## Step 4 — memory, jobs, sessions, pairing

```bash
echo "--- memory provider configuration ---"
remote 'hermes -p default memory status' || echo "(memory status exited $?)"
echo "--- scheduled jobs ---"
remote 'hermes -p default cron list' || echo "(cron list exited $?)"
echo "--- session store ---"
remote 'hermes -p default sessions stats' || echo "(sessions stats exited $?)"
remote 'hermes -p default sessions list --limit 5' || echo "(sessions list exited $?)"
echo "--- pairing (pending requests and approved users) ---"
remote 'hermes -p default pairing list' || echo "(pairing list exited $?)"
```

- `memory status` prints the built-in memory toggles, the configured provider name, that provider's config keys and whether its plugin is
  available (`hermes_cli/memory_setup.py:365-425`). It does **not** print a backend type, a usage figure or a limit, so do not report any. It prints
  the provider's configuration block: never paste a value that looks like a credential into the chat.
- `cron list` shows each job's id, state, schedule and last run (the prompt is not printed), and warns when the scheduler is not ready
  (`hermes_cli/cron.py:177-208`). A job that only fires while a gateway runs is not scheduled while the gateway is stopped.
- `sessions stats` and `sessions list` open `state.db` read-only (`hermes_cli/sessions_cmd.py:1261,1300-1312`); other `sessions` actions
  (prune, delete, optimize, repair) write and are not used here.
- `pairing list` shows user ids and names of people who asked for access (`hermes_cli/pairing.py:22-53`); approving is a different skill's
  decision (`hermes pairing approve` grants access to the bot).

---

## Step 5 — recent logs and process footprint

```bash
echo "--- gateway log (last 30 lines) ---"
remote 'hermes -p default logs gateway -n 30' || echo "(logs gateway exited $?)"
echo "--- errors log (last 20 lines) ---"
remote 'hermes -p default logs errors -n 20' || echo "(logs errors exited $?)"
echo "--- hermes processes (pid, elapsed, rss in KB) ---"
remote "ps -eo pid,etime,rss,comm | grep '[h]ermes'" || echo "(no process named hermes found)"
```

Scan for `ERROR`, repeated reconnect cycles on a platform, and registration failures. Do not paste raw log lines containing `_TOKEN=` or
`Bearer` back to the chat (the logs are redacted before they are written, but check). Process columns are only a display: there is no verified
RSS threshold that proves a leak, so report the numbers, compare them over time, and let the user decide whether a `/hermes-restart` is worth it.

---

## Step 6 — optional deeper checks (each needs the user's yes; none of them is free)

```bash
if [ "${DEEP:-0}" = "1" ]; then
  echo "--- hermes status --deep (implies --full; outbound GET to OpenRouter when OPENROUTER_API_KEY is set, plus a local port row) ---"
  remote 'hermes -p default status --deep' || echo "(status --deep exited $?)"
fi
if [ "${RUN_DOCTOR:-0}" = "1" ]; then
  echo "--- hermes doctor (diagnostic only, no --fix; opens outbound connections to configured providers) ---"
  DOCTOR_RC=0
  remote 'hermes -p default doctor' || DOCTOR_RC=$?
  echo "(hermes doctor exit code: $DOCTOR_RC. 0 means no issues were found; non-zero means issues remain or the command failed. Read the report.)"
fi
if [ "${SMOKE_MODEL:-0}" = "1" ]; then
  echo "--- one model call with hermes -z (uses model credit; tools and approvals as normal; proves provider/model, NOT the gateway) ---"
  remote "hermes -p default -z 'Reply with the single word PONG.'" || echo "(hermes -z exited $?)"
fi
```

- `status --deep` is `--full` plus a `Deep Checks` section: a GET to the OpenRouter model list with the key, if one is set, and an
  informational `Port 18789` row (`hermes_cli/status.py:322-342`). Treat the port row as a curiosity, not a verdict.
- `doctor` without `--fix` does not edit configuration, but it is not passive: it sends a request to each configured provider's model-list
  endpoint (`hermes_cli/doctor_connectivity.py:123-165`) and runs a write probe on `state.db` that is rolled back
  (`hermes_cli/doctor_state.py:293-318`). Its exit status is 1 when it lists issues (`hermes_cli/doctor.py:172-194`). Repairs belong to `/hermes-fix`.
- `hermes -z` runs a one-shot agent locally with approvals auto-bypassed (`hermes_cli/_parser.py:148-153`); it does not go through the
  gateway, so a good reply says nothing about Telegram delivery. Show the reply as printed. A reply that merely *contains* the letters
  `OK` is not a pass (the old copy of this skill matched `OK` inside any word).

---

## Reporting in plain language

After the steps, report in this order, quoting native lines instead of paraphrasing them:

1. **Version** — the banner.
2. **Gateway** — what `hermes status` and `gateway status` printed, verbatim, plus any "Recent gateway health" warnings. Call it "reported
   running/stopped by the process scan", never "healthy". If stopped, offer `/hermes-restart`.
3. **Platforms** — the platform rows of `status --full` (configured / not configured). "Configured" is not "connected to Telegram": for that, send a test message.
4. **Memory, jobs, sessions, pairing** — the numbers and names printed.
5. **Errors in the logs** — any non-benign lines, with the platform they belong to.
6. **Opt-in results** — only if run, with their exit codes.
7. **What was not checked** — message delivery, vendor APIs, disk space.

---

## Rollback

Nothing to roll back: this skill changes nothing on the VPS and keeps no state on the agent machine. If a command printed something worrying,
the next step is `/hermes-fix` (diagnose, then repair with consent) or `/hermes-restart`, not this skill.

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Reading `Gateway is not running` as healthy (or grepping `running`) | the stopped message contains `running` | quote the text; make no verdict from it |
| 2 | Calling `gateway ensure` (or `gw_ready`) to "check" | `ensure` starts a gateway when none runs: the check changes the system | this skill never calls it; offer `/hermes-restart` |
| 3 | Treating `hermes status` rows as readiness | they come from a process/service scan | label them informational |
| 4 | Reporting a memory backend, usage or limit | `memory status` prints none of them | report only the toggles, provider name and availability |
| 5 | `hermes -z` as an end-to-end test of the gateway | `-z` runs the agent locally and skips the gateway; any reply containing `OK` is not proof | opt-in only; show the reply; test delivery from the platform |
| 6 | Running `doctor --fix` "while we are here" | `--fix` edits `.env`/`config.yaml` and can repair `state.db` | `/hermes-fix`, with consent |
| 7 | Leaving a marker file or writing to `/tmp` | a read-only skill must leave no trace | none is written; the tests compare the file tree |
| 8 | Pasting `memory status` or log lines containing credentials | provider config blocks and logs can show key-shaped values | redact before quoting |
| 9 | Using `ps -ef`/`ps ... cmd` | the command line of a process can contain a secret passed as an argument | the block prints `comm` only |
| 10 | Container vs host confusion | `hermes` inside a container is invisible to the host | Step 1 detects both; check `whoami; hostname` |
| 11 | Fresh shell per command | Step 0's `remote` is undefined later | re-run the Step 0 block first |
| 12 | Assuming old flags | `hermes status --all` was the older spelling; at 0.22.5 `--full` is primary and `--all` an alias | use `--full` |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (`0.22.5`)
- [ ] Preview shown (Step 2); no marker or state file written
- [ ] `status --full`, `gateway status` and `gateway list` output shown verbatim
- [ ] Memory, cron, sessions and pairing output shown; no memory backend, usage or limit claimed
- [ ] Last gateway and error log lines scanned; no credential pasted into chat
- [ ] Opt-in checks (`DEEP`, `RUN_DOCTOR`, `SMOKE_MODEL`) ran only when requested, with exit codes reported
- [ ] No gateway was started, stopped or restarted; `gateway ensure` was not called
- [ ] The report calls the gateway state "reported", never "healthy", and says what was not checked

---

## Verified against Hermes v0.22.5

Read in the tagged source (`NousResearch/hermes-agent` at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`), paths relative to the repo root:

- `hermes_cli/subcommands/status.py:13-17`: `status [--full|--all] [--deep]` (`--all` is an alias of `--full`; `--deep` implies it).
  `hermes_cli/status.py:213-243,322-342,373-407`: the gateway section and row, the deep section, the one-screen summary.
- `hermes_cli/gateway.py:5579-5650` (`gateway status`; stopped text at `:5636`), `:4698-4750` (the "Recent gateway health" lines),
  `:1688-1721` (`gateway list`), `:1555-1592` (the process/service scan behind both).
- `hermes_cli/memory_setup.py:365-425` (`memory status` output), `hermes_cli/cron.py:177-208` (`cron list`),
  `hermes_cli/sessions_cmd.py:1228-1235,1261,1300-1312` (`sessions stats`, read-only open), `hermes_cli/pairing.py:22-53` (`pairing list`),
  `hermes_cli/subcommands/logs.py:9-48` (`logs gateway|errors -n N`).
- `hermes_cli/doctor.py:172-194`, `hermes_cli/doctor_connectivity.py:123-165`, `hermes_cli/doctor_state.py:293-318` (doctor's exit status,
  outbound probes, rolled-back write probe); `hermes_cli/_parser.py:148-153` (`-z`).
- `hermes_cli/gateway_runtime.py:390-495` (why `ensure` is not a read: it spawns or starts a gateway when none is running).

Not verified: nothing was run against a real Hermes host, so the exact printed layouts are read from source, not observed. No non-mutating,
machine-readable gateway readiness probe exists as a CLI command at v0.22.5 (`discover_gateway_endpoint` is a Python API,
`gateway_state.json` can outlive a dead process), which is why this skill reports text and makes no pass/fail verdict.

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway, memory and platform failure modes.
