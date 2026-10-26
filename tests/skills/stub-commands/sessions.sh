#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes sessions prune [--older-than AGE] [--dry-run] [--yes]`, sourced by the hermes stub ($@ starts at "sessions"; -p
# already removed). SYNTAX is the real vendored v0.22.5 argparse. BEHAVIOUR is an assumption written from hermes_cli/sessions_cmd.py:738-815
# (v0.22.5): a bare prune (no filter at all) defaults to "older than 90 days"; AGE is days when a bare number, or Nh/Nd/Nw; only ENDED,
# unpinned sessions are candidates; no candidates -> "No sessions match (...)." ; --dry-run lists and deletes nothing ; without --yes the
# command asks "[y/N]" and a closed stdin cancels ("Cancelled.", exit 0, nothing deleted) ; with --yes it prints "Pruned N session(s).".
# The simulated store is $HOME/sessions.db, one session per line "id<TAB>age_days<TAB>ended(0|1)<TAB>pinned(0|1)"; the test provides it.
# Only `prune` is modelled. Knob: fail.sessions -> exit 1 with an error.
hermes_cmd() {
  local db=$HOME/sessions.db older="" dry=0 yes=0 filtered=0
  shift # "sessions"
  [ "${1:-}" = prune ] || { event unknown sessions "$@"; echo "hermes: unknown: sessions $*" >&2; return 99; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --older-than) older=${2:-}; filtered=1; shift 2 ;;
      --dry-run) dry=1; shift ;;
      --yes|-y) yes=1; shift ;;
      --include-archived|--include-pinned|--never-active|--force) shift ;;
      --*) filtered=1; shift 2 ;;
      *) shift ;;
    esac
  done
  [ "$filtered" = 0 ] && older=90
  event sessions prune
  printf 'older=%s dry=%s yes=%s\n' "$older" "$dry" "$yes" >> "$HOME/logs/sessions-prune.log"
  inject sessions
  local days
  case "$older" in
    *h) days=$(( ${older%h} / 24 )) ;;
    *d) days=${older%d} ;;
    *w) days=$(( ${older%w} * 7 )) ;;
    *[!0-9]*|"") echo "Error: invalid age '$older'"; return 1 ;;
    *) days=$older ;;
  esac
  local n=0 id age ended pinned keep="" ans
  [ -f "$db" ] || : > "$db"
  while IFS="$(printf '\t')" read -r id age ended pinned; do
    [ -n "$id" ] || continue
    if [ "$ended" = 1 ] && [ "$pinned" = 0 ] && [ "$age" -gt "$days" ]; then n=$((n + 1)); else keep="$keep$id	$age	$ended	$pinned
"; fi
  done < "$db"
  if [ "$n" = 0 ]; then echo "No sessions match (older than $days days)."; return 0; fi
  if [ "$dry" = 1 ]; then echo "$n session(s) match (older than $days days)."; echo "Dry run — nothing deleted."; return 0; fi
  if [ "$yes" = 0 ]; then
    echo "$n session(s) match (older than $days days)."
    printf 'Delete these %s session(s)? [y/N] ' "$n"
    if ! read -r ans || [ "$ans" != y ]; then echo; echo "Cancelled."; return 0; fi
  fi
  printf '%s' "$keep" > "$db"
  echo "Pruned $n session(s)."
}
