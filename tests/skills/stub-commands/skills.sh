#!/bin/bash
# shellcheck shell=bash disable=SC2154
# (sourced by the hermes stub: H, K, event, inject and gw_state come from it)
# Test behaviour of `hermes skills {search,install,inspect,list,uninstall,snapshot export,tap list}`, sourced by the hermes stub ($@ starts at
# "skills"; -p already removed). SYNTAX is the real vendored v0.22.5 argparse (so `skills describe` and unknown flags exit 2 before this runs).
# BEHAVIOUR is an assumption written from hermes_cli/skills_hub.py and tools/skills_guard.py (v0.22.5), NOT evidence about a running Hermes:
#   search --json   prints json.dumps(rows, indent=2) with keys name, identifier, source, trust_level, description (skills_hub.py:354-362); the
#                   stub produces it with python's own json module so the shape is the real one. Without --json: "Searching for: <q>" first,
#                   a table after (skills_hub.py:366-381), "No skills found matching your query." when empty.
#   install         a name Hermes ships is "a built-in skill and is already available" (exit 0, nothing fetched, skills_hub.py:727-746); a
#                   name without "/" is resolved by exact name, several hits -> "Multiple skills named .. found" (exit 1, :217-248); an
#                   installed skill prints "Warning: '<n>' is already installed at <path>" + "Use --force to reinstall." (exit 0, no-op, :877-883);
#                   the scan policy of tools/skills_guard.py:26-33,818-831 (trusted: caution allowed, dangerous blocked; community: only safe
#                   allowed; --force overrides a block EXCEPT dangerous on community/trusted) -> "Not installed: ..." exit 1 ; without --yes or
#                   --force a closed stdin answers the install prompt with "no" ("Installation cancelled.", exit 0, nothing installed, :911-914);
#                   success prints "Installed: <path>" (:920). Every call is appended to logs/skills-install.log as "<id> force=F yes=Y".
#   uninstall NAME  "Uninstalled '<n>' from <path>" ; a name that is not hub-installed: "'<n>' is not a hub-installed skill (may be a builtin)" exit 1.
#   snapshot export -  prints json.dumps({"hermes_version","exported_at","skills":[{name,source,identifier,category}],"taps":[]}, indent=2)
#                   to stdout (skills_hub.py:1448-1470); only HUB-installed skills (the lock file) are listed.
# Registry for a test: $HOME/skills.registry, one skill per line "name<TAB>identifier<TAB>source<TAB>trust_level<TAB>verdict<TAB>description".
# Built-in names: $HOME/skills.builtin (one per line). Installed state: ~/.hermes/skills/.hub/lock.tsv + ~/.hermes/skills/<category>/<name>/.
# Knobs: fail.skills.search, fail.skills.install (exit 1), skills_registry_down (search/install print an error, exit 1).
skills_rows() { [ -f "$HOME/skills.registry" ] && cat "$HOME/skills.registry"; true; }
skills_lock() { echo "$HOME/.hermes/skills/.hub/lock.tsv"; }
skills_json() { # MODE [query] : emits the JSON the real CLI would print
  python3 -I - "$1" "${2:-}" "$HOME/skills.registry" "$(skills_lock)" <<'PY'
import json, sys, os
mode, query, reg, lock = sys.argv[1:5]
rows = []
if os.path.exists(reg):
    for line in open(reg, encoding="utf-8"):
        p = line.rstrip("\n").split("\t")
        if len(p) >= 6:
            rows.append(dict(name=p[0], identifier=p[1], source=p[2], trust_level=p[3], description=p[5]))
if mode == "search":
    q = query.lower()
    hits = [r for r in rows if q in r["name"].lower() or q in r["identifier"].lower() or q in r["description"].lower()]
    print(json.dumps(hits, indent=2))
else:
    skills = []
    if os.path.exists(lock):
        for line in open(lock, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) >= 5:
                skills.append({"name": p[0], "source": p[2], "identifier": p[1], "category": p[4]})
    print(json.dumps({"hermes_version": "0.1.0", "exported_at": "2026-10-25T00:00:00+00:00", "skills": skills, "taps": []}, indent=2, ensure_ascii=False))
PY
}
hermes_cmd() {
  local act=${2:-}
  [ $# -ge 2 ] && shift 2 || shift 1
  case "$act" in
    search)
      local q="" json=0
      while [ $# -gt 0 ]; do
        case "$1" in --json) json=1; shift ;; --source|--limit) shift 2 ;; *) q=$1; shift ;; esac
      done
      event skills search; inject skills.search
      [ -f "$HOME/knobs/skills_registry_down" ] && { echo "hermes: registry unreachable" >&2; return 1; }
      if [ "$json" = 1 ]; then skills_json search "$q"; return 0; fi
      printf '\nSearching for: %s\n' "$q"
      local out
      out=$(skills_rows | awk -F'\t' -v q="$(printf '%s' "$q" | tr '[:upper:]' '[:lower:]')" 'tolower($1 " " $2 " " $6) ~ q {printf "%s  %s  %s  %s  %s\n", $1, $6, $3, $4, $2}')
      if [ -z "$out" ]; then echo "No skills found matching your query."; else printf '%s\n' "$out"; fi ;;
    install)
      local id="" force=0 yes=0 category=""
      while [ $# -gt 0 ]; do
        case "$1" in
          --force) force=1; shift ;; --yes|-y) yes=1; shift ;;
          --category|--name) [ "$1" = --category ] && category=${2:-}; shift 2 ;;
          *) id=$1; shift ;;
        esac
      done
      event skills install; inject skills.install
      printf '%s force=%s yes=%s\n' "$id" "$force" "$yes" >> "$HOME/logs/skills-install.log"
      [ -f "$HOME/knobs/skills_registry_down" ] && { echo "hermes: registry unreachable" >&2; return 1; }
      if [ -f "$HOME/skills.builtin" ] && grep -qxF -- "$id" "$HOME/skills.builtin"; then
        echo "'$id' is a built-in skill and is already available at $HOME/.hermes/skills/$id."; return 0
      fi
      local row name ident source trust verdict desc
      case "$id" in
        */*) row=$(skills_rows | awk -F'\t' -v i="$id" '$2==i {print; exit}') ;;
        *)
          local hits; hits=$(skills_rows | awk -F'\t' -v n="$id" '$1==n')
          if [ -z "$hits" ]; then echo "No skill named '$id' found in any source."; return 1; fi
          if [ "$(printf '%s\n' "$hits" | wc -l | tr -d ' ')" -gt 1 ]; then echo "Multiple skills named '$id' found:"; echo "Use the full identifier to install a specific one."; return 1; fi
          row=$hits ;;
      esac
      [ -n "$row" ] || { echo "Could not fetch '$id' from any source."; return 1; }
      IFS="$(printf '\t')" read -r name ident source trust verdict desc <<EOT
$row
EOT
      local lock; lock=$(skills_lock)
      if [ -f "$lock" ] && awk -F'\t' -v n="$name" '$1==n {f=1} END{exit !f}' "$lock"; then
        echo "Warning: '$name' is already installed at $(awk -F'\t' -v n="$name" '$1==n {print $6; exit}' "$lock")"
        [ "$force" = 1 ] || { echo "Use --force to reinstall."; return 0; }
      fi
      echo "Running security scan..."
      echo "Scan: $name ($source/$trust)  Verdict: $(printf '%s' "$verdict" | tr '[:lower:]' '[:upper:]')"
      local decision
      case "$trust:$verdict" in
        official:*|builtin:*|*:safe) decision=allow ;;
        trusted:caution) decision=allow ;;
        *:caution) decision=block ;;
        *) decision=block ;;
      esac
      if [ "$decision" = block ]; then
        local hard=0
        [ "$verdict" = dangerous ] && { [ "$trust" = community ] || [ "$trust" = trusted ]; } && hard=1
        if [ "$force" = 0 ] || [ "$hard" = 1 ]; then
          echo "Not installed: the security scan found high-risk pattern(s) in '$ident'."
          return 1
        fi
      fi
      if [ "$force" = 0 ] && [ "$yes" = 0 ]; then
        printf "Install '%s'? Confirm [y/N]: " "$name"
        if ! read -r ans || [ "$ans" != y ]; then echo; echo "Installation cancelled."; return 0; fi
      fi
      local dir="$HOME/.hermes/skills/${category:+$category/}$name"
      mkdir -p "$dir" "$(dirname "$lock")"
      printf -- '---\nname: %s\ndescription: %s\n---\n# %s\n' "$name" "$desc" "$name" > "$dir/SKILL.md"
      { [ -f "$lock" ] && awk -F'\t' -v n="$name" '$1!=n' "$lock"; printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$ident" "$source" "$trust" "$category" "$dir"; } > "$lock.tmp"
      cat "$lock.tmp" > "$lock"; rm -f "$lock.tmp"
      echo "Installed: ${category:+$category/}$name" ;;
    inspect)
      event skills inspect
      local row; row=$(skills_rows | awk -F'\t' -v i="${1:-}" '$2==i || $1==i {print; exit}')
      [ -n "$row" ] || { echo "Could not find '${1:-}' in any source."; return 0; }
      printf '%s\n' "$row" | awk -F'\t' '{printf "Name: %s\nDescription: %s\nSource: %s\nTrust: %s\nIdentifier: %s\n", $1, $6, $3, $4, $2}' ;;
    list)
      event skills list
      # Native skills_hub.do_list uses the local catalog (not only the hub lock), classifies local/builtin/hub,
      # and applies source/enabled filters. Filesystem contents below remain an offline behavioural model.
      python3 -I - "$H/skills" "$HOME/skills.builtin" "$(skills_lock)" "$CFG" "$@" <<'PYLIST'
import ast, pathlib, re, sys
root, builtin_file, lock_file, config_file = map(pathlib.Path, sys.argv[1:5])
args = sys.argv[5:]
source = args[args.index("--source") + 1] if "--source" in args else "all"
enabled_only = "--enabled-only" in args
builtins = set(builtin_file.read_text().splitlines()) if builtin_file.exists() else set()
hub = {}
if lock_file.exists():
    for line in lock_file.read_text().splitlines():
        row = line.split("\t")
        if len(row) >= 5:
            hub[row[0]] = row
config = config_file.read_text() if config_file.exists() else ""
disabled = set()
for line in config.splitlines():
    if line.startswith("skills.disabled: "):
        raw = line.split(": ", 1)[1]
        try:
            value = ast.literal_eval(raw)
        except (SyntaxError, ValueError):
            value = raw
        disabled.update([value] if isinstance(value, str) else (value or []))
rows = {}
for name in builtins:
    rows[name] = ("builtin", "builtin")
for name, row in hub.items():
    rows[name] = ("hub", row[2])
if root.exists():
    for md in sorted(root.rglob("SKILL.md")):
        if md.is_symlink() or any(part.startswith(".") for part in md.relative_to(root).parts):
            continue
        text = md.read_text()
        if not text.startswith("---\n"):
            continue
        front = text.split("---", 2)[1]
        m = re.search(r"^name:\s*([^\n]+)", front, re.M)
        if not re.search(r"^description:\s*\S", front, re.M):
            continue
        name = m.group(1).strip().strip("\"'") if m else md.parent.name
        if name not in rows:
            rows[name] = ("local", "local")
print("Installed Skills")
for name, (kind, label) in sorted(rows.items()):
    if source not in ("all", kind) or (enabled_only and name in disabled):
        continue
    print(name, label, "disabled" if name in disabled else "enabled")
PYLIST
      ;;
    uninstall)
      local name="" yes=0
      while [ $# -gt 0 ]; do case "$1" in --yes|-y) yes=1; shift ;; *) name=$1; shift ;; esac; done
      event skills uninstall
      printf 'uninstall %s yes=%s\n' "$name" "$yes" >> "$HOME/logs/skills-install.log"
      local lock; lock=$(skills_lock)
      if [ ! -f "$lock" ] || ! awk -F'\t' -v n="$name" '$1==n {f=1} END{exit !f}' "$lock"; then echo "'$name' is not a hub-installed skill (may be a builtin)"; return 1; fi
      local p; p=$(awk -F'\t' -v n="$name" '$1==n {print $6; exit}' "$lock")
      rm -rf "$p"
      awk -F'\t' -v n="$name" '$1!=n' "$lock" > "$lock.tmp"; cat "$lock.tmp" > "$lock"; rm -f "$lock.tmp"
      echo "Uninstalled '$name' from $p" ;;
    snapshot)
      if [ "${1:-}" = export ] && [ "${2:-}" = "-" ]; then event skills snapshot-export; skills_json snapshot; else event unknown skills snapshot "$@"; echo "hermes: unknown: skills snapshot $*" >&2; return 99; fi ;;
    tap)
      if [ "${1:-}" = list ]; then event skills tap-list; echo "No custom taps configured. Using default sources only."; else event unknown skills tap "$@"; echo "hermes: tap is read-only in the test double" >&2; return 99; fi ;;
    *) event unknown skills "$act" "$@"; echo "hermes: unknown: skills $act $*" >&2; return 99 ;;
  esac
}
