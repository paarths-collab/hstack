#!/bin/bash
# shellcheck shell=bash disable=SC2154
# Test behaviour of `hermes update [--plan] [--check] [--channel C] [--backup|--no-backup] [--yes]`. NOT Hermes. Sourced by the hermes stub
# ($@ starts at `update`; the global `-p default` is removed and the real v0.22.5 argparse, hermes_cli/subcommands/update.py, has accepted
# the argv, so an invented flag such as --version never gets here).
#
# Strings and exit codes come from the v0.22.5 source: the plan header and rows are update_inventory.print_update_plan (:355-373), the check
# verdicts are update_cmd_check (:197-225), `--check` exits 2 on an admission refusal and 1 when it cannot fetch (update_cmd.py:651-690), `--plan`
# is read-only and handled before every refusal gate (main.py:2277-2340), and the pre-update backup is best-effort (update_cmd_maint.py:752-787).
# What the host would actually do is an ASSUMPTION steered by knobs under $HOME/knobs:
#   update_available     --check reports "Update available" instead of "Already up to date."
#   update_to            file holding the banner a successful update leaves behind (written to $HOME/hermes.version), e.g. "Hermes Agent v0.22.6"
#   update_refused       plan/check/update print the image-managed refusal and exit 2 (evaluate_update_admission)
#   fail.update.check    --check cannot fetch: exit 1
#   fail.update          the update itself fails: exit 1 after the banner is left as it was
#   update_backup_fail   the updater's own pre-update snapshot fails: it says so on stdout and the update CONTINUES (best-effort by design)
# Events: "hermes update plan|check|run [--backup]" (flags only, no values), and $HOME/state/update.ran holds the argv of the last real run.
hermes_cmd() {
  shift   # "update"
  local argv="$*"
  local plan=0 check=0 backup=0 nobackup=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --plan) plan=1 ;;
      --check) check=1 ;;
      --backup) backup=1 ;;
      --no-backup) nobackup=1 ;;
      --channel|--set-channel|--branch) shift ;;
    esac
    shift
  done
  if [ "$plan" = 1 ]; then
    event update plan
    echo "Update plan:"
    echo "  Install: git checkout"
    echo "  Profiles: default"
    if [ "$(gw_state)" = running ]; then
      echo "  Running services to restart (1):"
      echo "    • gateway [default] pid 4242 — manual"
    else
      echo "  Running Hermes services: none detected — code swap only."
    fi
    return 0
  fi
  if [ -f "$K/update_refused" ]; then
    echo "This install is managed by an image or package; update it through its owner."
    return 2
  fi
  if [ "$check" = 1 ]; then
    event update check
    inject update.check
    if [ -f "$K/update_available" ]; then
      echo "⚕ Update available: 3 commits behind origin/main."
      echo "  Run 'hermes update' to install."
    else
      echo "✓ Already up to date."
    fi
    return 0
  fi
  local ev="update run"; [ "$backup" = 1 ] && ev="$ev --backup"; [ "$nobackup" = 1 ] && ev="$ev --no-backup"
  event "$ev"
  printf '%s\n' "$argv" > "$HOME/state/update.ran"
  if [ "$nobackup" = 1 ]; then echo "◆ Pre-update backup: skipped (--no-backup)"
  elif [ -f "$K/update_backup_fail" ]; then echo "  ⚠ Pre-update snapshot FAILED — no recovery point was saved."; echo "  Continuing with update (set updates.pre_update_backup: off to silence this)."
  else echo "◆ Pre-update snapshot: 20260101-000001-pre-update"; fi
  inject update
  if [ -f "$K/update_to" ]; then cp "$K/update_to" "$HOME/hermes.version"; echo "Update complete."; else echo "✓ Already up to date!"; fi
  return 0
}
