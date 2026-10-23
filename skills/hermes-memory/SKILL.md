---
name: hermes-memory
description: Inspect Hermes built-in and external memory using the native memory/plugin commands, keeping provider dependencies under Hermes PM and never guessing a venv or leaking a provider key through SSH argv.
---

# /hermes-memory — native memory configuration

Built-in `MEMORY.md` / `USER.md` memory is bounded and remains active alongside an
external provider. External memory is additive, not a replacement for built-in memory.
Only one external provider is selected at a time. Do not describe memory as unlimited
or assume built-in memory is enabled on a deliberately minimal Blank Slate profile.

Current Hermes bundles RetainDB and ByteRover. Honcho, Hindsight, Supermemory, Mem0,
OpenViking and Holographic are catalog plugins. Hermes PM prepares declared plugin
dependencies; do not install guessed packages such as `${PROVIDER}ai` into an ambient
or guessed venv. Historical dependency workarounds are not evidence about v0.22.5.

## Before you start — gather once

| Variable | Meaning |
|---|---|
| `VPS_IP`, `VPS_USER` | Host and installation owner |
| `MODE` | `inspect` (default), explicit `builtin`, or `external` |
| `PROVIDER` | For external: `retaindb`, `byterover`, `honcho`, `hindsight`, `supermemory`, `mem0`, `openviking`, `holographic` |

Provider secrets are entered through native setup in an attended terminal. Do not ask
for them in chat or put them in command arguments, URLs, YAML, or shell snippets.

## Step 0 — validate without writing

```bash
MODE=${MODE:-inspect}
case "$MODE" in inspect|builtin|external) ;; *) echo "ABORT: MODE must be inspect|builtin|external."; exit 1 ;; esac
if [ "$MODE" = external ]; then
  case "${PROVIDER:-}" in retaindb|byterover|honcho|hindsight|supermemory|mem0|openviking|holographic) ;;
    *) echo "ABORT: choose an available native/catalog memory provider."; exit 1 ;;
  esac
fi
[[ "$VPS_IP" =~ ^[A-Za-z0-9._:-]+$ && "$VPS_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo "ABORT: malformed SSH target."; exit 1; }
remote() { ssh -o BatchMode=yes "$VPS_USER@$VPS_IP" "export PATH=\"\$HOME/.local/bin:\$PATH\"; $*"; }
```

## Step 1 — inspect the actual provider

```bash
remote 'hermes -p default --version && hermes -p default memory status' \
  || { echo "FAIL: native memory status unavailable; inspect this version before changing providers."; exit 1; }
if [ "$MODE" = inspect ]; then echo "Inspection complete. No provider was changed."; exit 0; fi
```

`memory status` reports configuration and provider state; it is not a proof of remote
storage write/read behavior. The v0.22.5 memory parser has `setup`, `status`, `off`, and
`reset`; there are no generic `memory write` or `memory search` commands.

## Step 2 — preview and preserve a native backup

For `builtin`, disable only the external provider with `memory off`; never use `memory
reset`, which erases the user's built-in notes. For `external`, review the catalog
plugin's declared capabilities, dependencies, privacy policy and provider-specific setup.
Proceed within the user's existing provider-change authorization.

```bash
remote 'bash -s' <<'REMOTE' || { echo "FAIL: memory backup unavailable; nothing changed by this recipe."; exit 1; }
set -e
umask 077
p="$HOME/.hermes/.hstack-backup"
mkdir -p "$p"; chmod 700 "$p"
d=$(mktemp -d "$p/memory-XXXXXX")
hermes -p default backup --output "$d/pre-memory.zip" --keep 0
[ -s "$d/pre-memory.zip" ]; chmod 600 "$d/pre-memory.zip"
printf 'Recovery artifact: %s\n' "$d/pre-memory.zip"
REMOTE
```

## Step 3 — use native configuration

```bash
if [ "$MODE" = builtin ]; then
  remote 'hermes -p default memory off && hermes -p default memory status' || exit 1
else
  # The identifier was allowlisted. Install catalog providers disabled until native
  # attended setup and capability/dependency review are complete.
  case "$PROVIDER" in
    retaindb|byterover) ;;
    *) remote "hermes -p default plugins install '$PROVIDER' --yes-deps --no-enable" || exit 1 ;;
  esac
  printf 'ACTION REQUIRED: in your attended terminal run: ssh -t %s@%s '\''export PATH="$HOME/.local/bin:$PATH"; hermes -p default memory setup %s'\''\n' "$VPS_USER" "$VPS_IP" "$PROVIDER"
  echo "External memory is not verified. Complete native setup and check memory status before continuing."
  exit 1
fi
```

Dependency installation requires the user's provider selection and consent. Do not use
`--yes-deps` to bypass a rejected dependency review. If enabling the chosen catalog
plugin is required, use `hermes -p default plugins enable <provider>` after reviewing its native
capabilities; do not grant tool-override permissions just to make setup pass.

In a noninteractive coding-agent session, show the native command and leave external
setup unverified. Do not start a wizard that cannot receive user input or invent an
unattended credential API. After the human completes setup, run Step 4 separately.

## Step 4 — reload only when the provider change is complete, then verify

```bash
remote 'hermes -p default gateway stop && hermes -p default gateway ensure --json --timeout 60 && hermes -p default memory status' \
  || { echo "FAIL: provider/runtime not confirmed. Preserve the recorded backup and inspect native diagnostics."; exit 1; }
```

Use the provider's documented tools for an explicitly authorized canary if storage
verification is needed. A configured provider does not prove remote storage access.

## Rollback — preserve native recovery state

Keep the exact native backup and working PM generation after a failure. Do not erase the
previous provider's key or reset built-in memory. Inspect the previous configuration;
use native `hermes -p default memory setup` to select it again, or review a full `hermes -p default import
<recorded-backup>` restore after stopping writers. Report recovery only after checking
provider state and the relevant workflow. Plugin code/dependencies are managed by PM,
not reverted by a hand-written `.env` deletion.


## Step 5 — distinguish configured memory from verified storage

Memory configuration has several independent boundaries:

1. The plugin code is installed from a reviewed native catalog entry.
2. PM has prepared the declared dependencies for this installation.
3. The plugin is enabled with the capabilities the user reviewed.
4. Native setup selected the intended external provider.
5. The provider's required credentials are available in the active profile.
6. Native memory status reports that configuration without an initialization error.
7. A provider-specific, explicitly authorized canary proves the desired storage behavior.

Do not collapse those boundaries into one success message.
A plugin on disk may still be disabled.
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
Do not grant tool override just because plugin activation asks about capabilities.
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
| 6 | Claiming `memory status` proves storage | Status may only inspect configuration | Run an authorized provider-specific canary |
| 7 | Inventing `memory write/search` | Those generic verbs are absent in the parser | Use the provider's documented tools |
| 8 | Enabling a plugin before reviewing scope | The plugin runs with host authority | Review capabilities and dependency consent |
| 9 | Deleting the old key during recovery | It may still be needed to recover old state | Preserve the native backup and previous provider |
| 10 | Sharing one home between independent agents | Their notes and sessions can mix | Use native profiles and explicit provider identity |

## Step 6 — evidence to report

Name the profile and selected provider without printing credentials.
Distinguish bundled and catalog-installed provider code.
State whether native setup and PM preparation completed.
State what memory status actually checked.
State whether a remote storage/retrieval canary was authorized and observed.
Keep missing canary evidence explicitly unverified.
Retain the exact backup path for the provider change.

## Definition of done

- [ ] Native memory status inspected; default inspection made no provider changes
- [ ] Provider change explicitly chosen and private native backup retained
- [ ] External dependencies handled by catalog/PM, not ambient pip
- [ ] Secrets entered only through native setup, never SSH argv or chat
- [ ] Built-in notes preserved; no `memory reset` used
- [ ] Native runtime readiness and memory status checked
- [ ] Remote storage canary verified separately, or explicitly still unverified

Sources: [v0.22.5 memory parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/memory.py),
[plugin parser](https://github.com/NousResearch/hermes-agent/blob/v0.22.5/hermes_cli/subcommands/plugins.py),
[memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers).
