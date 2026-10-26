---
name: hermes-memory
description: Inspect, switch off or prepare Hermes external memory with the native memory and plugin commands on Hermes 0.22.5, keeping provider dependencies under Hermes PM and never putting a provider key through SSH argv.
---

# /hermes-memory — native memory configuration

Built-in `MEMORY.md` / `USER.md` memory is bounded and remains active alongside an
external provider. External memory is additive, not a replacement for built-in memory.
Only one external provider is selected at a time. Do not describe memory as unlimited
or assume built-in memory is enabled on a deliberately minimal Blank Slate profile.

**Target: Hermes v0.22.5 only, source-verified and not live-verified.** Bundled providers are `retaindb` and `byterover`.
`honcho`, `hindsight`, `supermemory`, `mem0`, `openviking` and `holographic` are catalog plugins, installed with
`hermes plugins install <name>` (`hermes_cli/subcommands/memory.py:14-19`, `plugin-catalog/<name>.yaml`). Hermes PM prepares declared plugin
dependencies; do not install guessed packages such as `${PROVIDER}ai` into an ambient or guessed venv.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | Host and installation owner |
| `MODE` | `inspect` (default, read-only), `builtin` (external provider off), `external` (prepare a provider for attended setup) or `verify` (after the attended setup) |
| `PROVIDER` | For `external` and `verify`: `retaindb`, `byterover`, `honcho`, `hindsight`, `supermemory`, `mem0`, `openviking`, `holographic` |
| `DEPS_CONSENT=1` | For `external` with a catalog provider: you reviewed its declared dependencies and disclosure (the manifest in `plugin-catalog/<name>.yaml`) and consent to `plugins install --yes-deps` |
| `HERMES_VERSION` | Optional. If set it must be exactly `0.22.5` |

What each provider needs, from the v0.22.5 sources (the credential is entered by the human in native setup, never by this skill):

| Provider | Source | Declared credential or dependency |
|---|---|---|
| `retaindb` | bundled, `plugins/memory/retaindb` | `RETAINDB_API_KEY` (required), optional base URL and project |
| `byterover` | bundled, `plugins/memory/byterover` | the `brv` CLI (its manifest lists an install script, `curl -fsSL https://byterover.dev/install.sh \| sh`; this skill never runs it), optional `BRV_API_KEY` for cloud sync |
| `honcho` | catalog | `HONCHO_API_KEY` |
| `supermemory` | catalog | `SUPERMEMORY_API_KEY` |
| `hindsight`, `mem0`, `openviking`, `holographic` | catalog | the manifest declares none; their setup asks. Read the disclosure first: mem0 anonymous telemetry stays on unless `MEM0_TELEMETRY=false`, mem0 and OpenViking local modes start containers or a server that keeps running, hindsight local mode starts a background daemon, holographic is local SQLite |

Provider secrets are entered through native setup in an attended terminal. Do not ask
for them in chat or put them in command arguments, URLs, YAML, or shell snippets.

## Step 0 — helpers and validation (nothing is written)

```bash
SKILL_NAME=hermes-memory
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

# snapshot: copy ~/.hermes/.env and config.yaml aside BEFORE the first write.
# The snapshot dir doubles as the "run in progress" marker that rollback looks for.
snapshot() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
p="$HOME/.hermes/.hstack-backup"
d="$p/$SKILL_NAME"
# The active recovery point is published only after every artifact has been verified.
if [ -e "$d" ] || [ -L "$d" ]; then
  echo "snapshot: $d exists — a previous $SKILL_NAME run did not finish. Run rollback first (restores the state before that run), then re-run." >&2
  exit 1
fi
mkdir -p "$p" && chmod 700 "$p"
lock="$d.creating"
mkdir "$lock" 2>/dev/null || { echo "snapshot: another $SKILL_NAME snapshot is being created; retry after it finishes." >&2; exit 1; }
t=""
trap '[ -z "$t" ] || rm -rf "$t"; rmdir "$lock" 2>/dev/null || true' EXIT
[ ! -e "$d" ] && [ ! -L "$d" ] || { echo "snapshot: a recovery point appeared; nothing was written." >&2; exit 1; }
t=$(mktemp -d "$p/.snapshot-$SKILL_NAME.XXXXXX")
for f in .env config.yaml; do
  if [ -f "$HOME/.hermes/$f" ]; then
    cp -p "$HOME/.hermes/$f" "$t/$f"
    cmp -s "$HOME/.hermes/$f" "$t/$f"
    chmod 600 "$t/$f"
  elif [ -e "$HOME/.hermes/$f" ] || [ -L "$HOME/.hermes/$f" ]; then
    echo "snapshot: $f is not a readable regular file; nothing was written." >&2; exit 1
  else
    : > "$t/$f.absent"
    chmod 600 "$t/$f.absent"
  fi
done

for f in .env config.yaml; do
  for entry in "$f" "$f.absent"; do
    if [ -f "$t/$entry" ]; then cksum < "$t/$entry" > "$t/$entry.cksum"; chmod 600 "$t/$entry.cksum"; fi
  done
done
printf 'hstack-snapshot-v1\n' > "$t/.complete"
chmod 600 "$t/.complete"
mv "$t" "$d"
[ -f "$d/.complete" ] && [ ! -d "$t" ] || { echo "snapshot: recovery-point publication failed; nothing was written." >&2; exit 1; }
t=""
REMOTE
}
# rollback: restore the exact pre-skill .env + config.yaml (so a FORCE=1 re-run that
# fails puts the previous working value back), reload the gateway with gw_reload, then retire the snapshot.
rollback() {
  local rc=0
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE' || rc=$?
set -e
trap 'echo "rollback: restoration failed; active snapshot retained for recovery." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ ! -d "$d.creating" ] || { echo "rollback: snapshot creation is still in progress; retry later." >&2; exit 1; }
[ -d "$d" ] || { echo "rollback: no snapshot for $SKILL_NAME; nothing was written."; exit 10; }
# Incomplete legacy snapshots cannot prove that their final copy succeeded. Keep them for manual recovery.
[ -f "$d/.complete" ] && [ "$(cat "$d/.complete")" = hstack-snapshot-v1 ] \
  || { echo "rollback: snapshot is incomplete or legacy; active snapshot retained for manual recovery." >&2; exit 1; }
for f in .env config.yaml; do
  count=0
  for entry in "$f" "$f.absent"; do
    if [ -f "$d/$entry" ]; then
      count=$((count + 1))
      [ -f "$d/$entry.cksum" ] || { echo "rollback: missing checksum for $f; active snapshot retained for recovery." >&2; exit 1; }
      checksum=$(cksum < "$d/$entry")
      expected_checksum=$(cat "$d/$entry.cksum")
      [ "$checksum" = "$expected_checksum" ] \
        || { echo "rollback: corrupt backup for $f; active snapshot retained for recovery." >&2; exit 1; }
    fi
  done
  [ "$count" = 1 ] || { echo "rollback: missing or ambiguous backup for $f; active snapshot retained for recovery." >&2; exit 1; }
done
for f in .env config.yaml; do
  if [ -f "$d/$f" ]; then
    cp -p "$d/$f" "$HOME/.hermes/$f"
    cmp -s "$d/$f" "$HOME/.hermes/$f"
  elif [ -f "$d/$f.absent" ]; then
    rm -f "$HOME/.hermes/$f"
    [ ! -e "$HOME/.hermes/$f" ] && [ ! -L "$HOME/.hermes/$f" ] || { echo "rollback: file removal failed; active snapshot retained." >&2; exit 1; }
  else
    echo "rollback: missing backup for $f; active snapshot retained for recovery." >&2
    exit 1
  fi
done
[ -f "$HOME/.hermes/.env" ] && chmod 600 "$HOME/.hermes/.env"
exit 0
REMOTE
  [ "$rc" = 10 ] && return 0
  [ "$rc" = 0 ] || return "$rc"
  gw_reload >/dev/null \
    || { echo "rollback: files restored, but the gateway did NOT come back ready — active snapshot retained; inspect the gateway and retry rollback after resolving the fault" >&2; return 1; }
  finish || return 1
  echo "rollback: restored ~/.hermes/.env and config.yaml to their pre-$SKILL_NAME state."
}

# finish: mark the run successful; keep the snapshot as .prev for a manual undo.
finish() {
  remote "SKILL_NAME='$SKILL_NAME' bash -s" <<'REMOTE'
set -e
trap 'echo "finish: could not retire the active snapshot; inspect the recovery point before continuing." >&2' ERR
d="$HOME/.hermes/.hstack-backup/$SKILL_NAME"
[ -d "$d" ] || exit 0
rm -rf "$d.prev"
[ ! -e "$d.prev" ] && [ ! -L "$d.prev" ] || { echo "snapshot retirement: previous destination remains; active snapshot retained." >&2; exit 1; }
mv "$d" "$d.prev"
[ ! -e "$d" ] && [ ! -L "$d" ] && [ -f "$d.prev/.complete" ] || { echo "snapshot retirement: move could not be verified; inspect the recovery point." >&2; exit 1; }
REMOTE
}

MODE=${MODE:-inspect}
case "$MODE" in inspect|builtin|external|verify) ;; *) echo "ABORT: MODE must be inspect|builtin|external|verify. Nothing was written."; exit 1 ;; esac
if [ "$MODE" = external ] || [ "$MODE" = verify ]; then
  case "${PROVIDER:-}" in retaindb|byterover|honcho|hindsight|supermemory|mem0|openviking|holographic) ;;
    *) echo "ABORT: choose an available native/catalog memory provider. Nothing was written."; exit 1 ;;
  esac
fi
if [ "$MODE" = external ]; then
  case "$PROVIDER" in
    retaindb|byterover) ;;
    *) [ "${DEPS_CONSENT:-0}" = 1 ] \
         || { echo "ABORT: review plugin-catalog/$PROVIDER.yaml (dependencies, disclosure) and set DEPS_CONSENT=1 to install it. Nothing was written."; exit 1; } ;;
  esac
fi
[ -z "${HERMES_VERSION:-}" ] || [ "$HERMES_VERSION" = 0.22.5 ] \
  || { echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (HERMES_VERSION=$HERMES_VERSION). Nothing was written."; exit 1; }
[[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo "ABORT: malformed SSH target. Nothing was written."; exit 1; }
```

## Step 1 — inspect the actual provider

`memory status` prints the built-in toggles, `Provider:  <name>` (or `(none — built-in only)`), the provider's config, and for a configured
provider `Plugin:    installed ✓` and `Status:    available ✓` (or `not available ✗` with the missing variables)
(`hermes_cli/memory_setup.py:365-440`). It reads configuration; it does not write to or read from the remote store.

```bash
BANNER=$(remote 'hermes -p default --version') || { echo "ABORT: could not read the Hermes version. Nothing was written."; exit 1; }
printf '%s\n' "$BANNER" | grep -Eq '(^|[[:space:]])v?0[.]22[.]5([[:space:]]|$)' \
  || { echo "ABORT: this procedure is source-verified for Hermes 0.22.5 only (got: $BANNER). Nothing was written."; exit 1; }
remote 'hermes -p default memory status' \
  || { echo "FAIL: native memory status unavailable; inspect this version before changing providers. Nothing was written."; exit 1; }
if [ "$MODE" = inspect ]; then echo "Inspection complete. No provider was changed."; exit 0; fi
```

The v0.22.5 memory parser has `setup [provider]`, `status`, `off` and `reset`; there are no generic `memory write` or
`memory search` commands (`hermes_cli/subcommands/memory.py:21-33`).

## Step 2 — preserve a native backup (external mode)

The native archive also includes memory-provider state that lives outside `~/.hermes` but inside the home directory
(`hermes_cli/backup.py:571-587,661-665`). It is written outside `~/.hermes`, privately, with `--keep 0`; `hermes backup` exits 1 when the archive is
incomplete (`hermes_cli/main.py:2185-2192`).

```bash
if [ "$MODE" = external ]; then
  remote 'bash -s' <<'REMOTE' || { echo "FAIL: memory backup unavailable; nothing changed by this recipe."; exit 1; }
set -e
umask 077
art="$HOME/hermes-backup-hstack-pre-memory-$(date -u +%Y%m%dT%H%M%SZ).zip"
hermes -p default backup --output "$art" --keep 0
[ -s "$art" ]
chmod 600 "$art"
printf 'Recovery artifact: %s\n' "$art"
REMOTE
fi
```

## Step 3 — switch off, or prepare a provider

**builtin.** `memory off` sets `memory.provider` to the empty string in `config.yaml` and keeps the built-in notes
(`hermes_cli/main_agent_cmds.py:11-20`); it never calls `memory reset`, which erases `MEMORY.md` / `USER.md`
(`:23-57`). The change is a targeted `config.yaml` write, so it takes a `snapshot`, reloads the gateway with `gw_reload`
(new sessions read the provider when they start; a reload makes sure a gateway holding agents picks it up) and rolls back
on any failure.

```bash
if [ "$MODE" = builtin ]; then
  snapshot || { echo "ABORT: snapshot failed (if it says a previous run did not finish, run rollback first, then re-run). Nothing was written."; exit 1; }
  remote 'hermes -p default memory off' >/dev/null || { echo "FAIL: memory off."; rollback; exit 1; }
  gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready. Rolling back."; rollback; exit 1; }
  remote 'hermes -p default memory status' | grep -q '^  Provider:  (none' \
    || { echo "FAIL: memory status still names an external provider. Rolling back."; rollback; exit 1; }
  finish || exit 1
  echo "OK: external memory is off; built-in MEMORY.md / USER.md untouched."
fi
```

**external.** A catalog provider is installed with `--no-enable`: for a memory provider that only places the code and leaves it
inactive ("Memory provider installed but not active", `hermes_cli/plugins_cmd_install.py:724-731`), and `--yes-deps` answers the
dependency-consent question so a non-interactive session is not refused (`:592-598`); Step 0 requires `DEPS_CONSENT=1` before anything is written. Do not use it to bypass
a rejected dependency review. `plugins enable` cannot activate a memory provider (`:724-726`), so the activation is native setup, below.
Bundled providers need no install. A secret-bearing wizard cannot run in a session without a terminal, so this step ends with the exact
command for the attended terminal and a non-zero exit: external memory is not verified.

```bash
if [ "$MODE" = external ]; then
  case "$PROVIDER" in
    retaindb|byterover) echo "Bundled provider: nothing to install." ;;
    *)
      remote "hermes -p default plugins install '$PROVIDER' --yes-deps --no-enable" \
        || { echo "FAIL: plugin install refused or failed. Nothing is active; the backup above is untouched."; exit 1; } ;;
  esac
  echo "ACTION REQUIRED: in your attended terminal run: ssh -t $VPS_USER@$VPS_IP 'export PATH=\"\$HOME/.local/bin:\$PATH\"; hermes -p default memory setup $PROVIDER'"
  echo "External memory is NOT verified. After native setup completes, re-run with MODE=verify PROVIDER=$PROVIDER."
  exit 1
fi
```

In a noninteractive coding-agent session, show the native command and leave external
setup unverified. Do not start a wizard that cannot receive user input or invent an
unattended credential API. Native setup saves the activation (`memory.provider`) and any key to `.env`
itself (`hermes_cli/memory_setup.py:258-318`).

## Step 4 — reload and verify after the attended setup

`verify` reloads the gateway (nothing is written by this skill, so there is nothing to roll back) and then reads
`memory status`: the provider must be the one chosen and its status `available`. `available` means the configuration and credentials the
plugin declares are present; it is not a storage round trip.

```bash
if [ "$MODE" = verify ]; then
  gw_reload >/dev/null || { echo "FAIL: gateway did not restart ready (live sessions? see GW_INTERRUPT). Nothing was changed by this step."; exit 1; }
  MEM_STATUS=$(remote 'hermes -p default memory status') || { echo "FAIL: memory status unavailable."; exit 1; }
  printf '%s\n' "$MEM_STATUS" | grep -qx "  Provider:  $PROVIDER" \
    || { echo "FAIL: memory.provider is not $PROVIDER yet (native setup not completed?)."; printf '%s\n' "$MEM_STATUS"; exit 1; }
  printf '%s\n' "$MEM_STATUS" | grep -q '^  Plugin:    installed' \
    || { echo "FAIL: the $PROVIDER plugin is not installed."; printf '%s\n' "$MEM_STATUS"; exit 1; }
  printf '%s\n' "$MEM_STATUS" | grep -q '^  Status:    available' \
    || { echo "FAIL: $PROVIDER is selected but not available (missing credentials or dependencies)."; printf '%s\n' "$MEM_STATUS"; exit 1; }
  echo "OK: $PROVIDER is the configured memory provider and reports available. A storage canary is still a separate, authorized step."
fi
```

Use the provider's documented tools for an explicitly authorized canary if storage
verification is needed. A configured provider does not prove remote storage access.

## Rollback — preserve native recovery state

For `builtin`, `rollback` restores the exact pre-run `.env` and `config.yaml` and reloads the gateway; to undo a finished run, with the Step 0
functions loaded:

```bash
if remote "d=\$HOME/.hermes/.hstack-backup/$SKILL_NAME; [ -d \"\$d.prev\" ] && rm -rf \"\$d\" && mv \"\$d.prev\" \"\$d\""; then
  rollback
else
  echo "No .prev snapshot for $SKILL_NAME; nothing to undo."
fi
```

For `external`, keep the exact native backup and the working PM generation after a failure. Do not erase the previous provider's key or reset
built-in memory. Inspect the previous configuration; use native `hermes -p default memory setup <previous>` to select it again, or
`hermes -p default memory off`, or review a full `hermes -p default import <recorded-backup>` restore after stopping writers (a running
gateway makes `import` refuse, `hermes_cli/backup.py:800-806`). Report recovery only after checking provider state and the relevant workflow. Plugin
code and dependencies are managed by PM; `hermes -p default plugins remove <name>` removes a plugin (`hermes_cli/subcommands/plugins.py:122`), not a hand-written `.env` deletion.

## Step 5 — distinguish configured memory from verified storage

Memory configuration has several independent boundaries:

1. The plugin code is installed from a reviewed native catalog entry.
2. PM has prepared the declared dependencies for this installation.
3. Native setup selected the intended external provider (`memory.provider`).
4. The provider's required credentials are available in the active profile.
5. Native memory status reports that configuration without an initialization error.
6. A provider-specific, explicitly authorized canary proves the desired storage behavior.

Do not collapse those boundaries into one success message.
A plugin on disk may still be inactive.
A configured provider may still reject requests at runtime.
A status command may not perform a remote storage operation.
A successful memory write is not proof that the agent will retrieve the right note later.
A retrieval test must use the selected provider and profile, not another user's memory.
Keep smoke content non-sensitive and remove it only through the provider's documented API.
Do not invent a generic deletion command or erase built-in notes to clean up a test.

### Built-in and external memory coexist

Built-in notes are a separate local store.
Switching the external provider does not imply deleting those notes.
`memory off` disables the external selection and keeps built-in notes.
`memory reset` is destructive and is outside this configuration recipe.
External providers can receive conversation-derived material according to their integration.
Review what is sent, retained and shared before enabling a cloud provider.
Use separate profiles for assistants that need different memory identities.
Do not copy single-use OAuth credentials between profiles as a memory shortcut.
Changing a provider can leave old remote data intact under that provider's account.
Disabling a provider is not a request to delete that data.

### Headless and attended boundaries

The coding agent can inspect state and prepare an authorized catalog install.
A native wizard that needs secret input belongs in the user's attended terminal.
Do not collect provider secrets in this chat to evade that boundary.
Do not echo a copied setup command containing a secret.
Do not store the secret in a shell history command.
If the current plugin requires additional setup, follow its reviewed documentation.
If setup cannot be completed, keep external memory explicitly unverified.
The default inspect mode is safe to rerun and does not change providers.

## Pitfalls

| # | Pitfall | Why it bites | Prevention |
|---|---|---|---|
| 1 | Guessing `${PROVIDER}ai` as a package name | Provider packaging changed to plugins | Use native reviewed catalog/PM installation |
| 2 | Searching for an old venv | Managed generations have different ownership | Use native commands and PM diagnostics |
| 3 | Passing an API key inside SSH argv | It can leak through process listings | Use native attended secret entry |
| 4 | Treating external memory as replacement | Built-in notes remain a separate store | Explain additive behavior |
| 5 | Using `memory reset` to switch providers | It erases built-in notes | Use native setup/off only |
| 6 | Claiming `memory status` proves storage | Status reads configuration and `is_available()` only | Run an authorized provider-specific canary |
| 7 | Inventing `memory write/search` | Those generic verbs are absent in the parser | Use the provider's documented tools |
| 8 | Using `plugins enable <memory provider>` to activate it | `plugins enable` cannot activate a memory provider; activation is `memory.provider` | `memory setup <provider>` (attended), or `plugins install --enable` |
| 9 | Deleting the old key during recovery | It may still be needed to recover old state | Preserve the native backup and previous provider |
| 10 | Sharing one home between independent agents | Their notes and sessions can mix | Use native profiles and explicit provider identity |
| 11 | Running a manifest's install script (`curl ... \| sh`) for a provider | It executes remote code on the host | Show it to the user; never run it from this skill (ByteRover's `brv`) |
| 12 | `--yes-deps` as a default | It answers the dependency-consent question for the user | Require `DEPS_CONSENT=1` after the manifest review |
| 13 | A gateway reload refused by live sessions | `restart` refuses without a terminal when chats are live | Report it; `GW_INTERRUPT=1` only if interrupting them is acceptable |

## Step 6 — evidence to report

Name the profile and selected provider without printing credentials.
Distinguish bundled and catalog-installed provider code.
State whether native setup and PM preparation completed.
State what memory status actually checked.
State whether a remote storage/retrieval canary was authorized and observed.
Keep missing canary evidence explicitly unverified.
State that this procedure was source-verified, not run against a live host.
Retain the exact backup path for the provider change.

## Definition of done

- [ ] `HERMES_VERSION` unset or `0.22.5`; the host's version banner names 0.22.5
- [ ] Native memory status inspected; default inspection made no provider changes
- [ ] Provider change explicitly chosen and private native backup retained (external) or snapshot taken (builtin)
- [ ] External dependencies handled by catalog/PM after `DEPS_CONSENT=1`, not ambient pip
- [ ] Secrets entered only through native setup, never SSH argv or chat
- [ ] Built-in notes preserved; no `memory reset` used
- [ ] Gateway reloaded with `gw_reload` (ready, new instance) and `memory status` names the provider as available (or `(none — built-in only)` for builtin)
- [ ] Remote storage canary verified separately, or explicitly still unverified

## Verified against Hermes v0.22.5

Source-verified at tag v0.22.5 (commit `bf0203a794a07aac3ff764972ab9087baa4e4f4e`); paths are relative to that repository.

- `memory setup [provider]`, `status`, `off`, `reset [--yes] [--target]`: `hermes_cli/subcommands/memory.py:10-34`; dispatch, `off` and `reset`:
  `hermes_cli/main_agent_cmds.py:11-68`; `setup <provider>` and the interactive wizard (activation in `memory.provider`, dependencies through PM, "Start a
  new session to activate"): `hermes_cli/memory_setup.py:177-201,258-318`; `status` strings: `:365-440`; routing: `:442-460`.
- `plugins install IDENT [--force] [--ref] [--no-deps|--yes-deps] [--enable|--no-enable]`: `hermes_cli/subcommands/plugins.py:18-47`; consent and
  memory-provider selection semantics `hermes_cli/plugins_cmd_install.py:576-700,724-761`; the install hint `hermes plugins install <name>`
  `hermes_cli/memory_provider_migration.py:110-152`.
- Providers: bundled `plugins/memory/retaindb/plugin.yaml` and `__init__.py:320-326` (`RETAINDB_API_KEY`), `plugins/memory/byterover/plugin.yaml` and
  `__init__.py:166-170` (`BRV_API_KEY`, `brv`); catalog entries `plugin-catalog/{honcho,hindsight,supermemory,mem0,openviking,holographic}.yaml`
  (`requires_env`: `HONCHO_API_KEY`, `SUPERMEMORY_API_KEY`, the others none).
- Backup includes memory-provider files kept outside `~/.hermes`: `hermes_cli/backup.py:571-587`; exit status `hermes_cli/main.py:2185-2192`.
- Gateway helpers: see `/hermes-deploy` (`hermes_cli/gateway_runtime.py:390-495`, `hermes_cli/gateway_lifecycle_guards.py:97-129`).

Not verified: any run of setup or install against a live host, each provider's own wizard prompts and defaults, that a running gateway needs the reload
to pick up `memory.provider` (it is done as a precaution), and any remote storage behavior.

Sources: [v0.22.5 memory parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/memory.py),
[plugin parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/plugins.py),
[memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).
