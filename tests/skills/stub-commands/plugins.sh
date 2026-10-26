#!/bin/bash
# shellcheck shell=bash disable=SC2154
# Test behaviour of `hermes plugins install IDENT [--yes-deps|--no-deps] [--enable|--no-enable] [--force] [--ref SHA]`. NOT Hermes. Sourced by
# the hermes stub ($@ starts at `plugins`; `-p default` removed; the real v0.22.5 argparse, hermes_cli/subcommands/plugins.py:18-47, has accepted
# the argv). Only `install` of a MEMORY catalog entry is modelled; everything else exits 99.
#
# Rules copied from hermes_cli/plugins_cmd_install.py (v0.22.5):
#   * without --yes-deps / --no-deps a non-interactive session is REFUSED at the dependency-consent question ("fail-closed", :592-598)
#   * --no-enable leaves a memory provider installed but NOT active and prints "Memory provider installed but not active ..." (:724-731)
#   * --enable on a memory provider sets memory.provider (:732-761); plugins.enabled is never consulted for memory providers
# Catalog names known here: honcho hindsight supermemory mem0 openviking holographic (plugin-catalog/<name>.yaml). Anything else is
# "not in the curated catalog" (exit 1). Knob: fail.plugins -> exit 1. Events: "hermes plugins install" (no ids), state dir $HOME/.hermes/plugins/<name>.
hermes_cmd() {
  if [ "${2:-}" != install ]; then event unknown "$@"; echo "hermes: unknown: $*" >&2; exit 99; fi
  shift 2
  local ident="" yes_deps=0 no_deps=0 enable=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --yes-deps) yes_deps=1 ;; --no-deps) no_deps=1 ;; --enable) enable=1 ;; --no-enable) ;;
      --ref) shift ;; --force|-f|--allow-removed) ;;
      *) ident=$1 ;;
    esac
    shift
  done
  event plugins install; inject plugins
  case "$ident" in
    honcho|hindsight|supermemory|mem0|openviking|holographic) ;;
    *) echo "Error: '$ident' is not in the curated plugin catalog" >&2; return 1 ;;
  esac
  if [ "$yes_deps" = 0 ] && [ "$no_deps" = 0 ]; then
    echo "Error: this plugin declares Python dependencies; consent is required and this session has no terminal (use --yes-deps)" >&2; return 1
  fi
  mkdir -p "$H/plugins/$ident"; printf 'name: %s\n' "$ident" > "$H/plugins/$ident/plugin.yaml"
  if [ "$enable" = 1 ]; then
    upsert_cfg memory.provider "$ident"
    echo "✓ $ident set as memory.provider. Run \`hermes memory setup $ident\` to configure it; new sessions use it."
  else
    echo "Memory provider installed but not active. Run \`hermes memory setup\` (or set memory.provider: $ident) to use it."
  fi
}
