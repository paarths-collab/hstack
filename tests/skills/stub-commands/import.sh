#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by ../hermes, which defines H, K, CFG, ENVF, event, inject, upsert_env, gw_state, mcp_names and mcp_field)
# Test behaviour of `hermes import ZIPFILE [--force|-f]`. NOT Hermes. Sourced by the hermes stub for the `import` command
# ($@ starts at `import`; the global `-p default` is removed and the real v0.22.5 argparse has accepted the argv).
#
# Order of checks, messages and exit codes are copied from hermes_cli/backup.py:732-912 at v0.22.5; the restore itself is a
# real extraction (python3 zipfile) over the simulated home. Assumptions (knobs under $HOME/knobs):
#   import_corrupt   the archive is damaged: "Error: backup archive is damaged ... nothing was restored", exit 1
#
# Rules reproduced on purpose:
#   * file missing / not a zip / no config.yaml, .env or state.db inside -> "Error: ...", exit 1                (backup.py:735-751)
#   * existing config.yaml or .env and NO --force: asks "Continue? [y/N]"; EOF (no TTY) -> "Aborted." exit 1; anything but
#     y/yes -> "Aborted." and exit 0                                                                           (backup.py:772-790)
#   * a gateway that owns the home REFUSES the import before any file is written: "Import refused; no files restored:
#     Exclusive maintenance refused: ... Drain and stop the gateway, then retry.", exit 1   (gateway/runtime_ownership.py:253-275)
#   * never overwritten: gateway_state.json, gateway.pid, cron.pid, gateway.lock, processes.json, *.db-wal/-shm/-journal (backup.py:147)
#   * .env, auth.json, state.db, vault.* are tightened to mode 600 after extraction                             (backup.py:120,1055)
#   * afterwards an INSTALLED gateway service is started best-effort (the stub: state/gateway.install present)  (backup.py:1070-1100)
#   * success prints "Done. Your Hermes configuration has been restored." and exits 0

hermes_cmd() {
  shift   # "import"
  local zip="" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f) force=1; shift ;;
      *) zip=$1; shift ;;
    esac
  done
  event import; inject import
  if [ ! -f "$zip" ]; then echo "Error: File not found: $zip"; return 1; fi
  if ! python3 -I -c 'import sys,zipfile; sys.exit(0 if zipfile.is_zipfile(sys.argv[1]) else 1)' "$zip"; then echo "Error: Not a valid zip file: $zip"; return 1; fi
  local names
  names=$(python3 -I -c 'import sys,zipfile; print("\n".join(n for n in zipfile.ZipFile(sys.argv[1]).namelist() if not n.endswith("/")))' "$zip")
  if ! printf '%s\n' "$names" | grep -qE '(^|/)(config\.yaml|\.env|state\.db)$'; then
    echo "Error: zip does not appear to be a Hermes backup (no config.yaml, .env, or state databases found)"; return 1
  fi
  echo "Backup contains $(printf '%s\n' "$names" | grep -c .) files"
  echo "Target: ~/.hermes"
  if { [ -f "$H/config.yaml" ] || [ -f "$H/.env" ]; } && [ "$force" = 0 ]; then
    echo; echo "Warning: Target directory already has Hermes configuration."
    echo "Importing will overwrite existing files with backup contents."; echo
    printf 'Continue? [y/N] '
    local answer
    if ! IFS= read -r answer; then echo; echo "Aborted."; return 1; fi
    case $(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]') in y|yes) ;; *) echo "Aborted."; return 0 ;; esac
  fi
  echo; echo "Checking archive integrity ..."
  if [ -f "$K/import_corrupt" ]; then
    echo "Error: backup archive is damaged (1 member(s) fail to decompress or fail their CRC); nothing was restored:"; return 1
  fi
  if [ "$(gw_state)" = running ]; then
    echo; echo "Import refused; no files restored: Exclusive maintenance refused: Gateway runtime already owns profile $H. Drain and stop the gateway, then retry."
    return 1
  fi
  echo; echo "Importing $(printf '%s\n' "$names" | grep -c .) files ..."
  python3 -I - "$zip" "$H" <<'PY'
import os, sys, zipfile
zpath, home = sys.argv[1:3]
SKIP = {"gateway_state.json", "gateway.pid", "cron.pid", "gateway.lock", "processes.json"}
SECRET = {".env", "auth.json", "state.db", "vault.key", "vault.json.enc"}
with zipfile.ZipFile(zpath) as zf:
    for m in zf.namelist():
        if m.endswith("/"):
            continue
        base = os.path.basename(m)
        if base in SKIP or m.endswith((".db-wal", ".db-shm", ".db-journal")):
            continue
        target = os.path.join(home, m)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "wb") as fh:
            fh.write(zf.read(m))
        if base in SECRET:
            os.chmod(target, 0o600)
PY
  echo; echo "Import complete: $(printf '%s\n' "$names" | grep -c .) files restored in 0.0s"
  echo "  Target: ~/.hermes"
  if [ -f "$HOME/state/gateway.install" ]; then
    local c; c=$(cat "$H/gateway.instance" 2>/dev/null || echo 0); echo $((c + 1)) > "$H/gateway.instance"; echo running > "$H/gateway.state"
  fi
  echo; echo "Done. Your Hermes configuration has been restored."
  return 0
}
