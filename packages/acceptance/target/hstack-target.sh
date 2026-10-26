#!/usr/bin/env bash
# hstack-target.sh <op> [args]  --  the target-side half of the hstack "acceptance transaction".
#
# Runs ON the VPS (Linux, bash). Also runs on macOS /bin/bash 3.2 so the sandbox tests can
# execute the very same file. No dependencies beyond coreutils-ish tools (awk, sed, grep, find,
# tar, sha256sum|shasum, stat, cp, mv). The candidate native adapter also needs Python 3
# (stdlib only). No `eval`, no mapfile, no associative arrays.
#
# What it manages: ONE reversible transaction over ~/.hermes: a few .env keys, a few skill
# directories, and idempotent cron entries marked `[hstack:<id>]`. Everything else (unrelated
# env keys, skills, cron entries, config.yaml) is never written, and restore refuses to
# overwrite anything the user changed after apply.
#
# HONESTY: legacy recovery retains the small declared surface
#   hermes --version | cron list|create|remove | gateway restart
# (`cron list` is assumed to print one job per line: <id> TAB <schedule> TAB <prompt>).
# That surface is UNVERIFIED against real Hermes; the test double is tests/acceptance/stubs/hermes.
# Candidate v0.22.5 uses a bundled, version-specific structured jobs.json reader and native
# CLI writes, explicitly bound to HERMES_HOME and --profile default. Its gateway reload is
# limited to an exclusive default profile with an installed systemd service and validated
# readiness identity. Candidate status is not production promotion or live delivery proof.
# This script never runs `hermes doctor` or any `--fix`.
#
# Layout (HSTACK_HOME defaults to $HOME):
#   $HSTACK_HOME/.hermes/.env  config.yaml  skills/<name>/
#   $HSTACK_HOME/.hermes/.hstack/managed-skills.tsv   name TAB sha256 TAB txn TAB time
#   $HSTACK_HOME/.hermes/.hstack/txn/<txn>/           (dir 700, files 600, umask 077)
# Native snapshots and immutable intent plans are private JSON files within that transaction;
# the shell and Python adapter are shipped as one reviewed, content-addressed artifact.
# hermes binary: $HSTACK_HOME/.local/bin/hermes if executable, else `hermes` on PATH, else absent.
#
# Output: `key=value` lines on stdout (single line values, NEVER a secret value). On a non-zero
# exit it prints `error=<code>` and `detail=<non-secret text>` (also one line on stderr).
# Secrets/values arrive on stdin only; nothing secret is ever put in argv or a child's environment.
#
# Skill ownership (IMPORTANT): this script owns a skill dir only if it is listed in
# managed-skills.tsv AND its content hash still matches. Skill dirs it installs carry the marker
# file `.hstack-acceptance` (content `txn=<id>`). It never reads or writes `.hstack-managed`, which
# is the SEPARATE marker (a content checksum) used by the hstack installers. Dirs that carry the
# installer's marker, or no marker, are "foreign" to this script: a same-named dir is a collision
# (exit 5), never adopted automatically. Conversely the installers will see an acceptance-installed
# dir as not theirs; use one mechanism per skill name. Tar members named `.hstack-acceptance` or
# `.hstack-managed` are rejected.
#
# Secrets at rest on the target: txn/<id>/env.bak holds the PREVIOUS secret values (needed for
# rollback) at mode 600 until `purge`. txn/<id>/env.staged holds the NEW values and is deleted as soon
# as `apply` succeeds and when `restore` completes. commit/restore print
# `secrets_retained=env.bak` (file names only). `purge` removes the whole txn dir, env.bak included.
#
# restore NEVER reloads the gateway: after a restore the running gateway may still hold the old
# configuration. restore prints `gateway_reloaded=0`; call `reload <txn>` (allowed in state restored).
#
# PATH: the script puts /usr/bin:/bin:/usr/sbin:/sbin FIRST for its own tools, so a user-writable
# dir (~/.local/bin, put in front of PATH by the caller so hermes is found) cannot shadow
# sha256sum, awk, tar ... Only hermes is resolved from ~/.local/bin (absolute path) or the rest of PATH.
#
# Exit codes: 0 ok | 1 failure | 2 usage/validation | 3 precondition conflict (nothing changed)
#             | 4 blocked: incompatible/unknown target or an earlier incomplete txn (nothing
#               changed) | 5 skill collision (nothing changed)
# Exit 1 with error=backup_missing|backup_corrupt means the recovery point is unusable.
# Exit 3 error=restore_conflict carries `conflict=env:KEY,config,cron:id,skill:name,manifest`.
# Other exit-3 errors (not_applied, txn_not_final, skills_already_synced, changed_since_backup,
# already_staging_closed) are ordering/drift preconditions; nothing was changed.
#
# Ops
#   inspect
#     STRICTLY READ-ONLY (creates no file/dir, even when ~/.hermes is absent; no here-docs).
#     Runs only `hermes --version` and `hermes cron list`. Emits: hermes_present=1|0,
#     runtime_version=<x.y.z|unknown>, runtime_evidence=measured|unknown, os, os_id,
#     os_version_id, arch, service_manager=systemd|none|unknown (from /run/systemd/system; no
#     systemctl), env_file=present|absent, env_keys=NAMES only, env_perm=<octal>|absent,
#     config_fingerprint=<16 hex>|absent, cron_managed_ids, cron_other_count (or `unknown`),
#     skills_unmanaged, skills_unmanaged_unlisted, skills_managed=name:sha256,...,
#     skills_managed_modified, txn_incomplete, diagnostics=unknown (hstack never runs doctor).
#     Missing evidence is `unknown`, never a guess. Version policy is the caller's.
#   backup <txn> --keys K1,K2 [--allow K1,K2]
#     Exit 4 if another txn has no done/restored marker (error=incomplete_transaction, detail=<id>),
#     if hermes is absent or `cron list` fails (runtime_unavailable), or .env is a symlink/non-file.
#     Builds txn/<txn> (atomically, via a temp dir): env.bak|env.absent, config.bak|.absent
#     (cp -p, then chmod 600; original modes live in `meta`), cron.before (all marked lines),
#     manifest.bak|.absent, meta, prior.keys, unrelated.base, unrelated.skills, integrity (sha256 of each).
#     Emits backup_handle=bk_<txn>, txn, env_state, env_mode, prior_keys=K:present|absent,...
#   put-env <txn> <KEY> --allow K1,K2      (value: ONE line on stdin, [A-Za-z0-9_.:/=+,@-], <=4096)
#     KEY must be in --allow AND in the txn's --keys. Upserts into the STAGED copy only: replaces ALL
#     lines for KEY by one (at the first occurrence, else appended), keeps other lines verbatim,
#     guarantees newline separation. Emits staged_key=KEY, previous=present|absent.
#   stage-check <txn>
#     staged env has each staged key exactly once, is mode 600, and no staged value of length >= 8
#     appears in the live (or staged) config.yaml. Emits stage_ok=1, staged_keys=... or exit 1.
#   skills-sync <txn> --names a,b          (tar on stdin; at most once per txn)
#     Validates every tar member (no ../abs paths, no links/devices, top level = --names, SKILL.md
#     present), then checks ALL names before touching anything: on disk but not in manifest -> exit 5
#     (collisions=...); managed but disk sha != manifest sha -> exit 3 managed_skill_modified.
#     Then writes the plan + `applying` marker (write-ahead), installs by rename (replaced managed dirs
#     move to txn/skills.replaced/<name>), writes .hstack-acceptance markers, updates the manifest.
#     Emits skill_<name>=created|updated|unchanged, skills_changed=N. Identical content => unchanged
#     and NOTHING is written (no backup churn, manifest untouched).
#   apply <txn> [--cron 'id|schedule|prompt']...
#     Exit 3 changed_since_backup if live env/config/manifest differ from backup time (this txn's own
#     previous apply/skills-sync results are accepted, so apply is re-runnable). Writes `applying`
#     (write-ahead), swaps the staged env in (same-dir temp + mv; original owner kept; mode
#     600), then ensures each cron entry idempotently keyed on the marker `[hstack:<id>]`
#     (absent -> create, identical -> unchanged, different -> create new then remove old = updated;
#     entries WITHOUT the marker are never touched), then writes `applied`. If the prompt lacks the
#     marker the script PREFIXES it. Emits env_swapped=0|1, cron_<id>=created|unchanged|updated, applied=1.
#   reload <txn> [--interrupt-live-sessions]   (needs applied or restored)
#     Legacy (0.15.2): `gateway restart` (there is no `gateway run --daemon` and no -y, --detach or `ensure` at that
#     release), then a HSTACK_RELOAD_DELAY pause; the flag has no meaning there and is ignored.
#     Native (0.22.5): exclusive-default service check; remember the current instance_id (`gateway ensure --json
#     --timeout 10`); `gateway restart --detach` (plus `-y` only with --interrupt-live-sessions: without it Hermes
#     refuses while sessions are live and the reload FAILS, naming restart_refused_or_failed); then `gateway ensure
#     --json --timeout 60` must exit 0 (5/6 retried twice) with state ready AND a different instance_id.
#     Emits reloaded=1 only after the command (legacy) or that readiness proof (native).
#   verify <txn> --destination-fp <16hex> --allow-var VAR --dest-var VAR --cron-id ID --schedule 'S'
#          [--skills a,b]
#     TARGET-STATE checks only (delivery is NOT checked here). Emits, for each of env-boundary,
#     schedule-single, managed-skills-intact, unrelated-state-unchanged:
#     check.<id>=pass|fail|unknown and check.<id>.detail=...; plus apply_marker=applied|applying.
#     Exit 0 whenever the checks ran; callers read the statuses.
#   restore <txn>
#     `restored` marker present -> already_restored=1. Else FIRST checks every precondition modifying
#     nothing: each managed key's current signature must equal its post- or prior-signature; config.yaml
#     sha in {backup}; own cron entries unchanged; managed skills at post or prior state; manifest at
#     post or backup. Any mismatch -> exit 3 restore_conflict + conflict=NAMES, nothing modified.
#     Missing/corrupt backup -> exit 1. Otherwise restores ONLY managed keys (previous line(s) taken
#     verbatim from env.bak, never printed; keys that did not exist are deleted), removes own cron
#     entries (re-creating any it replaced), removes created skills / moves replaced ones back,
#     restores the manifest, re-verifies against the recorded hashes (restore_verified=1, else exit 1)
#     and writes `restored`. Unrelated keys/skills/cron entries changed meanwhile are left alone.
#     The backup is kept.
#   commit <txn>   needs `applied`; writes `done`; keeps the backup.
#   purge <txn>    needs done/restored; rm -rf of that txn dir only.

set -u
umask 077
LC_ALL=C
export LC_ALL
# Native inspection must not create Python bytecode caches in an otherwise untouched home.
export PYTHONDONTWRITEBYTECODE=1
IFS=$' \t\n'
unset CDPATH BASH_ENV ENV 2>/dev/null || true
PATH=/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}
export PATH

# ----------------------------------------------------------------------------------------------
# output / failure
# ----------------------------------------------------------------------------------------------
sanitize() { printf '%s' "$1" | tr -d '\000-\037\177'; }

out() {
  local v
  v=$(sanitize "$2")
  printf '%s=%s\n' "$1" "$v"
}

fail() { # <exit-code> <error-code> [detail]  -- main shell only (never inside $( ))
  local code=$1 err=$2 detail=${3:-}
  out error "$err"
  out detail "$detail"
  printf 'hstack-target: %s: %s\n' "$err" "$(sanitize "$detail")" >&2
  exit "$code"
}

usage() { fail 2 usage "$1"; }

# ----------------------------------------------------------------------------------------------
# globals / cleanup
# ----------------------------------------------------------------------------------------------
HOME_DIR="" HERMES_DIR="" STATE="" ENV_FILE="" CFG_FILE="" SKILLS_DIR="" MANIFEST=""
HERMES=""
ADAPTER=legacy-v1 NATIVE_OUT=""
TXN="" TXN_ID=""
LOCK_HELD=0
TMP_PATHS=()
LIST_OUT=()

cleanup() {
  local p
  for p in ${TMP_PATHS[@]+"${TMP_PATHS[@]}"}; do rm -rf "$p"; done
  if [ "$LOCK_HELD" = 1 ] && [ -n "$STATE" ]; then rm -rf "$STATE/lock.d"; fi
}
trap cleanup EXIT
trap 'exit 130' INT HUP
trap 'exit 143' TERM

register_tmp() { TMP_PATHS[${#TMP_PATHS[@]}]=$1; }

# ----------------------------------------------------------------------------------------------
# portable primitives
# ----------------------------------------------------------------------------------------------
SAFE_PATH=/usr/bin:/bin:/usr/sbin:/sbin
if [ -n "$(PATH=$SAFE_PATH command -v sha256sum 2>/dev/null)" ]; then
  sha_stdin() { sha256sum | cut -d' ' -f1; }
elif [ -n "$(PATH=$SAFE_PATH command -v shasum 2>/dev/null)" ]; then
  sha_stdin() { shasum -a 256 | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha_stdin() { sha256sum | cut -d' ' -f1; }
else
  sha_stdin() { shasum -a 256 | cut -d' ' -f1; }
fi

sha_file() { # hex sha256 of a regular file, or return 1
  local h
  [ -f "$1" ] && [ -r "$1" ] || return 1
  h=$(sha_stdin < "$1")
  [ "${#h}" -eq 64 ] || return 1
  printf '%s' "$h"
}

sha_or_absent() { # file sha, or `absent`, or `unreadable`
  if [ -e "$1" ] || [ -L "$1" ]; then sha_file "$1" || printf 'unreadable'; else printf 'absent'; fi
}

str_sha() { printf '%s' "$1" | sha_stdin; }

file_mode() { # octal permission bits. GNU stat first: on Linux `stat -f` means *filesystem* status.
  local m
  m=$(stat -c %a "$1" 2>/dev/null) || m=$(stat -f %Lp "$1" 2>/dev/null) || return 1
  case $m in *[!0-7]*|'') return 1 ;; esac
  printf '%s' "$m"
}

file_owner() {
  local o
  o=$(stat -c %U:%G "$1" 2>/dev/null) || o=$(stat -f %Su:%Sg "$1" 2>/dev/null) || return 1
  printf '%s' "$o"
}

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ----------------------------------------------------------------------------------------------
# validation (every argument; newline-bearing values are rejected before any regex)
# ----------------------------------------------------------------------------------------------
nonl() { case $1 in *$'\n'*|*$'\r'*|*$'\t'*) return 1 ;; esac; return 0; }

valid_txn() {
  local re='^[a-z0-9]{8,32}$'
  nonl "$1" && [[ $1 =~ $re ]]
}
valid_key() {
  local re='^[A-Z][A-Z0-9_]*$'
  nonl "$1" && [ "${#1}" -le 64 ] && [[ $1 =~ $re ]]
}
valid_skill() {
  local re='^[a-z0-9][a-z0-9-]*$'
  nonl "$1" && [ "${#1}" -le 64 ] && [[ $1 =~ $re ]]
}
valid_cronid() {
  local re='^[a-z0-9-]+$'
  nonl "$1" && [ "${#1}" -le 64 ] && [[ $1 =~ $re ]]
}
valid_jobid() { # ids reported by `hermes cron list`; never starts with '-'
  local re='^[A-Za-z0-9][A-Za-z0-9_.:-]*$'
  nonl "$1" && [ "${#1}" -le 64 ] && [[ $1 =~ $re ]]
}
valid_schedule() {
  local re='^[0-9*/, -]+$' re2='[0-9*]'
  nonl "$1" && [ "${#1}" -le 100 ] && [[ $1 =~ $re ]] && [[ $1 =~ $re2 ]] && [ "${1#-}" = "$1" ]
}
valid_prompt() {
  local re='^[][A-Za-z0-9 _.,:=+@%/|*()#!?-]+$'
  nonl "$1" && [ "${#1}" -le 1000 ] && [[ $1 =~ $re ]] && [ "${1#-}" = "$1" ]
}
valid_fp() {
  local re='^[0-9a-f]{16}$'
  nonl "$1" && [[ $1 =~ $re ]]
}

parse_csv() { # <csv> <validator-fn> -> LIST_OUT; returns 1 on empty/invalid/duplicate items
  local csv=$1 v=$2 rest item x
  LIST_OUT=()
  nonl "$csv" || return 1
  case $csv in ''|,*|*,|*,,*) return 1 ;; esac
  rest=$csv,
  while [ -n "$rest" ]; do
    item=${rest%%,*}
    rest=${rest#*,}
    "$v" "$item" || return 1
    for x in ${LIST_OUT[@]+"${LIST_OUT[@]}"}; do
      [ "$x" = "$item" ] && return 1
    done
    LIST_OUT[${#LIST_OUT[@]}]=$item
  done
  return 0
}

join_csv() { # args -> comma list
  local r="" x
  for x in "$@"; do r=$r${r:+,}$x; done
  printf '%s' "$r"
}

in_list() { # <needle> <items...>
  local n=$1 x
  shift
  for x in "$@"; do [ "$x" = "$n" ] && return 0; done
  return 1
}

# ----------------------------------------------------------------------------------------------
# paths, hermes, locking
# ----------------------------------------------------------------------------------------------
init_paths() {
  local h=${HSTACK_HOME:-${HOME:-}}
  [ -n "$h" ] || usage "HSTACK_HOME/HOME not set"
  case $h in /*) ;; *) usage "HSTACK_HOME must be an absolute path" ;; esac
  case $h in *\\*|*$'\n'*|*$'\r'*|*$'\t'*|*..*) usage "HSTACK_HOME has forbidden characters" ;; esac
  while [ "${#h}" -gt 1 ] && [ "${h%/}" != "$h" ]; do h=${h%/}; done
  HOME_DIR=$h
  HERMES_DIR=$h/.hermes
  STATE=$HERMES_DIR/.hstack
  ENV_FILE=$HERMES_DIR/.env
  CFG_FILE=$HERMES_DIR/config.yaml
  SKILLS_DIR=$HERMES_DIR/skills
  MANIFEST=$STATE/managed-skills.tsv
  # This workflow owns only the default profile at this explicit home. Never inherit a
  # caller's selected profile and accidentally read or mutate a different Hermes instance.
  export HERMES_HOME="$HERMES_DIR"
  unset HERMES_PROFILE 2>/dev/null || true
}

resolve_hermes() {
  HERMES=""
  if [ -x "$HOME_DIR/.local/bin/hermes" ] && [ ! -d "$HOME_DIR/.local/bin/hermes" ]; then
    HERMES=$HOME_DIR/.local/bin/hermes
  else
    HERMES=$(command -v hermes 2>/dev/null) || HERMES=""
    case $HERMES in /*) ;; *) HERMES="" ;; esac
  fi
}

run_hermes() { "$HERMES" "$@" </dev/null 2>/dev/null; }

native_adapter() {
  command -v python3 >/dev/null 2>&1 || return 4
  python3 -I -B - "$HERMES_DIR" "$HERMES" "$@" <<'HSTACK_NATIVE_PYTHON'
# HSTACK_NATIVE_HERMES_V0225_PYTHON
# Production helpers embed the reviewed adapter here; an unbundled source fails closed.
raise SystemExit(4)
HSTACK_NATIVE_PYTHON
}

native_field() { printf '%s\n' "$NATIVE_OUT" | awk -F= -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }'; }

native_call() { # stdout is internal structured evidence, never raw jobs/prompts/secrets.
  local rc rv plan seal nf
  resolve_hermes
  [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
  rv=$(parse_version "$(run_hermes --version)")
  [ "$rv" = 0.22.5 ] || fail 4 runtime_unavailable "native_adapter_requires_0.22.5"
  if [ $# -ge 2 ] && [ "$1" != reload ]; then
    plan=$2/native-cron.plan.json
    seal=$2/native-cron.plan.sha256
    if [ -e "$plan" ] || [ -L "$plan" ]; then
      { [ ! -L "$plan" ] && [ -f "$seal" ] && [ ! -L "$seal" ] &&
        [ "$(sha_file "$plan")" = "$(cat "$seal")" ]; } || fail 1 backup_corrupt "native_plan_integrity"
    fi
  fi
  NATIVE_OUT=$(native_adapter "$@")
  rc=$?
  if [ "$rc" != 0 ]; then
    if [ "$rc" = 3 ] && [ "$1" = preflight ]; then
      out conflict "cron:$3"; fail 3 changed_since_backup "cron:$3"
    elif [ "$rc" = 3 ] && [ "$1" = restore-check ]; then
      out conflict cron; fail 3 restore_conflict cron
    fi
    case $rc in 1|3|4) ;; *) rc=4 ;; esac
    # A reload refusal carries a fixed reason code (restart refused, readiness unconfirmed, instance unchanged ...).
    if [ "$1" = reload ]; then fail "$rc" native_adapter_failed "reload:$(native_field detail)"; fi
    fail "$rc" native_adapter_failed "op:$1"
  fi
  if [ "$1" = intend ]; then
    nf=$2/.native-plan.sha256.$$
    register_tmp "$nf"
    sha_file "$plan" > "$nf" && mv -f "$nf" "$seal" || fail 1 io_error "native_plan_seal_failed"
  fi
}

adapter_from_version() { [ "$1" = 0.22.5 ] && ADAPTER=native-v0.22.5 || ADAPTER=legacy-v1; }

legacy_runtime_check() {
  local rv
  resolve_hermes
  [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
  rv=$(parse_version "$(run_hermes --version)")
  # The TSV protocol is a contract for the original 0.15.2 fixture only.
  # Recovery must not mutate an upgraded or unrecognized runtime.
  [ "$rv" = 0.15.2 ] || fail 4 legacy_runtime_incompatible "recover_with_original_runtime_or_manual_reconciliation"
}

lock_is_stale() { # <lockdir>: holder pid dead, or no pid file for more than a minute (mtime)
  local pid
  pid=$(cat "$1/pid" 2>/dev/null) || pid=""
  if [ -n "$pid" ]; then
    local re='^[0-9]+$'
    [[ $pid =~ $re ]] || return 0
    kill -0 "$pid" 2>/dev/null && return 1
    return 0
  fi
  [ -n "$(find "$1" -maxdepth 0 -mmin +1 -print 2>/dev/null)" ]
}

lock_acquire() { # mutating ops only; never creates .hstack for an op that has no txn
  local i=0
  mkdir -p "$STATE" || fail 1 io_error "cannot_create_state_dir"
  while ! mkdir "$STATE/lock.d" 2>/dev/null; do
    if lock_is_stale "$STATE/lock.d"; then
      # only the holder of lock.reap may remove a stale lock; re-check staleness under it, so two
      # contenders cannot both delete a lock that the other one has just legitimately re-created
      if mkdir "$STATE/lock.reap" 2>/dev/null; then
        if lock_is_stale "$STATE/lock.d"; then rm -rf "$STATE/lock.d"; fi
        rmdir "$STATE/lock.reap" 2>/dev/null || true
        continue
      fi
      if [ -n "$(find "$STATE/lock.reap" -maxdepth 0 -mmin +1 -print 2>/dev/null)" ]; then rmdir "$STATE/lock.reap" 2>/dev/null || true; fi
    fi
    [ "$i" -ge 3 ] && fail 4 locked "another_hstack_target_operation_is_running"
    i=$((i + 1))
    sleep 1
  done
  LOCK_HELD=1
  printf '%s\n' "$$" > "$STATE/lock.d/pid"
}

# ----------------------------------------------------------------------------------------------
# .env helpers. Matching is LITERAL (awk string compare on the name before the first '='); lines
# may be `KEY=v` or `export KEY=v`. Lines like `KEY = v` are not recognised (and not touched).
# ----------------------------------------------------------------------------------------------
AWK_FN='function lname(s,   t, i) { t = s; if (substr(t,1,7) == "export ") t = substr(t,8); i = index(t,"="); if (i < 1) return ""; return substr(t,1,i-1) }
function lval(s,   t) { t = s; if (substr(t,1,7) == "export ") t = substr(t,8); return substr(t, index(t,"=") + 1) }
'

env_key_lines() { # <KEY> <file>  -> matching lines
  [ -f "$2" ] || return 0
  awk -v k="$1" "$AWK_FN"'lname($0) == k' "$2"
}

env_key_count() { env_key_lines "$1" "$2" | awk 'END { print NR }'; }

key_sig() { # <KEY> <file> -> sha256 of the KEY's lines, or `absent`
  local lines
  lines=$(env_key_lines "$1" "$2")
  if [ -z "$lines" ]; then printf 'absent'; else printf '%s\n' "$lines" | sha_stdin; fi
}

env_value() { # <VAR> <file> -> last value, one quote layer stripped; return 1 if absent
  [ -f "$2" ] || return 1
  awk -v k="$1" "$AWK_FN"'
    lname($0) == k { v = lval($0); f = 1 }
    END {
      if (!f) exit 1
      sub(/\r$/, "", v)
      n = length(v)
      if (n >= 2) { a = substr(v,1,1); b = substr(v,n,1); if (a == b && (a == "\"" || a == "\047")) v = substr(v,2,n-2) }
      print v
    }' "$2"
}

security_env_value() { # Access controls also accept dotenv whitespace/export forms.
  awk -v k="$1" '
    {
      t = $0; sub(/^[[:space:]]*/, "", t); sub(/^export[[:space:]]+/, "", t)
      i = index(t, "="); if (!i) next
      name = substr(t, 1, i - 1); sub(/[[:space:]]*$/, "", name)
      if (name != k) next
      v = substr(t, i + 1); sub(/^[[:space:]]*/, "", v); sub(/[[:space:]]*$/, "", v)
      n = length(v); a = substr(v, 1, 1); b = substr(v, n, 1)
      if (n >= 2 && a == b && (a == "\"" || a == "\047")) v = substr(v, 2, n - 2)
      found = 1
    }
    END { if (found) print v; else exit 1 }' "$2"
}

telegram_access_problem() { # <env file> -> fixed reason only; no values ever leave this helper
  local name value
  [ -f "$1" ] || return 0
  [ -r "$1" ] || { printf 'access_settings_unreadable'; return 0; }
  for name in TELEGRAM_ALLOW_ALL_USERS GATEWAY_ALLOW_ALL_USERS; do
    value=$(security_env_value "$name" "$1" 2>/dev/null | tr -d ' \r' | tr 'A-Z' 'a-z')
    case $value in ''|false|0|no|off) ;; *) printf 'open_access_switch:%s' "$name"; return 0 ;; esac
  done
  value=$(security_env_value TELEGRAM_GROUP_ALLOWED_CHATS "$1" 2>/dev/null | tr -d ' \r')
  if [ -n "$value" ]; then printf 'group_wide_access_enabled'; fi
}

env_names() { # names of all KEY= lines, sorted unique, comma separated
  [ -f "$1" ] || return 0
  awk "$AWK_FN"'{ n = lname($0); if (n ~ /^[A-Z][A-Z0-9_]*$/) print n }' "$1" | LC_ALL=C sort -u | tr '\n' ',' | sed 's/,$//'
}

env_nonmanaged_sha() { # <keys-csv> <file> -> sha of every line NOT belonging to a managed key
  if [ -f "$2" ]; then
    awk -v keys="$1" "$AWK_FN"'
      BEGIN { n = split(keys, a, ","); for (i = 1; i <= n; i++) M[a[i]] = 1 }
      { nm = lname($0); if (nm != "" && (nm in M)) next; print $0 }' "$2"
  fi | sha_stdin
}

# ----------------------------------------------------------------------------------------------
# skills / manifest helpers
# ----------------------------------------------------------------------------------------------
dir_sha() { # deterministic ownership hash: names, types, modes, bytes and link targets
  (
    cd "$1" 2>/dev/null || exit 1
    # Include the root and empty directories: chmod-only edits and new empty directories are
    # user changes too. The prefix deliberately separates this from the old content-only
    # digest; legacy manifests fail closed and need manual reconciliation, never adoption.
    printf 'hstack-skill-mode-v2\n'
    find . ! -path ./.hstack-acceptance -print | LC_ALL=C sort | while IFS= read -r p; do
      if [ -L "$p" ]; then
        printf 'L %s -> %s\n' "$p" "$(readlink "$p")"
      elif [ -d "$p" ]; then
        printf 'D %s %s\n' "$(file_mode "$p")" "$p"
      elif [ -f "$p" ]; then
        printf 'F %s %s  %s\n' "$(file_mode "$p")" "$(sha_file "$p")" "$p"
      else
        printf 'O %s\n' "$p"
      fi
    done
  ) | sha_stdin
}

entry_sha() { # sha of a skills-dir entry (dir, file or symlink) or `absent`
  if [ -L "$1" ]; then
    printf 'link:%s' "$(readlink "$1")" | sha_stdin
  elif [ -d "$1" ]; then
    dir_sha "$1" || printf 'unreadable'
  elif [ -f "$1" ]; then
    sha_file "$1" || printf 'unreadable'
  elif [ -e "$1" ]; then
    printf 'other'
  else
    printf 'absent'
  fi
}

manifest_names() { [ -f "$MANIFEST" ] && awk -F'\t' 'NF >= 2 { print $1 }' "$MANIFEST"; return 0; }

manifest_sha_of() { # <name> -> recorded sha; return 1 if not in manifest
  [ -f "$MANIFEST" ] || return 1
  awk -F'\t' -v n="$1" '$1 == n { print $2; f = 1; exit } END { exit !f }' "$MANIFEST"
}

in_manifest() { manifest_sha_of "$1" >/dev/null; }

safe_name() { # printable, conservative: usable in key=value output
  local re='^[A-Za-z0-9._+@-]+$'
  nonl "$1" && [ "${#1}" -le 128 ] && [[ $1 =~ $re ]]
}

# ----------------------------------------------------------------------------------------------
# cron helpers (adapter assumption: `cron list` = <id> TAB <schedule> TAB <prompt> per line)
# ----------------------------------------------------------------------------------------------
cron_marked() { # <list-text> [id] -> lines carrying the hstack marker (for id)
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$1" | awk -v m="[hstack:$2]" 'index($0, m) > 0'
  else
    printf '%s\n' "$1" | awk 'index($0, "[hstack:") > 0'
  fi
}

cron_other() { printf '%s\n' "$1" | awk 'index($0, "[hstack:") == 0 && NF > 0'; }

cron_sig() { # <list-text> <id> -> sha of sorted "schedule TAB prompt" of the id's entries, or `absent`
  local lines
  lines=$(cron_marked "$1" "$2" | awk -F'\t' '{ print $2 "\t" $3 }' | LC_ALL=C sort)
  if [ -z "$lines" ]; then printf 'absent'; else printf '%s\n' "$lines" | sha_stdin; fi
}

cron_other_sig() { cron_other "$1" | LC_ALL=C sort | sha_stdin; }

cron_line_sig() { # <list-line> -> sha of its "schedule TAB prompt" (job id excluded: ids change on re-create)
  str_sha "$(printf '%s\n' "$1" | awk -F'\t' '{ print $2 "\t" $3 }')"
}

cron_state_ok() { # <list-text> <id>: every marked line is a prior line or the line this txn intended
  local text=$1 id=$2 line allowed="" post
  post=$(tsv_get "$TXN/post.cron" "$id" 2) || post=""
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    allowed="$allowed $(cron_line_sig "$line")"
  done < <(cron_marked "$(cat "$TXN/cron.before")" "$id")
  allowed="$allowed $post"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case " $allowed " in *" $(cron_line_sig "$line") "*) ;; *) return 1 ;; esac
  done < <(cron_marked "$text" "$id")
  return 0
}

parse_cron_spec() { # 'id|schedule|prompt' -> C_ID C_SCHED C_PROMPT (marker ensured); return 1 if invalid
  local s=$1 rest marker stripped
  nonl "$s" || return 1
  case $s in *'|'*'|'*) ;; *) return 1 ;; esac
  C_ID=${s%%|*}
  rest=${s#*|}
  C_SCHED=${rest%%|*}
  C_PROMPT=${rest#*|}
  valid_cronid "$C_ID" || return 1
  valid_schedule "$C_SCHED" || return 1
  valid_prompt "$C_PROMPT" || return 1
  marker="[hstack:$C_ID]"
  stripped=${C_PROMPT//"$marker"/}
  case $stripped in *'[hstack:'*) return 1 ;; esac
  case $C_PROMPT in *"$marker"*) ;; *) C_PROMPT="$marker $C_PROMPT" ;; esac
  valid_prompt "$C_PROMPT" || return 1
  return 0
}

ensure_cron() { # <id> <schedule> <prompt> -> CRON_RESULT=created|unchanged|updated ; dies on failure
  local id=$1 sched=$2 prompt=$3 text n cur_s cur_p old jid
  text=$(run_hermes cron list) || fail 1 cron_list_failed "id:$id"
  n=$(cron_marked "$text" "$id" | awk 'END { print NR }')
  if [ "$n" = 1 ]; then
    cur_s=$(cron_marked "$text" "$id" | awk -F'\t' '{ print $2 }')
    cur_p=$(cron_marked "$text" "$id" | awk -F'\t' '{ print $3 }')
    if [ "$cur_s" = "$sched" ] && [ "$cur_p" = "$prompt" ]; then
      CRON_RESULT=unchanged
      return 0
    fi
  fi
  old=$(cron_marked "$text" "$id" | awk -F'\t' '{ print $1 }')
  run_hermes cron create "$sched" "$prompt" >/dev/null || fail 1 cron_create_failed "id:$id"
  while IFS= read -r jid; do
    [ -n "$jid" ] || continue
    valid_jobid "$jid" || fail 1 cron_remove_failed "id:$id:unsafe_job_id"
    run_hermes cron remove "$jid" >/dev/null || fail 1 cron_remove_failed "id:$id"
  done < <(printf '%s\n' "$old")
  text=$(run_hermes cron list) || fail 1 cron_list_failed "id:$id"
  n=$(cron_marked "$text" "$id" | awk 'END { print NR }')
  cur_s=$(cron_marked "$text" "$id" | awk -F'\t' '{ print $2 }')
  cur_p=$(cron_marked "$text" "$id" | awk -F'\t' '{ print $3 }')
  if [ "$n" != 1 ] || [ "$cur_s" != "$sched" ] || [ "$cur_p" != "$prompt" ]; then
    fail 1 cron_ensure_failed "id:$id"
  fi
  if [ -n "$old" ]; then CRON_RESULT=updated; else CRON_RESULT=created; fi
}

# ----------------------------------------------------------------------------------------------
# transaction helpers
# ----------------------------------------------------------------------------------------------
meta_get() { # <key> -> value from txn meta
  awk -F= -v k="$1" '$1 == k { print substr($0, length(k) + 2); exit }' "$TXN/meta"
}

tsv_get() { # <file> <key> <col>  (TAB separated; first column is the key)
  [ -f "$1" ] || return 1
  awk -F'\t' -v k="$2" -v c="$3" '$1 == k { print $c; f = 1; exit } END { exit !f }' "$1"
}

txn_light() {
  valid_txn "$1" || usage "invalid transaction id"
  TXN_ID=$1
  TXN=$STATE/txn/$1
  [ -d "$TXN" ] || fail 1 backup_missing "txn:$TXN_ID"
}

integrity_bad() {
  local line h f cur bad=""
  while IFS= read -r line; do
    h=${line%%  *}
    f=${line#*  }
    cur=$(sha_file "$TXN/$f") || cur=missing
    [ "$cur" = "$h" ] || bad=$bad${bad:+,}$f
  done < "$TXN/integrity"
  printf '%s' "$bad"
}

txn_load() {
  local bad
  txn_light "$1"
  { [ -f "$TXN/meta" ] && [ -f "$TXN/integrity" ]; } || fail 1 backup_corrupt "meta_or_integrity_missing"
  bad=$(integrity_bad)
  [ -z "$bad" ] || fail 1 backup_corrupt "files:$bad"
  [ "$(meta_get version)" = 1 ] || fail 1 backup_corrupt "unsupported_meta_version"
  ADAPTER=$(meta_get adapter)
  [ -n "$ADAPTER" ] || ADAPTER=legacy-v1
  case $ADAPTER in legacy-v1|native-v0.22.5) ;; *) fail 1 backup_corrupt "unsupported_adapter" ;; esac
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    [ "$(meta_get runtime_home)" = "$HERMES_DIR" ] || fail 1 backup_corrupt "runtime_home_mismatch"
  fi
}

list_incomplete() {
  local d n
  for d in "$STATE"/txn/*; do
    [ -d "$d" ] || continue
    n=${d##*/}
    valid_txn "$n" || continue
    if [ ! -e "$d/done" ] && [ ! -e "$d/restored" ]; then printf '%s\n' "$n"; fi
  done
}

lock_txn() { # Check existence without creating state, then re-load under the lock (purge may have won).
  txn_light "$1"
  lock_acquire
  txn_load "$1"
}

keys_of_txn() { # -> LIST_OUT = managed keys of the loaded txn
  parse_csv "$(meta_get keys)" valid_key || fail 1 backup_corrupt "meta_keys"
}

# ----------------------------------------------------------------------------------------------
# op: inspect
# ----------------------------------------------------------------------------------------------
# The Hermes release token of `hermes --version`, verbatim, or nothing. Real output is a multi-line report
# (hermes_cli/_startup_fast.py print_fast_version_info): the first line is the banner
# `Hermes Agent v<ver> (<release date>)[ · ...]`; the Install directory / Python / OpenAI SDK lines after it carry
# unrelated x.y.z tokens, so only line 1 is read. The offline test double prints `hermes <ver>`. The token is never
# truncated: `0.22.5.1`, `0.22.5.dev3` and `0.22.5+3.gabc` are reported as such and are NOT `0.22.5`. The grammar is
# the receipt schema's runtime_version pattern, so what is printed here can be recorded as observed.
parse_version() {
  local line v re='^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]{1,32})?$'
  line=${1%%$'\n'*}
  line=${line%$'\r'}
  case $line in
    "Hermes Agent v"*) v=${line#"Hermes Agent v"} ;;
    "hermes "*) v=${line#"hermes "} ;;
    *) return 0 ;;
  esac
  v=${v%% *}
  if [[ $v =~ $re ]]; then printf '%s' "$v"; fi
}

os_release_field() {
  local v re='^[A-Za-z0-9._-]+$'
  [ -r /etc/os-release ] || { printf 'unknown'; return 0; }
  v=$(grep -E "^$1=" /etc/os-release | head -1 | cut -d= -f2- | tr -d "\"'")
  if [ -n "$v" ] && [[ $v =~ $re ]]; then printf '%s' "$v"; else printf 'unknown'; fi
}

op_inspect() {
  [ $# -eq 0 ] || usage "inspect takes no arguments"
  local ver_out rv=unknown ev=unknown os cl cl_ok=0 ids other p n sha ms=""
  local unm="" unl=0 mod=""
  resolve_hermes
  out op inspect
  if [ -n "$HERMES" ]; then
    out hermes_present 1
    if ver_out=$(run_hermes --version); then
      rv=$(parse_version "$ver_out")
      if [ -n "$rv" ]; then ev=measured; else rv=unknown; fi
    fi
  else
    out hermes_present 0
  fi
  out runtime_version "$rv"
  out runtime_evidence "$ev"
  adapter_from_version "$rv"
  out runtime_adapter "$ADAPTER"
  out runtime_profile default

  os=$(uname -s 2>/dev/null | tr 'A-Z' 'a-z')
  [ -n "$os" ] || os=unknown
  out os "$os"
  out os_id "$(os_release_field ID)"
  out os_version_id "$(os_release_field VERSION_ID)"
  out arch "$(uname -m 2>/dev/null || printf unknown)"
  if [ -d /run/systemd/system ]; then out service_manager systemd
  elif [ "$os" = linux ]; then out service_manager none
  else out service_manager unknown; fi

  if [ -f "$ENV_FILE" ]; then
    out env_file present
    out env_keys "$(env_names "$ENV_FILE")"
    out env_perm "$(file_mode "$ENV_FILE" || printf unknown)"
  else
    out env_file absent
    out env_keys ""
    out env_perm absent
  fi
  if [ -f "$CFG_FILE" ]; then
    sha=$(sha_file "$CFG_FILE") && out config_fingerprint "$(printf '%s' "$sha" | cut -c1-16)" || out config_fingerprint unknown
  else
    out config_fingerprint absent
  fi

  if [ "$ADAPTER" = native-v0.22.5 ]; then
    native_call service-check
    native_call inspect
    out cron_managed_ids "$(native_field cron_managed_ids)"
    out cron_other_count "$(native_field cron_other_count)"
    cl_ok=2
  elif [ -n "$HERMES" ] && cl=$(run_hermes cron list); then cl_ok=1; fi
  if [ "$cl_ok" = 1 ]; then
    ids=$(cron_marked "$cl" | grep -Eo '\[hstack:[a-z0-9-]+\]' | sed 's/^\[hstack://; s/\]$//' | LC_ALL=C sort -u | tr '\n' ',' | sed 's/,$//')
    other=$(cron_other "$cl" | awk 'END { print NR }')
    out cron_managed_ids "$ids"
    out cron_other_count "$other"
  elif [ "$cl_ok" = 0 ]; then
    out cron_managed_ids unknown
    out cron_other_count unknown
  fi

  for p in "$SKILLS_DIR"/*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    n=${p##*/}
    in_manifest "$n" && continue
    if safe_name "$n"; then unm=$unm${unm:+,}$n; else unl=$((unl + 1)); fi
  done
  out skills_unmanaged "$unm"
  out skills_unmanaged_unlisted "$unl"
  while IFS= read -r n; do
    safe_name "$n" || continue
    sha=$(entry_sha "$SKILLS_DIR/$n")
    ms=$ms${ms:+,}$n:$sha
    [ "$sha" = "$(manifest_sha_of "$n")" ] || mod=$mod${mod:+,}$n
  done < <(manifest_names)
  out skills_managed "$ms"
  out skills_managed_modified "$mod"
  out txn_incomplete "$(list_incomplete | tr '\n' ',' | sed 's/,$//')"
  out diagnostics unknown
  out diagnostics_note "hstack_never_runs_doctor"
}

# ----------------------------------------------------------------------------------------------
# op: backup
# ----------------------------------------------------------------------------------------------
op_backup() {
  local txn keys="" allow="" t ver_out rv=unknown cl k p n inc f sha
  [ $# -ge 1 ] || usage "backup <txn> --keys K1,K2"
  txn=$1
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --keys) [ $# -ge 2 ] || usage "--keys needs a value"; keys=$2; shift 2 ;;
      --allow) [ $# -ge 2 ] || usage "--allow needs a value"; allow=$2; shift 2 ;;
      *) usage "unknown argument to backup" ;;
    esac
  done
  valid_txn "$txn" || usage "invalid transaction id"
  parse_csv "$keys" valid_key || usage "invalid --keys"
  local KEYS=(${LIST_OUT[@]+"${LIST_OUT[@]}"})
  if [ -n "$allow" ]; then
    parse_csv "$allow" valid_key || usage "invalid --allow"
    for k in "${KEYS[@]}"; do in_list "$k" ${LIST_OUT[@]+"${LIST_OUT[@]}"} || usage "key not in --allow: $k"; done
  fi
  local keys_csv
  keys_csv=$(join_csv "${KEYS[@]}")

  # Reject unavailable runtimes/unsafe env paths without creating any target state. Repeat the
  # measurements under the lock so a concurrent transaction cannot make the backup stale.
  resolve_hermes
  [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
  if ver_out=$(run_hermes --version); then rv=$(parse_version "$ver_out"); [ -n "$rv" ] || rv=unknown; fi
  adapter_from_version "$rv"
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call service-check; native_call inspect; cl=""
  else cl=$(run_hermes cron list) || fail 4 runtime_unavailable "cron_list_failed"; fi
  if [ -L "$ENV_FILE" ]; then fail 4 env_not_regular_file "env_is_symlink"; fi
  if [ -e "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then fail 4 env_not_regular_file "env_not_a_file"; fi
  mkdir -p "$STATE/txn" || fail 1 io_error "cannot_create_state_dir"
  lock_acquire
  resolve_hermes
  [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
  if ver_out=$(run_hermes --version); then rv=$(parse_version "$ver_out"); [ -n "$rv" ] || rv=unknown; fi
  adapter_from_version "$rv"
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call service-check; native_call inspect; cl=""
  else cl=$(run_hermes cron list) || fail 4 runtime_unavailable "cron_list_failed"; fi
  if [ -L "$ENV_FILE" ]; then fail 4 env_not_regular_file "env_is_symlink"; fi
  if [ -e "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then fail 4 env_not_regular_file "env_not_a_file"; fi

  inc=$(list_incomplete | head -1)
  [ -z "$inc" ] || fail 4 incomplete_transaction "$inc"
  [ ! -e "$STATE/txn/$txn" ] || fail 2 txn_exists "$txn"

  t=$STATE/txn/.tmp.$txn.$$
  register_tmp "$t"
  mkdir "$t" || fail 1 io_error "cannot_create_txn_dir"

  # ---- artefacts ----
  local env_state=absent env_mode=- env_owner=- env_sha=absent
  if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "$t/env.bak" || fail 1 io_error "env_copy_failed"
    chmod 600 "$t/env.bak"
    env_state=present
    env_mode=$(file_mode "$ENV_FILE") || fail 1 io_error "env_stat_failed"
    env_owner=$(file_owner "$ENV_FILE") || env_owner=unknown
    env_sha=$(sha_file "$t/env.bak") || fail 1 io_error "env_hash_failed"
  else
    : > "$t/env.absent"
  fi
  local cfg_state=absent cfg_mode=- cfg_sha=absent
  if [ -f "$CFG_FILE" ]; then
    cp -p "$CFG_FILE" "$t/config.bak" || fail 1 io_error "config_copy_failed"
    chmod 600 "$t/config.bak"
    cfg_state=present
    cfg_mode=$(file_mode "$CFG_FILE") || cfg_mode=unknown
    cfg_sha=$(sha_file "$t/config.bak") || fail 1 io_error "config_hash_failed"
  else
    : > "$t/config.absent"
  fi
  local man_state=absent man_sha=absent
  if [ -f "$MANIFEST" ]; then
    cp -p "$MANIFEST" "$t/manifest.bak" || fail 1 io_error "manifest_copy_failed"
    man_state=present
    man_sha=$(sha_file "$t/manifest.bak") || fail 1 io_error "manifest_hash_failed"
  else
    : > "$t/manifest.absent"
  fi
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    native_call backup "$t"
    : > "$t/cron.before"
  else cron_marked "$cl" > "$t/cron.before"; fi

  local envsrc=/dev/null
  [ -f "$t/env.bak" ] && envsrc=$t/env.bak
  : > "$t/prior.keys"
  local pk=""
  for k in "${KEYS[@]}"; do
    sha=$(key_sig "$k" "$envsrc")
    if [ "$sha" = absent ]; then p=absent; else p=present; fi
    printf '%s\t%s\t%s\n' "$k" "$p" "$sha" >> "$t/prior.keys"
    pk=$pk${pk:+,}$k:$p
  done

  local skills_dir=absent
  [ -d "$SKILLS_DIR" ] && skills_dir=present
  : > "$t/unrelated.skills"
  for p in "$SKILLS_DIR"/*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    n=${p##*/}
    in_manifest "$n" && continue
    safe_name "$n" || fail 4 unsafe_skill_name "unmanaged_skill_with_unsafe_name"
    printf '%s\t%s\n' "$n" "$(entry_sha "$p")" >> "$t/unrelated.skills"
  done
  {
    printf 'env_sha=%s\n' "$(env_nonmanaged_sha "$keys_csv" "$envsrc")"
    if [ "$ADAPTER" = native-v0.22.5 ]; then
      printf 'cron_other_count=%s\n' "$(native_field cron_other_count)"
      printf 'cron_other_sig=%s\n' "$(native_field cron_other_sig)"
    else
      printf 'cron_other_count=%s\n' "$(cron_other "$cl" | awk 'END { print NR }')"
      printf 'cron_other_sig=%s\n' "$(cron_other_sig "$cl")"
    fi
  } > "$t/unrelated.base"
  {
    printf 'version=1\n'
    printf 'txn=%s\n' "$txn"
    printf 'created=%s\n' "$(now)"
    printf 'keys=%s\n' "$keys_csv"
    printf 'runtime_version=%s\n' "$rv"
    printf 'adapter=%s\nruntime_home=%s\n' "$ADAPTER" "$HERMES_DIR"
    printf 'env_state=%s\nenv_mode=%s\nenv_owner=%s\nenv_sha=%s\n' "$env_state" "$env_mode" "$env_owner" "$env_sha"
    printf 'config_state=%s\nconfig_mode=%s\nconfig_sha=%s\n' "$cfg_state" "$cfg_mode" "$cfg_sha"
    printf 'manifest_state=%s\nmanifest_sha=%s\n' "$man_state" "$man_sha"
    printf 'skills_dir=%s\n' "$skills_dir"
  } > "$t/meta"
  : > "$t/integrity"
  for f in meta env.bak env.absent config.bak config.absent cron.before manifest.bak manifest.absent \
           prior.keys unrelated.base unrelated.skills native-cron.before.json; do
    [ -f "$t/$f" ] || continue
    printf '%s  %s\n' "$(sha_file "$t/$f")" "$f" >> "$t/integrity"
  done
  chmod 700 "$STATE" "$STATE/txn" 2>/dev/null || true
  mv "$t" "$STATE/txn/$txn" || fail 1 io_error "cannot_publish_txn_dir"

  out op backup
  out backup_handle "bk_$txn"
  out txn "$txn"
  out env_state "$env_state"
  out env_mode "$env_mode"
  out prior_keys "$pk"
  out runtime_version "$rv"
}

# ----------------------------------------------------------------------------------------------
# op: put-env / stage-check
# ----------------------------------------------------------------------------------------------
op_put_env() {
  local key allow="" size nonul value vlen
  [ $# -ge 2 ] || usage "put-env <txn> <KEY> --allow K1,K2"
  local txn=$1
  key=$2
  shift 2
  while [ $# -gt 0 ]; do
    case $1 in
      --allow) [ $# -ge 2 ] || usage "--allow needs a value"; allow=$2; shift 2 ;;
      *) usage "unknown argument to put-env" ;;
    esac
  done
  valid_key "$key" || usage "invalid env key"
  parse_csv "$allow" valid_key || usage "invalid or missing --allow"
  in_list "$key" ${LIST_OUT[@]+"${LIST_OUT[@]}"} || usage "key not in --allow: $key"
  lock_txn "$txn"
  keys_of_txn
  in_list "$key" ${LIST_OUT[@]+"${LIST_OUT[@]}"} || usage "key not managed by this transaction: $key"
  [ ! -e "$TXN/applying" ] || fail 3 staging_closed "apply_already_started"
  [ ! -e "$TXN/done" ] && [ ! -e "$TXN/restored" ] || fail 3 staging_closed "txn_finished"

  # stdin -> private temp file inside the txn dir (removed on exit), validated, never in argv.
  local vf=$TXN/.value.$$ rf=$TXN/.repl.$$ nf=$TXN/.env.new.$$
  register_tmp "$vf"; register_tmp "$rf"; register_tmp "$nf"
  head -c 4200 > "$vf" || fail 1 io_error "stdin_read_failed"
  size=$(wc -c < "$vf" | tr -d ' ')
  [ "$size" -ge 1 ] && [ "$size" -le 4097 ] || fail 2 value_invalid "length"
  nonul=$(tr -d '\000' < "$vf" | wc -c | tr -d ' ')
  [ "$nonul" = "$size" ] || fail 2 value_invalid "nul_byte"
  value=$(head -n 1 < "$vf")
  vlen=${#value}
  if [ "$size" -ne "$vlen" ] && [ "$size" -ne $((vlen + 1)) ]; then fail 2 value_invalid "must_be_a_single_line"; fi
  [ "$vlen" -ge 1 ] && [ "$vlen" -le 4096 ] || fail 2 value_invalid "length"
  case $value in *[!A-Za-z0-9_.:/=+,@-]*) fail 2 value_invalid "charset" ;; esac
  rm -f "$vf"

  local src=$TXN/env.staged
  if [ ! -f "$src" ]; then
    if [ -f "$TXN/env.bak" ]; then cp "$TXN/env.bak" "$src"; else : > "$src"; fi
    chmod 600 "$src"
  fi
  printf '%s=%s\n' "$key" "$value" > "$rf"
  unset value
  awk -v k="$key" -v rf="$rf" "$AWK_FN"'
    FILENAME == rf { r = $0; next }
    { if (lname($0) == k) { if (!d) { print r; d = 1 } ; next } print }
    END { if (!d) print r }' "$rf" "$src" > "$nf" || fail 1 io_error "upsert_failed"
  chmod 600 "$nf"
  mv -f "$nf" "$src" || fail 1 io_error "stage_write_failed"
  rm -f "$rf"
  if ! { [ -f "$TXN/staged.keys" ] && grep -Fxq -- "$key" "$TXN/staged.keys"; }; then
    printf '%s\n' "$key" >> "$TXN/staged.keys"
  fi
  out op put-env
  out staged_key "$key"
  out previous "$(tsv_get "$TXN/prior.keys" "$key" 2)"
}

stage_check_run() { # TXN already loaded; dies with stage_check_failed; sets STAGED_KEYS_CSV
  local staged=$TXN/env.staged k cnt mode val pf=$TXN/.pat.$$ c rc
  register_tmp "$pf"
  STAGED_KEYS_CSV=""
  { [ -f "$staged" ] && [ -f "$TXN/staged.keys" ]; } || fail 1 stage_check_failed "nothing_staged"
  mode=$(file_mode "$staged") || mode=unknown
  [ "$mode" = 600 ] || fail 1 stage_check_failed "staged_env_mode_not_600"
  while IFS= read -r k; do
    valid_key "$k" || fail 1 stage_check_failed "bad_staged_key_name"
    cnt=$(env_key_count "$k" "$staged")
    [ "$cnt" = 1 ] || fail 1 stage_check_failed "key_not_exactly_once:$k"
    STAGED_KEYS_CSV=$STAGED_KEYS_CSV${STAGED_KEYS_CSV:+,}$k
    val=$(env_value "$k" "$staged") || fail 1 stage_check_failed "key_missing:$k"
    if [ "${#val}" -ge 8 ]; then
      printf '%s\n' "$val" > "$pf"
      for c in "$CFG_FILE" "$TXN/config.yaml.staged"; do
        [ -f "$c" ] || continue
        rc=0
        grep -Fq -f "$pf" "$c" || rc=$?
        [ "$rc" -eq 1 ] || fail 1 stage_check_failed "secret_value_in_config_yaml:$k"
      done
      rm -f "$pf"
    fi
  done < "$TXN/staged.keys"
  unset val
  # A preserved allow-all setting would override the private per-user allowlist after reload.
  if grep -Eq '^TELEGRAM_(BOT_TOKEN|ALLOWED_USERS)$' "$TXN/staged.keys"; then
    local access_problem
    access_problem=$(telegram_access_problem "$staged")
    [ -z "$access_problem" ] || fail 1 stage_check_failed "$access_problem"
  fi
}

op_stage_check() {
  [ $# -eq 1 ] || usage "stage-check <txn>"
  txn_load "$1"
  stage_check_run
  out op stage-check
  out stage_ok 1
  out staged_keys "$STAGED_KEYS_CSV"
}

# ----------------------------------------------------------------------------------------------
# op: skills-sync
# ----------------------------------------------------------------------------------------------
write_manifest_from() { # <tmpfile> -> atomically installs it as the manifest
  mkdir -p "$STATE" || return 1
  mv -f "$1" "$MANIFEST"
}

op_skills_sync() {
  local names="" txn tarf n e kinds nm line top
  [ $# -ge 1 ] || usage "skills-sync <txn> --names a,b"
  txn=$1
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --names) [ $# -ge 2 ] || usage "--names needs a value"; names=$2; shift 2 ;;
      *) usage "unknown argument to skills-sync" ;;
    esac
  done
  parse_csv "$names" valid_skill || usage "invalid --names"
  local NAMES=(${LIST_OUT[@]+"${LIST_OUT[@]}"})
  lock_txn "$txn"
  [ ! -e "$TXN/skills.plan" ] || fail 3 skills_already_synced "once_per_txn"
  [ ! -e "$TXN/done" ] && [ ! -e "$TXN/restored" ] || fail 3 staging_closed "txn_finished"
  [ ! -e "$TXN/applied" ] || fail 3 staging_closed "txn_already_applied"
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call service-check; fi

  # ---- spool + validate the archive (no extraction yet) ----
  tarf=$TXN/skills.tar
  local inc=$TXN/skills.incoming
  register_tmp "$tarf"; register_tmp "$inc"
  rm -rf "$inc"
  head -c 52428801 > "$tarf" || fail 1 io_error "stdin_read_failed"
  [ "$(wc -c < "$tarf" | tr -d ' ')" -le 52428800 ] || fail 2 tar_invalid "too_large"
  register_tmp "$TXN/.tar.names"; register_tmp "$TXN/.tar.types"
  tar -tf "$tarf" > "$TXN/.tar.names" 2>/dev/null || fail 2 tar_invalid "unreadable_archive"
  tar -tvf "$tarf" 2>/dev/null | cut -c1 > "$TXN/.tar.types" || fail 2 tar_invalid "unreadable_archive"
  [ "$(wc -l < "$TXN/.tar.names" | tr -d ' ')" = "$(wc -l < "$TXN/.tar.types" | tr -d ' ')" ] || fail 2 tar_invalid "listing_mismatch"
  [ "$(wc -l < "$TXN/.tar.names" | tr -d ' ')" -le 5000 ] || fail 2 tar_invalid "too_many_members"
  local seg_re='^[A-Za-z0-9._+@=,-]+(/[A-Za-z0-9._+@=,-]+)*$'
  local tops=""
  while IFS= read -r line; do
    n=${line#./}
    n=${n%/}
    [ -n "$n" ] && [ "$n" != . ] || continue
    [[ $n =~ $seg_re ]] || fail 2 tar_invalid "unsafe_member_name"
    case "/$n/" in */../*|*/./*) fail 2 tar_invalid "dot_segment" ;; esac
    case "/$n/" in */.hstack-acceptance/*|*/.hstack-managed/*) fail 2 tar_invalid "reserved_marker_name" ;; esac
    top=${n%%/*}
    in_list "$top" "${NAMES[@]}" || fail 2 tar_invalid "unexpected_top_level"
    in_list "$top" $tops || tops=$tops${tops:+ }$top
  done < "$TXN/.tar.names"
  while IFS= read -r line; do
    case $line in -|d) ;; *) fail 2 tar_invalid "non_regular_member" ;; esac
  done < "$TXN/.tar.types"
  for n in "${NAMES[@]}"; do in_list "$n" $tops || fail 2 tar_invalid "missing_top_level:$n"; done

  mkdir "$inc" || fail 1 io_error "cannot_create_incoming"
  tar -xof "$tarf" -C "$inc" 2>/dev/null || fail 2 tar_invalid "extract_failed"
  [ -z "$(find "$inc" ! -type f ! -type d -print 2>/dev/null | head -1)" ] || fail 2 tar_invalid "non_regular_after_extract"
  [ -z "$(find "$inc" -mindepth 1 -name '*[!A-Za-z0-9._+@=,-]*' -print 2>/dev/null | head -1)" ] || fail 2 tar_invalid "unsafe_name_after_extract"
  for n in "${NAMES[@]}"; do
    { [ -d "$inc/$n" ] && [ -f "$inc/$n/SKILL.md" ] && [ ! -L "$inc/$n/SKILL.md" ]; } || fail 2 tar_invalid "missing_SKILL.md:$n"
  done

  # ---- decide, touching nothing: collisions first, then user-modified managed skills ----
  local coll="" modl="" cur newsha
  for n in "${NAMES[@]}"; do
    if [ -e "$SKILLS_DIR/$n" ] || [ -L "$SKILLS_DIR/$n" ]; then
      in_manifest "$n" || coll=$coll${coll:+,}$n
    fi
  done
  if [ -n "$coll" ]; then out collisions "$coll"; fail 5 skill_collision "collision:${coll%%,*}"; fi
  for n in "${NAMES[@]}"; do
    if in_manifest "$n"; then
      cur=$(entry_sha "$SKILLS_DIR/$n")
      [ "$cur" = "$(manifest_sha_of "$n")" ] || modl=$modl${modl:+,}$n
    fi
  done
  if [ -n "$modl" ]; then out conflict "skill:${modl//,/,skill:}"; fail 3 managed_skill_modified "$modl"; fi

  # ---- plan ----
  local plan=$TXN/skills.plan.new changes=0
  register_tmp "$plan"
  : > "$plan"
  local results=()
  for n in "${NAMES[@]}"; do
    newsha=$(dir_sha "$inc/$n") || fail 1 io_error "hash_failed:$n"
    if [ -d "$SKILLS_DIR/$n" ] || [ -L "$SKILLS_DIR/$n" ]; then
      cur=$(entry_sha "$SKILLS_DIR/$n")
      if [ "$cur" = "$newsha" ]; then
        results[${#results[@]}]="$n=unchanged"
      else
        printf '%s\t%s\t%s\t%s\n' "$n" replace "$newsha" "$cur" >> "$plan"
        results[${#results[@]}]="$n=updated"
        changes=$((changes + 1))
      fi
    else
      printf '%s\t%s\t%s\t%s\n' "$n" new "$newsha" absent >> "$plan"
      results[${#results[@]}]="$n=created"
      changes=$((changes + 1))
    fi
  done
  out op skills-sync
  if [ "$changes" -gt 0 ]; then
    # write-ahead: plan + applying before the first live mutation
    mv "$plan" "$TXN/skills.plan"
    [ -e "$TXN/applying" ] || now > "$TXN/applying"
    mkdir -p "$TXN/skills.replaced" "$SKILLS_DIR" || fail 1 io_error "mkdir_failed"
    local mf=$STATE/.manifest.new.$$ stage
    register_tmp "$mf"
    if [ -f "$MANIFEST" ]; then
      awk -F'\t' -v plan="$TXN/skills.plan" 'BEGIN { while ((getline l < plan) > 0) { split(l, a, "\t"); P[a[1]] = 1 } } !($1 in P)' "$MANIFEST" > "$mf"
    else
      : > "$mf"
    fi
    local ts
    ts=$(now)
    while IFS=$'\t' read -r nm kinds newsha cur; do
      printf '%s\t%s\t%s\t%s\n' "$nm" "$newsha" "$TXN_ID" "$ts" >> "$mf"
    done < "$TXN/skills.plan"
    printf '%s\n' "$(sha_file "$mf")" > "$TXN/post.manifest_sha"
    while IFS=$'\t' read -r nm kinds newsha cur; do
      stage=$SKILLS_DIR/.hstack-new.$nm.$$
      register_tmp "$stage"
      cp -R "$inc/$nm" "$stage" || fail 1 io_error "copy_failed:$nm"
      printf 'txn=%s\n' "$TXN_ID" > "$stage/.hstack-acceptance"
      if [ "$kinds" = replace ]; then
        [ ! -e "$TXN/skills.replaced/$nm" ] || fail 1 io_error "replaced_backup_exists:$nm"
        mv "$SKILLS_DIR/$nm" "$TXN/skills.replaced/$nm" || fail 1 io_error "move_replaced_failed:$nm"
      fi
      mv "$stage" "$SKILLS_DIR/$nm" || fail 1 io_error "install_failed:$nm"
    done < "$TXN/skills.plan"
    write_manifest_from "$mf" || fail 1 io_error "manifest_write_failed"
  fi
  for e in ${results[@]+"${results[@]}"}; do out "skill_${e%%=*}" "${e#*=}"; done
  out skills_changed "$changes"
  rm -rf "$inc" "$tarf"
}

# ----------------------------------------------------------------------------------------------
# op: apply
# ----------------------------------------------------------------------------------------------
cron_post_set() { # <id> <sig>  -> rewrite the id's line in post.cron
  local f=$TXN/post.cron
  { [ -f "$f" ] && awk -F'\t' -v id="$1" '$1 != id' "$f"; printf '%s\t%s\n' "$1" "$2"; } > "$f.new.$$" && mv -f "$f.new.$$" "$f"
}

op_apply() {
  local txn k id
  [ $# -ge 1 ] || usage "apply <txn> [--cron 'id|schedule|prompt']..."
  txn=$1
  shift
  local CRON_IDS=() CRON_SCHEDS=() CRON_PROMPTS=()
  while [ $# -gt 0 ]; do
    case $1 in
      --cron)
        [ $# -ge 2 ] || usage "--cron needs a value"
        parse_cron_spec "$2" || usage "invalid --cron spec"
        in_list "$C_ID" ${CRON_IDS[@]+"${CRON_IDS[@]}"} && usage "duplicate cron id"
        CRON_IDS[${#CRON_IDS[@]}]=$C_ID
        CRON_SCHEDS[${#CRON_SCHEDS[@]}]=$C_SCHED
        CRON_PROMPTS[${#CRON_PROMPTS[@]}]=$C_PROMPT
        shift 2
        ;;
      *) usage "unknown argument to apply" ;;
    esac
  done
  lock_txn "$txn"
  [ ! -e "$TXN/done" ] && [ ! -e "$TXN/restored" ] || fail 3 txn_finished "cannot_apply_a_finished_txn"

  # ---- preconditions: nothing may have changed behind the backup (own earlier results accepted) ----
  local cur_env cur_cfg cur_man bad="" ok
  cur_env=$(sha_or_absent "$ENV_FILE")
  cur_cfg=$(sha_or_absent "$CFG_FILE")
  cur_man=$(sha_or_absent "$MANIFEST")
  ok=0; [ "$cur_env" = "$(meta_get env_sha)" ] && ok=1
  [ -f "$TXN/post.env_sha" ] && [ "$cur_env" = "$(cat "$TXN/post.env_sha")" ] && ok=1
  [ "$ok" = 1 ] || bad=$bad${bad:+,}env
  [ "$cur_cfg" = "$(meta_get config_sha)" ] || bad=$bad${bad:+,}config
  ok=0; [ "$cur_man" = "$(meta_get manifest_sha)" ] && ok=1
  [ -f "$TXN/post.manifest_sha" ] && [ "$cur_man" = "$(cat "$TXN/post.manifest_sha")" ] && ok=1
  [ "$ok" = 1 ] || bad=$bad${bad:+,}manifest
  if [ -n "$bad" ]; then out conflict "$bad"; fail 3 changed_since_backup "$bad"; fi
  if [ -f "$TXN/env.staged" ]; then stage_check_run; fi
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call service-check
  else legacy_runtime_check; fi
  if [ "${#CRON_IDS[@]}" -gt 0 ]; then
    resolve_hermes
    [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
    if [ "$ADAPTER" = native-v0.22.5 ]; then
      local ni=0
      while [ "$ni" -lt "${#CRON_IDS[@]}" ]; do
        native_call preflight "$TXN" "${CRON_IDS[$ni]}" "${CRON_SCHEDS[$ni]}" "${CRON_PROMPTS[$ni]}"
        ni=$((ni + 1))
      done
    else
    local cl cur_cron prior_cron recorded_sig intended_sig i=0
    cl=$(run_hermes cron list) || fail 4 runtime_unavailable "cron_list_failed"
    while [ "$i" -lt "${#CRON_IDS[@]}" ]; do
      id=${CRON_IDS[$i]}
      cur_cron=$(cron_sig "$cl" "$id")
      prior_cron=$(cron_sig "$(cat "$TXN/cron.before")" "$id")
      recorded_sig=$(tsv_get "$TXN/post.cron" "$id" 2) || recorded_sig=""
      intended_sig=$(str_sha "${CRON_SCHEDS[$i]}"$'\t'"${CRON_PROMPTS[$i]}")
      # One transaction has one intent per id. Replacing its recorded signature could strand
      # an earlier owned job after a failed remove, making a later restore refuse it.
      if [ -n "$recorded_sig" ] && [ "$recorded_sig" != "$intended_sig" ]; then
        fail 3 cron_intent_changed "id:$id"
      fi
      # Completed applies must retain exactly the intended job. Only an incomplete attempt
      # may accept the prior/post mixture left by our interrupted create/remove sequence.
      if [ -e "$TXN/applied" ] && [ -n "$recorded_sig" ]; then
        if [ "$(cron_marked "$cl" "$id" | awk 'END { print NR }')" != 1 ] ||
           [ "$(cron_line_sig "$(cron_marked "$cl" "$id")")" != "$recorded_sig" ]; then
          bad=$bad${bad:+,}cron:$id
        fi
      elif [ "$cur_cron" != "$prior_cron" ]; then
        if [ -z "$recorded_sig" ] || ! cron_state_ok "$cl" "$id"; then
          bad=$bad${bad:+,}cron:$id
        fi
      fi
      i=$((i + 1))
    done
    if [ -n "$bad" ]; then out conflict "$bad"; fail 3 changed_since_backup "$bad"; fi
    fi
  fi

  # ---- write-ahead ----
  local staged_sha=$cur_env swap=0
  if [ -f "$TXN/env.staged" ]; then
    staged_sha=$(sha_file "$TXN/env.staged") || fail 1 io_error "staged_hash_failed"
  else
    staged_sha=$(meta_get env_sha)
  fi
  if [ -f "$TXN/env.staged" ] || [ ! -f "$TXN/post.env_sha" ]; then
  {
    keys_of_txn
    for k in ${LIST_OUT[@]+"${LIST_OUT[@]}"}; do
      if [ -f "$TXN/env.staged" ]; then
        printf '%s\t%s\n' "$k" "$(key_sig "$k" "$TXN/env.staged")"
      else
        printf '%s\t%s\n' "$k" "$(tsv_get "$TXN/prior.keys" "$k" 3)"
      fi
    done
  } > "$TXN/post.keys.new.$$" || fail 1 io_error "post_keys_failed"
  mv -f "$TXN/post.keys.new.$$" "$TXN/post.keys"
  printf '%s\n' "$staged_sha" > "$TXN/post.env_sha"
  meta_get config_sha > "$TXN/post.config_sha"
  fi   # a re-run after env.staged was deleted keeps the recorded post state
  if [ "${#CRON_IDS[@]}" -gt 0 ]; then
    for id in "${CRON_IDS[@]}"; do
      grep -Fxq -- "$id" "$TXN/cron.ids" 2>/dev/null || printf '%s\n' "$id" >> "$TXN/cron.ids"
    done
    if [ "$ADAPTER" = native-v0.22.5 ]; then
      local ni=0
      while [ "$ni" -lt "${#CRON_IDS[@]}" ]; do
        native_call intend "$TXN" "${CRON_IDS[$ni]}" "${CRON_SCHEDS[$ni]}" "${CRON_PROMPTS[$ni]}"
        ni=$((ni + 1))
      done
    fi
  fi
  [ -e "$TXN/applying" ] || now > "$TXN/applying"
  # A subsequent apply can add cron ids. If it fails part-way, its newly recorded intents
  # need the same interrupted-state retry rules as the initial attempt, not stale completion.
  rm -f "$TXN/applied" || fail 1 io_error "applied_marker_clear_failed"

  # ---- env swap (same-directory temp + mv; original owner kept, credentials private) ----
  if [ -f "$TXN/env.staged" ] && { [ "$cur_env" != "$staged_sha" ] || [ "$(file_mode "$ENV_FILE" 2>/dev/null)" != 600 ]; }; then
    local nf=$HERMES_DIR/.env.hstack-new.$$
    register_tmp "$nf"
    mkdir -p "$HERMES_DIR" || fail 1 io_error "mkdir_failed"
    if [ -f "$ENV_FILE" ]; then
      cp -p "$ENV_FILE" "$nf" || fail 1 io_error "env_temp_failed"
      # cp -p also copies permissive old modes: make the temporary file private BEFORE
      # copying any new credential into it, not merely before the final rename.
      chmod 600 "$nf" || fail 1 io_error "env_chmod_failed"
      cat "$TXN/env.staged" > "$nf" || fail 1 io_error "env_write_failed"
    else
      cp "$TXN/env.staged" "$nf" || fail 1 io_error "env_temp_failed"
    fi
    chmod 600 "$nf" || fail 1 io_error "env_chmod_failed"
    mv -f "$nf" "$ENV_FILE" || fail 1 io_error "env_swap_failed"
    swap=1
  fi

  # ---- cron ----
  local i=0
  out op apply
  out env_swapped "$swap"
  if [ "${#CRON_IDS[@]}" -gt 0 ]; then
    while [ "$i" -lt "${#CRON_IDS[@]}" ]; do
      id=${CRON_IDS[$i]}
      # write-ahead: record the line this txn intends BEFORE touching cron, so an interrupted
      # create/remove sequence is recognised as "ours" by restore
      if [ "$ADAPTER" = native-v0.22.5 ]; then
        native_call ensure "$TXN" "$id" "${CRON_SCHEDS[$i]}" "${CRON_PROMPTS[$i]}"
        CRON_RESULT=$(native_field cron_result)
        case $CRON_RESULT in created|unchanged|updated) ;; *) fail 1 native_adapter_failed "ensure_confirmation_missing" ;; esac
      else
        cron_post_set "$id" "$(str_sha "${CRON_SCHEDS[$i]}"$'\t'"${CRON_PROMPTS[$i]}")"
        ensure_cron "$id" "${CRON_SCHEDS[$i]}" "${CRON_PROMPTS[$i]}"
      fi
      out "cron_$id" "$CRON_RESULT"
      i=$((i + 1))
    done
  fi
  now > "$TXN/applied"
  rm -f "$TXN/env.staged"   # new secret values leave the txn dir as soon as apply has succeeded
  out applied 1
}

# ----------------------------------------------------------------------------------------------
# op: reload
# ----------------------------------------------------------------------------------------------
op_reload() {
  local interrupt=0
  if [ $# -eq 2 ] && [ "$2" = --interrupt-live-sessions ]; then interrupt=1; set -- "$1"; fi
  [ $# -eq 1 ] || usage "reload <txn> [--interrupt-live-sessions]"
  txn_light "$1"
  lock_acquire
  txn_load "$1"
  { [ -e "$TXN/applied" ] || [ -e "$TXN/restored" ]; } || fail 3 not_applied "reload_needs_applied_or_restored"
  local delay=${HSTACK_RELOAD_DELAY:-2} re='^[0-9]{1,2}$'
  [[ $delay =~ $re ]] && [ "$delay" -le 30 ] || usage "HSTACK_RELOAD_DELAY must be 0..30"
  resolve_hermes
  [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    if [ "$interrupt" = 1 ]; then native_call reload --interrupt-live-sessions; else native_call reload; fi
    [ "$(native_field native_gateway_reloaded)" = 1 ] || fail 1 native_adapter_failed "reload_confirmation_missing"
  else
    legacy_runtime_check
    # Hermes 0.15.2 (upstream tag v2026.5.29.2) has no `gateway run --daemon` (hermes_cli/main.py gateway parsers,
    # 11494-11526: `run` is the foreground gateway) and no `gateway ensure`. Its reload is `gateway restart`
    # (main.py:11557 parser; hermes_cli/gateway.py gateway_command `restart` branch, 5483-5600: through the installed
    # systemd/launchd service, else stop + FOREGROUND run), with no -y flag and no live-session guard.
    # The service manager's own failure is reported by a non-zero exit, but a linger warning exits 0, so this
    # offline-fixture recovery path can only report that the command succeeded.
    run_hermes gateway restart >/dev/null || fail 1 gateway_restart_failed "hermes_gateway_restart_failed"
    sleep "$delay"
  fi
  out op reload
  out reloaded 1
}

# ----------------------------------------------------------------------------------------------
# op: verify
# ----------------------------------------------------------------------------------------------
check_out() { out "check.$1" "$2"; out "check.$1.detail" "$3"; }

op_verify() {
  local txn fp="" allowvar="" destvar="" cronid="" sched="" skills="" marker
  [ $# -ge 1 ] || usage "verify <txn> --destination-fp ..."
  txn=$1
  shift
  while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage "option needs a value"
    case $1 in
      --destination-fp) fp=$2 ;;
      --allow-var) allowvar=$2 ;;
      --dest-var) destvar=$2 ;;
      --cron-id) cronid=$2 ;;
      --schedule) sched=$2 ;;
      --skills) skills=$2 ;;
      *) usage "unknown argument to verify" ;;
    esac
    shift 2
  done
  valid_fp "$fp" || usage "invalid --destination-fp"
  valid_key "$allowvar" || usage "invalid --allow-var"
  valid_key "$destvar" || usage "invalid --dest-var"
  valid_cronid "$cronid" || usage "invalid --cron-id"
  valid_schedule "$sched" || usage "invalid --schedule"
  local SK=()
  if [ -n "$skills" ]; then
    parse_csv "$skills" valid_skill || usage "invalid --skills"
    SK=(${LIST_OUT[@]+"${LIST_OUT[@]}"})
  fi
  txn_load "$txn"
  if [ -e "$TXN/applied" ]; then marker=applied
  elif [ -e "$TXN/applying" ]; then marker=applying
  else fail 3 not_applied "verify_needs_applying_or_applied"; fi
  keys_of_txn
  local MKEYS=(${LIST_OUT[@]+"${LIST_OUT[@]}"}) keys_csv
  keys_csv=$(join_csv "${MKEYS[@]}")
  out op verify
  out apply_marker "$marker"

  # -- env-boundary --
  local allow chat fpv st="pass" det="" re='^-?[0-9]+$' user_re='^[0-9]+$' item rest cnt
  cnt=$(env_key_count "$allowvar" "$ENV_FILE")
  if [ ! -f "$ENV_FILE" ]; then st=fail; det="env_file_missing"
  elif [ "$cnt" -gt 1 ]; then st=fail; det="allowlist_defined_more_than_once"
  elif ! allow=$(env_value "$allowvar" "$ENV_FILE") || [ -z "$allow" ]; then st=fail; det="allowlist_missing_or_empty"
  else
    case $allow in ''|,*|*,|*,,*) st=fail; det="allowlist_has_empty_entry" ;; esac
    rest=$allow,
    while [ "$st" = pass ] && [ -n "$rest" ]; do
      item=${rest%%,*}
      rest=${rest#*,}
      # Ignore surrounding whitespace, but never turn an embedded space into a different id.
      item=${item#"${item%%[![:space:]]*}"}
      item=${item%"${item##*[![:space:]]}"}
      if [ -z "$item" ] || [ "$item" = '*' ]; then st=fail; det="allowlist_contains_wildcard_or_blank"
      elif ! [[ $item =~ $user_re ]]; then st=fail; det="allowlist_contains_nonnumeric_id"; fi
    done
    [ "$st" = pass ] && det="allowlist_nonempty_no_wildcard"
  fi
  unset allow
  if [ "$st" = pass ]; then
    cnt=$(env_key_count "$destvar" "$ENV_FILE")
    if [ "$cnt" -gt 1 ]; then st=fail; det="destination_defined_more_than_once"
    elif ! chat=$(env_value "$destvar" "$ENV_FILE") || [ -z "$chat" ]; then st=fail; det="destination_missing"
    elif ! [[ $chat =~ $re ]]; then st=fail; det="destination_malformed"
    else
      fpv=$(str_sha "telegram:$chat" | cut -c1-16)
      if [ "$fpv" = "$fp" ]; then det="$det,destination_fingerprint_matches"
      else st=fail; det="destination_fingerprint_mismatch"; fi
    fi
  fi
  unset chat
  if [ "$st" = pass ] && [ "$(file_mode "$ENV_FILE" 2>/dev/null)" != 600 ]; then
    st=fail; det="env_mode_not_600"
  fi
  if [ "$st" = pass ]; then
    local access_problem
    access_problem=$(telegram_access_problem "$ENV_FILE")
    if [ -n "$access_problem" ]; then st=fail; det=$access_problem; fi
  fi
  check_out env-boundary "$st" "$det"

  # -- schedule-single --
  local cl="" cstat cdet cl_ok=0 native_unrelated=unknown
  resolve_hermes
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    native_call verify "$TXN" "$cronid" "$sched"
    cstat=$(native_field cron_check)
    cdet=$(native_field cron_detail)
    native_unrelated=$(native_field cron_unrelated_check)
    case $cstat in pass|fail|unknown) ;; *) cstat=unknown; cdet=native_confirmation_missing ;; esac
    cl_ok=2
  elif [ -n "$HERMES" ] && cl=$(run_hermes cron list); then cl_ok=1; fi
  if [ "$ADAPTER" = native-v0.22.5 ]; then :
  elif [ -z "$HERMES" ]; then cstat=unknown; cdet="hermes_not_found"
  elif [ "$cl_ok" = 0 ]; then cstat=unknown; cdet="cron_list_failed"
  else
    cnt=$(cron_marked "$cl" "$cronid" | awk 'END { print NR }')
    if [ "$cnt" = 1 ]; then
      if [ "$(cron_marked "$cl" "$cronid" | awk -F'\t' '{ print $2 }')" = "$sched" ]; then
        local intended_sig
        intended_sig=$(tsv_get "$TXN/post.cron" "$cronid" 2) || intended_sig=""
        if [ -z "$intended_sig" ]; then cstat=unknown; cdet="intended_cron_signature_missing"
        elif [ "$(cron_line_sig "$(cron_marked "$cl" "$cronid")")" = "$intended_sig" ]; then
          cstat=pass; cdet="one_marked_entry_expected_schedule_and_prompt"
        else cstat=fail; cdet="prompt_differs"; fi
      else cstat=fail; cdet="schedule_differs"; fi
    else cstat=fail; cdet="marked_entries=$cnt"; fi
  fi
  check_out schedule-single "$cstat" "$cdet"

  # -- managed-skills-intact --
  local n sstat=pass sdet="" count=0 want actual
  while IFS= read -r n; do
    safe_name "$n" || continue
    count=$((count + 1))
    actual=$(entry_sha "$SKILLS_DIR/$n")
    want=$(manifest_sha_of "$n")
    [ "$actual" = "$want" ] || { sstat=fail; sdet=$sdet${sdet:+,}modified:$n; }
  done < <(manifest_names)
  for n in ${SK[@]+"${SK[@]}"}; do
    in_manifest "$n" || { sstat=fail; sdet=$sdet${sdet:+,}not_managed:$n; }
  done
  if [ "$sstat" = pass ] && [ "$count" -eq 0 ]; then sstat=unknown; sdet="no_managed_skills_recorded"
  elif [ "$sstat" = pass ]; then sdet="managed=$count"; fi
  check_out managed-skills-intact "$sstat" "$sdet"

  # -- unrelated-state-unchanged --
  local ustat=pass udet="" b_env b_cnt b_sig cur_cnt cur_sig want_sk got_sk p
  b_env=$(awk -F= '$1 == "env_sha" { print $2 }' "$TXN/unrelated.base")
  b_cnt=$(awk -F= '$1 == "cron_other_count" { print $2 }' "$TXN/unrelated.base")
  b_sig=$(awk -F= '$1 == "cron_other_sig" { print $2 }' "$TXN/unrelated.base")
  [ "$(env_nonmanaged_sha "$keys_csv" "$ENV_FILE")" = "$b_env" ] || { ustat=fail; udet=$udet${udet:+,}env; }
  [ "$(sha_or_absent "$CFG_FILE")" = "$(meta_get config_sha)" ] || { ustat=fail; udet=$udet${udet:+,}config; }
  got_sk=""
  for p in "$SKILLS_DIR"/*; do
    [ -e "$p" ] || [ -L "$p" ] || continue
    n=${p##*/}
    in_manifest "$n" && continue
    got_sk=$got_sk$n$'\t'$(entry_sha "$p")$'\n'
  done
  want_sk=$(cat "$TXN/unrelated.skills")
  [ "$(printf '%s' "$got_sk" | LC_ALL=C sort)" = "$(printf '%s\n' "$want_sk" | LC_ALL=C sort | awk 'NF > 0')" ] || { ustat=fail; udet=$udet${udet:+,}skills; }
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    if [ "$native_unrelated" = fail ]; then ustat=fail; udet=$udet${udet:+,}cron
    elif [ "$native_unrelated" != pass ]; then
      [ "$ustat" = pass ] && ustat=unknown
      udet=$udet${udet:+,}cron_unknown
    fi
  elif [ "$cl_ok" = 1 ]; then
    cur_cnt=$(cron_other "$cl" | awk 'END { print NR }')
    cur_sig=$(cron_other_sig "$cl")
    { [ "$cur_cnt" = "$b_cnt" ] && [ "$cur_sig" = "$b_sig" ]; } || { ustat=fail; udet=$udet${udet:+,}cron; }
  else
    [ "$ustat" = pass ] && ustat=unknown
    udet=$udet${udet:+,}cron_unknown
  fi
  [ "$ustat" = pass ] && udet="env,config,skills,cron_unchanged"
  check_out unrelated-state-unchanged "$ustat" "$udet"
}

# ----------------------------------------------------------------------------------------------
# op: restore
# ----------------------------------------------------------------------------------------------
op_restore() {
  [ $# -eq 1 ] || usage "restore <txn>"
  txn_light "$1"
  lock_acquire
  txn_light "$1"
  if [ -e "$TXN/restored" ]; then
    out op restore
    out already_restored 1
    out secrets_retained "$(retained_secrets)"
    return 0
  fi
  txn_load "$1"
  keys_of_txn
  local MKEYS=(${LIST_OUT[@]+"${LIST_OUT[@]}"}) keys_csv k conflicts="" cur prior post
  keys_csv=$(join_csv "${MKEYS[@]}")

  local CIDS=() id cl=""
  if [ -f "$TXN/cron.ids" ]; then
    while IFS= read -r id; do valid_cronid "$id" && CIDS[${#CIDS[@]}]=$id; done < "$TXN/cron.ids"
  fi
  if [ "$ADAPTER" = native-v0.22.5 ]; then
    native_call restore-check "$TXN"
    CIDS=()
  fi
  if [ "${#CIDS[@]}" -gt 0 ]; then
    legacy_runtime_check
    resolve_hermes
    [ -n "$HERMES" ] || fail 4 runtime_unavailable "hermes_not_found"
    cl=$(run_hermes cron list) || fail 4 runtime_unavailable "cron_list_failed"
  fi

  # ---- 1. preconditions (read-only) ----
  for k in "${MKEYS[@]}"; do
    cur=$(key_sig "$k" "$ENV_FILE")
    prior=$(tsv_get "$TXN/prior.keys" "$k" 3) || fail 1 backup_corrupt "prior_keys"
    post=$(tsv_get "$TXN/post.keys" "$k" 2) || post=$prior
    { [ "$cur" = "$prior" ] || [ "$cur" = "$post" ]; } || conflicts=$conflicts${conflicts:+,}env:$k
  done
  [ "$(sha_or_absent "$CFG_FILE")" = "$(meta_get config_sha)" ] || conflicts=$conflicts${conflicts:+,}config
  if [ "${#CIDS[@]}" -gt 0 ]; then
    for id in "${CIDS[@]}"; do
      cur=$(cron_sig "$cl" "$id")
      prior=$(cron_sig "$(cat "$TXN/cron.before")" "$id")
      cron_state_ok "$cl" "$id" || conflicts=$conflicts${conflicts:+,}cron:$id
      if [ "$cur" != "$prior" ] && [ "$prior" != absent ]; then
        # prior entries must be re-creatable with safe arguments, decided now, before any change
        local pl ps pp
        while IFS= read -r pl; do
          ps=$(printf '%s\n' "$pl" | awk -F'\t' '{ print $2 }')
          pp=$(printf '%s\n' "$pl" | awk -F'\t' '{ print $3 }')
          { valid_schedule "$ps" && valid_prompt "$pp"; } || fail 1 restore_blocked "prior_cron_entry_not_recreatable:$id"
        done < <(cron_marked "$(cat "$TXN/cron.before")" "$id")
      fi
    done
  fi
  local nm kind newsha priorsha pcur
  if [ -f "$TXN/skills.plan" ]; then
    # the plan is not covered by `integrity` (it is written later): re-validate EVERY field before
    # any path built from it is used by a destructive operation
    local share='^([0-9a-f]{64}|absent|unreadable|other|link:.*)$'
    while IFS=$'\t' read -r nm kind newsha priorsha; do
      valid_skill "$nm" || fail 1 backup_corrupt "skills_plan_invalid_name"
      { [ "$kind" = new ] || [ "$kind" = replace ]; } || fail 1 backup_corrupt "skills_plan_invalid_kind"
      { [[ $newsha =~ $share ]] && [[ $priorsha =~ $share ]]; } || fail 1 backup_corrupt "skills_plan_invalid_hash"
    done < "$TXN/skills.plan"
    while IFS=$'\t' read -r nm kind newsha priorsha; do
      pcur=$(entry_sha "$SKILLS_DIR/$nm")
      if [ "$kind" = new ]; then
        { [ "$pcur" = absent ] || [ "$pcur" = "$newsha" ]; } || conflicts=$conflicts${conflicts:+,}skill:$nm
      else
        if [ "$pcur" = absent ] && [ -d "$TXN/skills.replaced/$nm" ]; then :   # interrupted swap
        elif [ "$pcur" != "$newsha" ] && [ "$pcur" != "$priorsha" ]; then conflicts=$conflicts${conflicts:+,}skill:$nm; fi
        if [ "$pcur" != "$priorsha" ]; then
          [ "$(entry_sha "$TXN/skills.replaced/$nm")" = "$priorsha" ] || fail 1 backup_corrupt "replaced_skill_backup:$nm"
        fi
      fi
    done < "$TXN/skills.plan"
  fi
  cur=$(sha_or_absent "$MANIFEST")
  if [ "$cur" != "$(meta_get manifest_sha)" ]; then
    { [ -f "$TXN/post.manifest_sha" ] && [ "$cur" = "$(cat "$TXN/post.manifest_sha")" ]; } || conflicts=$conflicts${conflicts:+,}manifest
  fi
  if [ -n "$conflicts" ]; then out conflict "$conflicts"; fail 3 restore_conflict "$conflicts"; fi

  # ---- 2. restore (each step idempotent; preconditions already allow the prior state) ----
  local restored_keys=""
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call restore "$TXN"; fi
  if [ "${#CIDS[@]}" -gt 0 ]; then
    for id in "${CIDS[@]}"; do
      cur=$(cron_sig "$cl" "$id")
      prior=$(cron_sig "$(cat "$TXN/cron.before")" "$id")
      [ "$cur" != "$prior" ] || continue
      local jid pl ps pp
      while IFS= read -r jid; do
        [ -n "$jid" ] || continue
        valid_jobid "$jid" || fail 1 restore_failed "unsafe_job_id:$id"
        run_hermes cron remove "$jid" >/dev/null || fail 1 restore_failed "cron_remove:$id"
      done < <(cron_marked "$cl" "$id" | awk -F'\t' '{ print $1 }')
      while IFS= read -r pl; do
        ps=$(printf '%s\n' "$pl" | awk -F'\t' '{ print $2 }')
        pp=$(printf '%s\n' "$pl" | awk -F'\t' '{ print $3 }')
        run_hermes cron create "$ps" "$pp" >/dev/null || fail 1 restore_failed "cron_create:$id"
      done < <(cron_marked "$(cat "$TXN/cron.before")" "$id")
    done
  fi
  if [ -f "$TXN/skills.plan" ]; then
    while IFS=$'\t' read -r nm kind newsha priorsha; do
      pcur=$(entry_sha "$SKILLS_DIR/$nm")
      if [ "$kind" = new ]; then
        [ "$pcur" = absent ] || rm -rf "${SKILLS_DIR:?}/${nm:?}"
      elif [ "$pcur" != "$priorsha" ]; then
        [ "$pcur" = absent ] || rm -rf "${SKILLS_DIR:?}/${nm:?}"
        mv "$TXN/skills.replaced/$nm" "$SKILLS_DIR/$nm" || fail 1 restore_failed "skill_move_back:$nm"
      fi
    done < "$TXN/skills.plan"
    if [ "$(meta_get skills_dir)" = absent ]; then rmdir "$SKILLS_DIR" 2>/dev/null || true; fi
  fi
  if [ "$(sha_or_absent "$MANIFEST")" != "$(meta_get manifest_sha)" ]; then
    if [ -f "$TXN/manifest.bak" ]; then
      cp -p "$TXN/manifest.bak" "$STATE/.manifest.restore.$$" && mv -f "$STATE/.manifest.restore.$$" "$MANIFEST" || fail 1 restore_failed "manifest"
    else
      rm -f "$MANIFEST"
    fi
  fi

  # env: exact bytes when only our swap happened; otherwise a per-key line merge
  local cur_env post_env bak_sha nf
  cur_env=$(sha_or_absent "$ENV_FILE")
  post_env=$(cat "$TXN/post.env_sha" 2>/dev/null) || post_env=$cur_env
  bak_sha=$(meta_get env_sha)
  nf=$HERMES_DIR/.env.hstack-restore.$$
  register_tmp "$nf"
  if [ "$cur_env" = "$bak_sha" ]; then
    if [ "$(meta_get env_state)" = present ] && [ -f "$TXN/post.env_sha" ]; then
      chmod "$(meta_get env_mode)" "$ENV_FILE" || fail 1 restore_failed "env_chmod"
    fi
  elif [ "$cur_env" = "$post_env" ]; then
    if [ "$(meta_get env_state)" = present ]; then
      cp -p "$ENV_FILE" "$nf" || fail 1 restore_failed "env_temp"
      cat "$TXN/env.bak" > "$nf" || fail 1 restore_failed "env_write"
      chmod "$(meta_get env_mode)" "$nf" || fail 1 restore_failed "env_chmod"
      mv -f "$nf" "$ENV_FILE" || fail 1 restore_failed "env_swap"
    else
      rm -f "$ENV_FILE"
    fi
  else
    local bak=/dev/null cursrc=/dev/null
    [ -f "$TXN/env.bak" ] && bak=$TXN/env.bak
    if [ -f "$ENV_FILE" ]; then cursrc=$ENV_FILE; cp -p "$ENV_FILE" "$nf" || fail 1 restore_failed "env_temp"; else : > "$nf"; fi
    awk -v keys="$keys_csv" -v bak="$bak" "$AWK_FN"'
      BEGIN { n = split(keys, K, ","); for (i = 1; i <= n; i++) M[K[i]] = 1 }
      FILENAME == bak { nm = lname($0); if (nm in M) { c[nm]++; P[nm, c[nm]] = $0 } ; next }
      { nm = lname($0)
        if (nm != "" && (nm in M)) { if (!E[nm]) { for (j = 1; j <= c[nm] + 0; j++) print P[nm, j]; E[nm] = 1 } ; next }
        print }
      END { for (i = 1; i <= n; i++) { nm = K[i]; if (!E[nm]) for (j = 1; j <= c[nm] + 0; j++) print P[nm, j] } }' "$bak" "$cursrc" > "$nf" || fail 1 restore_failed "env_merge"
    if [ "$(meta_get env_state)" = absent ] && [ ! -s "$nf" ]; then
      rm -f "$ENV_FILE" "$nf"
    else
      mv -f "$nf" "$ENV_FILE" || fail 1 restore_failed "env_swap"
    fi
  fi

  # ---- 3. re-verify against the recorded pre-state ----
  local bad=""
  for k in "${MKEYS[@]}"; do
    [ "$(key_sig "$k" "$ENV_FILE")" = "$(tsv_get "$TXN/prior.keys" "$k" 3)" ] || bad=$bad${bad:+,}env:$k
    restored_keys=$restored_keys${restored_keys:+,}$k
  done
  if [ "$(meta_get env_state)" = present ] && [ "$cur_env" != "$bak_sha" ] && [ "$cur_env" = "$post_env" ]; then
    [ "$(sha_or_absent "$ENV_FILE")" = "$bak_sha" ] || bad=$bad${bad:+,}env_bytes
    [ "$(file_mode "$ENV_FILE")" = "$(meta_get env_mode)" ] || bad=$bad${bad:+,}env_mode
  fi
  [ "$(sha_or_absent "$CFG_FILE")" = "$(meta_get config_sha)" ] || bad=$bad${bad:+,}config
  [ "$(sha_or_absent "$MANIFEST")" = "$(meta_get manifest_sha)" ] || bad=$bad${bad:+,}manifest
  if [ -f "$TXN/skills.plan" ]; then
    while IFS=$'\t' read -r nm kind newsha priorsha; do
      [ "$(entry_sha "$SKILLS_DIR/$nm")" = "$priorsha" ] || bad=$bad${bad:+,}skill:$nm
    done < "$TXN/skills.plan"
  fi
  if [ "${#CIDS[@]}" -gt 0 ]; then
    cl=$(run_hermes cron list) || fail 1 restore_verification_failed "cron_list_failed"
    for id in "${CIDS[@]}"; do
      [ "$(cron_sig "$cl" "$id")" = "$(cron_sig "$(cat "$TXN/cron.before")" "$id")" ] || bad=$bad${bad:+,}cron:$id
    done
  fi
  if [ "$ADAPTER" = native-v0.22.5 ]; then native_call verify-restored "$TXN"; fi
  [ -z "$bad" ] || fail 1 restore_verification_failed "$bad"
  now > "$TXN/restored"
  rm -f "$TXN/env.staged"   # never leave new secret values behind after a rollback
  out op restore
  out restore_verified 1
  out restored_keys "$restored_keys"
  out gateway_reloaded 0
  out secrets_retained "$(retained_secrets)"
}

# ----------------------------------------------------------------------------------------------
# op: commit / purge
# ----------------------------------------------------------------------------------------------
retained_secrets() { if [ -f "$TXN/env.bak" ]; then printf 'env.bak'; fi; }

op_commit() {
  [ $# -eq 1 ] || usage "commit <txn>"
  txn_light "$1"
  lock_acquire
  txn_light "$1"
  [ ! -e "$TXN/restored" ] || fail 3 txn_finished "already_restored"
  [ -e "$TXN/applied" ] || fail 3 not_applied "commit_needs_applied"
  [ -e "$TXN/done" ] || now > "$TXN/done"
  out op commit
  out committed 1
  out secrets_retained "$(retained_secrets)"
}

op_purge() {
  [ $# -eq 1 ] || usage "purge <txn>"
  txn_light "$1"
  lock_acquire
  txn_light "$1"
  { [ -e "$TXN/done" ] || [ -e "$TXN/restored" ]; } || fail 3 txn_not_final "purge_needs_done_or_restored"
  rm -rf "${STATE:?}/txn/${TXN_ID:?}"
  out op purge
  out purged 1
}

# ----------------------------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------------------------
[ $# -ge 1 ] || usage "usage: hstack-target.sh <inspect|backup|put-env|stage-check|skills-sync|apply|reload|verify|restore|commit|purge> [args]"
OP=$1
shift
init_paths
case $OP in
  inspect) op_inspect "$@" ;;
  backup) op_backup "$@" ;;
  put-env) op_put_env "$@" ;;
  stage-check) op_stage_check "$@" ;;
  skills-sync) op_skills_sync "$@" ;;
  apply) op_apply "$@" ;;
  reload) op_reload "$@" ;;
  verify) op_verify "$@" ;;
  restore) op_restore "$@" ;;
  commit) op_commit "$@" ;;
  purge) op_purge "$@" ;;
  *) usage "unknown op" ;;
esac
exit 0
