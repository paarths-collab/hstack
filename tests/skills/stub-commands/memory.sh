#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes memory status`. NOT Hermes. Sourced by the hermes stub; $@ starts at the command (-p already removed) and the
# real v0.22.5 argparse has already accepted the argv. The text is hermes_cli/memory_setup.py:cmd_status at v0.22.5 (:365-425): a "Memory
# status" banner, the built-in MEMORY.md / USER.md toggles, the provider name and its config keys, and "Plugin:" / "Status:" rows. It prints
# NO backend type, usage or ceiling. Which provider is configured is an assumption: $HOME/memory.out replaces the whole text.
# Event: "hermes memory status". Knob: fail.memory -> exit 1. (hermes-memory extended this file; see the block below.)
#
# hermes-memory additions (same file, additive): the provider is now STATE. `memory.provider` lives in config.yaml like the real thing
# (`memory off` writes the empty string: hermes_cli/main_agent_cmds.py:11-20), and `status` derives its rows from it when $HOME/memory.out
# is absent. A provider counts as "Plugin: installed" when it is bundled (retaindb, byterover: plugins/memory/) or when `plugins install`
# placed $HOME/.hermes/plugins/<name>; "Status: available" unless knob memory_unavailable exists (memory_setup.py:365-425). `setup` and
# `reset` are NOT modelled: an unattended `memory setup` would block on a prompt (exit 5) and `reset` erases the user's notes (exit 99),
# so a skill that calls either fails its test. Events: "hermes memory status|off|setup|reset".
hermes_cmd() {
  prov() { sed -n 's/^memory\.provider: *//p' "$CFG" 2>/dev/null | tail -n1 | tr -d "\"'"; }
  case "${2:-}" in
    status)
      event memory status; inject memory
      if [ -f "$HOME/memory.out" ]; then cat "$HOME/memory.out"; else
        local p; p=$(prov)
        printf '\nMemory status\n────────────────────────────────────────\n'
        printf '  Built-in (MEMORY.md / USER.md):\n    Memory injection:   enabled ✓\n    User profile:       enabled ✓\n    Memory tool:        enabled ✓\n'
        printf '  Provider:  %s\n' "${p:-(none — built-in only)}"
        if [ -n "$p" ]; then
          case "$p" in
            retaindb|byterover) printf '\n  Plugin:    installed ✓\n' ;;
            *) if [ -d "$H/plugins/$p" ]; then printf '\n  Plugin:    installed ✓\n'; else printf '\n  Plugin:    NOT installed ✗\n  Install it with: hermes plugins install %s\n' "$p"; fi ;;
          esac
          if [ -f "$K/memory_unavailable" ]; then printf '  Status:    not available ✗\n'; else printf '  Status:    available ✓\n'; fi
        fi
      fi ;;
    off)
      event memory off; inject memory.off
      upsert_cfg memory.provider '""'
      printf '\n  ✓ Memory provider: built-in only\n  Saved to config.yaml\n\n' ;;
    setup) event memory setup; echo "hermes(stub): memory setup is an attended wizard and would block on a prompt" >&2; exit 5 ;;
    reset) event memory reset; echo "hermes(stub): memory reset erases the built-in notes; no test may call it" >&2; exit 99 ;;
    *) event unknown "$@"; echo "hermes: unknown: $*" >&2; exit 99 ;;
  esac
}
