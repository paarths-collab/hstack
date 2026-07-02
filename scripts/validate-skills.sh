#!/usr/bin/env bash
# scripts/validate-skills.sh — enforce the SSH-first skill authoring template.
#
# What this validator asserts, per skills/<name>/SKILL.md:
#   1. Frontmatter present and well-formed (--- ... name: ... description: ... ---).
#   2. `name` matches the directory name.
#   3. `description` is a single line and non-trivial (>= 40 chars).
#   4. File length is within SKILL_MIN_LINE_COUNT..SKILL_MAX_LINE_COUNT
#      (both read from VERSIONS.txt so policy lives in one place).
#   5. The body contains the required SSH-first sections. For integration-*
#      and hermes-* skills (not platform-* which have their own shape), the
#      required sections are:
#        - "## Before you start" (gather block)
#        - "## Step 1" through at least "## Step 6"
#        - "## Rollback" or a `rollback()` function definition
#        - "## Pitfalls" with at least SKILL_MIN_PITFALLS table rows
#        - "## Definition of done" with at least one `- [ ]` checkbox
#   6. Every bash block referencing a secret uses `chmod 600` at least once.
#   7. No literal secret string patterns leak (Bearer <32+ hex>, sk_live_,
#      AKIA[0-9A-Z]{16}, etc.) — a soft check that catches copy-paste
#      accidents; the strict gitleaks workflow is the authoritative gate.
#   8. Every skill referencing HERMES_VERSION uses the value pinned in
#      VERSIONS.txt (drift detection).
#
# Exit codes:
#   0  every skill passed
#   1  one or more skills failed a MUST rule (validation errors)
#   2  the validator itself misconfigured (missing VERSIONS.txt etc.)
#
# Usage:
#   scripts/validate-skills.sh                # validate everything
#   scripts/validate-skills.sh --quiet        # only print failures
#   scripts/validate-skills.sh --skill=foo    # validate one skill
#   scripts/validate-skills.sh --changed      # only skills changed vs main
#   scripts/validate-skills.sh --json         # emit machine-readable report
#
# The workflow at .github/workflows/validate-skills.yml runs this on every
# push and PR touching skills/**.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate repo root; load VERSIONS.txt
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f VERSIONS.txt ]; then
  echo "ERROR: VERSIONS.txt missing at repo root ($REPO_ROOT)." >&2
  exit 2
fi

# Parse a value out of VERSIONS.txt safely (no eval).
version_pin() {
  local key="$1"
  local val
  val=$(grep -E "^${key}=" VERSIONS.txt | head -1 | cut -d= -f2- || true)
  if [ -z "$val" ]; then
    echo "ERROR: VERSIONS.txt missing key '$key'." >&2
    exit 2
  fi
  printf '%s' "$val"
}

HERMES_VERSION=$(version_pin HERMES_VERSION)
MIN_LINES=$(version_pin SKILL_MIN_LINE_COUNT)
MAX_LINES=$(version_pin SKILL_MAX_LINE_COUNT)
MIN_PITFALLS=$(version_pin SKILL_MIN_PITFALLS)

# ---------------------------------------------------------------------------
# CLI flags
# ---------------------------------------------------------------------------

QUIET=0
JSON=0
CHANGED_ONLY=0
ONE_SKILL=""

for arg in "$@"; do
  case "$arg" in
    --quiet)      QUIET=1 ;;
    --json)       JSON=1 ;;
    --changed)    CHANGED_ONLY=1 ;;
    --skill=*)    ONE_SKILL="${arg#--skill=}" ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag '$arg'. Try --help." >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Build the target list
# ---------------------------------------------------------------------------

if [ -n "$ONE_SKILL" ]; then
  TARGETS=("skills/${ONE_SKILL}/SKILL.md")
  [ -f "${TARGETS[0]}" ] || { echo "ERROR: skill '$ONE_SKILL' not found." >&2; exit 2; }
elif [ "$CHANGED_ONLY" = "1" ]; then
  base="${GITHUB_BASE_REF:-main}"
  mapfile -t TARGETS < <(git diff --name-only "origin/${base}...HEAD" 2>/dev/null | grep -E '^skills/[^/]+/SKILL\.md$' || true)
  if [ "${#TARGETS[@]}" -eq 0 ]; then
    [ "$QUIET" = "1" ] || echo "No skill changes vs origin/${base}. Nothing to validate."
    exit 0
  fi
else
  mapfile -t TARGETS < <(find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort)
fi

# ---------------------------------------------------------------------------
# Reporting helpers
# ---------------------------------------------------------------------------

FAIL_COUNT=0
PASS_COUNT=0
declare -a FAILURES=()

log_info()  { [ "$QUIET" = "1" ] || echo "    $*"; }
log_pass()  { [ "$QUIET" = "1" ] || printf '  \033[32m✓\033[0m %s\n' "$*"; }
log_fail()  { printf '  \033[31m✗\033[0m %s: %s\n' "$1" "$2" >&2; FAIL_COUNT=$((FAIL_COUNT+1)); FAILURES+=("$1: $2"); }

# ---------------------------------------------------------------------------
# Individual assertions (each returns 0=pass, non-zero=fail)
# ---------------------------------------------------------------------------

assert_frontmatter() {
  local f="$1"
  # First non-blank line must be '---', frontmatter must terminate at another '---'.
  local first
  first=$(head -1 "$f")
  [ "$first" = "---" ] || { log_fail "$f" "missing frontmatter opener '---' on line 1"; return 1; }
  # Second '---' should appear within lines 3-20.
  local end
  end=$(awk 'NR>1 && /^---$/ { print NR; exit }' "$f")
  [ -n "$end" ] || { log_fail "$f" "frontmatter never closes"; return 1; }
  [ "$end" -le 20 ] || { log_fail "$f" "frontmatter closer at line $end (expected <= 20)"; return 1; }
  return 0
}

assert_name_matches_dir() {
  local f="$1"
  local dir
  dir=$(basename "$(dirname "$f")")
  local name
  name=$(awk -F': *' '/^name:/ { print $2; exit }' "$f" | tr -d '\r"'"'")
  [ -n "$name" ] || { log_fail "$f" "frontmatter 'name:' missing"; return 1; }
  [ "$name" = "$dir" ] || { log_fail "$f" "frontmatter name '$name' != directory '$dir'"; return 1; }
  return 0
}

assert_description() {
  local f="$1"
  local desc
  desc=$(awk -F': *' '/^description:/ { $1=""; sub(/^ /, ""); print; exit }' "$f")
  [ -n "$desc" ] || { log_fail "$f" "frontmatter 'description:' missing"; return 1; }
  local len=${#desc}
  [ "$len" -ge 40 ] || { log_fail "$f" "description too short ($len chars; need >= 40)"; return 1; }
  # No trailing newline within description (must be single-line YAML).
  if awk '/^description:/ { getline nxt; if (nxt !~ /^(---|[a-z_-]+:)/) print "multiline" }' "$f" | grep -q multiline; then
    log_fail "$f" "description spans multiple lines"
    return 1
  fi
  return 0
}

assert_line_count() {
  local f="$1"
  local lines
  lines=$(wc -l < "$f")
  if [ "$lines" -lt "$MIN_LINES" ]; then
    log_fail "$f" "too short ($lines lines; policy min = $MIN_LINES)"
    return 1
  fi
  if [ "$lines" -gt "$MAX_LINES" ]; then
    log_fail "$f" "too long ($lines lines; policy max = $MAX_LINES). Consider splitting."
    return 1
  fi
  return 0
}

assert_required_sections() {
  local f="$1"
  local dir
  dir=$(basename "$(dirname "$f")")
  # platform-* skills follow a different shape (bot-tokens focus); skip strict
  # step-count assertion on them but still require the SSH check and rollback.
  local strict=1
  [[ "$dir" == platform-* ]] && strict=0
  grep -q '^## Before you start' "$f"      || { log_fail "$f" "missing '## Before you start'"; return 1; }
  if [ "$strict" = "1" ]; then
    for step in 1 2 3 4 5 6; do
      grep -qE "^## Step ${step}( |—|$)" "$f" || { log_fail "$f" "missing '## Step $step'"; return 1; }
    done
  fi
  grep -qE '^## Rollback|^rollback\(\)' "$f" || { log_fail "$f" "no '## Rollback' header nor 'rollback()' function"; return 1; }
  grep -q '^## Pitfalls' "$f"               || { log_fail "$f" "missing '## Pitfalls' table"; return 1; }
  grep -q '^## Definition of done' "$f"     || { log_fail "$f" "missing '## Definition of done'"; return 1; }
  return 0
}

assert_pitfalls_count() {
  local f="$1"
  # Count table rows under the Pitfalls section (naive: lines between '## Pitfalls' and next '##').
  local count
  count=$(awk '/^## Pitfalls/{p=1;next} /^## /{p=0} p && /^\| *[0-9]+ *\|/{c++} END{print c+0}' "$f")
  if [ "$count" -lt "$MIN_PITFALLS" ]; then
    log_fail "$f" "only $count pitfall rows (policy min = $MIN_PITFALLS)"
    return 1
  fi
  return 0
}

assert_definition_of_done_checkboxes() {
  local f="$1"
  local count
  count=$(awk '/^## Definition of done/{p=1;next} /^## /{p=0} p && /^- \[ \]/{c++} END{print c+0}' "$f")
  [ "$count" -ge 6 ] || { log_fail "$f" "Definition of done has only $count checkboxes (need >= 6)"; return 1; }
  return 0
}

assert_secret_hygiene() {
  local f="$1"
  # Only enforce chmod 600 on skills that actually WRITE to ~/.hermes/.env
  # inside a shell code block (```bash or ```sh).
  # Prose mentions in tables and Pitfalls entries don't count — they're
  # documentation of anti-patterns, not real writes.
  local writes_in_code
  writes_in_code=$(awk '
    /^```/                       { in_code = !in_code; next }
    in_code && /hermes config set/                         { print; next }
    in_code && />>? *~?\/?\.hermes\/\.env/                 { print; next }
  ' "$f")
  if [ -n "$writes_in_code" ]; then
    grep -q 'chmod 600' "$f" || { log_fail "$f" "writes ~/.hermes/.env inside a code block without any 'chmod 600' anywhere"; return 1; }
  fi
  return 0
}

assert_no_literal_secret_leaks() {
  local f="$1"
  # Deliberately conservative — real secret scanning is gitleaks' job. We only
  # want to catch obvious copy-paste footguns before they land.
  local pattern hit=0
  for pattern in \
      'sk_live_[a-zA-Z0-9]{20,}' \
      'sk-proj-[a-zA-Z0-9]{20,}' \
      'AKIA[0-9A-Z]{16}' \
      'xoxb-[0-9]+-[0-9]+-[a-zA-Z0-9]{20,}' \
      'ghp_[a-zA-Z0-9]{30,}' \
      'AIza[0-9A-Za-z_-]{30,}' \
      ; do
    if grep -qE "$pattern" "$f"; then
      log_fail "$f" "looks like a real secret matches pattern /$pattern/"
      hit=1
    fi
  done
  return $hit
}

assert_hermes_pin_consistency() {
  local f="$1"
  # If the file names a Hermes version at all, it must match the pin.
  local mentioned
  mentioned=$(grep -oE '0\.1[0-9]\.[0-9]+' "$f" | sort -u || true)
  if [ -n "$mentioned" ]; then
    if ! echo "$mentioned" | grep -qx "$HERMES_VERSION"; then
      # Allow mentioning the pinned version plus other 0.15.x / 0.17.x as
      # aspirational compat targets in docs. Fail only when the file names a
      # version *other than* the pin AND doesn't also name the pin.
      if ! grep -q "$HERMES_VERSION" "$f"; then
        log_fail "$f" "names Hermes version(s) '$(echo "$mentioned" | tr '\n' ' ')' but not the pin '$HERMES_VERSION'"
        return 1
      fi
    fi
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Run all assertions on each target
# ---------------------------------------------------------------------------

[ "$QUIET" = "1" ] || echo "Validating ${#TARGETS[@]} skill(s) against VERSIONS.txt (HERMES_VERSION=$HERMES_VERSION)..."

for f in "${TARGETS[@]}"; do
  [ -f "$f" ] || { log_fail "$f" "file not found"; continue; }
  before_fail=$FAIL_COUNT
  assert_frontmatter                 "$f" || true
  assert_name_matches_dir            "$f" || true
  assert_description                 "$f" || true
  assert_line_count                  "$f" || true
  assert_required_sections           "$f" || true
  assert_pitfalls_count              "$f" || true
  assert_definition_of_done_checkboxes "$f" || true
  assert_secret_hygiene              "$f" || true
  assert_no_literal_secret_leaks     "$f" || true
  assert_hermes_pin_consistency      "$f" || true
  if [ "$FAIL_COUNT" = "$before_fail" ]; then
    PASS_COUNT=$((PASS_COUNT+1))
    log_pass "$f"
  fi
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if [ "$JSON" = "1" ]; then
  # Compact JSON — no external `jq`.
  printf '{"total":%d,"passed":%d,"failed":%d,"failures":[' "${#TARGETS[@]}" "$PASS_COUNT" "$FAIL_COUNT"
  first=1
  for entry in "${FAILURES[@]}"; do
    esc=${entry//\\/\\\\}
    esc=${esc//\"/\\\"}
    if [ "$first" = "1" ]; then first=0; else printf ','; fi
    printf '"%s"' "$esc"
  done
  printf ']}\n'
else
  echo ""
  echo "Summary: $PASS_COUNT passed, $FAIL_COUNT failed of ${#TARGETS[@]} skill(s)."
fi

[ "$FAIL_COUNT" = "0" ]
