---
name: hermes-install
description: Install the opt-in Hermes v0.22.5 compatibility candidate on a fresh POSIX host using its official pinned source installer and managed runtime, without ambient pip or deleting existing user state.
---

# /hermes-install — official source installation over SSH

Run the installer as the account that will own Hermes and its gateway. This recipe covers
a fresh Linux/macOS source installation using the default `~/.hermes` data root and
`~/.local/bin/hermes` launcher. Packaged Desktop, Docker, custom homes and existing
source installations must use their native installation/update route instead.

**Compatibility candidate, not a promoted pin.** v0.22.5 resolves to commit
`bf0203a794a07aac3ff764972ab9087baa4e4f4e`. Its installer delegates managed Python,
Node and dependencies to Hermes PM. Tagged-source/parser checks establish the commands
below; they do not establish a real-server golden path. The promotion gate in
`VERSIONS.txt` still applies. Do not install the unrelated PyPI package to pin Hermes.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | SSH target and intended service account |
| `HERMES_VERSION` | Explicitly `0.22.5` for this candidate recipe |
| `CANDIDATE_ACKNOWLEDGED` | `1` to opt into the unpromoted compatibility candidate |

For a local install, run the remote bodies directly as the intended service account.
Never run the installer under sudo to change accounts.

## Step 0 — validate the candidate and target before any remote write

```bash
[ "${HERMES_VERSION:-}" = 0.22.5 ] && [ "${CANDIDATE_ACKNOWLEDGED:-0}" = 1 ] \
  || { echo "ABORT: set HERMES_VERSION=0.22.5 and CANDIDATE_ACKNOWLEDGED=1 for this unpromoted candidate. Nothing was written."; exit 1; }
[[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo "ABORT: malformed SSH target. Nothing was written."; exit 1; }
HERMES_COMMIT=bf0203a794a07aac3ff764972ab9087baa4e4f4e
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes "$VPS_USER@$VPS_IP" 'echo ok' \
  || { echo "ABORT: SSH failed. Run /setup-ssh-keys first."; exit 1; }
```

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

Show the target, candidate version and immutable commit. The source installer will use
`--non-interactive --skip-browser --skip-computer-use`, select the stable update channel,
and leave provider credentials to `/hermes-model` or native `hermes -p default model`.
Proceed after the user's existing installation authorization, or `AUTO_APPROVE=1`.

## Step 3 — run the pinned official installer

Download first and check the download succeeded before executing it. Do not pipe a failed
network response into a shell. This step needs network access on the target when actually run.

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

## Step 4 — verify source identity and managed runtime

```bash
remote "HERMES_COMMIT='$HERMES_COMMIT' bash -s" <<'REMOTE' || { echo "FAIL: candidate identity/runtime not confirmed. Preserve the installation for native repair."; exit 1; }
set -e
H="$HOME/.local/bin/hermes"
[ -x "$H" ]
[ "$(git -C "$HOME/.hermes/hermes-agent" rev-parse HEAD)" = "$HERMES_COMMIT" ]
v=$("$H" -p default --version)
printf '%s\n' "$v" | grep -Eq '(^|[^0-9])0[.]22[.]5([^0-9]|$)'
"$H" -p default pm status
"$H" -p default doctor
REMOTE
```

A failed doctor is an unresolved installation check; report its actual diagnostics rather
than declaring the install healthy. No inference or platform delivery has been tested yet.
Native `hermes -p default model` and `hermes -p default gateway setup` perform attended setup; headless BYOK
configuration is covered by `/hermes-model`.

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
| 2 | Installing from moving `main` | It defeats candidate identity | Pin the installer URL and source commit |
| 3 | Ignoring a failed download | An empty shell pipeline can appear successful | Download to a private file and check its status |
| 4 | Running under the wrong account | Keys, launcher and service read different homes | Install as the intended service account |
| 5 | Deleting the launcher on failure | It may destroy a working older installation | Refuse existing installs and preserve recovery state |
| 6 | Claiming the stable channel pins a version | The channel follows future releases | Distinguish immutable initial commit from update policy |
| 7 | Treating parser tests as live proof | Parsers do not start services or call providers | Keep runtime and delivery evidence separate |
| 8 | Guessing old venv paths | PM owns managed generations | Use the published wrapper and native PM diagnostics |
| 9 | Installing in an ephemeral container | Recreation discards the changes | Update the image through its owner |
| 10 | Calling installation a complete deployment | No model/platform has been tested | Complete the ordered configuration handoff |

## Step 6 — evidence to report

Record the observed version and source commit, not just the requested ones.
Report whether native PM and doctor completed successfully.
State which optional tools were intentionally excluded.
State that provider inference is still unverified at this boundary.
State that real platform delivery is still unverified at this boundary.
Retain local recovery diagnostics if any step failed.

## Definition of done

- [ ] Candidate opt-in and exact version/commit were explicit
- [ ] Installation ownership and fresh-host prerequisites checked before mutation
- [ ] Official installer completed with managed dependencies and no interactive setup
- [ ] Source commit, version, PM status and doctor verified
- [ ] Provider inference and platform delivery are still reported as unverified
- [ ] Existing installations and user data preserved on refusal/failure

Sources checked against v0.22.5: [official installer](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/scripts/install.sh),
[installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation).
