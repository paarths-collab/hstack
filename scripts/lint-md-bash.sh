#!/usr/bin/env bash
# Lint the bash that hstack actually ships: fenced ```bash / ```sh blocks inside
# Markdown (skills/**/SKILL.md, CLAUDE.md, reference/TROUBLESHOOTING.md, blog/*).
#
# The repo's whole reason for existing is bash deploy procedures embedded in
# Markdown — none of which match `**.sh`, so they bypass the ShellCheck job.
# This script closes that gap.
#
# These blocks are documentation snippets, so many legitimately contain
# placeholders (<container-name>), ellipses (...), and partial fragments that
# are NOT valid standalone scripts. We therefore:
#   * extract every bash/sh fenced block,
#   * SKIP blocks that contain template placeholders or ellipses (the main
#     false-positive sources), and
#   * run `bash -n` (parse-only — never executes) on the rest to catch real
#     syntax errors in copy-pasteable commands.
#
# Needs only bash (no shellcheck), so it runs locally and in CI. Exits non-zero
# only when a non-placeholder block fails to parse.
set -uo pipefail

root="${1:-.}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
checked=0
skipped=0
errors=0

while IFS= read -r -d '' md; do
  rm -f "$tmp"/block.*.sh
  awk -v dir="$tmp" '
    /^[[:space:]]*```(bash|sh)[[:space:]]*$/ { inblock=1; n++; next }
    /^[[:space:]]*```[[:space:]]*$/          { inblock=0; next }
    inblock                                  { print > (dir "/block." n ".sh") }
  ' "$md"
  for blk in "$tmp"/block.*.sh; do
    [ -e "$blk" ] || continue
    # Skip documentation fragments that aren't meant to run as-is.
    if grep -qE '<[A-Za-z0-9_./-]+>|\.\.\.' "$blk"; then
      skipped=$((skipped + 1))
      continue
    fi
    checked=$((checked + 1))
    if ! err="$(bash -n "$blk" 2>&1)"; then
      echo "::group::Syntax error in a bash block of ${md}"
      echo "$err"
      echo "---- offending block ----"
      cat "$blk"
      echo "::endgroup::"
      errors=$((errors + 1))
      fail=1
    fi
  done
done < <(find "$root" -type f -name '*.md' \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -print0)

echo "md-bash lint: ${checked} block(s) parsed, ${skipped} placeholder block(s) skipped, ${errors} error(s)."
exit "$fail"
