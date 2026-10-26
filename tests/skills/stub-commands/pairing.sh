#!/bin/bash
# shellcheck shell=bash
# event and inject are defined by the sourcing tests/skills/stubs/hermes script.
# Test behaviour of `hermes pairing list` (hermes_cli/pairing.py:22-53 at v0.22.5). Sourced by the hermes stub; $@ starts at the
# command (-p already removed). The SYNTAX is checked by the real vendored argparse before this runs; the BEHAVIOUR is an assumption
# written from the source's output strings: with nothing paired it prints "No pairing data found. No one has tried to pair yet~"
# (pairing.py:27); otherwise the test supplies the exact text in $HOME/pairing.out. Only the read-only `list` action is modelled:
# approve/revoke/clear-pending change authorization and no skill block here is allowed to call them (the stub exits 99 for them).
# Knob: fail.pairing -> exit 1.
hermes_cmd() {
  case "${2:-}" in
    list)
      event pairing list; inject pairing
      if [ -f "$HOME/pairing.out" ]; then cat "$HOME/pairing.out"; else echo "No pairing data found. No one has tried to pair yet~"; fi ;;
    *) event unknown "$@"; echo "hermes: unknown: $*" >&2; exit 99 ;;
  esac
}
