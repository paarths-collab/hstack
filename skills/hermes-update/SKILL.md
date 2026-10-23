---
name: hermes-update
description: Inspect and explicitly opt into Hermes's native stable updater on an existing source installation, keeping an exact private backup and reporting version, runtime and delivery verification honestly.
---

# /hermes-update — use the installation owner's updater

Hermes v0.22.5 source installations use tested stable releases and PM dependency
generations. Use `hermes -p default update`; do not install a PyPI package over its launcher,
run `git reset`, or replace it with an installer tracking `main`. Desktop packages,
Store installs and Docker images have their own update owners and must use them.

This is an **opt-in compatibility-candidate workflow**, not promotion of hstack's
legacy runtime pin. Stable is an upstream release channel, not a promise to remain
on v0.22.5. Review the native plan and release notes before authorizing a channel update.
If an exact immutable version is required, do not pretend the updater has a `--version`
flag: use an explicitly reviewed fresh source installation and migration plan instead.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | Target and installation owner |
| `CANDIDATE_ACKNOWLEDGED=1` | Acknowledge unpromoted current-Hermes compatibility work |
| `ALLOW_STABLE_UPDATE=1` | Explicitly authorize the native stable-channel update after reviewing its plan |

## Step 0 — validate the target and define the remote helper

```bash
[ "${CANDIDATE_ACKNOWLEDGED:-0}" = 1 ] \
  || { echo "ABORT: current-Hermes compatibility candidate not acknowledged. Nothing was written."; exit 1; }
[[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo "ABORT: malformed SSH target. Nothing was written."; exit 1; }
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
```

## Step 1 — inspect before mutation

```bash
remote 'bash -s' <<'REMOTE' || { echo "ABORT: native updater inspection failed. Preserve this installation and inspect its upgrade path."; exit 1; }
set -e
whoami; hostname
H="$HOME/.local/bin/hermes"
[ -x "$H" ] && [ -d "$HOME/.hermes/hermes-agent/.git" ] \
  || { echo "ABORT: this recipe requires the default POSIX source installation; use the actual package/image owner." >&2; exit 1; }
"$H" -p default --version
"$H" -p default update --plan
"$H" -p default update --channel stable --check
REMOTE
```

Older versions may not support these flags. That is a migration boundary, not permission
to fall back to pip or a destructive reinstall. Inspect the official release-specific
upgrade path first. Do not force a downgrade or interrupt live work to get past a refusal.

## Step 2 — dry run and authorization gate

Explain that the native updater owns code/dependency preparation and fleet restart;
back up first, follow stable for this run, and verify afterwards. Stable may advance
beyond v0.22.5. Its selection does not promote that version into hstack's support matrix.

```bash
[ "${ALLOW_STABLE_UPDATE:-0}" = 1 ] \
  || { echo "ABORT: review the native plan and authorize ALLOW_STABLE_UPDATE=1 before applying. Nothing was changed by hstack."; exit 1; }
```

## Step 3 — keep an exact private recovery artifact, then update

```bash
remote 'bash -s' <<'REMOTE' || { echo "FAIL: update not confirmed. Keep the private update recovery directory and native updater diagnostics; no automatic downgrade was attempted."; exit 1; }
set -e
umask 077
H="$HOME/.local/bin/hermes"
p="$HOME/.hermes/.hstack-backup"
mkdir -p "$p"; chmod 700 "$p"
d=$(mktemp -d "$p/update-XXXXXX")
"$H" -p default --version > "$d/version-before.txt"
"$H" -p default backup --output "$d/pre-update.zip" --keep 0
[ -s "$d/pre-update.zip" ]; chmod 600 "$d/pre-update.zip"
printf 'Recovery artifact: %s\n' "$d/pre-update.zip"
"$H" -p default update --channel stable --backup --yes
"$H" -p default --version > "$d/version-after.txt"
"$H" -p default pm status
"$H" -p default doctor
"$H" -p default gateway ensure --json --timeout 60
printf 'Update command completed. Review version and live workflow checks before marking supported.\n'
cat "$d/version-after.txt"
REMOTE
```

`--channel stable` is a transient override; it does not silently change a custom install's
persisted channel. `--yes` handles the updater's migration prompts; it is not a force flag
and must not be combined with `--force-venv` to bypass its process guards.

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
/path/to/pre-update.zip`; inspect its overwrite prompt and stop live writers first. It is
not `hermes restore`, and restoring data does not restore the prior executable. Do not
blindly import the newest unrelated backup, force an old code version, or report
"rolled back" unless code, data and the actual workflow have been rechecked.


## Step 5 — classify the result before normal scheduling resumes

Use the narrowest status supported by the evidence:

| Result | Meaning | Next action |
|---|---|---|
| Plan/check failed | Native update path is not established | Preserve the install and inspect its owner/version |
| Backup failed | No checked recovery artifact exists | Abort before updating |
| Updater refused | A guard or unsupported migration blocked the change | Resolve the named condition without bypassing it |
| Code updated, doctor failed | Installation health is unresolved | Keep recovery state; use native diagnostics |
| Runtime ready, inference failed | The configured provider is not confirmed | Check provider identity/credentials without printing secrets |
| Inference passed, canary missing | Real workflow delivery is unknown | Keep scheduled activation under review |
| Intended canary observed | The tested workflow completed on this version | Record its actual scope; do not generalize to all integrations |

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
A compatibility candidate is distinct from the repository's promoted runtime pin.

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
| 10 | Assuming stable means hstack-promoted | Upstream and local promotion are separate | Keep candidate status and evidence explicit |

## Step 6 — evidence to report

Report the native update's before/after version and installation owner.
Report whether the private backup was verified before the change.
Report native PM, doctor and runtime readiness outcomes.
Report inference and workflow delivery outcomes separately.
Preserve unresolved errors and the exact recovery artifact.

## Definition of done

- [ ] Installation owner, native plan and stable-channel choice reviewed
- [ ] Exact private backup path recorded before update
- [ ] Native update completed without bypassing process/dependency guards
- [ ] Version, PM status, doctor and gateway readiness checked
- [ ] Inference command succeeded with exact expected output
- [ ] Intended connector and private-message delivery reverified, or explicitly unverified
- [ ] No pip mutation, moving-main installer, forced downgrade or invented restore command

Sources: v0.22.5 [update parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/update.py),
[backup parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/backup.py),
[import parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/import_cmd.py).
