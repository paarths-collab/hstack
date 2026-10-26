#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by ../hermes, which defines H, K, CFG, ENVF, event, inject, upsert_env, gw_state, mcp_names and mcp_field)
# Test behaviour of `hermes backup [-o PATH] [-q] [-l LABEL] [-k N]`. NOT Hermes. Sourced by the hermes stub for the `backup`
# command ($@ starts at `backup`; the global `-p default` is removed and the real v0.22.5 argparse has accepted the argv).
#
# What it prints, which files it skips, how it names the archive and when it prunes are copied from hermes_cli/backup.py at
# v0.22.5 (cited per rule below); the archive itself is a real zip built with python3 so a skill can verify it. Assumptions
# (steered by knobs under $HOME/knobs):
#   backup_locked      another backup holds .backup.lock: "Error: another Hermes backup is already running", exit 2
#   backup_incomplete  one file cannot be added: the archive is KEPT, "Backup incomplete", exit 1, nothing is pruned
#   backup_corrupt     the published file is not a valid zip (a torn disk write the native command could not notice)
#
# Rules reproduced on purpose:
#   * default name hermes-backup-<YYYY-MM-DD-HHMMSS>.zip, in $HOME when --output is absent, inside --output when it is an
#     EXISTING directory, and a non-.zip --output gets ".zip" appended (so a missing directory becomes a file)   (backup.py:550-568)
#   * excluded: hermes-agent/ at the root, backups/, state-snapshots/, checkpoints/, node_modules, .git, venvs, *.db-wal/-shm,
#     gateway.pid, cron.pid, .backup.lock (backup.py:69-107,140). NOT excluded: .hstack-backup/ (it holds copies of .env)
#   * --keep N prunes only hermes-backup-*.zip in the output directory, only after a COMPLETE archive, never with N=0
#     (default 3), and only when the archive's own name starts with hermes-backup-                                 (backup.py:661-668)
#   * --quick writes state-snapshots/<UTC stamp>[-label]/ (mode 700, files 600) and prints how to restore it with the
#     /snapshot slash command; --keep and --output are ignored                                                    (backup.py:2081-2094)
#   * the zip is created with the ambient umask (no chmod in backup.py), so only `umask 077` makes it private
# The timestamp's time part is a counter, so two backups in one second do not collide in the stub.

hermes_cmd() {
  shift   # "backup"
  local out="" quick=0 label="" keep=3
  while [ $# -gt 0 ]; do
    case "$1" in
      -o|--output) out=$2; shift 2 ;;
      -q|--quick) quick=1; shift ;;
      -l|--label) label=$2; shift 2 ;;
      -k|--keep) keep=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  event backup; inject backup
  if [ ! -d "$H" ]; then echo "Error: Hermes home directory not found at $H"; return 1; fi
  if [ -f "$K/backup_locked" ]; then echo "Error: another Hermes backup is already running"; return 2; fi

  if [ "$quick" = 1 ]; then
    local ts id root
    n=0; [ -f "$HOME/state/backup.seq" ] && n=$(cat "$HOME/state/backup.seq"); n=$((n + 1)); echo "$n" > "$HOME/state/backup.seq"
    ts="20260101-$(printf '%06d' "$n")"
    id=$ts; [ -n "$label" ] && id="$ts-$label"
    root="$H/state-snapshots"
    mkdir -p "$root" "$root/$id"; chmod 700 "$root" "$root/$id"
    local f any=0
    for f in state.db config.yaml .env auth.json; do
      [ -f "$H/$f" ] && { cp "$H/$f" "$root/$id/$f"; chmod 600 "$root/$id/$f"; any=1; }
    done
    if [ "$any" = 0 ]; then rmdir "$root/$id"; echo "No state files found to snapshot."; return 0; fi
    echo "State snapshot created: $id"
    echo "  $(ls "$root" | wc -l | tr -d ' ') snapshot(s) stored in ~/.hermes/state-snapshots/"
    echo "  Restore with: /snapshot restore $id"
    return 0
  fi

  # ---- full backup ----
  local dest name
  n=0; [ -f "$HOME/state/backup.seq" ] && n=$(cat "$HOME/state/backup.seq"); n=$((n + 1)); echo "$n" > "$HOME/state/backup.seq"
  name="hermes-backup-$(date +%Y-%m-%d)-$(printf '%06d' "$n").zip"
  if [ -z "$out" ]; then dest="$HOME/$name"
  elif [ -d "$out" ]; then dest="${out%/}/$name"
  else
    case "$out" in *.zip|*.ZIP) dest=$out ;; *) dest="$out.zip" ;; esac
    mkdir -p "$(dirname "$dest")" || { echo "Error: cannot write backup to $out"; return 1; }
  fi
  echo "Scanning ~/.hermes ..."
  local list; list="$HOME/state/backup.files.$$"
  (cd "$H" && find . -type f \
      -not -path './hermes-agent/*' -not -path './backups/*' -not -path './state-snapshots/*' -not -path './checkpoints/*' \
      -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/__pycache__/*' \
      -not -name '*.db-wal' -not -name '*.db-shm' -not -name '*.db-journal' -not -name 'gateway.pid' -not -name 'cron.pid' -not -name '.backup.lock' \
      | sed 's|^\./||' | sort) > "$list"
  local count; count=$(grep -c . "$list")
  if [ "$count" = 0 ]; then echo "No files to back up."; rm -f "$list"; return 0; fi
  echo "Backing up $count files ..."
  local partial
  partial="$(dirname "$dest")/.$(basename "$dest").$$.partial"
  python3 -I - "$H" "$list" "$partial" <<'PY'
import sys, zipfile
home, lst, out = sys.argv[1:4]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for rel in open(lst).read().split("\n"):
        if rel:
            zf.write(f"{home}/{rel}", rel)
PY
  [ -f "$K/backup_corrupt" ] && printf 'this is not a zip archive' > "$partial"
  # record the mode the archive was BORN with (the native writer never chmods a full zip), for tests that check the umask
  { stat -c %a "$partial" 2>/dev/null || stat -f %Lp "$partial"; } >> "$HOME/logs/backup-birth-mode.log"
  mv "$partial" "$dest"; rm -f "$list"
  local errs=0; [ -f "$K/backup_incomplete" ] && errs=1
  if [ "$errs" = 1 ]; then echo; echo "Backup incomplete: $dest"; else echo; echo "Backup complete: $dest"; fi
  echo "  Files:       $count"
  echo "  Original:    0.1 MB"
  echo "  Compressed:  0.1 MB"
  echo "  Time:        0.0s"
  echo; echo "  Excluded directories:"; echo "    hermes-agent/"
  if [ "$errs" = 1 ]; then
    echo; echo "  Archive kept, but 1 file(s) could not be added:"; echo "  state.db: SQLite safe copy failed"
    return 1
  fi
  echo; echo "Restore with: hermes import $(basename "$dest")"
  case "$(basename "$dest")" in
    hermes-backup-*)
      if [ "$keep" != 0 ]; then
        local dir; dir=$(dirname "$dest")
        local pruned=0 f
        while IFS= read -r f; do
          [ -n "$f" ] || continue
          rm -f "$dir/$f"; pruned=$((pruned + 1))
        done <<LISTEND
$(find "$dir" -maxdepth 1 -type f -name 'hermes-backup-*.zip' ! -name '*.incomplete.zip' -exec basename {} \; | sort -r | sed "1,${keep}d")
LISTEND
        [ "$pruned" -gt 0 ] && echo "  Pruned $pruned older hermes-backup-*.zip (keeping $keep)."
      fi ;;
  esac
  return 0
}
