---
name: hermes-install
description: Install Hermes Agent v0.22.5 on a fresh POSIX host with its official pinned source installer and managed runtime, without ambient pip or deleting existing user state.
---

# /hermes-install — official source installation over SSH

Run the installer as the account that will own Hermes and its gateway. This recipe covers
a fresh Linux/macOS source installation using the default `~/.hermes` data root and
`~/.local/bin/hermes` launcher. Packaged Desktop, Docker, custom homes and existing
source installations must use their native installation/update route instead.

**Target: Hermes v0.22.5 only, source-verified and not live-verified.** v0.22.5 resolves to commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Its installer delegates managed Python,
Node and dependencies to Hermes PM. The commands below were read in the tagged source
(see "Verified against Hermes v0.22.5"); no real-server install has been run with this
recipe, and the promotion gate in `VERSIONS.txt` still applies before anyone calls it
live-verified. Do not install the unrelated PyPI package to pin Hermes.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | SSH target and intended service account |
| `HERMES_VERSION` | Optional. If set it must be exactly `0.22.5`; any other value is refused before the target is contacted |

For a local install, run the remote bodies directly as the intended service account.
Never run the installer under sudo to change accounts.

## Step 0 — helpers, version gate and target validation (nothing is written)

```bash
SKILL_NAME=hermes-install
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
[ -z "${HERMES_VERSION:-}" ] || [ "$HERMES_VERSION" = 0.22.5 ] \
  || { echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (HERMES_VERSION=$HERMES_VERSION). Nothing was written."; exit 1; }
[[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo "ABORT: malformed SSH target. Nothing was written."; exit 1; }
HERMES_COMMIT=bf0203a794a07aac3ff764972ab9087baa4e4f4e
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$VPS_USER@$VPS_IP" 'echo ok' \
  || { echo "ABORT: SSH failed. Run /setup-ssh-keys first."; exit 1; }
```

This skill writes nothing hstack manages (the installer creates `~/.hermes` itself), so it takes no
`snapshot`, and it never starts a gateway: `gw_ready` and `gw_reload` are the shared helpers, used by
`/hermes-deploy` and the other skills that run after this one.

## Step 1 — inspect the installation owner and refuse an existing installation

```bash
remote 'bash -s' <<'REMOTE' || exit 1
set -e
whoami; hostname
case "$(uname -s)" in Linux|Darwin) ;; *) echo "ABORT: use the native installation route for this OS." >&2; exit 1 ;; esac
[ ! -e /.dockerenv ] && [ ! -e /run/.containerenv ] \
  || { echo "ABORT: container detected; update its image through its owner." >&2; exit 1; }
for p in "$HOME/.local/bin/hermes" "$HOME/.hermes/hermes-agent"; do
  [ ! -e "$p" ] && [ ! -L "$p" ] || { echo "ABORT: an installation already exists; use /hermes-update or native repair. It was preserved." >&2; exit 1; }
done
if command -v hermes >/dev/null 2>&1; then echo "ABORT: another Hermes launcher exists; inspect its installation owner." >&2; exit 1; fi
for cmd in curl git tar; do command -v "$cmd" >/dev/null || { echo "ABORT: administrator must install $cmd first." >&2; exit 1; }; done
REMOTE
```

The administrator supplies system libraries and build prerequisites. PM owns its pinned
tools and Python generations; do not probe arbitrary system venvs or install packages
with ambient `pip`.

## Step 2 — dry run

Show the target, version and immutable commit. The source installer will use
`--non-interactive --skip-browser --skip-computer-use`, select the stable update channel,
and leave provider credentials to `/hermes-model` or native `hermes -p default model`.
Proceed after the user's existing installation authorization, or `AUTO_APPROVE=1`.

## Step 3 — run the pinned official installer

Download first and check the download succeeded before executing it. Do not pipe a failed
network response into a shell. This step needs network access on the target when actually run.
The installer refuses a `--commit` that is not on `main` (`scripts/install.sh:928-932`); the v0.22.5 commit is
an ancestor of `main` in the upstream clone this recipe was read from.

```bash
remote "HERMES_COMMIT='$HERMES_COMMIT' bash -s" <<'REMOTE' || { echo "FAIL: installation incomplete. Preserve ~/.hermes and inspect its logs/install.log; do not delete the launcher or user data."; exit 1; }
set -e
umask 077
t=$(mktemp)
trap 'rm -f "$t"' EXIT
curl -fsSL --max-time 60 "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" -o "$t"
[ -s "$t" ]
if command -v sha256sum >/dev/null 2>&1; then
  digest=$(sha256sum "$t")
else
  digest=$(shasum -a 256 "$t")
fi
digest=${digest%% *}
[ "$digest" = 99cb3691d55019c6973a7acb775a915648666cc24e483ca827a1cdbb3531a674 ]
env HERMES_REPO_URL=https://github.com/NousResearch/hermes-agent.git \
  HERMES_INSTALL_DIR="$HOME/.hermes/hermes-agent" HERMES_HOME="$HOME/.hermes" \
  bash "$t" --commit "$HERMES_COMMIT" --channel stable \
  --non-interactive --skip-browser --skip-computer-use
REMOTE
```

## Step 4 — verify source identity, version and the managed runtime

The gate is the launcher, the exact commit, the version banner and `pm doctor` (the managed
dependency check, which exits 1 when a required package is missing or fails verification).
`pm status` only prints the latest PM sync receipt and always exits 0, so it is shown but is not a gate.
`pm` is dispatched before argparse (`hermes_cli/main.py:679-683`), which is why the two `pm` lines
carry a `hermes-parse: skip` marker for the syntax test.

```bash
remote "HERMES_COMMIT='$HERMES_COMMIT' bash -s" <<'REMOTE' || { echo "FAIL: version/runtime not confirmed. Preserve the installation for native repair."; exit 1; }
set -e
[ -x "$HOME/.local/bin/hermes" ]
[ "$(git -C "$HOME/.hermes/hermes-agent" rev-parse HEAD)" = "$HERMES_COMMIT" ]
v=$(hermes -p default --version)
printf '%s\n' "$v" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)'
hermes -p default pm doctor  # hermes-parse: skip (pm is dispatched before argparse: hermes_cli/main.py:679-683)
hermes -p default pm status  # hermes-parse: skip (pm is dispatched before argparse: hermes_cli/main.py:679-683)
REMOTE
```

`hermes doctor` is a broader check and is reported, not used as a gate. At v0.22.5 it exits non-zero
whenever any issue remains (`hermes_cli/doctor.py:171-194`, forwarded by `hermes_cli/main.py:3550-3554`), and
some of those issues are expected before a model key exists (for example "Run 'hermes setup' to configure API
keys" when `.env` names no provider, `hermes_cli/doctor_config.py:179-184`, or missing toolset keys,
`hermes_cli/doctor_tools.py:530`). Whether a fresh, keyless headless install exits 0 is not verified, so a
non-zero exit is recorded and classified; it does not undo the installation.

```bash
DOCTOR_RC=0
DOCTOR_OUT=$(remote 'hermes -p default doctor 2>&1') || DOCTOR_RC=$?
printf '%s\n' "$DOCTOR_OUT" | tail -40
if [ "$DOCTOR_RC" = 0 ]; then
  echo "OK: hermes -p default doctor reports no remaining issues."
else
  echo "NOTE: hermes -p default doctor exited $DOCTOR_RC (issues remain; listed above). Classify them against what was requested:"
  echo "      a missing provider key is resolved by /hermes-model; anything else needs the listed fix before relying on this install."
fi
```

No inference or platform delivery has been tested yet. Native `hermes -p default model` and
`hermes -p default gateway setup` perform attended setup; headless BYOK configuration is covered by
`/hermes-model`.

## Rollback — preserve native recovery state

There is no uninstall-as-rollback step. Hermes PM stages dependency generations; preserve
its working generation, source checkout, user data and logs after any failure. Use native
`hermes -p default pm doctor` / `hermes -p default pm repair` or rerun the reviewed installer after inspecting
the failure. Never remove a pre-existing launcher, `~/.hermes`, or run `pip uninstall`.


## Step 5 — hand off configuration without overstating readiness

Installation and useful operation are different checks.
A working launcher does not prove a model credential is valid.
A ready local runtime does not prove Telegram can reach the intended chat.
Do the following in order after this installation gate:

1. Choose provider/model through native attended setup or `/hermes-model`.
2. Verify one successful inference request with the expected output.
3. Configure a private platform through native gateway setup or its supported recipe.
4. Confirm the configured bot identity and numeric access policy.
5. Observe a real message round trip from an allowed user.
6. Enable scheduled work only after its intended destination is confirmed.

Do not turn on every tool, plugin, connector or platform just because it is available.
The installer intentionally skipped browser/computer-use tools.
Native PM can install those tools later if the user needs them.
Skipping them is a persistent native installation choice, not an installation failure.
The non-interactive installer also skips its own setup and gateway stages
(`scripts/install.sh:1217-1221`), so no gateway service exists yet; `/hermes-deploy` installs it.

### Ownership and migration boundaries

The default source launcher belongs to the account that ran the installer.
A shell running as root and a gateway running as another account read different homes.
Confirm the intended account before configuring keys or installing a service.
A readable hostname is not proof that the process is on the host.
Use the container markers and installation-owner checks rather than a hostname guess.
Do not update a container's interior when its image/supervisor owns the installation.
Do not replace a packaged Desktop launcher with a source checkout.
A pre-existing checkout, even if incomplete, may contain changes worth recovering.
The fresh-install gate therefore refuses it instead of deleting it.

### When installation fails

Keep the exact commit and installer exit status in the incident record.
Inspect the target's `logs/install.log` as the same installation account.
Do not paste whole logs into chat without checking for credentials or private paths.
A network failure is not evidence that the user must change provider credentials.
A dependency-generation failure is not repaired by arbitrary system pip installs.
A native process guard should be investigated, not bypassed with force flags.
A doctor warning should be classified against the capabilities the user requested.
If optional tooling was intentionally skipped, explain that specific limitation.
If the launcher or managed environment is broken, keep installation unverified.
If another installation owner is found, stop this recipe and use that owner.

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---|---|---|
| 1 | Ambient `pip install hermes-agent` | It can target another project/runtime | Use the official immutable source installer |
| 2 | Installing from moving `main` | It defeats the pinned identity | Pin the installer URL and source commit |
| 3 | Ignoring a failed download | An empty shell pipeline can appear successful | Download to a private file and check its status |
| 4 | Running under the wrong account | Keys, launcher and service read different homes | Install as the intended service account |
| 5 | Deleting the launcher on failure | It may destroy a working older installation | Refuse existing installs and preserve recovery state |
| 6 | Claiming the stable channel pins a version | The channel follows future releases (the installer saves `stable` with `update --set-channel`, `scripts/install.sh:1179-1181`) | Distinguish the immutable initial commit from the update policy |
| 7 | Treating parser tests as live proof | Parsers do not start services or call providers | Keep runtime and delivery evidence separate |
| 8 | Guessing old venv paths | PM owns managed generations | Use the published wrapper and native PM diagnostics |
| 9 | Installing in an ephemeral container | Recreation discards the changes | Update the image through its owner |
| 10 | Calling installation a complete deployment | No model/platform has been tested | Complete the ordered configuration handoff |
| 11 | Aborting or rolling back because `hermes doctor` exits non-zero | Doctor exits 1 whenever any issue remains, including "no API key yet" | Record the exit code and issues; gate on `pm doctor`, not on doctor |
| 12 | Installing any Hermes other than 0.22.5 with this recipe | Flags and lifecycle differ between releases and only this tag was read | Step 0 refuses another `HERMES_VERSION`; Step 4 refuses another version banner |
| 13 | Putting `pm ...` through the argument parser check | `pm` never reaches argparse (dispatched at `hermes_cli/main.py:679-683`) | Mark those lines `hermes-parse: skip` with that reason, nothing else |

## Step 6 — evidence to report

Record the observed version and source commit, not just the requested ones.
Report whether `pm doctor` passed and what `hermes doctor` exited with, with its issue list.
State which optional tools were intentionally excluded.
State that provider inference is still unverified at this boundary.
State that real platform delivery is still unverified at this boundary.
State that this procedure was source-verified, not run against a live host.
Retain local recovery diagnostics if any step failed.

## Definition of done

- [ ] `HERMES_VERSION` unset or exactly `0.22.5`; exact commit and version banner confirmed on the target
- [ ] Installation ownership and fresh-host prerequisites checked before mutation
- [ ] Official installer completed with managed dependencies and no interactive setup
- [ ] Source commit, version and `pm doctor` verified; `hermes doctor` exit code and issues recorded
- [ ] Provider inference and platform delivery are still reported as unverified
- [ ] Existing installations and user data preserved on refusal/failure

## Verified against Hermes v0.22.5

Source-verified at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository. The installer
bytes are pinned by SHA-256 `99cb3691d55019c6973a7acb775a915648666cc24e483ca827a1cdbb3531a674` and equal the offline fixture in
`tests/skills/fixtures/hermes-v0.22.5/install.sh` (checked by `native-surfaces.test.mjs`).

- Installer options and environment: `--commit`, `--channel stable|main`, `--non-interactive`, `--skip-browser`, `--skip-computer-use`
  `scripts/install.sh:46-90`; `HERMES_REPO_URL`, `HERMES_INSTALL_DIR`, `HERMES_HOME` `:23-33`; unknown options exit 1 `:88`; `--channel` is
  persisted with `update --set-channel` `:1179-1181`; a pinned commit must be on `main` `:928-932`.
- Prerequisites it checks: git and curl `:584-594`; non-interactive runs skip the setup and gateway stages `:1217-1221`; `.env` is created
  mode 600 from `.env.example` `:1136-1139`.
- Launcher publication `hermes_cli/_launchers.py:769-806`; the shell PATH line for `~/.local/bin` `scripts/install.sh:1061-1100`; the
  `hermes` command check in `hermes doctor` `hermes_cli/doctor_platform.py:622-658`.
- `pm` dispatch before argparse `hermes_cli/main.py:679-683`; `pm doctor` exit 1 on a bad required package and `pm status` always 0
  `pm/cli.py:422-470,790-803`; `pm repair` `:806-813`.
- `hermes doctor` flags `--fix --live --ack` `hermes_cli/subcommands/doctor.py:10-25`; exit code `int(bool(issues))` `hermes_cli/doctor.py:171-194`,
  forwarded at `hermes_cli/main.py:3550-3554`; the "no API key" issue `hermes_cli/doctor_config.py:179-184`.

Not verified: any run of the installer on a real host (network, PM generations, Python/Node builds), whether `hermes doctor` exits 0 on a fresh
keyless headless install, and everything after installation (inference, platforms).

Sources checked against v0.22.5: [official installer](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/scripts/install.sh),
[installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation).
