#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes doctor [--fix] [--live] [--ack ID]`. NOT Hermes. Sourced by the hermes stub; $@ starts at the command
# (-p already removed) and the real v0.22.5 argparse (hermes_cli/subcommands/doctor.py) has already accepted the argv.
#
# Strings and exit codes come from the v0.22.5 source (hermes_cli/doctor.py): the summary lines are _print_summary (:130-148), the exit
# status is run_doctor's `int(bool(total.issues or total.manual_issues))` (:171-194, forwarded by main.py:1837,3550-3554), so a run that
# still has issues exits 1 and "All checks passed!" exits 0. What the host actually has wrong is an ASSUMPTION steered by knobs:
#   doctor_issues     file: one finding per line. A line starting "fixable:" is repaired by --fix (the rest is the text), any other line
#                     is a manual issue that --fix leaves in place. "fixable:max_iterations" removes HERMES_MAX_ITERATIONS from .env
#                     (doctor_config.py:_drift_max_iterations_ghost), "fixable:env_missing" creates an empty .env with mode 600
#                     (_check_env_file), "fixable:config_version" appends a config version line to config.yaml (_drift_config_version).
#   doctor_state_db   present: --fix also "repairs" state.db and drops the marker file $HOME/state/state-db-repaired (doctor_state.py
#                     _repair_state_db: --fix is NOT limited to .env/config.yaml)
#   fail.doctor       the call exits 1 at once with an error (a crash, not "issues remain")
# --live prints one extra line; --ack ID prints the real acknowledgement text and exits 0.
# Events: "hermes doctor", "hermes doctor --fix", "hermes doctor --live", "hermes doctor --ack" (no ids/values).
hermes_cmd() {
  local fix=0 live=0 ack=0 a
  shift # drop "doctor"
  for a in "$@"; do
    case "$a" in --fix) fix=1 ;; --live) live=1 ;; --ack) ack=1 ;; esac
  done
  local ev="doctor"
  [ "$fix" = 1 ] && ev="$ev --fix"
  [ "$live" = 1 ] && ev="$ev --live"
  [ "$ack" = 1 ] && ev="$ev --ack"
  event "$ev"
  inject doctor
  if [ "$ack" = 1 ]; then echo "  ✓ Acknowledged advisory (stub). It will no longer trigger startup banners."; return 0; fi

  local issues="$HOME/knobs/doctor_issues" line text fixed=0 remaining=0 n=0 listing=""
  echo "┌─────────────────────────────────────────────────────────┐"
  echo "│                 🩺 Hermes Doctor                        │"
  echo "└─────────────────────────────────────────────────────────┘"
  if [ -f "$H/.env" ]; then echo "  ✓ ~/.hermes/.env file exists"; else echo "  ✗ ~/.hermes/.env file missing"; fi
  if [ -f "$issues" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      case "$line" in
        fixable:*)
          text=${line#fixable:}
          if [ "$fix" = 1 ]; then
            case "$text" in
              max_iterations)
                [ -f "$H/.env" ] && { grep -v '^HERMES_MAX_ITERATIONS=' "$H/.env" > "$H/.env.tmp" || true; cat "$H/.env.tmp" > "$H/.env"; rm -f "$H/.env.tmp"; }
                echo "  ✓ Removed stale HERMES_MAX_ITERATIONS from .env" ;;
              env_missing)
                [ -f "$H/.env" ] || { : > "$H/.env"; chmod 600 "$H/.env"; }
                echo "  ✓ Created empty ~/.hermes/.env" ;;
              config_version)
                printf '_config_version: 17\n' >> "$H/config.yaml"
                echo "  ✓ Config migrated to latest version" ;;
              *) echo "  ✓ Fixed: $text" ;;
            esac
            fixed=$((fixed + 1))
          else
            echo "  ⚠ $text"
            n=$((n + 1)); listing="$listing  $n. $text
"
            remaining=$((remaining + 1))
          fi ;;
        *)
          echo "  ⚠ $line"
          n=$((n + 1)); listing="$listing  $n. $line
"
          remaining=$((remaining + 1)) ;;
      esac
    done < "$issues"
  fi
  if [ "$fix" = 1 ] && [ -f "$K/doctor_state_db" ]; then
    echo "  ✓ Repaired state.db FTS write health (strategy: stub; backup: state.db.bak)"
    : > "$HOME/state/state-db-repaired"
    fixed=$((fixed + 1))
  fi
  [ "$live" = 1 ] && echo "  ✓ Live probes (stub): one read-only call per configured tool backend"
  echo
  if [ "$fix" = 1 ] && [ "$fixed" -gt 0 ]; then
    printf '  Fixed %s issue(s).' "$fixed"
    if [ "$remaining" -gt 0 ]; then printf ' %s issue(s) require manual intervention.\n\n%s' "$remaining" "$listing"; else echo; fi
  elif [ "$remaining" -gt 0 ]; then
    echo "  Found $remaining issue(s) to address:"
    echo
    printf '%s' "$listing"
    echo "  Tip: run 'hermes doctor --fix' to auto-fix what's possible."
  else
    echo "  All checks passed! 🎉"
  fi
  [ "$remaining" -eq 0 ]
}
