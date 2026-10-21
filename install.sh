#!/usr/bin/env bash
# hstack universal installer.
#
# Usage — one-liner (curl-piped, installs to every detected IDE with all skills):
#   curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash
#
# Usage — with interactive picker (recommended, run in a terminal):
#   curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh -o hstack-install.sh
#   bash hstack-install.sh --pick
#
# Usage — non-interactive with explicit choices:
#   ... | bash -s -- --tier=memory,database
#   ... | bash -s -- --include=notion,stripe,mem0,supabase
#   ... | bash -s -- --ide=claude,openclaw
#
# What it does:
#   1. Clones or updates hstack into ~/.hstack
#   2. Detects installed IDEs / agents (Claude Code, Codex, Cursor, Hermes, Gemini CLI, OpenClaw)
#   3. Optionally prompts you to pick integrations (or accepts flags)
#   4. Symlinks the chosen skills into each detected IDE's skill directory
#   5. Reports what got wired where
#
# Safe defaults:
#   - Always installs core operational skills (/hermes-deploy, /hermes-*, /platform-*)
#   - Integrations default to "all" when run non-interactively (curl-piped)
#   - Never touches config.yaml, .env, or anything with secrets
#   - Never deletes your own files: anything at a destination that hstack did not
#     install is moved aside (skill dirs to <skills-parent>/.hstack-backups/<timestamp>/,
#     files to <name>.hstack-backup-<timestamp>) and the exact path is printed
#   - No sudo, no network calls after the git clone
#
# Runs on bash 3.2 (stock macOS /bin/bash) and newer.

# Not running under bash (e.g. `curl ... | zsh`, `zsh install.sh`)? Re-exec with bash when
# we are a real file, otherwise say how to run us. Everything above this guard is POSIX.
if [ -z "${BASH_VERSION:-}" ]; then
  case "$0" in
    sh | -sh | zsh | -zsh | dash | -dash | ksh | -ksh | */sh | */zsh | */dash | */ksh) ;;
    *)
      if [ -f "$0" ] && [ -r "$0" ]; then exec bash "$0" "$@"; fi
      ;;
  esac
  echo "hstack: install.sh must be run with bash, e.g.  curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash" >&2
  exit 2
fi

set -euo pipefail

usage() {
  cat <<'USAGE'
hstack universal installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash
  curl -fsSL https://raw.githubusercontent.com/paarths-collab/hstack/main/install.sh | bash -s -- [FLAGS]
  bash install.sh [FLAGS]

Flags:
  --all              install every integration, no prompt
  --tier=a,b         install the named integration tiers (e.g. --tier=memory,database)
  --include=x,y      install specific integrations or tiers (e.g. --include=notion,stripe)
  --pick             interactive picker (reads the terminal, works when piped)
  --ide=a,b          only wire these agents: claude, codex, cursor, hermes, gemini, openclaw
                     (or "all"). Default: every agent detected on this machine.
  --local            use the checkout this script lives in instead of cloning ~/.hstack
  --branch=NAME      branch to clone/update (default: main)
  -h, --help         show this help

Core (hermes-*, blueprint-*, setup-ssh-keys) and platform-* skills are always installed.
With no selection flags: interactive picker on a terminal, all integrations otherwise.

Environment overrides:
  HSTACK_REPO_URL, HSTACK_INSTALL_DIR, HSTACK_BRANCH
  CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR, CURSOR_RULES_DIR, HERMES_SKILLS_DIR,
  GEMINI_CONTEXT_DIR, OPENCLAW_SKILLS_DIR

Existing files: anything at a destination that hstack did not install is moved aside, never
deleted: skill dirs to <skills-parent>/.hstack-backups/<timestamp>/<name>, files to
<name>.hstack-backup-<timestamp>. Re-running replaces only hstack's own links and copies.
Path overrides may be relative (resolved against the current directory). A destination that is,
or resolves into, the hstack checkout's skills/ directory is refused.
USAGE
}

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_URL="${HSTACK_REPO_URL:-https://github.com/paarths-collab/hstack.git}"
INSTALL_DIR="${HSTACK_INSTALL_DIR:-${HOME:-}/.hstack}"
BRANCH="${HSTACK_BRANCH:-main}"

# CLI flags (parsed below)
PICK_MODE=0
INCLUDE=""
TIER=""
IDE_FILTER=""
INSTALL_ALL=0
LOCAL_RUN=0

# Tier → skills mapping (edit as new tiers land; mirrored in install.ps1 and CLAUDE.md).
# A case function instead of an associative array: stock macOS bash 3.2 has no `declare -A`.
tier_members() {
  case "$1" in
    core) echo "blueprint-install blueprint-saas-founder setup-ssh-keys hermes-backup hermes-cron hermes-deploy hermes-fix hermes-home hermes-install hermes-integrate hermes-mcp-add hermes-memory hermes-model hermes-restart hermes-skills hermes-soul hermes-status hermes-update" ;;
    platforms) echo "platform-discord platform-google-chat platform-mattermost platform-signal platform-slack platform-teams platform-telegram platform-whatsapp" ;;
    memory) echo "integration-mem0 integration-supermemory" ;;
    database) echo "integration-supabase integration-postgres integration-neon integration-redis" ;;
    vector) echo "integration-pinecone integration-qdrant" ;;
    auth) echo "integration-auth0 integration-clerk" ;;
    observability) echo "integration-posthog integration-sentry integration-datadog integration-segment" ;;
    rag) echo "integration-firecrawl" ;;
    code) echo "integration-e2b" ;;
    ai-tools) echo "integration-openai-tools integration-elevenlabs integration-replicate" ;;
    storage) echo "integration-r2" ;;
    crm) echo "integration-hubspot integration-salesforce integration-pipedrive integration-zoho-crm" ;;
    docs) echo "integration-notion integration-google-workspace integration-microsoft-365 integration-obsidian" ;;
    dev) echo "integration-github integration-gitlab integration-bitbucket" ;;
    pm) echo "integration-jira integration-linear integration-asana integration-clickup integration-monday integration-trello integration-airtable" ;;
    cloud) echo "integration-aws integration-gcp integration-azure integration-digitalocean integration-hetzner integration-cloudflare integration-vercel integration-netlify integration-railway integration-render" ;;
    payments) echo "integration-stripe integration-paypal integration-razorpay" ;;
    commerce) echo "integration-shopify integration-woocommerce integration-webflow integration-wordpress" ;;
    email) echo "integration-mailchimp integration-brevo integration-sendgrid integration-postmark" ;;
    support) echo "integration-twilio integration-sendbird integration-intercom integration-zendesk integration-freshdesk" ;;
    forms) echo "integration-typeform integration-tally integration-calendly integration-zoom" ;;
    search) echo "integration-brave-search integration-tavily integration-exa" ;;
    *) return 0 ;;
  esac
}

# Integration tiers, in display order (this order also numbers the --pick menu)
INTEGRATION_TIERS="memory database vector auth observability rag code ai-tools storage crm docs dev pm cloud payments commerce email support forms search"
ALL_IDES="claude codex cursor hermes gemini openclaw"

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --pick) PICK_MODE=1 ;;
    --all) INSTALL_ALL=1 ;;
    --local) LOCAL_RUN=1 ;;
    --include=*) INCLUDE="${arg#--include=}" ;;
    --tier=*) TIER="${arg#--tier=}" ;;
    --ide=*) IDE_FILTER="${arg#--ide=}" ;;
    --branch=*) BRANCH="${arg#--branch=}" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "WARN: unknown flag '$arg' — ignoring" >&2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Colors + logging
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

log()    { printf "%s\n" "$*"; }
info()   { printf "${DIM}%s${RESET}\n" "$*"; }
ok()     { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()   { printf "${YELLOW}!${RESET} %s\n" "$*" >&2; }
die()    { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }
heading(){ printf "\n${BOLD}%s${RESET}\n" "$*"; }

# "a, b,c" → one trimmed item per line
csv_items() { printf '%s\n' "$1" | tr ',' '\n' | tr -d ' '; }

hs_warn() { warn "$@"; }

# >>> hstack-ownership (this block is identical in install.sh and every setup* script;
# >>> tests/installer/test-install.sh fails if the copies drift apart)
#
# Rule: hstack replaces only what hstack itself installed, and never deletes anything else.
# A non-owned entry found at a destination is moved aside and the exact new path is printed:
#   skill dir / symlink -> <skills-parent>/.hstack-backups/<stamp>[-N]/<name>
#                          (outside the skills dir, so agents do not load the old skill twice)
#   file (.mdc/.md)     -> <file>.hstack-backup-<stamp>
# Owned means:
#   symlink : its target resolves inside a hstack skills tree (HS_ROOTS) or any hstack
#             checkout, or it dangles at ".../skills/<same name>" (a removed old checkout)
#   dir     : the .hstack-managed marker holds "sha256:<digest of the tree as hstack wrote
#             it>" and the tree still matches it (an unedited, possibly older, copy: replaced
#             silently on upgrade), or the dir equals the source being installed (marker
#             ignored; this is also the rule for an empty legacy marker)
#   file    : the "<!-- hstack-managed sig=... -->" line matches the digest of the rest of
#             the file (unedited), or the file equals what hstack would write now (marker
#             line ignored). A user-edited copy is backed up like any foreign entry.
# Destinations that are, or lie inside, a hstack skills tree are refused outright.
# Callers define hs_warn() and HS_ROOTS (newline-separated physical skills dirs).
HS_MARKER=".hstack-managed"
HS_STAMP="${HS_STAMP:-$(date +%Y%m%d%H%M%S)}"

# HOME must be an absolute path: anything else would write to "/.claude" or the cwd.
hs_need_home() {
  case "${HOME:-}" in
    /*) ;;
    *)
      echo "hstack: HOME must be set to an absolute path (got '${HOME:-}')" >&2
      exit 2
      ;;
  esac
}

# Absolute form of a path, resolved against the CURRENT directory. Call before any cd.
hs_abs() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$(pwd)" "${1#./}" ;;
  esac
}

# Physical (symlink-free) absolute path of a directory; fails if it does not exist.
hs_pdir() { (CDPATH='' cd -P "$1" 2>/dev/null && pwd -P); }

# "sha256:<hex>" digest of stdin (a cksum value where no sha256 tool exists), and of a
# directory tree: sorted names, kinds, file digests and link texts; only the top-level
# marker file is excluded, so extra files, empty dirs and symlinks all change it.
hs_sig() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf 'sha256:%s\n' "$(sha256sum | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    printf 'sha256:%s\n' "$(shasum -a 256 | cut -d' ' -f1)"
  else
    printf 'cksum:%s\n' "$(cksum | tr ' ' '-')"
  fi
}
hs_sig_dir() {
  (
    cd "$1" || exit 1
    find . ! -path . ! -path "./$HS_MARKER" -print | LC_ALL=C sort | while IFS= read -r f; do
      if [ -L "$f" ]; then
        printf 'l %s -> %s\n' "$f" "$(readlink "$f")"
      elif [ -d "$f" ]; then
        printf 'd %s\n' "$f"
      elif [ -f "$f" ]; then
        printf 'f %s %s\n' "$f" "$(hs_sig <"$f")"
      else
        printf 'o %s\n' "$f"
      fi
    done | hs_sig
  )
}

# stdin-less helper: <file> with the one marker line "<!-- hstack-managed sig=$2 -->" removed.
hs_strip_marker() {
  awk -v m="<!-- hstack-managed sig=$2 -->" '!d && $0 == m { d = 1; next } { print }' "$1"
}

# Follow a symlink chain and return the absolute final path (no readlink -f: BSD/macOS
# readlink lacks it). A dangling link yields its best-effort target path.
hs_resolve() {
  local p="$1" n=0 t d
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname "$p")/$t" ;;
    esac
    n=$((n + 1))
  done
  if d="$(hs_pdir "$(dirname "$p")")"; then p="${d%/}/$(basename "$p")"; fi
  printf '%s\n' "$p"
}

# 0 if the symlink points into a hstack skills tree, into any hstack checkout, or dangles
# at ".../skills/<its own name>" (the checkout it came from was removed or moved).
hs_is_our_link() {
  local t root top b
  t="$(hs_resolve "$1")"
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    case "$t" in "$root"/*) return 0 ;; esac
  done <<<"$HS_ROOTS"
  if [ ! -e "$1" ]; then
    b="$(basename "$1")"
    case "$t" in
      */skills/"$b" | */skills/"$b"/SKILL.md | */skills/"${b%.md}"/SKILL.md) return 0 ;;
    esac
    return 1
  fi
  t="${t%/SKILL.md}"
  top="$(dirname "$(dirname "$t")")"
  [ -f "$top/install.sh" ] && [ -f "$top/setup-all" ] && [ -f "$t/SKILL.md" ]
}

# hs_owned <dst> [<reference copy of what would be installed>]
hs_owned() {
  local dst="$1" ref="${2%/}" rec
  if [ -L "$dst" ]; then
    hs_is_our_link "$dst"
  elif [ -d "$dst" ]; then
    if [ -f "$dst/$HS_MARKER" ] && [ "$(cat "$dst/$HS_MARKER")" = "$(hs_sig_dir "$dst")" ]; then return 0; fi
    # equal to the source being installed (top-level marker ignored; compared by digest,
    # not diff, because some diffs miss empty dirs and symlinks)
    [ -d "$ref" ] || return 1
    [ "$(hs_sig_dir "$dst")" = "$(hs_sig_dir "$ref")" ]
  elif [ -f "$dst" ]; then
    rec="$(sed -n 's/^<!-- hstack-managed sig=\([0-9a-z:-]*\) -->$/\1/p' "$dst" 2>/dev/null | head -1)"
    if [ -n "$rec" ]; then
      if [ "$rec" = "$(hs_strip_marker "$dst" "$rec" | hs_sig)" ]; then return 0; fi
      # still what hstack would write now (the one marker line ignored)?
      [ -f "$ref" ] && hs_strip_marker "$dst" "$rec" | cmp -s - "$ref" && return 0
    fi
    # an unmarked copy identical to what hstack would install
    [ -f "$ref" ] && cmp -s "$ref" "$dst"
  else
    return 1
  fi
}

# An unused "<path>.hstack-backup-<stamp>[-n]" name (files backed up next to the original).
hs_bak_path() {
  local bak="$1.hstack-backup-$HS_STAMP" n=1
  while [ -e "$bak" ] || [ -L "$bak" ]; do
    bak="$1.hstack-backup-$HS_STAMP-$n"
    n=$((n + 1))
  done
  printf '%s\n' "$bak"
}

# An unused "<skills-parent>/.hstack-backups/<stamp>[-n]/<name>" path, parent dir created.
hs_dir_bak_path() {
  local name root d suffix="" n=0
  name="$(basename "$1")"
  root="$(dirname "$(dirname "$1")")/.hstack-backups"
  while :; do
    d="$root/$HS_STAMP$suffix"
    if [ ! -e "$d/$name" ] && [ ! -L "$d/$name" ]; then break; fi
    n=$((n + 1))
    suffix="-$n"
  done
  mkdir -p "$d" || return 1
  [ -d "$d" ] && [ -w "$d" ] || return 1
  printf '%s\n' "$d/$name"
}

# hs_clear_dst <dst> [<ref>] [dir|file]
# Free <dst> for a fresh install: remove it if hstack owns it, otherwise move it aside.
# Returns 1 and writes nothing if <dst> is the hstack source itself, or if it could not be
# removed / moved aside (failed backups are never ignored: the caller must not write then).
hs_clear_dst() {
  local dst="$1" ref="${2:-}" kind="${3:-file}" bak
  [ -e "$dst" ] || [ -L "$dst" ] || return 0
  if [ ! -L "$dst" ] && [ -n "$ref" ] && [ "$dst" -ef "$ref" ]; then
    hs_warn "$dst is the hstack source itself - skipped"
    return 1
  fi
  if hs_owned "$dst" "$ref"; then
    if [ -d "$dst" ] && [ ! -L "$dst" ]; then rm -rf "$dst"; else rm -f "$dst"; fi
  else
    if [ "$kind" = dir ]; then
      bak="$(hs_dir_bak_path "$dst")" || {
        hs_warn "$dst is not managed by hstack and no backup location is usable - left untouched"
        return 1
      }
    else
      bak="$(hs_bak_path "$dst")"
    fi
    mv "$dst" "$bak" || {
      hs_warn "cannot move $dst aside to $bak - left untouched"
      return 1
    }
    hs_warn "$dst is not managed by hstack - moved to $bak (nothing deleted)"
  fi
  # Whatever happened, only write when the destination is really free.
  if [ -e "$dst" ] || [ -L "$dst" ]; then
    hs_warn "$dst could not be cleared - left untouched"
    return 1
  fi
  return 0
}

# hs_target_ok <dir>: refuse a destination that is, or resolves to somewhere inside, a
# hstack skills tree (e.g. ~/.claude/skills symlinked to the checkout's skills/).
hs_target_ok() {
  local p root
  p="$(hs_pdir "$1")" || {
    hs_warn "cannot use $1 as a destination: not a directory"
    return 1
  }
  while IFS= read -r root; do
    [ -n "$root" ] || continue
    case "$p/" in
      "$root"/*)
        hs_warn "refusing to install into $1: it resolves to $p, which is inside the hstack source tree $root"
        return 1
        ;;
    esac
  done <<<"$HS_ROOTS"
  return 0
}

# Skill directory: symlink (preferred) or copy carrying a checksum marker.
hs_install_dir() {
  local src="${1%/}" dst="$2"
  hs_clear_dst "$dst" "$src" dir || return 1
  if ln -s "$src" "$dst" 2>/dev/null; then
    :
  else
    if ! cp -R "$src" "$dst" 2>/dev/null || ! hs_sig_dir "$dst" >"$dst/$HS_MARKER"; then
      rm -rf "$dst"
      hs_warn "write error: could not copy $src to $dst (partial copy removed)"
      return 1
    fi
  fi
}

# Single file (Gemini context): symlink (preferred) or copy ending in a checksum marker.
hs_install_file() {
  local src="$1" dst="$2"
  hs_clear_dst "$dst" "$src" file || return 1
  if ln -s "$src" "$dst" 2>/dev/null; then
    :
  else
    # dst was free before this point, so anything at dst now is the partial file we just made
    if ! { cat "$src" >"$dst" && printf '\n' >>"$dst"; } 2>/dev/null ||
      ! printf '<!-- hstack-managed sig=%s -->\n' "$(hs_sig <"$dst")" 2>/dev/null >>"$dst"; then
      rm -f "$dst"
      hs_warn "write error: could not write $dst (partial file removed)"
      return 1
    fi
  fi
}

# Cursor rule body for <skill>; a non-empty 3rd argument is the checksum for the marker line.
hs_gen_mdc() {
  local skill="$1" src="$2" sig="${3:-}" desc
  desc="$(awk '/^description:/{sub(/^description: */,""); print; exit}' "$src")"
  echo "---"
  echo "description: ${desc:-hstack skill: $skill}"
  echo "globs:"
  echo "alwaysApply: false"
  echo "---"
  if [ -n "$sig" ]; then echo "<!-- hstack-managed sig=$sig -->"; fi
  echo
  awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$src"
}

# Cursor .mdc rule. Written through a temp file onto a fresh path, never through an
# existing symlink.
hs_install_mdc() {
  local skill="$1" src="$2" dst="$3" new legacy
  new="$(mktemp "${TMPDIR:-/tmp}/hstack-mdc.XXXXXX")"
  legacy="$(mktemp "${TMPDIR:-/tmp}/hstack-mdc.XXXXXX")"
  hs_gen_mdc "$skill" "$src" >"$legacy"
  hs_gen_mdc "$skill" "$src" "$(hs_sig <"$legacy")" >"$new"
  if ! hs_clear_dst "$dst" "$legacy" file; then
    rm -f "$new" "$legacy"
    return 1
  fi
  # dst is free here, so a failed write leaves only our own partial file: remove exactly that
  if ! cat "$new" 2>/dev/null >"$dst" || ! cmp -s "$new" "$dst"; then
    rm -f "$new" "$legacy" "$dst"
    hs_warn "write error: could not write $dst (partial file removed)"
    return 1
  fi
  rm -f "$new" "$legacy"
}
# <<< hstack-ownership

# From here on HOME is known good (--help above works without it).
hs_need_home

# Resolve every path override against the directory we were started in, BEFORE the cd
# below: a relative CLAUDE_SKILLS_DIR=skills must not point into the checkout itself.
INSTALL_DIR="$(hs_abs "$INSTALL_DIR")"
CLAUDE_TARGET="$(hs_abs "${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}")"
CODEX_TARGET="$(hs_abs "${CODEX_SKILLS_DIR:-$HOME/.agents/skills}")"
CURSOR_TARGET="$(hs_abs "${CURSOR_RULES_DIR:-$HOME/.cursor/rules}")"
HERMES_TARGET="$(hs_abs "${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}")"
GEMINI_TARGET="$(hs_abs "${GEMINI_CONTEXT_DIR:-$HOME/.gemini/context/hstack}")"
OPENCLAW_TARGET="$(hs_abs "${OPENCLAW_SKILLS_DIR:-$HOME/.openclaw/skills}")"

# ---------------------------------------------------------------------------
# Step 1: clone / update repo
# ---------------------------------------------------------------------------

if [ "$LOCAL_RUN" = "1" ]; then
  # (piped into bash there is no script path: fall back to the current directory)
  if [ -n "${BASH_SOURCE[0]:-}" ]; then
    INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  else
    INSTALL_DIR="$(pwd)"
  fi
  info "Running from local checkout: $INSTALL_DIR"
else
  command -v git >/dev/null 2>&1 || die "git is required. Install git and re-run."
  heading "==> Fetching hstack"
  # </dev/null: when this script is piped into bash, stdin IS the script — keep git off it.
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing checkout at $INSTALL_DIR"
    (cd "$INSTALL_DIR" && git fetch origin --quiet </dev/null && git checkout --quiet "$BRANCH" && git pull --ff-only --quiet </dev/null) \
      || warn "Could not fast-forward. Continuing with existing checkout."
  elif [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null | wc -l)" -gt 0 ]; then
    die "$INSTALL_DIR exists and is not a git checkout of hstack. Move it aside and re-run."
  else
    info "Cloning $REPO_URL → $INSTALL_DIR (branch $BRANCH)"
    git clone --depth 1 --branch "$BRANCH" --quiet "$REPO_URL" "$INSTALL_DIR" </dev/null
  fi
  ok "hstack checkout ready"
fi

cd "$INSTALL_DIR"

[ -d skills ] || die "$INSTALL_DIR/skills not found — checkout is broken."


# Skills trees whose symlinks count as "ours": the one being installed, the default
# ~/.hstack checkout, and a custom HSTACK_INSTALL_DIR.
HS_ROOTS="$(hs_pdir "$INSTALL_DIR/skills" || echo "$INSTALL_DIR/skills")"
for hs_extra in "$HOME/.hstack/skills" "${HSTACK_INSTALL_DIR:+$HSTACK_INSTALL_DIR/skills}"; do
  [ -n "$hs_extra" ] || continue
  HS_ROOTS="$HS_ROOTS"$'\n'"$(hs_pdir "$hs_extra" || echo "$hs_extra")"
done

# ---------------------------------------------------------------------------
# Step 2: detect installed IDEs
# ---------------------------------------------------------------------------

heading "==> Detecting IDEs / agents"

# Set of selected IDEs as a space-delimited string (bash 3.2 has no associative arrays).
IDES=" "
ide_add() { case "$IDES" in *" $1 "*) ;; *) IDES="$IDES$1 " ;; esac; }
ide_has() { case "$IDES" in *" $1 "*) return 0 ;; esac; return 1; }

[ -d "$HOME/.claude" ]    && ide_add claude
[ -d "$HOME/.agents" ]    && ide_add codex
[ -d "$HOME/.cursor" ]    && ide_add cursor
[ -d "$HOME/.hermes" ]    && ide_add hermes
[ -d "$HOME/.gemini" ]    && ide_add gemini
[ -d "$HOME/.openclaw" ]  && ide_add openclaw

# --ide= selects exactly the requested agents (even ones not detected: the target dir is created)
if [ -n "$IDE_FILTER" ]; then
  IDES=" "
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ "$p" = "all" ]; then
      IDES=" "
      for k in $ALL_IDES; do ide_add "$k"; done
      break
    fi
    case " $ALL_IDES " in
      *" $p "*) ide_add "$p" ;;
      *) warn "unknown IDE '$p' — skipping (available: $ALL_IDES, all)" ;;
    esac
  done <<<"$(csv_items "$IDE_FILTER")"
fi

IDE_COUNT=0
for ide in $ALL_IDES; do
  if ide_has "$ide"; then IDE_COUNT=$((IDE_COUNT + 1)); fi
done

if [ "$IDE_COUNT" -eq 0 ]; then
  warn "No IDEs / agents detected."
  info "Nothing to configure. Install one of these first:"
  info "  Claude Code:  https://docs.claude.com/en/docs/claude-code"
  info "  Cursor:       https://cursor.com"
  info "  Codex:        https://github.com/openai/codex"
  info "  Hermes:       https://github.com/NousResearch/hermes-agent"
  info "  Gemini CLI:   https://github.com/google/gemini-cli"
  info "  OpenClaw:     https://docs.openclaw.ai"
  info ""
  info "Or force-install to a specific target: bash install.sh --ide=claude"
  exit 0
fi

for ide in $ALL_IDES; do
  if ide_has "$ide"; then
    ok "detected: $ide"
  fi
done

# ---------------------------------------------------------------------------
# Step 3: decide which skills to install
# ---------------------------------------------------------------------------

heading "==> Choosing skills"

# Chosen skills, one per line (duplicates are fine: sorted/uniqued below).
CHOSEN=""
chosen_add() { CHOSEN="$CHOSEN$1"$'\n'; }

pick_from_tier() {
  local s
  for s in $(tier_members "$1"); do chosen_add "$s"; done
}

pick_all_integrations() {
  local t
  for t in $INTEGRATION_TIERS; do pick_from_tier "$t"; done
}

# Resolve one user token (tier, integration name, bare skill name). Returns 1 if unknown.
pick_token() {
  local p="$1"
  if [ -n "$(tier_members "$p")" ]; then
    pick_from_tier "$p"
  elif [ -d "skills/integration-$p" ]; then
    chosen_add "integration-$p"
  elif [ -d "skills/$p" ]; then
    chosen_add "$p"
  else
    return 1
  fi
}

# Menu number → tier (1 = all, 2.. = INTEGRATION_TIERS in order)
tier_by_number() {
  local n="$1" i=2 t
  for t in $INTEGRATION_TIERS; do
    if [ "$i" = "$n" ]; then echo "$t"; return 0; fi
    i=$((i + 1))
  done
  return 1
}

# Always install core + platforms (deploy is useless without these)
pick_from_tier core
pick_from_tier platforms

if [ "$INSTALL_ALL" = "1" ]; then
  info "Installing ALL integrations (--all)"
  pick_all_integrations
elif [ -n "$INCLUDE" ]; then
  info "Installing only: $INCLUDE"
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    pick_token "$p" || warn "unknown skill or tier: '$p' — skipping"
  done <<<"$(csv_items "$INCLUDE")"
elif [ -n "$TIER" ]; then
  info "Installing tiers: $TIER"
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    if [ -n "$(tier_members "$t")" ]; then
      pick_from_tier "$t"
    else
      warn "unknown tier: '$t' — skipping (available: $INTEGRATION_TIERS)"
    fi
  done <<<"$(csv_items "$TIER")"
elif [ "$PICK_MODE" = "1" ] || [ -t 0 ]; then
  # Interactive picker — only if TTY is present
  cat <<EOF

hstack currently has 71 integrations across 20 tiers.
Core skills (/hermes-deploy, all platforms) are ALWAYS installed.

Available integration tiers:

  1) all              - everything (71 integrations)
  2) memory           - mem0, supermemory
  3) database         - supabase, postgres, neon, redis
  4) vector           - pinecone, qdrant
  5) auth             - auth0, clerk
  6) observability    - posthog, sentry, datadog, segment
  7) rag              - firecrawl (web scraping for RAG)
  8) code             - e2b (safe code execution)
  9) ai-tools         - openai-tools (DALL-E, Whisper, embeddings), elevenlabs (voice), replicate
 10) storage          - r2 (zero-egress S3-compat)
 11) crm              - hubspot, salesforce, pipedrive, zoho-crm
 12) docs             - notion, google-workspace, microsoft-365, obsidian
 13) dev              - github, gitlab, bitbucket
 14) pm               - jira, linear, asana, clickup, monday, trello, airtable
 15) cloud            - aws, gcp, azure, digitalocean, hetzner, cloudflare, vercel, netlify, railway, render
 16) payments         - stripe, paypal, razorpay
 17) commerce         - shopify, woocommerce, webflow, wordpress
 18) email            - mailchimp, brevo, sendgrid, postmark
 19) support          - twilio, sendbird, intercom, zendesk, freshdesk
 20) forms            - typeform, tally, calendly, zoom
 21) search           - brave-search, tavily, exa

Enter the numbers or names of tiers, comma-separated (e.g. '2,3,9' or 'memory,database,ai-tools'),
or a specific integration ('notion,stripe'),
or 'all' (or 1) for everything, or press Enter to skip integrations.

EOF
  # Read from the terminal so this works even when piped from curl (HSTACK_TTY: test hook)
  PICKS=""
  read -rp "> " -er PICKS <"${HSTACK_TTY:-/dev/tty}" || true
  if [ -z "${PICKS// /}" ]; then
    info "No integrations selected. Installing core + platforms only."
  else
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      if [ "$p" = "all" ]; then
        pick_all_integrations
        continue
      fi
      case "$p" in
        *[!0-9]*) ;;
        *)
          # a menu number
          n=$((10#$p))
          if [ "$n" = "1" ]; then
            pick_all_integrations
          elif t="$(tier_by_number "$n")"; then
            pick_from_tier "$t"
          else
            warn "unknown menu number: '$p' — skipping (1-21)"
          fi
          continue
          ;;
      esac
      pick_token "$p" || warn "unknown: '$p' — skipping"
    done <<<"$(csv_items "$PICKS")"
  fi
else
  # Non-interactive, no flags — default to ALL (safe for curl-pipe use)
  info "Non-interactive install (no flags) — including all integrations."
  info "Run with --pick or --tier=... / --include=... for a smaller install."
  pick_all_integrations
fi

# Filter chosen down to skills that actually exist on disk
FINAL=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    */* | .*)
      warn "ignoring invalid skill name '$name'"
      continue
      ;;
  esac
  if [ -f "skills/$name/SKILL.md" ]; then
    FINAL[${#FINAL[@]}]="$name"
  else
    warn "skill 'skills/$name/SKILL.md' not found in checkout — skipping"
  fi
done <<<"$(printf '%s' "$CHOSEN" | LC_ALL=C sort -u)"

SKILL_COUNT=${#FINAL[@]}
ok "$SKILL_COUNT skills chosen"

# ---------------------------------------------------------------------------
# Step 4: symlink chosen skills into each detected IDE's dir
#
# Only hstack-owned entries are replaced (see the ownership block above); anything
# else at a destination is moved aside (dirs to <skills-parent>/.hstack-backups/<stamp>/,
# files to <file>.hstack-backup-<stamp>) and the exact path is printed.
# ---------------------------------------------------------------------------

heading "==> Wiring into IDEs"

# Set when a destination is refused or an entry could not be installed: exit status 1.
INSTALL_PROBLEMS=0

# Symlink (or marked copy) every chosen skill directory into $1; sets N_INSTALLED.
# Returns 1 without touching anything if $1 is, or lies inside, a hstack skills tree.
install_skill_dirs() {
  local target="$1" skill
  mkdir -p "$target"
  hs_target_ok "$target" || return 1
  N_INSTALLED=0
  for skill in ${FINAL[@]+"${FINAL[@]}"}; do
    if hs_install_dir "$INSTALL_DIR/skills/$skill" "$target/$skill"; then
      N_INSTALLED=$((N_INSTALLED + 1))
    else
      INSTALL_PROBLEMS=1
    fi
  done
}

install_to_claude() {
  install_skill_dirs "$CLAUDE_TARGET" || return 1
  ok "claude    → $CLAUDE_TARGET ($N_INSTALLED skills)"
}

install_to_codex() {
  install_skill_dirs "$CODEX_TARGET" || return 1
  ok "codex     → $CODEX_TARGET ($N_INSTALLED skills)"
}

install_to_cursor() {
  local skill n=0
  mkdir -p "$CURSOR_TARGET"
  hs_target_ok "$CURSOR_TARGET" || return 1
  for skill in ${FINAL[@]+"${FINAL[@]}"}; do
    if hs_install_mdc "$skill" "$INSTALL_DIR/skills/$skill/SKILL.md" "$CURSOR_TARGET/$skill.mdc"; then
      n=$((n + 1))
    else
      INSTALL_PROBLEMS=1
    fi
  done
  ok "cursor    → $CURSOR_TARGET ($n skills, converted to .mdc)"
}

install_to_hermes() {
  install_skill_dirs "$HERMES_TARGET" || return 1
  ok "hermes    → $HERMES_TARGET ($N_INSTALLED skills)"
}

install_to_gemini() {
  local skill n=0
  mkdir -p "$GEMINI_TARGET"
  hs_target_ok "$GEMINI_TARGET" || return 1
  for skill in ${FINAL[@]+"${FINAL[@]}"}; do
    if hs_install_file "$INSTALL_DIR/skills/$skill/SKILL.md" "$GEMINI_TARGET/$skill.md"; then
      n=$((n + 1))
    else
      INSTALL_PROBLEMS=1
    fi
  done
  ok "gemini    → $GEMINI_TARGET ($n skills)"
}

install_to_openclaw() {
  install_skill_dirs "$OPENCLAW_TARGET" || return 1
  ok "openclaw  → $OPENCLAW_TARGET ($N_INSTALLED skills)"
}

for ide in $ALL_IDES; do
  if ide_has "$ide"; then
    if ! "install_to_$ide"; then
      INSTALL_PROBLEMS=1
      warn "$ide: nothing installed (see above)"
    fi
  fi
done

if [ "$INSTALL_PROBLEMS" != "0" ]; then
  warn "Some destinations were skipped or refused (see warnings above); nothing was deleted."
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 5: summary + next steps
# ---------------------------------------------------------------------------

heading "==> Done"

log ""
ok "$SKILL_COUNT skills installed into $IDE_COUNT IDE(s):"
for ide in $ALL_IDES; do
  if ide_has "$ide"; then log "  - $ide"; fi
done
log ""
log "Next steps:"
log ""
log "  1. Deploy Hermes to your own server (~30 min):"
log "     Open any of your IDEs and run:  ${BOLD}/hermes-deploy${RESET}"
log ""
log "  2. After deploy, wire integrations one at a time:"
log "     ${BOLD}/integration-notion${RESET} · ${BOLD}/integration-stripe${RESET} · etc."
log ""
log "  3. Or wire many at once:"
log "     ${BOLD}/hermes-integrate${RESET}"
log ""
log "Repo:    $INSTALL_DIR"
log "Docs:    https://github.com/paarths-collab/hstack"
log ""
log "To re-run this installer with different choices:"
log "  bash $INSTALL_DIR/install.sh --pick"
log ""
