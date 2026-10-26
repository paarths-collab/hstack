#!/usr/bin/env bash
# Regression tests for install.sh and the setup* scripts.
#
#   bash tests/installer/test-install.sh          # any bash >= 3.2 (stock macOS /bin/bash works)
#
# Self-contained: every run uses a throwaway HOME under $TMPDIR, installs with --local from
# this checkout, and needs no network. Prints a PASS/FAIL line per assertion and a summary;
# exits non-zero if anything failed.
#
# Covers: bash 3.2 start-up, piped --help, zsh guard, ownership-safe installs (backups, no
# deletion, idempotence), instruction-file rewrites that must never truncate, Cursor/Gemini
# destinations, --pick numbers, tier membership vs. a fixture generated from the original
# installer, and drift between the duplicated helper blocks.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL="$ROOT/install.sh"
FIXTURE="$ROOT/tests/installer/fixtures/tiers.expected"
BASH_BIN="${BASH:-bash}"

# Never inherit overrides from the caller's environment.
unset CLAUDE_SKILLS_DIR CODEX_SKILLS_DIR CURSOR_RULES_DIR HERMES_SKILLS_DIR GEMINI_CONTEXT_DIR \
  OPENCLAW_SKILLS_DIR CLAUDE_MD_PATH AGENTS_MD_PATH GEMINI_MD_PATH OPENCLAW_MD_PATH \
  HSTACK_INSTALL_DIR HSTACK_REPO_URL HSTACK_BRANCH HSTACK_TTY HS_STAMP

TMP_BASE="$(mktemp -d "${TMPDIR:-/tmp}/hstack-installer-test.XXXXXX")"
trap 'rm -rf "$TMP_BASE"' EXIT

PASS=0
FAIL=0
RC=0
OUT=""
HOME_N=0

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
}
# assert <description> <command...>: passes when the command succeeds
assert() {
  local desc="$1"
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}
assert_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}
contains() { case "$OUT" in *"$1"*) return 0 ;; esac; return 1; }

# Fresh empty HOME; exports HOME.
new_home() {
  HOME_N=$((HOME_N + 1))
  HOME="$TMP_BASE/home$HOME_N"
  mkdir -p "$HOME"
  export HOME
}

# run <cmd...>: capture combined output in OUT, status in RC (stdin closed).
run() {
  OUT="$("$@" 2>&1 </dev/null)"
  RC=$?
}

# first existing match (dangling symlinks included) of the given globs; prints nothing if none
first() {
  local f
  for f in "$@"; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      echo "$f"
      return 0
    fi
  done
}
count_backups() { # <dir> [pattern]
  local n=0 f
  for f in "$1"/${2:-*}.hstack-backup-*; do
    if [ -e "$f" ] || [ -L "$f" ]; then n=$((n + 1)); fi
  done
  echo "$n"
}
# skill-dir backups live outside the skills dir: <skills-parent>/.hstack-backups/<stamp>/<name>
count_dir_backups() { # <skills dir>
  local n=0 f
  for f in "$(dirname "$1")"/.hstack-backups/*/*; do
    if [ -e "$f" ] || [ -L "$f" ]; then n=$((n + 1)); fi
  done
  echo "$n"
}
first_dir_backup() { # <skills dir> <name>
  first "$(dirname "$1")"/.hstack-backups/*/"$2"
}
count_links() { # <dir>
  local n=0 f
  for f in "$1"/*; do
    if [ -L "$f" ]; then n=$((n + 1)); fi
  done
  echo "$n"
}
skills_total() { ls -1 "$ROOT/skills" | wc -l | tr -d ' '; }

printf 'bash %s, repo %s\n\n' "${BASH_VERSION:-?}" "$ROOT"

# ---------------------------------------------------------------------------
# (a) --help: direct and piped
# ---------------------------------------------------------------------------
run "$BASH_BIN" "$INSTALL" --help
assert_eq "(a) install.sh --help exits 0" 0 "$RC"
assert "(a) install.sh --help prints usage" contains "Usage:"
assert "(a) --help documents --tier and --pick" contains "--tier=a,b"

OUT="$("$BASH_BIN" -s -- --help <"$INSTALL" 2>&1)"
RC=$?
assert_eq "(a) piped 'bash -s -- --help < install.sh' exits 0" 0 "$RC"
assert "(a) piped --help prints usage" contains "Usage:"

if [ -x /bin/bash ] && [ "$BASH_BIN" != /bin/bash ]; then
  run /bin/bash "$INSTALL" --help
  assert "(a) /bin/bash install.sh --help prints usage" contains "Usage:"
fi

if command -v zsh >/dev/null 2>&1; then
  run zsh "$INSTALL" --help
  assert_eq "(a) zsh install.sh --help exits 0 (re-exec under bash)" 0 "$RC"
  assert "(a) zsh install.sh --help prints usage" contains "Usage:"
  OUT="$(zsh <"$INSTALL" 2>&1)"
  RC=$?
  assert_eq "(a) piping install.sh into zsh exits 2" 2 "$RC"
  assert "(a) piping into zsh says to use bash" contains "must be run with bash"
else
  printf 'SKIP: zsh not installed\n'
fi

# ---------------------------------------------------------------------------
# (b) --local --all --ide=claude installs every skill as a symlink
# ---------------------------------------------------------------------------
new_home
run "$BASH_BIN" "$INSTALL" --local --all --ide=claude
assert_eq "(b) install --local --all --ide=claude exits 0" 0 "$RC"
TOTAL="$(skills_total)"
LINKS="$(count_links "$HOME/.claude/skills")"
assert_eq "(b) every skill ($TOTAL) is installed as a symlink" "$TOTAL" "$LINKS"
assert_eq "(b) fixture '--all' agrees with skills/ ($TOTAL)" "$TOTAL" \
  "$(awk '/^== --all$/{f=1;next} /^==/{f=0} f' "$FIXTURE" | wc -l | tr -d ' ')"
assert "(b) a link resolves to the checkout" test -f "$HOME/.claude/skills/hermes-deploy/SKILL.md"
assert_eq "(b) no backups on a clean install" 0 "$(( $(count_backups "$HOME/.claude/skills") + $(count_dir_backups "$HOME/.claude/skills") ))"

new_home
OUT="$(cd "$ROOT" && "$BASH_BIN" -s -- --local --tier=memory --ide=claude <"$INSTALL" 2>&1)"
RC=$?
assert_eq "(b) piped 'bash -s -- --local ...' works from the checkout directory" 0 "$RC"
assert "(b) piped --local installed the memory tier" test -e "$HOME/.claude/skills/integration-mem0"

# ---------------------------------------------------------------------------
# (c)(d)(e) ownership: user-owned dir backed up, unrelated skill untouched, idempotent
# ---------------------------------------------------------------------------
new_home
S="$HOME/.claude/skills"
mkdir -p "$S/hermes-deploy" "$S/my-own-skill"
echo "precious" >"$S/hermes-deploy/my-notes.txt"
echo "mine" >"$S/my-own-skill/SKILL.md"
ln -s /nonexistent-elsewhere "$S/hermes-fix" # foreign (dangling) symlink
run "$BASH_BIN" "$INSTALL" --local --all --ide=claude
assert_eq "(c) install over user-owned dir exits 0" 0 "$RC"
assert "(c) installer warns about the move" contains "not managed by hstack"
assert "(c) hermes-deploy is now an hstack symlink" test -L "$S/hermes-deploy"
BAK="$(first_dir_backup "$S" hermes-deploy)"
assert "(c) user dir moved to <skills-parent>/.hstack-backups/<stamp>/hermes-deploy" test -d "$BAK"
assert "(c) the warning prints the exact backup path" contains "moved to $BAK"
assert_eq "(c) no backup is left inside the scanned skills dir" 0 "$(count_backups "$S")"
assert "(c) no SKILL.md-bearing backup under the skills dir" test -z "$(find "$S" -name '*hstack-backup*' 2>/dev/null)"
assert "(c) user file preserved in the backup" test "$(cat "$BAK/my-notes.txt" 2>/dev/null)" = "precious"
FBAK="$(first_dir_backup "$S" hermes-fix)"
assert "(c) foreign symlink moved aside, not followed" test -L "$FBAK"
assert "(d) unrelated user skill is untouched (still a real dir)" test -d "$S/my-own-skill" -a ! -L "$S/my-own-skill"
assert "(d) unrelated user skill content intact" test "$(cat "$S/my-own-skill/SKILL.md")" = "mine"
assert_eq "(d) unrelated skill got no backup" 0 "$(count_backups "$S" my-own-skill)"
BEFORE="$(count_dir_backups "$S")"
run "$BASH_BIN" "$INSTALL" --local --all --ide=claude
assert_eq "(e) second run exits 0" 0 "$RC"
assert_eq "(e) second run creates no new backups" "$BEFORE" "$(count_dir_backups "$S")"
assert "(e) second run prints no 'not managed' warning" test "${OUT#*not managed by hstack}" = "$OUT"

# Symlink left by an older ~/.hstack checkout is ours: replaced silently, no backup.
new_home
mkdir -p "$HOME/.hstack/skills/hermes-deploy" "$HOME/.claude/skills"
echo old >"$HOME/.hstack/skills/hermes-deploy/SKILL.md"
ln -s "$HOME/.hstack/skills/hermes-deploy" "$HOME/.claude/skills/hermes-deploy"
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
assert_eq "(e) link into an old ~/.hstack checkout is replaced without a backup" 0 \
  "$(count_dir_backups "$HOME/.claude/skills")"
assert "(e) ...and now points at the checkout being installed" \
  test "$(cd -P "$HOME/.claude/skills/hermes-deploy" && pwd -P)" = "$(cd -P "$ROOT/skills/hermes-deploy" && pwd -P)"

# Copy fallback (no symlinks available): copies carry a marker and are replaced on re-run.
new_home
SHIM="$TMP_BASE/noln"
mkdir -p "$SHIM"
printf '#!/bin/sh\nexit 1\n' >"$SHIM/ln"
chmod +x "$SHIM/ln"
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude,gemini </dev/null 2>&1)"
RC=$?
assert_eq "(e) install without working 'ln' exits 0" 0 "$RC"
assert "(e) copied skill dir carries the .hstack-managed marker" test -f "$HOME/.claude/skills/hermes-deploy/.hstack-managed"
assert "(e) copied gemini file is a regular file with a marker" \
  grep -q 'hstack-managed' "$HOME/.gemini/context/hstack/hermes-deploy.md"
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude,gemini
assert_eq "(e) re-running over marked copies exits 0" 0 "$RC"
assert_eq "(e) ...with no backups for hstack's own copies" 0 \
  "$(( $(count_dir_backups "$HOME/.claude/skills") + $(count_backups "$HOME/.gemini/context/hstack") ))"
assert "(e) ...and the copies became symlinks" test -L "$HOME/.claude/skills/hermes-deploy"

# ---------------------------------------------------------------------------
# (f) instruction files: an unterminated hstack block is never truncated
# ---------------------------------------------------------------------------
check_instr() { # <script> <relative md path>
  local script="$1" rel="$2" before bak
  new_home
  mkdir -p "$HOME/$(dirname "$rel")"
  printf 'my own notes\n<!-- hstack:start -->\nhalf-edited hstack text\nUSER-LINE-AFTER-MARKER\n' >"$HOME/$rel"
  before="$TMP_BASE/before.$$"
  cp "$HOME/$rel" "$before"
  run "$BASH_BIN" "$ROOT/$script"
  assert_eq "(f) $script exits 0 with an unterminated block" 0 "$RC"
  assert "(f) $script leaves $rel byte-identical" cmp -s "$before" "$HOME/$rel"
  assert "(f) $script warns about the missing end marker" contains "no matching"
  assert_eq "(f) $script wrote no backup for an untouched file" 0 "$(count_backups "$(dirname "$HOME/$rel")" "$(basename "$rel")")"

  # Well-formed block: replaced in place, user text kept, backup written, stable on re-run.
  new_home
  mkdir -p "$HOME/$(dirname "$rel")"
  printf 'top\n<!-- hstack:start -->\nstale\n<!-- hstack:end -->\nbottom\n' >"$HOME/$rel"
  run "$BASH_BIN" "$ROOT/$script"
  assert "(f) $script rewrites a well-formed block" test "$(grep -c 'stale' "$HOME/$rel")" = 0
  assert "(f) $script keeps text around the block" test "$(head -1 "$HOME/$rel")" = top -a "$(tail -1 "$HOME/$rel")" = bottom
  bak="$(count_backups "$(dirname "$HOME/$rel")" "$(basename "$rel")")"
  assert_eq "(f) $script backs up before rewriting" 1 "$bak"
  cp "$HOME/$rel" "$before"
  run "$BASH_BIN" "$ROOT/$script"
  assert "(f) $script re-run leaves the file unchanged" cmp -s "$before" "$HOME/$rel"
  assert_eq "(f) $script re-run writes no further backup" 1 "$(count_backups "$(dirname "$HOME/$rel")" "$(basename "$rel")")"
  rm -f "$before"
}
check_instr setup .claude/CLAUDE.md
check_instr setup-codex .agents/AGENTS.md
check_instr setup-gemini .gemini/GEMINI.md
check_instr setup-openclaw .openclaw/AGENTS.md

# ---------------------------------------------------------------------------
# (g) Cursor: user .mdc backed up, symlinked .mdc never written through
# ---------------------------------------------------------------------------
check_cursor() { # <label> <runner...>
  local label="$1" R
  shift
  new_home
  R="$HOME/.cursor/rules"
  mkdir -p "$R" "$HOME/outside"
  echo "my own rule" >"$R/hermes-fix.mdc"
  echo "victim" >"$HOME/outside/victim.txt"
  ln -s "$HOME/outside/victim.txt" "$R/hermes-status.mdc"
  run "$@"
  assert_eq "($label) cursor install exits 0" 0 "$RC"
  assert "($label) user .mdc of the same name was backed up" test "$(cat "$R"/hermes-fix.mdc.hstack-backup-* 2>/dev/null)" = "my own rule"
  assert "($label) hstack rule installed in its place" grep -q 'hstack-managed' "$R/hermes-fix.mdc"
  assert "($label) symlink target outside was NOT overwritten" test "$(cat "$HOME/outside/victim.txt")" = victim
  assert "($label) symlinked .mdc is now a regular hstack file" test ! -L "$R/hermes-status.mdc" -a -f "$R/hermes-status.mdc"
  assert "($label) the old symlink was moved aside intact" test -L "$(first "$R"/hermes-status.mdc.hstack-backup-*)"
  local b
  b="$(count_backups "$R")"
  run "$@"
  assert_eq "($label) cursor re-run creates no new backups" "$b" "$(count_backups "$R")"
  assert_eq "($label) cursor rule count matches skills" "$(skills_total)" "$(ls "$R"/*.mdc | wc -l | tr -d ' ')"
}
check_cursor install.sh "$BASH_BIN" "$INSTALL" --local --all --ide=cursor
check_cursor setup-cursor "$BASH_BIN" "$ROOT/setup-cursor"

# Cursor output keeps the body the original installer generated (frontmatter swap + marker).
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=cursor
MDC="$HOME/.cursor/rules/hermes-deploy.mdc"
assert "(g) .mdc starts with Cursor frontmatter" test "$(head -1 "$MDC")" = "---"
assert "(g) .mdc has alwaysApply: false" grep -q '^alwaysApply: false$' "$MDC"

# ---------------------------------------------------------------------------
# Gemini: a real directory at the destination must not abort the installer
# ---------------------------------------------------------------------------
new_home
G="$HOME/.gemini/context/hstack"
mkdir -p "$G/hermes-deploy.md"
echo keep >"$G/hermes-deploy.md/file"
echo "user ctx" >"$G/hermes-fix.md"
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=gemini
assert_eq "(gemini) install over a real directory exits 0" 0 "$RC"
assert "(gemini) directory kept in a backup" test "$(cat "$G"/hermes-deploy.md.hstack-backup-*/file)" = keep
assert "(gemini) user file kept in a backup" test "$(cat "$G"/hermes-fix.md.hstack-backup-*)" = "user ctx"
assert "(gemini) hstack file installed" test -f "$G/hermes-deploy.md"

# ---------------------------------------------------------------------------
# every setup* script: installs everything, idempotent, user dir backed up
# ---------------------------------------------------------------------------
new_home
mkdir -p "$HOME/.claude/skills/hermes-deploy"
echo "mine" >"$HOME/.claude/skills/hermes-deploy/notes"
for s in setup setup-codex setup-hermes setup-openclaw setup-gemini setup-cursor; do
  run "$BASH_BIN" "$ROOT/$s"
  assert_eq "(setup) $s exits 0" 0 "$RC"
  assert "(setup) $s reports $(skills_total) skills" contains "Registered $(skills_total) skills"
done
assert "(setup) user's same-named dir was backed up by ./setup" \
  test "$(cat "$HOME"/.claude/.hstack-backups/*/hermes-deploy/notes)" = mine
BK="$(count_dir_backups "$HOME/.claude/skills")"
run "$BASH_BIN" "$ROOT/setup-all"
assert_eq "(setup) setup-all exits 0" 0 "$RC"
assert_eq "(setup) setup-all re-run creates no new skill backups" "$BK" "$(count_dir_backups "$HOME/.claude/skills")"
assert_eq "(setup) hermes skills are symlinks" "$(skills_total)" "$(count_links "$HOME/.hermes/skills")"

# ---------------------------------------------------------------------------
# --pick accepts the numbers shown in the menu as well as names
# ---------------------------------------------------------------------------
pick() { # <input>
  new_home
  printf '%s\n' "$1" >"$TMP_BASE/tty"
  OUT="$(HSTACK_TTY="$TMP_BASE/tty" "$BASH_BIN" "$INSTALL" --local --pick --ide=claude </dev/null 2>&1)"
  RC=$?
}
pick "2"
assert "(pick) '2' (memory) installs integration-mem0" test -e "$HOME/.claude/skills/integration-mem0"
assert "(pick) '2' does not install postgres" test ! -e "$HOME/.claude/skills/integration-postgres"
pick "3, 9"
assert "(pick) '3,9' installs database and ai-tools" \
  test -e "$HOME/.claude/skills/integration-supabase" -a -e "$HOME/.claude/skills/integration-elevenlabs"
pick "memory,21"
assert "(pick) names and numbers mix" \
  test -e "$HOME/.claude/skills/integration-mem0" -a -e "$HOME/.claude/skills/integration-tavily"
pick "1"
assert_eq "(pick) '1' installs everything" "$(skills_total)" "$(count_links "$HOME/.claude/skills")"
pick "99"
assert "(pick) out-of-range number warns" contains "unknown menu number"
pick ""
assert "(pick) empty input installs core + platforms only" test ! -e "$HOME/.claude/skills/integration-mem0"

# ---------------------------------------------------------------------------
# data-loss guards. These run against a COPY of the repo (never the real checkout) and
# assert the copy's skills/ tree is byte-identical afterwards.
# ---------------------------------------------------------------------------
REPO_REF="$TMP_BASE/reporef"
mkdir -p "$REPO_REF"
cp -R "$ROOT/skills" "$ROOT/install.sh" "$REPO_REF/"
cp "$ROOT"/setup* "$REPO_REF/"
REPO_N=0
new_repo() { # sets REPO to a fresh pristine copy
  REPO_N=$((REPO_N + 1))
  REPO="$TMP_BASE/repo$REPO_N"
  cp -R "$REPO_REF" "$REPO"
}
# byte-identical to the pristine copy: no diff output at all (some diffs exit 0 on ELOOP) and no symlinks
tree_same() {
  [ -z "$(diff -r -q "$REPO_REF/skills" "$1/skills" 2>&1)" ] && [ -z "$(find "$1/skills" -type l 2>/dev/null)" ]
}
run_in() { # <dir> <cmd...>
  local d="$1"
  shift
  OUT="$(cd "$d" && "$@" 2>&1 </dev/null)"
  RC=$?
}

# (1A) ~/.claude/skills is a symlink to the checkout's skills/
new_home
new_repo
mkdir -p "$HOME/.claude"
ln -s "$REPO/skills" "$HOME/.claude/skills"
run "$BASH_BIN" "$REPO/setup"
assert "(1A) ./setup refuses a skills dir that is the checkout's skills/ (exit != 0)" test "$RC" -ne 0
assert "(1A) ...with a clear message" contains "refusing to install"
assert "(1A) ...and the checkout's skills/ is byte-identical" tree_same "$REPO"
run "$BASH_BIN" "$REPO/install.sh" --local --all --ide=claude
assert "(1A) install.sh --local refuses it too (exit != 0)" test "$RC" -ne 0
assert "(1A) ...checkout intact" tree_same "$REPO"
mkdir -p "$HOME/.cursor"
ln -s "$REPO/skills" "$HOME/.cursor/rules"
run "$BASH_BIN" "$REPO/setup-cursor"
assert "(1A) setup-cursor refuses a rules dir that is the checkout's skills/" test "$RC" -ne 0
assert "(1A) ...nothing was written into the checkout" tree_same "$REPO"

# (1B) relative path overrides resolve against the invoking directory, not the checkout
new_home
new_repo
mkdir -p "$TMP_BASE/work$REPO_N"
run_in "$TMP_BASE/work$REPO_N" env CLAUDE_SKILLS_DIR=out "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude
assert_eq "(1B) relative CLAUDE_SKILLS_DIR=out installs fine" 0 "$RC"
assert "(1B) ...into ./out of the invoking directory" test -e "$TMP_BASE/work$REPO_N/out/integration-mem0"
assert "(1B) ...not into the checkout" test ! -e "$REPO/out"
assert "(1B) checkout intact" tree_same "$REPO"
run_in "$REPO" env CLAUDE_SKILLS_DIR=skills "$BASH_BIN" install.sh --local --tier=memory --ide=claude
assert "(1B) CLAUDE_SKILLS_DIR=skills (relative, from the checkout) is refused" test "$RC" -ne 0
assert "(1B) ...and no skill was deleted" tree_same "$REPO"
run_in "$REPO" env CLAUDE_SKILLS_DIR=skills "$BASH_BIN" setup
assert "(1B) same for ./setup" test "$RC" -ne 0
assert "(1B) ...checkout intact after ./setup" tree_same "$REPO"
# setup-all cd's into the checkout: relative overrides must have been made absolute BEFORE that
mkdir -p "$TMP_BASE/work-all"
run_in "$TMP_BASE/work-all" env CLAUDE_SKILLS_DIR=rel-out CURSOR_RULES_DIR=rel-rules "$BASH_BIN" "$REPO/setup-all"
assert_eq "(1B) setup-all with relative overrides exits 0" 0 "$RC"
assert "(1B) setup-all: CLAUDE_SKILLS_DIR=rel-out lands in ./rel-out of the invoking dir" test -e "$TMP_BASE/work-all/rel-out/hermes-deploy"
assert "(1B) setup-all: CURSOR_RULES_DIR=rel-rules lands in ./rel-rules of the invoking dir" test -e "$TMP_BASE/work-all/rel-rules/hermes-deploy.mdc"
assert "(1B) setup-all: nothing was created inside the checkout" test ! -e "$REPO/rel-out" -a ! -e "$REPO/rel-rules"
assert "(1B) setup-all: checkout intact" tree_same "$REPO"
run_in "$REPO" env CLAUDE_SKILLS_DIR=skills "$BASH_BIN" setup-all
assert "(1B) setup-all with CLAUDE_SKILLS_DIR=skills run from the checkout fails (refused)" test "$RC" -ne 0
assert "(1B) ...and the checkout is intact" tree_same "$REPO"

# (2) a hstack copy the user edited is NOT owned: backed up, never overwritten silently.
new_home
new_repo
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude,gemini,cursor </dev/null 2>&1)"
RC=$?
assert_eq "(2) copy install (no 'ln') exits 0" 0 "$RC"
C="$HOME/.claude/skills"
G="$HOME/.gemini/context/hstack"
R="$HOME/.cursor/rules"
echo "my tweak" >>"$C/hermes-deploy/SKILL.md"
echo "extra user file" >"$C/hermes-fix/extra.txt"
echo "my gemini note" >>"$G/hermes-deploy.md"
echo "my cursor note" >>"$R/hermes-deploy.mdc"
run "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude,gemini,cursor
assert_eq "(2) re-install over edited copies exits 0" 0 "$RC"
assert "(2) edited SKILL.md preserved in a backup" grep -q "my tweak" "$(first_dir_backup "$C" hermes-deploy)/SKILL.md"
assert "(2) extra user file preserved in a backup" test "$(cat "$(first_dir_backup "$C" hermes-fix)/extra.txt")" = "extra user file"
assert_eq "(2) only the two edited dirs were backed up" 2 "$(count_dir_backups "$C")"
assert "(2) edited gemini copy preserved" grep -q "my gemini note" "$G"/hermes-deploy.md.hstack-backup-*
assert "(2) edited .mdc preserved" grep -q "my cursor note" "$R"/hermes-deploy.mdc.hstack-backup-*
assert_eq "(2) untouched gemini copies were not backed up" 1 "$(count_backups "$G")"
assert_eq "(2) untouched .mdc files were not backed up" 1 "$(count_backups "$R")"

# (2b) an unedited copy from an OLDER hstack version is still ours: upgrades make no backups
new_home
new_repo
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude,gemini,cursor </dev/null 2>&1)"
echo "new upstream line" >>"$REPO/skills/hermes-deploy/SKILL.md"
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude,gemini,cursor </dev/null 2>&1)"
RC=$?
assert_eq "(2b) upgrade over unedited copies exits 0" 0 "$RC"
assert_eq "(2b) ...with no backups at all" 0 \
  "$(( $(count_dir_backups "$HOME/.claude/skills") + $(count_backups "$HOME/.gemini/context/hstack") + $(count_backups "$HOME/.cursor/rules") ))"
assert "(2b) ...and the new content arrived (dir copy)" grep -q "new upstream line" "$HOME/.claude/skills/hermes-deploy/SKILL.md"
assert "(2b) ...(gemini copy)" grep -q "new upstream line" "$HOME/.gemini/context/hstack/hermes-deploy.md"
assert "(2b) ...(.mdc)" grep -q "new upstream line" "$HOME/.cursor/rules/hermes-deploy.mdc"

# (2c) the marker records "sha256:<digest>"; an EMPTY legacy marker falls back to match-the-source
new_home
new_repo
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude </dev/null 2>&1)"
case "$(cat "$HOME/.claude/skills/hermes-deploy/.hstack-managed")" in
  sha256:* | cksum:*) pass "(2c) copy marker holds a digest" ;;
  *) fail "(2c) copy marker holds a digest" "$(cat "$HOME/.claude/skills/hermes-deploy/.hstack-managed")" ;;
esac
: >"$HOME/.claude/skills/hermes-deploy/.hstack-managed"
: >"$HOME/.claude/skills/hermes-fix/.hstack-managed"
echo "edited" >>"$HOME/.claude/skills/hermes-fix/SKILL.md"
run "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude
assert_eq "(2c) legacy empty marker + dir equal to the source: replaced silently, edited one backed up" 1 "$(count_dir_backups "$HOME/.claude/skills")"
assert "(2c) ...the backed-up one is the edited dir" test -d "$(first_dir_backup "$HOME/.claude/skills" hermes-fix)"

# (2d) a user-added empty dir, symlink or nested ".hstack-managed" file makes a copy "edited"
new_home
new_repo
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude </dev/null 2>&1)"
C="$HOME/.claude/skills"
mkdir "$C/hermes-deploy/emptydir"
ln -s /etc/hostname "$C/hermes-fix/lnk"
echo mine >"$C/blueprint-install/scripts/.hstack-managed"
run "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=claude
assert_eq "(2d) edited copies (empty dir, symlink, nested marker) were backed up" 3 "$(count_dir_backups "$C")"
assert "(2d) empty user dir preserved" test -d "$(first_dir_backup "$C" hermes-deploy)/emptydir"
assert "(2d) user symlink preserved" test -L "$(first_dir_backup "$C" hermes-fix)/lnk"
assert "(2d) nested user .hstack-managed preserved" test "$(cat "$(first_dir_backup "$C" blueprint-install)/scripts/.hstack-managed")" = mine

# (4b) a user note shaped like our marker is an edit, not a marker
new_home
new_repo
OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=gemini,cursor </dev/null 2>&1)"
echo "<!-- hstack-managed my note -->" >>"$HOME/.gemini/context/hstack/hermes-deploy.md"
echo "<!-- hstack-managed my note -->" >>"$HOME/.cursor/rules/hermes-deploy.mdc"
run "$BASH_BIN" "$REPO/install.sh" --local --tier=memory --ide=gemini,cursor
assert "(4b) gemini copy with a look-alike note is backed up" grep -q "my note" "$HOME"/.gemini/context/hstack/hermes-deploy.md.hstack-backup-*
assert "(4b) .mdc with a look-alike note is backed up" grep -q "my note" "$HOME"/.cursor/rules/hermes-deploy.mdc.hstack-backup-*
assert_eq "(4b) only those two were backed up" 2 "$(( $(count_backups "$HOME/.gemini/context/hstack") + $(count_backups "$HOME/.cursor/rules") ))"

# (8) a backup that cannot be made must never end with the user's content overwritten
RO_OK=1
mkdir -p "$TMP_BASE/probe"
chmod 555 "$TMP_BASE/probe"
if [ -w "$TMP_BASE/probe" ]; then RO_OK=0; fi
chmod 755 "$TMP_BASE/probe"
same_text() { [ "$(cat "$1" 2>/dev/null)" = "$2" ]; }
intact_dir() { # <dir>: still a real dir holding only f=precious
  [ -d "$1" ] && [ ! -L "$1" ] && same_text "$1/f" precious && [ "$(ls -A "$1" | wc -l | tr -d ' ')" = 1 ]
}
if [ "$RO_OK" = 1 ]; then
  new_home
  R="$HOME/.cursor/rules"
  mkdir -p "$R"
  echo "my own rule" >"$R/hermes-fix.mdc"
  chmod 555 "$R"
  run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=cursor
  assert "(8) 555 rules dir: install.sh exits non-zero" test "$RC" -ne 0
  assert "(8) 555 rules dir: user .mdc byte-identical" same_text "$R/hermes-fix.mdc" "my own rule"
  assert "(8) 555 rules dir: clear warning, no false 'moved'" contains "cannot move"
  assert "(8) ...never claims it moved the file" test "${OUT#*hermes-fix.mdc is not managed by hstack - moved}" = "$OUT"
  run "$BASH_BIN" "$ROOT/setup-cursor"
  assert "(8) 555 rules dir: setup-cursor exits non-zero, file intact" test "$RC" -ne 0 -a "$(cat "$R/hermes-fix.mdc")" = "my own rule"
  chmod 755 "$R"

  new_home
  G="$HOME/.gemini/context/hstack"
  mkdir -p "$G"
  echo "user ctx" >"$G/hermes-fix.md"
  chmod 555 "$G"
  run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=gemini
  assert "(8) 555 gemini dir: install.sh exits non-zero, user .md byte-identical" test "$RC" -ne 0 -a "$(cat "$G/hermes-fix.md")" = "user ctx"
  OUT="$(chmod 555 "$G"; PATH="$SHIM:$PATH" "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=gemini </dev/null 2>&1)"
  RC=$?
  assert "(8) 555 gemini dir + no 'ln' (copy path): non-zero, user .md byte-identical" test "$RC" -ne 0 -a "$(cat "$G/hermes-fix.md")" = "user ctx"
  run "$BASH_BIN" "$ROOT/setup-gemini"
  assert "(8) 555 gemini dir: setup-gemini non-zero, file intact" test "$RC" -ne 0 -a "$(cat "$G/hermes-fix.md")" = "user ctx"
  chmod 755 "$G"
fi

blocked_backup_case() { # <label> <block-fn> <unblock-fn>
  local label="$1" variant
  for variant in link copy; do
    new_home
    local S="$HOME/.claude/skills"
    mkdir -p "$S/hermes-deploy"
    echo precious >"$S/hermes-deploy/f"
    "$2"
    if [ "$variant" = copy ]; then
      OUT="$(PATH="$SHIM:$PATH" "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude </dev/null 2>&1)"
      RC=$?
    else
      run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
    fi
    assert "(8) $label/$variant: exits non-zero" test "$RC" -ne 0
    assert "(8) $label/$variant: user skill dir untouched (no link inside, no hstack files mixed in)" intact_dir "$S/hermes-deploy"
    assert "(8) $label/$variant: warns" contains "left untouched"
    run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
    assert "(8) $label/$variant: second run after the failed one still deletes nothing" intact_dir "$S/hermes-deploy"
    "$3"
    run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
    assert "(8) $label/$variant: once the problem is fixed the content is backed up" same_text "$(first_dir_backup "$S" hermes-deploy)/f" precious
  done
}
block_file() { echo x >"$HOME/.claude/.hstack-backups"; }
unblock_file() { rm -f "$HOME/.claude/.hstack-backups"; }
block_dangling() { ln -s /nonexistent/zzz "$HOME/.claude/.hstack-backups"; }
unblock_dangling() { rm -f "$HOME/.claude/.hstack-backups"; }
block_ro_dir() { mkdir -p "$HOME/.claude/.hstack-backups"; chmod 555 "$HOME/.claude/.hstack-backups"; }
unblock_ro_dir() { chmod 755 "$HOME/.claude/.hstack-backups"; }
block_ro_parent() { chmod 555 "$HOME/.claude"; }
unblock_ro_parent() { chmod 755 "$HOME/.claude"; }
blocked_backup_case ".hstack-backups is a file" block_file unblock_file
blocked_backup_case ".hstack-backups dangling symlink" block_dangling unblock_dangling
if [ "$RO_OK" = 1 ]; then
  blocked_backup_case ".hstack-backups is a 555 dir" block_ro_dir unblock_ro_dir
  blocked_backup_case "unwritable parent (555 ~/.claude)" block_ro_parent unblock_ro_parent
else
  printf 'SKIP: chmod-based backup-failure tests (running with privileges that ignore file modes)\n'
fi

# (9) setup-all reports failures (but still runs every child)
OUT="$(env -u HOME "$BASH_BIN" "$ROOT/setup-all" </dev/null 2>&1)"
RC=$?
assert_eq "(9) setup-all exits 1 when its children fail" 1 "$RC"
assert_eq "(9) ...after running all six children" 6 "$(printf '%s\n' "$OUT" | grep -c 'WARN: setup.* failed')"

# (3) read-only instruction file: skipped with a warning, no false "Added", no backup, exit 0
new_home
mkdir -p "$HOME/.claude"
echo "my notes" >"$HOME/.claude/CLAUDE.md"
chmod 444 "$HOME/.claude/CLAUDE.md"
if [ -w "$HOME/.claude/CLAUDE.md" ]; then
  printf 'SKIP: read-only tests (running with privileges that ignore file modes)\n'
else
  cat "$HOME/.claude/CLAUDE.md" >"$TMP_BASE/ro.before"
  run "$BASH_BIN" "$ROOT/setup"
  assert_eq "(3) ./setup exits 0 with a read-only CLAUDE.md" 0 "$RC"
  assert "(3) says it is not writable" contains "not writable"
  assert "(3) does not claim it added the section" test "${OUT#*Added hstack section}" = "$OUT"
  assert "(3) file unchanged" cmp -s "$TMP_BASE/ro.before" "$HOME/.claude/CLAUDE.md"
  chmod 644 "$HOME/.claude/CLAUDE.md"
  printf 'a\n<!-- hstack:start -->\nold\n<!-- hstack:end -->\nb\n' >"$HOME/.claude/CLAUDE.md"
  chmod 444 "$HOME/.claude/CLAUDE.md"
  cat "$HOME/.claude/CLAUDE.md" >"$TMP_BASE/ro.before"
  run "$BASH_BIN" "$ROOT/setup"
  assert_eq "(3) ./setup exits 0 with a read-only file holding a valid block" 0 "$RC"
  assert "(3) valid-block file unchanged" cmp -s "$TMP_BASE/ro.before" "$HOME/.claude/CLAUDE.md"
  run "$BASH_BIN" "$ROOT/setup"
  assert_eq "(3) no backups are made (or piled up on re-runs)" 0 "$(count_backups "$HOME/.claude" CLAUDE.md)"
  chmod 644 "$HOME/.claude/CLAUDE.md"
fi

# (4) dangling links left by a removed old checkout are ours: replaced silently
new_home
mkdir -p "$HOME/.claude/skills" "$HOME/.gemini/context/hstack"
ln -s /gone/.hstack/skills/hermes-deploy "$HOME/.claude/skills/hermes-deploy"
ln -s /gone/.hstack/skills/hermes-deploy/SKILL.md "$HOME/.gemini/context/hstack/hermes-deploy.md"
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude,gemini
assert_eq "(4) install over dangling old-checkout links exits 0" 0 "$RC"
assert_eq "(4) ...with no backups" 0 "$(( $(count_dir_backups "$HOME/.claude/skills") + $(count_backups "$HOME/.gemini/context/hstack") ))"
assert "(4) ...and the links now resolve" test -f "$HOME/.claude/skills/hermes-deploy/SKILL.md" -a -f "$HOME/.gemini/context/hstack/hermes-deploy.md"

# (5b) two backups of the same name in the same second get distinct directories
new_home
mkdir -p "$HOME/.claude/skills/hermes-deploy"
echo one >"$HOME/.claude/skills/hermes-deploy/f"
HS_STAMP=20000101000000 run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
rm "$HOME/.claude/skills/hermes-deploy"
mkdir -p "$HOME/.claude/skills/hermes-deploy"
echo two >"$HOME/.claude/skills/hermes-deploy/f"
HS_STAMP=20000101000000 run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude
assert "(5) same-second backups do not collide" \
  test "$(cat "$HOME/.claude/.hstack-backups/20000101000000/hermes-deploy/f")" = one -a "$(cat "$HOME/.claude/.hstack-backups/20000101000000-1/hermes-deploy/f")" = two

# (6) CRLF instruction files
new_home
mkdir -p "$HOME/.claude"
printf 'top\r\n<!-- hstack:start -->\r\nstale\r\n<!-- hstack:end -->\r\nbottom\r\n' >"$HOME/.claude/CLAUDE.md"
run "$BASH_BIN" "$ROOT/setup"
assert_eq "(6) CRLF block is replaced, not duplicated" 1 "$(grep -c 'hstack:start' "$HOME/.claude/CLAUDE.md")"
assert "(6) ...stale text gone, surrounding text kept" test "$(grep -c stale "$HOME/.claude/CLAUDE.md")" = 0 -a "$(grep -c '^top' "$HOME/.claude/CLAUDE.md")" = 1
new_home
mkdir -p "$HOME/.claude"
printf 'x\r\n<!-- hstack:start -->\r\nfoo\r\nUSER\r\n' >"$HOME/.claude/CLAUDE.md"
cp "$HOME/.claude/CLAUDE.md" "$TMP_BASE/crlf.before"
run "$BASH_BIN" "$ROOT/setup"
assert "(6) unterminated CRLF block is left byte-identical" cmp -s "$TMP_BASE/crlf.before" "$HOME/.claude/CLAUDE.md"

# (7) HOME handling
OUT="$(env -u HOME "$BASH_BIN" "$INSTALL" --help 2>&1)"
RC=$?
assert_eq "(7) --help works with HOME unset" 0 "$RC"
assert "(7) ...and prints usage" contains "Usage:"
for h in UNSET EMPTY relative/path; do
  case "$h" in
    UNSET) OUT="$(env -u HOME "$BASH_BIN" "$INSTALL" --local --all </dev/null 2>&1)" ;;
    EMPTY) OUT="$(HOME='' "$BASH_BIN" "$INSTALL" --local --all </dev/null 2>&1)" ;;
    *) OUT="$(HOME="$h" "$BASH_BIN" "$INSTALL" --local --all </dev/null 2>&1)" ;;
  esac
  RC=$?
  assert_eq "(7) install.sh with HOME=$h exits 2" 2 "$RC"
  assert "(7) ...with a clear message" contains "HOME must be set to an absolute path"
done
OUT="$(HOME='' "$BASH_BIN" "$ROOT/setup" </dev/null 2>&1)"
RC=$?
assert_eq "(7) ./setup with empty HOME exits 2" 2 "$RC"
OUT="$(env -u HOME "$BASH_BIN" "$ROOT/setup-cursor" </dev/null 2>&1)"
RC=$?
assert_eq "(7) ./setup-cursor with HOME unset exits 2" 2 "$RC"

# (10) A: the instruction-file write never truncates in place; a failure keeps the backup.
FSHIM="$TMP_BASE/failshim"
mkdir -p "$FSHIM"
# cat: writes 100 bytes of a hstack temp/source file, then fails (like ENOSPC/EIO mid-write)
cat >"$FSHIM/cat" <<'SHIMEOF'
#!/bin/sh
case "$*" in
  *hstack-md.* | *hstack-mdc.* | */SKILL.md*) head -c 100 "$@"; exit 1 ;;
esac
exec /bin/cat "$@"
SHIMEOF
# mv: refuses to move over an instruction file
cat >"$FSHIM/mv" <<'SHIMEOF'
#!/bin/sh
case "$*" in
  *.hstack-new.*) exit 1 ;;
esac
exec /bin/mv "$@"
SHIMEOF
# cp: refuses to make the working copy next to the original
cat >"$FSHIM/cp" <<'SHIMEOF'
#!/bin/sh
case "$*" in
  *.hstack-new.*) exit 1 ;;
esac
exec /bin/cp "$@"
SHIMEOF
chmod +x "$FSHIM/cat" "$FSHIM/mv" "$FSHIM/cp"

fail_write_case() { # <script> <rel md path> <shim name> <with block: 1|0>
  local script="$1" rel="$2" shim="$3" withblock="$4" before nbak
  new_home
  mkdir -p "$HOME/$(dirname "$rel")"
  if [ "$withblock" = 1 ]; then
    printf 'USERHEAD\n<!-- hstack:start -->\nstale\n<!-- hstack:end -->\nUSERTAIL\n' >"$HOME/$rel"
  else
    printf 'USERHEAD\nUSERTAIL\n' >"$HOME/$rel"
  fi
  before="$TMP_BASE/fw.before"
  cat "$HOME/$rel" >"$before"
  OUT="$(PATH="$FSHIM:$PATH" "$BASH_BIN" "$ROOT/$script" </dev/null 2>&1)"
  RC=$?
  # the shim dir only holds the failing tool under test: remove the others for this call
  assert "(10) $script/$shim/block=$withblock: exits non-zero" test "$RC" -ne 0
  assert "(10) $script/$shim/block=$withblock: original byte-identical" cmp -s "$before" "$HOME/$rel"
  assert "(10) $script/$shim/block=$withblock: honest message" contains "write failed"
  nbak="$(count_backups "$(dirname "$HOME/$rel")" "$(basename "$rel")")"
  if [ "$withblock" = 1 ]; then
    assert_eq "(10) $script/$shim: backup kept" 1 "$nbak"
    assert "(10) $script/$shim: ...holds the original" cmp -s "$before" "$(first "$(dirname "$HOME/$rel")/$(basename "$rel")".hstack-backup-*)"
    assert "(10) $script/$shim: ...and its exact path is printed" contains "$(first "$(dirname "$HOME/$rel")/$(basename "$rel")".hstack-backup-*)"
  fi
  assert "(10) $script/$shim: no stray temp file left next to it" test -z "$(find "$(dirname "$HOME/$rel")" -maxdepth 1 -name '.hstack-new.*')"
}
only_shim() { # <tool>: a PATH dir containing just that failing tool
  rm -rf "$TMP_BASE/only"
  mkdir -p "$TMP_BASE/only"
  cp "$FSHIM/$1" "$TMP_BASE/only/$1"
  FSHIM_SAVE="$FSHIM"
  FSHIM="$TMP_BASE/only"
}
for tool in cat mv cp; do
  only_shim "$tool"
  fail_write_case setup .claude/CLAUDE.md "$tool" 1
  fail_write_case setup .claude/CLAUDE.md "$tool" 0
  if [ "$tool" = cat ]; then
    fail_write_case setup-codex .agents/AGENTS.md "$tool" 1
    fail_write_case setup-gemini .gemini/GEMINI.md "$tool" 1
    fail_write_case setup-openclaw .openclaw/AGENTS.md "$tool" 1
  fi
  FSHIM="$FSHIM_SAVE"
done

# success path: mode preserved, backup made once, re-run is quiet
new_home
mkdir -p "$HOME/.claude"
printf 'USERHEAD\n<!-- hstack:start -->\nstale\n<!-- hstack:end -->\nUSERTAIL\n' >"$HOME/.claude/CLAUDE.md"
chmod 640 "$HOME/.claude/CLAUDE.md"
MODE_BEFORE="$(ls -l "$HOME/.claude/CLAUDE.md" | cut -c1-10)"
run "$BASH_BIN" "$ROOT/setup"
assert_eq "(10) success path: exits 0" 0 "$RC"
assert_eq "(10) success path: mode preserved" "$MODE_BEFORE" "$(ls -l "$HOME/.claude/CLAUDE.md" | cut -c1-10)"
assert "(10) success path: user text kept" test "$(head -1 "$HOME/.claude/CLAUDE.md")" = USERHEAD -a "$(tail -1 "$HOME/.claude/CLAUDE.md")" = USERTAIL
assert_eq "(10) success path: one backup" 1 "$(count_backups "$HOME/.claude" CLAUDE.md)"
run "$BASH_BIN" "$ROOT/setup"
assert_eq "(10) success path: re-run makes no further backup" 1 "$(count_backups "$HOME/.claude" CLAUDE.md)"
assert "(10) success path: no stray temp files" test -z "$(find "$HOME/.claude" -maxdepth 1 -name '.hstack-new.*')"

# (10) B: a write that fails midway after the user's file was moved aside leaves no stub
only_shim cat
new_home
R="$HOME/.cursor/rules"
mkdir -p "$R"
echo "my own rule" >"$R/hermes-fix.mdc"
OUT="$(PATH="$FSHIM:$PATH" "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=cursor </dev/null 2>&1)"
RC=$?
assert "(10) cursor partial write: exits non-zero" test "$RC" -ne 0
assert "(10) cursor partial write: explicit write error" contains "write error"
assert "(10) cursor partial write: no partial .mdc stub left" test ! -e "$R/hermes-fix.mdc"
assert_eq "(10) cursor partial write: no stubs for any rule" 0 "$(ls "$R"/*.mdc 2>/dev/null | wc -l | tr -d ' ')"
assert "(10) cursor partial write: user's rule is in its backup" test "$(cat "$R"/hermes-fix.mdc.hstack-backup-* 2>/dev/null)" = "my own rule"
new_home
G="$HOME/.gemini/context/hstack"
mkdir -p "$G"
echo "user ctx" >"$G/hermes-fix.md"
OUT="$(PATH="$FSHIM:$SHIM:$PATH" "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=gemini </dev/null 2>&1)"
RC=$?
assert "(10) gemini partial copy: exits non-zero" test "$RC" -ne 0
assert "(10) gemini partial copy: explicit write error" contains "write error"
assert "(10) gemini partial copy: no stub left at the destination" test ! -e "$G/hermes-fix.md"
assert "(10) gemini partial copy: user's file is in its backup" test "$(cat "$G"/hermes-fix.md.hstack-backup-* 2>/dev/null)" = "user ctx"
FSHIM="$TMP_BASE/failshim"

# ---------------------------------------------------------------------------
# misc: unknown IDE names are warnings, unknown flags are errors, --ide filter
# ---------------------------------------------------------------------------
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude,bogus
assert_eq "(misc) an unknown IDE next to a valid one is a warning, not an error" 0 "$RC"
assert "(misc) unknown IDE warned" contains "unknown IDE 'bogus'"
assert "(misc) only the requested IDE is wired" test ! -e "$HOME/.agents"
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=claude --frobnicate
assert_eq "(misc) unknown flag exits 2" 2 "$RC"
assert "(misc) unknown flag is named" contains "unknown flag or argument '--frobnicate'"
assert "(misc) unknown flag prints the usage" contains "Usage:"
assert "(misc) unknown flag installs nothing" test ! -e "$HOME/.claude"
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory
assert_eq "(misc) with no IDE present: exit 0 and nothing written" 0 "$RC"
assert "(misc) says no IDEs detected" contains "No IDEs"

# ---------------------------------------------------------------------------
# (11) flag parsing: space form, missing values, --ide=bogus, precedence, --pick without a tty
# ---------------------------------------------------------------------------
new_home
run "$BASH_BIN" "$INSTALL" --local --tier memory --ide claude
assert_eq "(11) '--tier memory --ide claude' (space form) exits 0" 0 "$RC"
assert "(11) space form honoured: memory tier installed" test -e "$HOME/.claude/skills/integration-mem0"
assert "(11) space form honoured: other tiers NOT installed" test ! -e "$HOME/.claude/skills/integration-stripe"
new_home
run "$BASH_BIN" "$INSTALL" --local --include notion --ide codex
assert_eq "(11) '--include notion --ide codex' exits 0" 0 "$RC"
assert "(11) '--ide codex' wired codex only" test -e "$HOME/.agents/skills/integration-notion" -a ! -e "$HOME/.claude"
assert "(11) '--include notion' did not widen to everything" test ! -e "$HOME/.agents/skills/integration-stripe"
new_home
run "$BASH_BIN" "$INSTALL" --local --ide claude --tier
assert_eq "(11) a trailing '--tier' with no value exits 2" 2 "$RC"
assert "(11) ...and says it needs a value" contains "needs a value"
assert "(11) ...and installs nothing" test ! -e "$HOME/.claude"
new_home
run "$BASH_BIN" "$INSTALL" --local --tier --ide=claude
assert_eq "(11) '--tier --ide=claude' (flag where the value should be) exits 2" 2 "$RC"
assert "(11) ...and installs nothing" test ! -e "$HOME/.claude"
new_home
run "$BASH_BIN" "$INSTALL" --local --tier= --ide=claude
assert_eq "(11) an empty '--tier=' exits 2" 2 "$RC"
new_home
run "$BASH_BIN" "$INSTALL" --local --ide=bogus --tier=memory
assert_eq "(11) '--ide=bogus' with no valid IDE left exits 2 (not 0)" 2 "$RC"
assert "(11) ...and says no valid IDE" contains "no valid IDE"
assert "(11) ...and writes nothing" test -z "$(ls -A "$HOME")"
new_home
run "$BASH_BIN" "$INSTALL" --local --ide=bogus,nope --tier=memory
assert_eq "(11) several unknown IDEs and no valid one exits 2" 2 "$RC"
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory --include=notion --ide=claude
assert_eq "(11) --include with --tier exits 0" 0 "$RC"
assert "(11) --include overriding --tier is warned about" contains "--include overrides --tier"
assert "(11) --include wins: notion installed, memory tier not" test -e "$HOME/.claude/skills/integration-notion" -a ! -e "$HOME/.claude/skills/integration-mem0"
new_home
run "$BASH_BIN" "$INSTALL" --local --all --tier=memory --ide=claude
assert "(11) --all with --tier is warned about" contains "--all given: ignoring"
assert_eq "(11) --all wins" "$(skills_total)" "$(count_links "$HOME/.claude/skills")"

# --pick without any terminal (new session: no controlling tty) falls back to --all
no_tty() { # <cmd...>: run in a new session, stdin from /dev/null
  if command -v python3 >/dev/null 2>&1; then
    OUT="$(python3 -c 'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" 2>&1 </dev/null)"
  elif command -v setsid >/dev/null 2>&1; then
    # util-linux needs -w to wait for the child; busybox has no -w (and does not fork here)
    if setsid -w true >/dev/null 2>&1; then
      OUT="$(setsid -w "$@" 2>&1 </dev/null)"
    else
      OUT="$(setsid "$@" 2>&1 </dev/null)"
    fi
  else
    OUT=""
    RC=127
    return 127
  fi
  RC=$?
}
new_home
if no_tty "$BASH_BIN" "$INSTALL" --local --pick --ide=claude; then :; fi
if [ "$RC" = 127 ]; then
  printf 'SKIP: (11) --pick without a tty: neither python3 nor setsid available\n'
else
  assert_eq "(11) --pick without a tty exits 0" 0 "$RC"
  assert "(11) ...with no raw /dev/tty error" test "${OUT#*/dev/tty}" = "$OUT"
  assert "(11) ...and says it falls back to --all" contains "falling back to --all"
  assert_eq "(11) ...and installs every skill (the documented fallback)" "$(skills_total)" "$(count_links "$HOME/.claude/skills")"
fi

# ---------------------------------------------------------------------------
# (12) --branch on an existing depth-1 checkout; clone and update failures (local bare repo)
# ---------------------------------------------------------------------------
if command -v git >/dev/null 2>&1; then
  gitc() {
    GIT_AUTHOR_NAME=Anonymous GIT_AUTHOR_EMAIL=anonymous@example.invalid \
      GIT_COMMITTER_NAME=Anonymous GIT_COMMITTER_EMAIL=anonymous@example.invalid \
      GIT_CONFIG_NOSYSTEM=1 git "$@"
  }
  new_home # git reads no global config from the real home
  GW="$TMP_BASE/gitwork"
  GB="$TMP_BASE/gitbare.git"
  GI="$TMP_BASE/gitinst"
  mkdir -p "$GW"
  cp -R "$ROOT/skills" "$GW/skills"
  gitc -C "$GW" init -q
  gitc -C "$GW" symbolic-ref HEAD refs/heads/main
  gitc -C "$GW" add -A >/dev/null
  gitc -C "$GW" commit -q -m base
  gitc init -q --bare "$GB"
  gitc -C "$GB" symbolic-ref HEAD refs/heads/main
  gitc -C "$GW" push -q "file://$GB" main
  gitc -C "$GW" checkout -q -b devbranch
  echo "DEV-BRANCH-MARKER" >>"$GW/skills/hermes-deploy/SKILL.md"
  gitc -C "$GW" commit -q -am dev
  gitc -C "$GW" push -q "file://$GB" devbranch
  gitc -C "$GW" checkout -q main
  inst() { # <install.sh args...>: install from the bare repo into $GI
    run env HSTACK_REPO_URL="file://$GB" HSTACK_INSTALL_DIR="$GI" "$BASH_BIN" "$INSTALL" "$@"
  }
  head_of() { gitc -C "$GI" symbolic-ref --short HEAD 2>/dev/null; }
  inst --tier=memory --ide=claude
  assert_eq "(12) first install clones main" 0 "$RC"
  assert_eq "(12) ...checkout is on main" main "$(head_of)"
  inst --tier=memory --ide=claude --branch=devbranch
  assert_eq "(12) --branch=devbranch on the existing depth-1 checkout exits 0" 0 "$RC"
  assert_eq "(12) ...the checkout is now on devbranch" devbranch "$(head_of)"
  assert "(12) ...and the installed skills come from devbranch" grep -q DEV-BRANCH-MARKER "$HOME/.claude/skills/hermes-deploy/SKILL.md"
  assert "(12) ...without a 'Could not fast-forward' warning" test "${OUT#*Could not fast-forward}" = "$OUT"
  inst --tier=memory --ide=claude --branch main
  assert_eq "(12) switching back (space form) exits 0" 0 "$RC"
  assert_eq "(12) ...checkout is on main again" main "$(head_of)"
  assert "(12) ...and the devbranch change is gone" test "$(grep -c DEV-BRANCH-MARKER "$HOME/.claude/skills/hermes-deploy/SKILL.md")" = 0
  inst --tier=memory --ide=claude --branch=no-such-branch
  assert "(12) a branch that does not exist exits non-zero" test "$RC" -ne 0
  assert "(12) ...says it could not switch" contains "Could not switch"
  assert "(12) ...and does not claim the checkout is ready" test "${OUT#*checkout ready}" = "$OUT"
  assert_eq "(12) ...the checkout stays on main" main "$(head_of)"
  inst --tier=memory --ide=claude '--branch=-x'
  assert "(12) an option-like branch name is rejected" test "$RC" -ne 0
  # a new commit on the same branch is fast-forwarded
  echo "NEW-ON-MAIN" >"$GW/skills/hermes-deploy/NEWFILE"
  gitc -C "$GW" add -A >/dev/null
  gitc -C "$GW" commit -q -m more
  gitc -C "$GW" push -q "file://$GB" main
  inst --tier=memory --ide=claude
  assert_eq "(12) updating the same branch exits 0" 0 "$RC"
  assert "(12) ...and fast-forwards it" test -f "$GI/skills/hermes-deploy/NEWFILE"
  # fetch failure on the branch we are already on: warn and continue with the old checkout
  gitc -C "$GI" remote set-url origin "$TMP_BASE/does-not-exist.git"
  inst --tier=memory --ide=claude
  assert_eq "(12) offline update of the current branch: exits 0" 0 "$RC"
  assert "(12) ...with the 'Could not fast-forward' warning" contains "Could not fast-forward"
  # clone failure is an error, not "checkout ready"
  run env HSTACK_REPO_URL="file://$TMP_BASE/nope.git" HSTACK_INSTALL_DIR="$TMP_BASE/gitinst2" "$BASH_BIN" "$INSTALL" --tier=memory --ide=claude
  assert "(12) a failed clone exits non-zero" test "$RC" -ne 0
  assert "(12) ...says the clone failed" contains "git clone of"
  assert "(12) ...and never says 'checkout ready'" test "${OUT#*checkout ready}" = "$OUT"
else
  printf 'SKIP: (12) git not installed: --branch and clone-failure scenarios not run\n'
fi

# ---------------------------------------------------------------------------
# (13) .mdc generation drops only the frontmatter block, never a body "---"
# ---------------------------------------------------------------------------
MR="$TMP_BASE/mdcrepo"
mkdir -p "$MR/skills/hermes-fix"
cp "$INSTALL" "$MR/install.sh"
cp "$ROOT/setup-cursor" "$MR/setup-cursor"
cp "$ROOT/setup-all" "$MR/setup-all" 2>/dev/null || true
cat >"$MR/skills/hermes-fix/SKILL.md" <<'MDEOF'
---
name: hermes-fix
description: Fixture skill with horizontal rules in the body
---

# /hermes-fix

Intro text

---

A section after a rule.

```yaml
first: 1
---
second: 2
```

---

Tail
MDEOF
cat >"$TMP_BASE/mdc.body.expected" <<'MDEOF'

# /hermes-fix

Intro text

---

A section after a rule.

```yaml
first: 1
---
second: 2
```

---

Tail
MDEOF
mdc_body() { tail -n +8 "$1"; } # 5 header lines, the marker line, one blank line; then the body as written
new_home
run "$BASH_BIN" "$MR/install.sh" --local --include=hermes-fix --ide=cursor
assert_eq "(13) install.sh .mdc fixture install exits 0" 0 "$RC"
MDC="$HOME/.cursor/rules/hermes-fix.mdc"
assert "(13) install.sh .mdc keeps every body '---' line" diff "$TMP_BASE/mdc.body.expected" <(mdc_body "$MDC")
assert "(13) install.sh .mdc header is the Cursor frontmatter" test "$(sed -n '1p;5p' "$MDC" | tr '\n' ' ')" = "--- --- "
assert_eq "(13) install.sh .mdc: same number of '---' lines as the source (header fences replace the originals)" \
  "$(grep -c '^---$' "$MR/skills/hermes-fix/SKILL.md")" "$(grep -c '^---$' "$MDC")"
new_home
run "$BASH_BIN" "$MR/setup-cursor"
assert_eq "(13) setup-cursor .mdc fixture install exits 0" 0 "$RC"
assert "(13) setup-cursor .mdc keeps every body '---' line" diff "$TMP_BASE/mdc.body.expected" <(mdc_body "$HOME/.cursor/rules/hermes-fix.mdc")
# real skills: all of their '---' lines survive
new_home
run "$BASH_BIN" "$INSTALL" --local --tier=memory --ide=cursor
BADMDC=""
for sk in hermes-deploy hermes-status integration-mem0; do
  if [ "$(grep -c '^---$' "$ROOT/skills/$sk/SKILL.md")" != "$(grep -c '^---$' "$HOME/.cursor/rules/$sk.mdc")" ]; then BADMDC="$BADMDC $sk"; fi
done
assert "(13) real skills keep their body '---' lines in .mdc (bad:${BADMDC:- none})" test -z "$BADMDC"

# ---------------------------------------------------------------------------
# (14) PowerShell scripts must be pure ASCII (Windows PowerShell 5.1 reads a BOM-less file as ANSI)
# ---------------------------------------------------------------------------
PS_FILES="$(cd "$ROOT" && find . -name '*.ps1' -not -path './.git/*' -not -path '*/node_modules/*' | sort)"
assert "(14) found the PowerShell scripts" test -n "$PS_FILES"
NONASCII=""
for f in $PS_FILES; do
  if [ "$(LC_ALL=C tr -d '\000-\177' <"$ROOT/$f" | wc -c | tr -d ' ')" != 0 ]; then NONASCII="$NONASCII $f"; fi
done
assert "(14) every *.ps1 is pure ASCII (non-ASCII bytes in:${NONASCII:- none})" test -z "$NONASCII"
assert "(14) install.ps1 header does not name the nonexistent 'hstack-install' function" \
  test -z "$(grep -n 'iex; *hstack-install' "$ROOT/install.ps1")"

# ---------------------------------------------------------------------------
# (15) the injected instruction block targets Hermes v0.22.5 and names all 8 platforms
# ---------------------------------------------------------------------------
check_block() { # <script> <env var holding the md path> <file name>
  local script="$1" var="$2" f="$TMP_BASE/blockcheck-$1.md" p ok=1
  new_home
  rm -f "$f"
  run env "$var=$f" "$BASH_BIN" "$ROOT/$script"
  assert_eq "($script) writes its instruction block (exit 0)" 0 "$RC"
  for p in telegram discord whatsapp slack mattermost teams google-chat signal; do
    grep -q "$p" "$f" 2>/dev/null || ok=0
  done
  assert "(15) $script block names all 8 platforms" test "$ok" = 1
  assert "(15) $script block targets Hermes v0.22.5, source-verified only" grep -q 'v0.22.5 (source-verified; vendor and live gateway validation remain pending)' "$f"
  assert "(15) $script block no longer pins 0.15.2" test -z "$(grep -n '0\.15' "$f")"
  assert "(15) $script block gives the gateway reload recipe" grep -q "/hermes-restart: default profile, guarded restart, readiness and new-instance proof; interrupt chats only with explicit consent" "$f"
  assert "(15) $script block states vendor and live validation limits" grep -q "vendor and live gateway validation remain pending" "$f"
}
check_block setup CLAUDE_MD_PATH
check_block setup-codex AGENTS_MD_PATH
check_block setup-gemini GEMINI_MD_PATH
check_block setup-openclaw OPENCLAW_MD_PATH

# ---------------------------------------------------------------------------
# (h) tier membership is exactly what the ORIGINAL installer resolved
# ---------------------------------------------------------------------------
ACTUAL="$TMP_BASE/tiers.actual"
"$BASH_BIN" "$ROOT/tests/installer/tier-scenarios.sh" "$ROOT" "$INSTALL" >"$ACTUAL" 2>"$TMP_BASE/tiers.err"
assert "(h) tier-scenarios ran" test -s "$ACTUAL"
if diff "$FIXTURE" "$ACTUAL" >"$TMP_BASE/tiers.diff"; then
  pass "(h) resolved skill sets match the original installer for all $(grep -c '^==' "$FIXTURE") scenarios"
else
  fail "(h) tier membership changed vs. fixture" "$(head -5 "$TMP_BASE/tiers.diff" | tr '\n' ' ')"
fi

# ---------------------------------------------------------------------------
# the duplicated helper blocks must stay identical
# ---------------------------------------------------------------------------
block() { # <file> <begin-regex> <end-regex>
  awk -v b="$2" -v e="$3" '$0 ~ b {f=1} f {print} $0 ~ e {f=0}' "$1"
}
REF_OWN="$(block "$INSTALL" '^# >>> hstack-ownership' '^# <<< hstack-ownership')"
assert "(sync) install.sh contains the ownership block" test -n "$REF_OWN"
for s in setup setup-codex setup-cursor setup-gemini setup-hermes setup-openclaw; do
  assert "(sync) $s ownership block identical to install.sh" \
    test "$(block "$ROOT/$s" '^# >>> hstack-ownership' '^# <<< hstack-ownership')" = "$REF_OWN"
done
REF_INSTR="$(block "$ROOT/setup" '^# >>> hstack-instruction-block' '^# <<< hstack-instruction-block')"
assert "(sync) setup contains the instruction-file block" test -n "$REF_INSTR"
for s in setup-codex setup-gemini setup-openclaw; do
  assert "(sync) $s instruction block identical to setup" \
    test "$(block "$ROOT/$s" '^# >>> hstack-instruction-block' '^# <<< hstack-instruction-block')" = "$REF_INSTR"
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  exit 1
fi
exit 0
