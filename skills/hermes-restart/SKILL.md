---
name: hermes-restart
description: "Reload or restart the Hermes gateway on a remote VPS over SSH with the native v0.22.5 lifecycle: gateway restart --detach, then gateway ensure --json until it reports a ready gateway with a new instance. Use after a config or .env change, or when the gateway is stuck or down. Works from any AI agent (Hermes, Claude Code, Codex, Cursor, Gemini CLI)."
---

# /hermes-restart — reload the gateway the native way (SSH-first)

You are the engineer reloading the Hermes gateway for the user. The agent (Hermes, Codex,
Claude Code, Cursor, Gemini CLI — whichever ran you) is talking to a remote VPS over SSH as root.

This is the user-facing skill for "reload / restart the gateway", and it documents the
canonical lifecycle every other hstack skill uses (`gw_reload` and `gw_ready` in Step 0).
Hermes v0.22.5 does the hard parts itself: stale pid/lock files, other profiles, drain of
live turns and the service manager are all handled by `gateway restart` and `gateway ensure`.
This skill therefore **changes no files, deletes nothing and kills nothing**. It asks the
native commands, reads their answer, and reports it. If they refuse, it says why; it does
not work around the refusal.

**Where commands run.** Every `bash` block below runs on the agent's LOCAL machine
(possibly macOS, bash 3.2) and reaches the VPS through the `remote` helper from Step 0,
which wraps `ssh` and puts `~/.local/bin` (where `hermes` lives) on the remote PATH. Run all
blocks in ONE shell session: later steps call the Step 0 functions.

**Honest picture.** Everything below is checked against the Hermes v0.22.5 source (see
"Verified against Hermes v0.22.5"). Nothing was run against a real Hermes host; the offline
tests drive these exact blocks against a stub whose command *syntax* is the real v0.22.5
argparse and whose *behaviour* is an assumption.

---

## How the native lifecycle works (read once)

`gw_reload` runs `hermes -p default gateway restart --detach` and then requires `gw_ready`,
which is `gateway ensure --json --timeout 60` exiting 0 with `"state":"ready"` and a
different `instance_id` than before.

- `gateway restart` restarts the installed systemd/launchd service. With no service it stops the profile's gateway and starts the
  replacement; `--detach` starts that replacement in the background the way `ensure` does, so an ssh call cannot hang
  (`hermes_cli/gateway.py:5454-5536`, `hermes_cli/gateway_supervised_restart.py:140-151`, `hermes_cli/gateway_runtime_start.py:86-97`).
  A restart is drain-aware and can wait for in-flight turns (`agent.restart_after_turn_timeout`, default 1800 s:
  `hermes_cli/config_defaults.py:123`); do not interrupt the ssh call.
- With live sessions it asks y/N on a terminal and **refuses with exit 1 without one**. `-y`/`--yes`/`--interrupt` interrupts them
  (`hermes_cli/gateway_lifecycle_guards.py:81-129`, `hermes_cli/subcommands/gateway.py:146-155`). The helper never adds `-y` on its own:
  set `GW_INTERRUPT=1` only after the user agreed that interrupting live chats, cron jobs and background delegations is acceptable.
- `gateway ensure` never installs a service; it starts an installed one or spawns an unmanaged daemon, and exits 0 only when the gateway is
  ready. Exit codes: 0 ready, 2 invalid invocation, 3 incompatible, 4 authorization or profile mismatch, 5 deadline or still starting,
  6 draining or update-paused, 7 inaccessible or conflicting supervisor (`hermes_cli/subcommands/gateway.py:122-131`,
  `hermes_cli/gateway_runtime_cli.py:8-37`, `hermes_cli/gateway_runtime.py:390-495`). `instance_id` is a fresh uuid per gateway process
  (`gateway/run_runtime.py:144`), which is how `gw_reload` notices a restart that silently did nothing.
- `gateway status` prints `✗ Gateway is not running` when stopped (exit 0), so its text is **never** a health check
  (`hermes_cli/gateway.py:5636`). It is shown to the user as information only.
- A restarted gateway process loads `~/.hermes/.env` at start (`gateway/run.py:1583-1585`; it is also reloaded per turn outside multiplex
  mode, `:1588-1600`), so `restart` does re-read `.env`; config.yaml and MCP changes need the reload too.
- The recipe assumes the exclusive default profile and its one host gateway; named-profile and shared-host deployments are out of scope.
  There is no `--daemon` flag at all; the foreground command is `gateway run`.

---

## Before you start — gather (ask once, in one batch)

Required from the user (skip any already in env):

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `$VPS_IP` | IP or hostname of the VPS running Hermes | Their hosting dashboard |
| `$VPS_USER` | SSH user, usually `root` | Their hosting dashboard |
| `$GW_INTERRUPT` (optional) | `1` = interrupt live sessions (adds `-y`). Leave unset unless the user said so | Ask: "chats are running; interrupt them?" |
| `$INSTALL_SERVICE` (optional) | `1` = also install the supervised service so the gateway survives reboots (Step 4). Persistent change: needs the user's explicit yes | Ask only if they want it to survive reboots |

Confirm SSH access before doing anything:

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
SKILL_NAME=hermes-restart
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

This skill edits no file, so it has no `snapshot`/`rollback`/`finish`. A failure leaves the gateway as the native commands left it and
the skill reports it (Step 6).

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
```

Expected: a banner naming Hermes `0.22.5` (the version pinned as `HERMES_VERSION` in `VERSIONS.txt`). The `whoami; hostname` check from
`CLAUDE.md` applies if you ssh in by hand: a hex hostname means you are inside a container, not on the host.

---

## Step 2 — look first (read-only, informational)

A restart is not skipped because the gateway "looks healthy": the user asked for a reload, and no text from `gateway status` can prove
health. Show what the native tools say, and keep it as information:

```bash
echo "--- gateway status (informational text, not a health verdict) ---"
remote 'hermes -p default gateway status' || echo "(gateway status exited $?)"
echo "--- last gateway log lines ---"
remote 'hermes -p default logs gateway -n 30' || echo "(logs exited $?)"
```

If the user only wants to know whether the agent is fine, stop here and use `/hermes-status`; it reads more and starts nothing.

---

## Step 3 — DRY RUN preview (always show before touching anything)

```bash
LIVE_NOTE="the restart REFUSES and nothing changes (set GW_INTERRUPT=1 to interrupt them)"
GW_RESTART_FLAG=""
if [ "${GW_INTERRUPT:-0}" = 1 ]; then
  LIVE_NOTE="they WILL be interrupted (GW_INTERRUPT=1)"
  GW_RESTART_FLAG=1
fi
cat <<EOF
DRY RUN — the following will happen on $VPS_USER@$VPS_IP:
  1. (optional, only if INSTALL_SERVICE=1 and you agreed) hermes -p default gateway install --if-missing --no-start-now
  2. hermes -p default gateway ensure --json --timeout 10    (reads the current instance_id; starts a gateway if none is running)
  3. hermes -p default gateway restart --detach${GW_RESTART_FLAG:+ -y}
  4. hermes -p default gateway ensure --json --timeout 60 until it exits 0 with "state":"ready"
  5. The new instance_id must differ from the old one
  Live sessions: $LIVE_NOTE

No file is edited, no pid/lock file is touched, no process is killed, no secret is read or printed.
EOF
```

If the user confirms (or `AUTO_APPROVE=1`), continue.

---

## Step 4 — (optional, consent-gated) install the supervised service

Only when `INSTALL_SERVICE=1`. This **installs a persistent systemd/launchd service** (`Restart=always`, started at boot where linger or
the system scope allows it), so do it only on the user's explicit yes. `--no-start-now` leaves starting it to the reload in Step 5, which
then goes through the service. On a headless host, `gateway install` tries to enable linger itself; if it cannot, it prints the
`sudo loginctl enable-linger` command it needs. Run that yourself only with the user's agreement
(`hermes_cli/gateway.py:5171-5232,2445-2490`, `hermes_cli/subcommands/gateway.py:165-185`).

```bash
if [ "${INSTALL_SERVICE:-0}" = "1" ]; then
  remote 'hermes -p default gateway install --if-missing --no-start-now' \
    || { echo "FAIL: gateway install was refused or failed. Read its message (no systemd user session, linger, WSL, container are the usual causes). The gateway was not touched."; exit 1; }
else
  echo "Skipping service install (INSTALL_SERVICE is not 1): the gateway keeps whatever supervision it has."
fi
```

`gateway install --if-missing` prints `✓ Gateway service already installed` and does nothing when a service exists (`hermes_cli/gateway.py:5203-5205`).
Use no `--system`, `--run-as-user` or `--force` here; those are separate decisions for the user.

---

## Step 5 — reload through the native lifecycle

`gw_reload` (Step 0) returns only when `gateway ensure` reports a ready gateway with a new `instance_id`. It prints the ensure JSON line
(`state`, `reason_code`, `endpoint.instance_id`). Because it first reads the old instance id with `ensure`, a host with no running gateway
starts one for that read and the restart then replaces it; the end state is the same.

```bash
RELOAD_FAILED=0
gw_reload || RELOAD_FAILED=1
```

---

## Step 6 — if the reload failed: diagnose, read-only, then stop

```bash
if [ "$RELOAD_FAILED" = "1" ]; then
  echo "FAIL: the gateway did not come back ready (the message above is the refusal, or the ensure JSON with state and reason_code)."
  echo "--- gateway status (informational text) ---"
  remote 'hermes -p default gateway status' || true
  echo "--- gateway log ---"
  remote 'hermes -p default logs gateway -n 60' || true
  echo "Nothing was deleted, killed or edited. Read the tables below; do not retry with stop, run, --force or --all."
  exit 1
fi
```

**`gateway ensure` exit code and what to do** (the JSON line is printed with it; `detail` carries the human-readable cause when there is one):

| Exit | `state` | Meaning (source) | What to do |
|------|---------|------------------|------------|
| 3 | incompatible | an older Hermes gateway owns this home and could not be replaced (`gateway_runtime.py:366`) or the runtime protocol differs | do what `detail` says (it names `hermes gateway stop`), then run this skill again |
| 4 | inaccessible | `authorization`, `profile_mismatch`: a gateway owned by another user or profile refuses this client | run the skill as the user that owns the gateway; do not start a second one |
| 5 | starting | `deadline`: it was still starting when the timeout ran out | read `logs gateway` and `~/.hermes/logs/gateway-stdio.log` (the launch's own output); fix the cause (missing token, port in use), then rerun |
| 6 | draining | restart-wait or `update_paused`: an update owns the install while `.hermes-update-in-progress` exists (`gateway_runtime.py:325-362`) | wait for the update to finish; never delete that marker |
| 7 | inaccessible | `conflict`, `invalid_control_peer`, `profile_parked`, `runtime_start_failed`, or `runtime_exited` (the gateway it started died: `detail` has the redacted tail of its output) | read `detail`, `gateway status` and the log; ask the user before touching a supervisor |

**Refusals from `gateway restart` itself: read them, do not evade them.**

| What you see | Meaning (source) | What to do |
|--------------|------------------|------------|
| `Refusing to restart the gateway: N live session(s) would be interrupted.` (exit 1) | live turns, cron jobs or background delegations (`gateway_lifecycle_guards.py:81-129`) | wait, or ask the user and rerun with `GW_INTERRUPT=1` |
| `Refusing to restart the gateway from inside the gateway process.` | the command ran inside the gateway's own process tree (`gateway.py:5023-5032`) | run it from a normal ssh shell outside the gateway |
| `✗ Gateway (PID n) is managed by systemd unit ...` (exit 1) | a unit owns the gateway under a non-canonical name (`gateway_supervised_restart.py:107-130`) | follow the restart commands it prints, with the user's agreement; `gateway migrate-legacy --dry-run` lists legacy units |
| `⚠ Cannot restart gateway as a service — linger is not enabled.` (exit **0**, nothing restarted) | a failed service restart on a host without linger (`gateway.py:5497-5511`) | `gw_reload` reports "instance did not change"; the user runs the `loginctl enable-linger` command it prints |
| `✗ Gateway service restart failed.` (exit 1) | the unit exists but the service manager did not recover it (`gateway.py:5513-5519`) | read `logs gateway`; fix the unit; `gateway start` is the retry it names |
| exit 78 | a configuration refusal (a served named profile; `gateway.py:4272-4290`, `gateway/restart.py:17`) | stop; this skill drives the default profile only; ask the user |

Flags and commands that look like fixes and are not for this skill:

- `--all` restarts the ONE host multiplexer, may kill gateways of other profiles, and refuses when this profile does not own it
  (`gateway.py:5390-5450`). `--force` starts a separate gateway for a profile the host already serves: two pollers on one bot token
  (`subcommands/gateway.py:9-11`). Do not pass either to get past a refusal.
- `gateway list` is read-only and shows which profiles have a gateway (`gateway.py:1688-1721`); use it to understand a multi-profile host.
- `gateway migrate-legacy` stops, disables and removes legacy `hermes.service` unit files (`gateway.py:2627-2660`, `5652-5660`). Run it with
  `--dry-run` first and only with the user's yes.
- A pid or lock file left by a crash is handled by `restart`/`ensure`; deleting one by hand is profile-blind and can orphan a live gateway.

---

## Step 7 — verify and report

`gw_reload` already proved readiness; this step repeats the native check once more and shows the log, so the report quotes real output.

```bash
gw_ready || { echo "FAIL: the gateway is not ready after the reload."; exit 1; }
echo "--- recent gateway log (informational) ---"
remote 'hermes -p default logs gateway -n 20' || true
echo "OK: the gateway restarted and answers ready with a new instance_id (see the JSON above)."
```

Report to the user: the old and new `instance_id`, whether live sessions were interrupted (`GW_INTERRUPT`), and whether a service was
installed. Say plainly that readiness means "the gateway control endpoint answers", not that a platform delivered a message: for that,
send a test message on the platform or use `/hermes-status`.

---

## Rollback

There is nothing to roll back: this skill edits no file and a restart cannot be undone. If the reload failed, the gateway is in the state
the native commands left it, and Step 6 printed what they said. Do not try to "restore" it with `gateway stop`, `gateway run` or by
deleting pid/lock files. If a previous skill changed `.env`/`config.yaml` and the reload then failed, use that skill's `rollback`
(it restores the files and reloads through `gw_reload`).

---

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---------|--------------|------------|
| 1 | Treating a substring `running` in `gateway status` as healthy | `✗ Gateway is not running` contains `running`; the text is informational | `gw_ready`: `gateway ensure --json` must exit 0 with `"state":"ready"` |
| 2 | `rm -f` on `gateway.pid` or `gateway-locks/*.lock`, or `pkill`/`pgrep` | profile-blind; deletes the files of a gateway that is still alive when the restart was refused; native `restart`/`ensure` already replace stale owners | never touch pid/lock files; read the refusal instead |
| 3 | `--daemon`, a foreground `gateway run`, tmux or nohup | the foreground command blocks the ssh call; `--daemon` does not exist (argparse exit 2) | `restart --detach` (no service) or the installed service |
| 4 | Reaching for `-y`, `--force`, `--all` after a refusal | interrupts users' chats, starts a second poller on one bot token, or sweeps other profiles | ask the user; `GW_INTERRUPT=1` is the only interrupt switch |
| 5 | Probing `http://127.0.0.1:4000/health` | the base gateway has no HTTP listener and 4000 is not a Hermes port; the probe always fails | readiness is `gateway ensure`, not a port |
| 6 | Trusting exit 0 from `gateway restart` | the linger case prints a warning and exits 0 without restarting | `gw_reload` compares `instance_id` before and after |
| 7 | Killing a slow ssh call | a drain-aware restart waits for in-flight turns (default budget up to 1800 s) and killing it leaves a half-restarted gateway | wait; ask the user before interrupting with `GW_INTERRUPT=1` |
| 8 | Deleting `.hermes-update-in-progress` because `ensure` says `update_paused` | an update owns the install; clearing the fence lets the gateway start on a half-updated tree | wait for `hermes update` to finish |
| 9 | Container vs host confusion | a restart inside a container does not reach the host's service | `whoami; hostname` first: a hex hostname means a container |
| 10 | Fresh shell per command (some harnesses) | Step 0 functions are undefined later: `gw_reload: command not found` | re-run the Step 0 block first |
| 11 | Installing the service as a side effect of "just restart" | `gateway install` creates a persistent unit (and may enable linger) | only with `INSTALL_SERVICE=1` after the user's explicit yes |
| 12 | Believing `restart` skips `.env` | the gateway loads `~/.hermes/.env` when it starts (`gateway/run.py:1583-1585`) | one `gw_reload` after any `.env`, config or MCP change |

---

## Definition of done

- [ ] SSH to `$VPS_USER@$VPS_IP` confirmed working
- [ ] Hermes version verified on the VPS (`0.22.5`)
- [ ] Dry-run shown to the user; user approved (or `AUTO_APPROVE=1`)
- [ ] Live-session behaviour was explicit: refused, or interrupted only because `GW_INTERRUPT=1` was set with the user's yes
- [ ] The service was installed only if `INSTALL_SERVICE=1` and the user said yes
- [ ] `gw_reload` returned success: `gateway ensure --json` exited 0 with `"state":"ready"` and the `instance_id` changed
- [ ] No pid/lock file was deleted, no process was killed, no HTTP port was probed, no `.env`/`config.yaml` was edited
- [ ] `gateway status` text was shown as information only; no health verdict came from it
- [ ] On failure: Step 6 diagnosis was printed, the refusal was explained, and nothing was retried with `--force`, `--all` or `stop`

---

## Verified against Hermes v0.22.5

Read in the tagged source (`NousResearch/hermes-agent` at `bf0203a794a07aac3ff764972ab9087baa4e4f4e`), paths relative to the repo root:

- `hermes_cli/subcommands/gateway.py:70-215`: there is no `--daemon` flag on `gateway run`; `restart` takes `--all`, `--force`, `-y/--yes/--interrupt`, `--detach`;
  `ensure` takes `--json`, `--timeout` and documents exit codes 0/2/3/4/5/6/7; `status` takes `--deep`, `--full`; `install` takes `--if-missing`,
  `--no-start-now`; `list` and `migrate-legacy` exist.
- `hermes_cli/gateway.py:5454-5536` restart (service path, linger no-op at 5497-5511, service-failed at 5513-5519, replacement start),
  `:5023-5032` refusal from inside the gateway, `:4272-4290` exit 78, `:5579-5650` status (stopped text at `:5636`), `:4698-4750` the
  "Recent gateway health" lines status appends, `:1688-1721` list, `:5199-5232` install.
- `hermes_cli/gateway_lifecycle_guards.py:81-129` the live-session refusal and its wording.
- `hermes_cli/gateway_runtime_cli.py:8-37`, `hermes_cli/gateway_runtime.py:325-495` ensure (never installs a service; update fence; replace of an older gateway).
- `hermes_cli/gateway_supervised_restart.py:107-151`, `hermes_cli/gateway_runtime_start.py:70-101` supervised-unit refusal and the detached replacement
  (its stdout/stderr go to `logs/gateway-stdio.log`).
- `gateway/run.py:1583-1600` (.env loaded at start and per turn), `gateway/run_runtime.py:144` (`instance_id`), `gateway/restart.py:13-17` (exit 75/78).

Not verified: nothing here was run against a real Hermes host, systemd, or a live chat. The stub the tests use reproduces the real command
syntax but invents behaviour. The service-install path (Step 4) and the restart of an installed service while an unmanaged gateway runs are
source-read only.

See [reference/TROUBLESHOOTING.md](../../reference/TROUBLESHOOTING.md) for gateway failure modes.
