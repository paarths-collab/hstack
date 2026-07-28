#!/usr/bin/env bash
# scripts/check-skill-refs.sh — every /skill-name referenced in docs must exist on disk.
#
# Why this exists: CHANGELOG.md advertised `/hermes-provision` as part of the
# catalog for months. It was never committed. Anyone who installed hstack and
# went looking for it found nothing. Docs promising skills that do not ship is
# the same class of bug as the badge-count drift that count-check.yml guards.
#
# It also stops the reverse rot: a skill that references `/integration-linear`
# in a hand-off step keeps working only as long as that directory exists.
#
# Scans every tracked Markdown file for hstack skill references matching
#   /hermes-<x>  /platform-<x>  /integration-<x>
# and asserts skills/<name>/SKILL.md exists.
#
# Exit codes:
#   0  every referenced skill exists
#   1  one or more references point at a skill that is not in the catalog
#
# Usage:
#   scripts/check-skill-refs.sh            # scan everything
#   scripts/check-skill-refs.sh --quiet    # only print failures
#   scripts/check-skill-refs.sh --list     # print the reference map and exit 0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

QUIET=0
LIST_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=1 ;;
    --list)  LIST_ONLY=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown flag '$arg'. Try --help." >&2; exit 2 ;;
  esac
done

# Markdown files we actually control. Skip vendored/generated trees.
mapfile -t DOCS < <(
  find . -type f -name '*.md' \
    -not -path './.git/*' \
    -not -path './node_modules/*' \
    -not -path './blog-site/*' \
  | sort
)

# Known runtime commands that look like skill refs but are not. Hermes ships
# its own chat slash commands; `/hermes sethome` and friends are executed by
# the agent at runtime, not read from skills/.
is_runtime_command() {
  case "$1" in
    hermes-agent|hermes-cli) return 0 ;;
    *) return 1 ;;
  esac
}

declare -A SEEN_IN   # skill name -> space-separated list of files referencing it
MISSING=0
TOTAL_REFS=0

for doc in "${DOCS[@]}"; do
  # Pull /hermes-x, /platform-x, /integration-x. Require a non-path character
  # before the slash so `skills/hermes-cron/SKILL.md` does not match, and
  # exclude `~` so the `~/hermes-backups` directory is not read as a skill ref.
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    is_runtime_command "$ref" && continue
    TOTAL_REFS=$((TOTAL_REFS + 1))
    SEEN_IN[$ref]="${SEEN_IN[$ref]:-} $doc"
  done < <(
    grep -oE '(^|[^a-zA-Z0-9._/~-])/(hermes|platform|integration)-[a-z0-9-]+' "$doc" 2>/dev/null \
      | grep -oE '(hermes|platform|integration)-[a-z0-9-]+' \
      | sed 's/-$//' \
      | sort -u
  )
done

if [ "$LIST_ONLY" = "1" ]; then
  for name in $(printf '%s\n' "${!SEEN_IN[@]}" | sort); do
    printf '%-34s %s\n' "$name" "$(echo "${SEEN_IN[$name]}" | tr ' ' '\n' | grep -c . ) file(s)"
  done
  exit 0
fi

[ "$QUIET" = "1" ] || echo "Checking ${#SEEN_IN[@]} distinct skill references across ${#DOCS[@]} Markdown files..."

for name in $(printf '%s\n' "${!SEEN_IN[@]}" | sort); do
  if [ ! -f "skills/${name}/SKILL.md" ]; then
    # shellcheck disable=SC2086
    files=$(echo ${SEEN_IN[$name]} | tr ' ' '\n' | grep -c .)
    printf '  \033[31m✗\033[0m /%s referenced in %s file(s) but skills/%s/SKILL.md does not exist\n' \
      "$name" "$files" "$name" >&2
    # shellcheck disable=SC2086
    for f in ${SEEN_IN[$name]}; do echo "      $f" >&2; done
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -gt 0 ]; then
  echo "" >&2
  echo "FAIL: $MISSING skill reference(s) point at a skill that is not in the catalog." >&2
  echo "Either commit the skill, or stop advertising it." >&2
  exit 1
fi

[ "$QUIET" = "1" ] || echo "OK: all ${#SEEN_IN[@]} referenced skills exist in skills/."
exit 0
