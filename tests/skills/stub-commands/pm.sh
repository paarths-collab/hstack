#!/bin/bash
# shellcheck shell=bash disable=SC2154
# Test behaviour of `hermes pm doctor | status | repair`. NOT Hermes. Sourced by the hermes stub ($@ starts at `pm`; the global `-p default` is
# removed). `pm` is dispatched by hermes_cli/main.py:679-683 BEFORE argparse, so unlike every other command its syntax is not checked by the
# vendored parsers; the subcommand names come from pm/cli.py:835-888 and unknown ones exit 2 here.
#   doctor  pm/cli.py:422-470: one line per package, exit 1 when a required package is missing or fails verification, else 0.
#   status  pm/cli.py:790-803: prints the latest sync receipt as JSON, or "no pm sync receipt yet ..." ; always exit 0.
#   repair  pm/cli.py:806-813: exit 1 when nothing could be recovered, else "Restart Hermes to use the repaired dependency environment."
# Which packages exist and whether they are healthy is an ASSUMPTION steered by knobs: fail.pm.doctor (exit 1 with a failing line),
# fail.pm.repair. Events: "hermes pm doctor", "hermes pm status", "hermes pm repair".
hermes_cmd() {
  case "${2:-}" in
    doctor)
      event pm doctor
      if [ -f "$K/fail.pm.doctor" ]; then echo "✗ uv: not installed"; return 1; fi
      echo "✓ uv 0.0.0"; echo "✓ node 0.0.0" ;;
    status)
      event pm status
      echo "no pm sync receipt yet (no venv operation has run)" ;;
    repair)
      event pm repair
      if [ -f "$K/fail.pm.repair" ]; then return 1; fi
      echo "Restart Hermes to use the repaired dependency environment." ;;
    *) event unknown "$@"; echo "hermes: unknown: $*" >&2; return 2 ;;
  esac
}
