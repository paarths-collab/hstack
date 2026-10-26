#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes status [--full|--all] [--deep]`. NOT Hermes. Sourced by the hermes stub; $@ starts at the command (-p already
# removed) and the real v0.22.5 argparse (hermes_cli/subcommands/status.py) has already accepted the argv (--all is an alias of --full,
# --deep implies --full).
#
# The row labels and glyphs are copied from hermes_cli/status.py at v0.22.5: the one-screen summary is _render_summary (:391-407:
# "Model:", "Provider:", "Gateway:", "Platforms:", "Jobs:"), the full report adds the "Gateway Service" section (_render_gateway :213-243) and
# --deep adds "Deep Checks" with a "Port 18789:" row (_render_deep :322-342). The gateway row there is judged from a process/service scan
# (get_gateway_runtime_snapshot), NOT from a readiness probe. Which state the stub reports is an assumption taken from ~/.hermes/gateway.state
# (running | stopped, the same file the gateway stub keeps). The command never starts, stops or restarts anything.
# Event: "hermes status" (+ " --full" / " --deep"). Knob: fail.status -> exit 1.
hermes_cmd() {
  local full=0 deep=0 a
  shift # drop "status"
  for a in "$@"; do
    case "$a" in --full|--all) full=1 ;; --deep) deep=1; full=1 ;; esac
  done
  local ev="status"
  if [ "$deep" = 1 ]; then ev="$ev --deep"; elif [ "$full" = 1 ]; then ev="$ev --full"; fi
  event "$ev"
  inject status
  local running=0
  if [ "$(gw_state)" = running ]; then running=1; fi
  echo
  echo "◆ Hermes Agent (stub header)"
  echo
  echo "  Model:        configured-by-test"
  echo "  Provider:     configured-by-test"
  if [ "$running" = 1 ]; then echo "  Gateway:      ✓ running"; else echo "  Gateway:      ✗ stopped"; fi
  echo "  Platforms:    telegram"
  echo "  Jobs:         0"
  if [ "$full" = 0 ]; then
    echo "  Run 'hermes status --full' for every section"
    return 0
  fi
  echo
  echo "◆ Gateway Service"
  if [ "$running" = 1 ]; then echo "  Status:       ✓ running"; else echo "  Status:       ✗ stopped"; fi
  echo "  Manager:      manual process"
  echo
  echo "◆ Scheduled Jobs"
  echo "  Jobs:         0"
  echo
  echo "◆ Sessions"
  echo "  Active:       0"
  if [ "$deep" = 1 ]; then
    echo
    echo "◆ Deep Checks"
    echo "  Port 18789:   available"
  fi
  echo "  Run 'hermes doctor' for detailed diagnostics"
}
