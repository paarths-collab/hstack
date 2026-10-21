#!/usr/bin/env bash
# Print the resolved skill set for a fixed list of install.sh invocations.
#
#   tier-scenarios.sh <repo-root> <install.sh>
#
# <install.sh> may be any version of the installer (e.g. `git show HEAD:install.sh`
# saved to a file). It is copied next to a copy of <repo-root>/skills so --local
# resolves against that copy, and run with a throwaway HOME. No network.
# The output is what tests/installer/fixtures/tiers.expected holds.
#
# bash 3.2 compatible. (The ORIGINAL pre-fix installer needs bash 4+ to run.)
set -euo pipefail

REPO="${1:?usage: tier-scenarios.sh <repo-root> <install.sh>}"
INSTALLER="${2:?usage: tier-scenarios.sh <repo-root> <install.sh>}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hstack-tiers.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/repo" "$WORK/home"
cp -R "$REPO/skills" "$WORK/repo/skills"
cp "$INSTALLER" "$WORK/repo/install.sh"

TIERS="memory database vector auth observability rag code ai-tools storage crm docs dev pm cloud payments commerce email support forms search"

run_case() {
  local label="$1"
  shift
  local out="$WORK/out"
  rm -rf "${out:?}" "${WORK:?}/home"
  mkdir -p "$out" "$WORK/home"
  HOME="$WORK/home" CLAUDE_SKILLS_DIR="$out" \
    bash "$WORK/repo/install.sh" --local --ide=claude "$@" </dev/null >/dev/null 2>&1 || true
  printf '== %s\n' "$label"
  (cd "$out" && ls -1 | LC_ALL=C sort)
}

run_case "default (non-interactive)"
run_case "--all" --all
for t in core platforms $TIERS; do
  run_case "--tier=$t" "--tier=$t"
done
run_case "--tier=memory,database" --tier=memory,database
run_case "--tier=memory, ai-tools ,bogus" "--tier=memory, ai-tools ,bogus"
run_case "--tier=bogus" --tier=bogus
run_case "--include=notion,stripe,mem0,hermes-deploy,nope" --include=notion,stripe,mem0,hermes-deploy,nope
run_case "--include=memory,github" --include=memory,github
run_case "--include=core" --include=core
run_case "--all --tier=memory" --all --tier=memory
run_case "--include=stripe --tier=memory" --include=stripe --tier=memory
