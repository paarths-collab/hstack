---
name: hermes-update
description: Inspect and apply Hermes's native stable-channel updater on an existing Hermes 0.22.5 source installation, with a verified native backup first, and report version, runtime and delivery honestly.
---

# /hermes-update — use the installation owner's updater

Hermes v0.22.5 source installations use tested stable releases and PM dependency
generations. Use `hermes -p default update`; do not install a PyPI package over its launcher,
run `git reset`, or replace it with an installer tracking `main`. Desktop packages,
Store installs and Docker images have their own update owners and must use them.

**Target: Hermes v0.22.5 only, source-verified and not live-verified.** This recipe starts from an
installation that reports 0.22.5 and drives the native updater (`update --plan`, `update --check`,
`update --channel stable --yes`). Stable is an upstream release channel, not a promise to remain on
v0.22.5: if a newer release is published, the update moves the host past the only version the other hstack
skills were read against. Review the native plan and release notes before authorizing it, and treat the
result as **unverified for hstack** until its skills are re-verified for that release. If an exact immutable
version is required, do not pretend the updater has a `--version` flag: use an explicitly reviewed fresh
source installation and migration plan instead.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | Target and installation owner |
| `HERMES_VERSION` | Optional. If set it must be exactly `0.22.5` (the version this recipe updates from); anything else is refused before the target is contacted |
| `ALLOW_STABLE_UPDATE=1` | Explicitly authorize the native stable-channel update after reviewing its plan |
| `GATEWAY_EXPECTED=1` | Set when a gateway should be running after the update (every `/hermes-deploy` host). The post-update check is `gateway ensure`, which would START a gateway that was deliberately stopped, so it only runs when you say so |

## Step 0 — helpers, version gate and target validation (nothing is written)

```bash
SKILL_NAME=hermes-update
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
```

This skill takes no `snapshot`: the native updater owns `.env`/`config.yaml` migrations, and the recovery
artifact is a native `hermes backup` archive (Step 3). `gw_ready` is used for the readiness check after the update
(the updater restarts the gateway itself); `gw_reload` is the shared helper and is not needed here.

## Step 1 — inspect before mutation

`--plan` is read-only and runs before any refusal gate; `--check` fetches and reports without installing
(`hermes_cli/main.py:2277-2340`). `--check` exits 2 when the install is image/package managed, 1 when it is not a git
checkout or the fetch fails (`hermes_cli/update_cmd.py:632-690`).

```bash
remote 'bash -s' <<'REMOTE' || { echo "ABORT: native updater inspection failed. Preserve this installation and inspect its upgrade path."; exit 1; }
set -e
whoami; hostname
[ -x "$HOME/.local/bin/hermes" ] && [ -d "$HOME/.hermes/hermes-agent/.git" ] \
  || { echo "ABORT: this recipe requires the default POSIX source installation; use the actual package/image owner." >&2; exit 1; }
v=$(hermes -p default --version)
printf '%s\n' "$v"
printf '%s\n' "$v" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' \
  || { echo "ABORT: this recipe updates FROM Hermes 0.22.5 only (got: $v)." >&2; exit 1; }
hermes -p default update --plan
hermes -p default update --channel stable --check
REMOTE
```

Older versions may not support these flags. That is a migration boundary, not permission
to fall back to pip or a destructive reinstall. Inspect the official release-specific
upgrade path first. Do not force a downgrade or interrupt live work to get past a refusal.

## Step 2 — dry run and authorization gate

Explain that the native updater owns code/dependency preparation and the gateway fleet restart (unless
`--no-gateway-restart`, `hermes_cli/subcommands/update.py:110-114`); back up first, follow stable for this run, and
verify afterwards. Stable may advance beyond v0.22.5. Its selection does not promote that version into hstack's support matrix.

```bash
[ "${ALLOW_STABLE_UPDATE:-0}" = 1 ] \
  || { echo "ABORT: review the native plan and authorize ALLOW_STABLE_UPDATE=1 before applying. Nothing was changed by hstack."; exit 1; }
```

## Step 3 — keep an exact private recovery artifact, then update

`hermes backup` is the native full archive of `~/.hermes` (without the `hermes-agent` checkout, venvs and caches); it exits 1 when the
archive was written but is incomplete (`hermes_cli/main.py:2185-2192`). The artifact is written OUTSIDE `~/.hermes` so it does not
archive itself or the older recovery copies, with `--keep 0` so no older backup is pruned, and its exact path is recorded before anything changes.

`update` also takes its own pre-update snapshot by default (`updates.pre_update_backup: quick`,
`hermes_cli/config_defaults.py:2362-2375`; `hermes_cli/update_cmd_maint.py:621-645`), but a failed snapshot or `--backup` zip is
best-effort and never stops the update (`:752-787`). That is why the verified archive above is taken explicitly and `--backup`
is not repeated: it would only write a second archive that cannot block anything.

```bash
remote 'bash -s' <<'REMOTE' || { echo "FAIL: update not confirmed. Keep the recovery artifact printed above and the native updater diagnostics; no automatic downgrade was attempted."; exit 1; }
set -e
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
art="$HOME/hermes-backup-hstack-pre-update-$stamp.zip"
hermes -p default --version > "$art.version"
hermes -p default backup --output "$art" --keep 0
[ -s "$art" ]
chmod 600 "$art" "$art.version"
printf 'Recovery artifact: %s\n' "$art"
hermes -p default update --channel stable --yes
printf 'Update command completed. Version now: '
hermes -p default --version
REMOTE
```

`--channel stable` is a transient override; it does not silently change a custom install's
persisted channel (`hermes_cli/subcommands/update.py:99-109`). `--yes` accepts the updater's config-migration and stash-restore
prompts and skips API-key entry (`:41-44`); it is not a force flag and must not be combined with `--force-venv` to bypass process guards.

Then verify what the update left behind. `pm doctor` exits 1 when a required package is missing or fails verification
(`pm/cli.py:422-470`). `hermes doctor` exits non-zero while any issue remains (`hermes_cli/doctor.py:171-194`), so it is
reported and classified, not a gate. The gateway check is `gw_ready` (`gateway ensure --json` exit 0 with `"state":"ready"`),
only when a gateway is expected; never grep `gateway status` text.

```bash
remote 'hermes -p default pm doctor' >/dev/null \
  || { echo "FAIL: pm doctor reports a missing or unverified package after the update. Keep the recovery artifact; use pm repair after inspecting."; exit 1; }  # hermes-parse: skip (pm is dispatched before argparse: hermes_cli/main.py:679-683)
NEW_VERSION=$(remote 'hermes -p default --version') || { echo "FAIL: version unreadable after the update."; exit 1; }
printf 'Version after update: %s\n' "$NEW_VERSION"
if printf '%s\n' "$NEW_VERSION" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)'; then
  echo "Still Hermes 0.22.5: no newer stable release was applied."
else
  echo "UNVERIFIED FOR HSTACK: the host moved past 0.22.5. The other hstack skills refuse to run on any other version until they are re-verified."
fi
DOCTOR_RC=0
DOCTOR_OUT=$(remote 'hermes -p default doctor 2>&1') || DOCTOR_RC=$?
printf '%s\n' "$DOCTOR_OUT" | tail -40
[ "$DOCTOR_RC" = 0 ] && echo "OK: hermes -p default doctor reports no remaining issues." \
  || echo "NOTE: hermes -p default doctor exited $DOCTOR_RC (issues remain; listed above). Classify them; this is not an automatic failure."
if [ "${GATEWAY_EXPECTED:-0}" = 1 ]; then
  gw_ready >/dev/null || { echo "FAIL: gateway is not ready after the update (gateway ensure --json did not report ready). Inspect hermes -p default logs gateway -n 100."; exit 1; }
  echo "OK: gateway reports ready."
else
  echo "Gateway readiness not checked (GATEWAY_EXPECTED is not 1): gateway ensure would start a gateway that was deliberately stopped."
fi
```

## Step 4 — verify inference and the actual workflow

```bash
REPLY=$(remote "hermes -p default -z 'reply with the single word OK'") \
  || { echo "FAIL: inference command failed. Preserve the update recovery artifact."; exit 1; }
[ "$(printf '%s' "$REPLY" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | sed '/^$/d')" = OK ] \
  || { echo "UNVERIFIED: inference did not return exact OK. Preserve the update recovery artifact."; exit 1; }
```

Recheck each configured connector's real read-only operation and each intended private
messaging destination. A version banner, plugin list, or gateway log is not proof that a
scheduled result arrived. Keep the update unverified until the relevant observed canary
passes; never claim that a changed wiring list alone proves delivery.

## Rollback — preserve native recovery state

Native update owns staging, dependency validation and interrupted-update recovery. If it
refuses, retain its diagnostic and backup. A full data restore uses `hermes -p default import
<recorded-artifact>`; it asks "Continue? [y/N]" when `config.yaml` or `.env` exist (an EOF answer aborts) unless `--force`, and a running
gateway that owns the home makes it refuse with "Drain and stop the gateway, then retry"
(`hermes_cli/backup.py:732-790,800-806`, `gateway/runtime_ownership.py:274`). Stop live writers through their actual supervisor first. It
is not `hermes restore`, and restoring data does not restore the prior executable. Do not
blindly import the newest unrelated backup, force an old code version, or report
"rolled back" unless code, data and the actual workflow have been rechecked.

## Step 5 — classify the result before normal scheduling resumes

Use the narrowest status supported by the evidence:

| Result | Meaning | Next action |
|---|---|---|
| Plan/check failed | Native update path is not established | Preserve the install and inspect its owner/version |
| Update failed or `pm doctor` failed | The code or dependency generation is not trusted | Keep the artifact and diagnostics; use `pm repair` only after inspecting |
| Runtime ready, inference failed | The configured provider is not confirmed | Check provider identity/credentials without printing secrets |
| Inference passed, canary missing | Real workflow delivery is unknown | Keep scheduled activation under review |
| Intended canary observed | The tested workflow completed on this version | Record its actual scope; do not generalize to all integrations |
| Version moved past 0.22.5 | hstack's skills are not verified for it | Report it as unverified; do not run other hstack skills until they are re-verified |

An uncertain result does not justify deleting the backup or automatically retrying sends.
An update can change behavior even when the version banner looks correct.
Verify that the gateway is running code from the updated installation, not a stale process.
Native ensure/readiness is useful evidence but does not replace the workflow canary.
If multiple profiles share the gateway, include all affected owners in the plan review.
Do not run a second profile-specific dispatcher to work around a shared-host conflict.

### Before restoring a data backup

Confirm the artifact path belongs to this update attempt.
Confirm its file exists, is private, and has not been substituted by another run.
Confirm which account and data root the restore will affect.
Stop live writers through their actual supervisor first.
Read the native importer's overwrite prompt and scope.
Do not assume restoring user data also installs the previous application code.
Do not assume an older binary can read data migrated by a newer version.
Do not force a downgrade solely because a smoke check is inconclusive.
Keep the recovery artifact until the user accepts the reverified state.
If the state cannot be proven restored, report the remaining uncertainty plainly.

### Package and channel boundaries

A Windows Store installation updates through the Store.
A sealed Desktop package uses its package updater.
A Docker deployment changes its reviewed image through the deployment owner.
This source-install recipe does not mutate any of those owners.
A custom checkout/channel remains custom unless explicitly changed.
`--channel stable` chooses stable only for the current native update invocation.
`--set-channel stable` persists a channel change and is a separate user decision.
The native updater has no generic exact-version install flag in this checked parser.
Do not invent `--version`, `--tag`, or a pip fallback to simulate one.

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---|---|---|
| 1 | Updating with ambient pip | It bypasses native PM ownership | Use the installation owner's updater |
| 2 | Selecting the newest backup by filename | Another run may own it | Record the exact artifact path before mutation |
| 3 | Using nonexistent `hermes restore` | It can leave recovery incomplete | Inspect native `hermes -p default import` semantics |
| 4 | Treating `--yes` as universal authorization | It only answers specific updater prompts | Review the native plan before allowing the update |
| 5 | Bypassing process guards | Live runtimes can hold managed files | Resolve the owner/process conflict |
| 6 | Forced downgrade after a weak smoke test | New data may not be backward compatible | Keep evidence and plan recovery explicitly |
| 7 | Counting `OK` inside an error as success | Diagnostic text can repeat the prompt | Require command success and exact output |
| 8 | Assuming install success proves delivery | Platform routing may still be wrong | Observe the intended private canary |
| 9 | Calling every integration supported | Only a bounded workflow was tested | Report version, target and tested operations |
| 10 | Assuming stable means hstack-verified | Stable moves on; this recipe was read against 0.22.5 only | Compare the version after the update; report "unverified for hstack" when it changed |
| 11 | Running `update --backup` on top of an explicit `hermes backup` | Two full archives, and the updater's copy is best-effort | One verified `hermes backup`; the updater's default quick snapshot still runs |
| 12 | `gateway ensure` after the update on a host whose gateway was stopped on purpose | `ensure` starts a gateway | Only with `GATEWAY_EXPECTED=1` |
| 13 | Failing the update because `hermes doctor` exits 1 | Doctor exits non-zero while any issue remains | Gate on `pm doctor` and inference; classify doctor's issues |

## Step 6 — evidence to report

Report the native update's before/after version and installation owner.
Report whether the private backup was verified before the change.
Report `pm doctor`, `hermes doctor` and gateway readiness outcomes separately.
Report inference and workflow delivery outcomes separately.
State that this procedure was source-verified, not run against a live host, and whether the version is still 0.22.5.
Preserve unresolved errors and the exact recovery artifact.

## Definition of done

- [ ] `HERMES_VERSION` unset or `0.22.5`; the host reported 0.22.5 before the update
- [ ] Installation owner, native plan and stable-channel choice reviewed
- [ ] Exact private backup path recorded before update
- [ ] Native update completed without bypassing process/dependency guards
- [ ] Version after the update recorded (and called out as unverified for hstack if it is not 0.22.5)
- [ ] `pm doctor` passed; `hermes doctor` exit code and issues recorded; gateway readiness checked when `GATEWAY_EXPECTED=1`
- [ ] Inference command succeeded with exact expected output
- [ ] Intended connector and private-message delivery reverified, or explicitly unverified
- [ ] No pip mutation, moving-main installer, forced downgrade or invented restore command

## Verified against Hermes v0.22.5

Source-verified at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository.

- `update` flags `--check --plan --backup --no-backup --yes/-y --channel --set-channel --no-gateway-restart`: `hermes_cli/subcommands/update.py:8-115`
  (there is no `--version` flag).
- Preflight order (managed-install refusal, `--plan`, admission gate exit 2, `--check`): `hermes_cli/main.py:2277-2340`; `--check` exits `1`/`2`:
  `hermes_cli/update_cmd.py:632-690`.
- Pre-update backup: modes and flag precedence `hermes_cli/update_cmd_maint.py:621-645`; quick snapshot plus full zip, best-effort,
  prints `Saved:` and `Restore: hermes import <path>` `:672-787`; default `quick`, `backup_keep: 5` `hermes_cli/config_defaults.py:2362-2375`.
- The updater restarts the gateway fleet itself and `--no-gateway-restart` defers it: `hermes_cli/update_cmd.py:1515-1550`.
- `hermes backup -o/--output -q -l -k` `hermes_cli/subcommands/backup.py:16-35`; default output name and directory handling
  `hermes_cli/backup.py:550-568`; written outside-home archive, `Backup complete/incomplete` and pruning only for `hermes-backup-*` names
  `:612-679`; exit 1 when incomplete `hermes_cli/main.py:2185-2192`.
- `hermes import ZIP [--force]` `hermes_cli/subcommands/import_cmd.py:8-17`; prompt, EOF abort and gateway-ownership refusal
  `hermes_cli/backup.py:732-806`, `gateway/runtime_ownership.py:274`.
- `pm doctor` `pm/cli.py:422-470`, `pm repair` `:806-813`; `pm` dispatch `hermes_cli/main.py:679-683`; `hermes doctor` exit code
  `hermes_cli/doctor.py:171-194`. `gateway ensure` and the lifecycle helpers: see the template notes (`hermes_cli/gateway_runtime.py:390-495`).

Not verified: any run of the updater on a live host (fetch, dependency sync, fleet restart), what the next stable release changes, whether
the updater's quick snapshot succeeds on a real home, and everything after the update (inference, delivery).

Sources: v0.22.5 [update parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/update.py),
[backup parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/backup.py),
[import parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/import_cmd.py).
