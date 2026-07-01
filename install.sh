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
#   - No sudo, no network calls after the git clone

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_URL="${HSTACK_REPO_URL:-https://github.com/paarths-collab/hstack.git}"
INSTALL_DIR="${HSTACK_INSTALL_DIR:-$HOME/.hstack}"
BRANCH="${HSTACK_BRANCH:-main}"

# CLI flags (parsed below)
PICK_MODE=0
INCLUDE=""
TIER=""
IDE_FILTER=""
INSTALL_ALL=0
LOCAL_RUN=0

# Tier → integration mapping (edit as new tiers land)
declare -A TIERS
TIERS[core]="hermes-backup hermes-cron hermes-deploy hermes-fix hermes-home hermes-install hermes-integrate hermes-mcp-add hermes-memory hermes-model hermes-restart hermes-skills hermes-soul hermes-status hermes-update"
TIERS[platforms]="platform-discord platform-google-chat platform-mattermost platform-signal platform-slack platform-teams platform-telegram platform-whatsapp"
TIERS[memory]="integration-mem0 integration-supermemory"
TIERS[database]="integration-supabase integration-postgres integration-neon integration-redis"
TIERS[vector]="integration-pinecone integration-qdrant"
TIERS[auth]="integration-auth0 integration-clerk"
TIERS[observability]="integration-posthog integration-sentry"
TIERS[rag]="integration-firecrawl"
TIERS[code]="integration-e2b"
TIERS[ai-tools]="integration-openai-tools integration-elevenlabs integration-replicate"
TIERS[storage]="integration-r2"
TIERS[crm]="integration-hubspot integration-salesforce integration-pipedrive integration-zoho-crm"
TIERS[docs]="integration-notion integration-google-workspace integration-microsoft-365"
TIERS[dev]="integration-github integration-gitlab integration-bitbucket"
TIERS[pm]="integration-jira integration-linear integration-asana integration-clickup integration-monday integration-trello integration-airtable"
TIERS[cloud]="integration-aws integration-gcp integration-azure integration-digitalocean integration-hetzner integration-cloudflare integration-vercel integration-netlify integration-railway integration-render"
TIERS[payments]="integration-stripe integration-paypal integration-razorpay"
TIERS[commerce]="integration-shopify integration-woocommerce integration-webflow integration-wordpress"
TIERS[email]="integration-mailchimp integration-brevo integration-sendgrid integration-postmark"
TIERS[support]="integration-twilio integration-sendbird integration-intercom integration-zendesk integration-freshdesk"
TIERS[forms]="integration-typeform integration-tally integration-calendly integration-zoom"
TIERS[search]="integration-brave-search integration-tavily integration-exa"

# ---------------------------------------------------------------------------
# Parse CLI flags
# ---------------------------------------------------------------------------

for arg in "$@"; do
  case "$arg" in
    --pick)          PICK_MODE=1 ;;
    --all)           INSTALL_ALL=1 ;;
    --local)         LOCAL_RUN=1 ;;
    --include=*)     INCLUDE="${arg#--include=}" ;;
    --tier=*)        TIER="${arg#--tier=}" ;;
    --ide=*)         IDE_FILTER="${arg#--ide=}" ;;
    --branch=*)      BRANCH="${arg#--branch=}" ;;
    -h|--help)
      sed -n '2,45p' "$0" 2>/dev/null || true
      exit 0 ;;
    *)
      echo "WARN: unknown flag '$arg' — ignoring" >&2 ;;
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

# ---------------------------------------------------------------------------
# Step 1: clone / update repo
# ---------------------------------------------------------------------------

if [ "$LOCAL_RUN" = "1" ]; then
  INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  info "Running from local checkout: $INSTALL_DIR"
else
  command -v git >/dev/null 2>&1 || die "git is required. Install git and re-run."
  heading "==> Fetching hstack"
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing checkout at $INSTALL_DIR"
    (cd "$INSTALL_DIR" && git fetch origin --quiet && git checkout --quiet "$BRANCH" && git pull --ff-only --quiet) \
      || warn "Could not fast-forward. Continuing with existing checkout."
  elif [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null | wc -l)" -gt 0 ]; then
    die "$INSTALL_DIR exists and is not a git checkout of hstack. Move it aside and re-run."
  else
    info "Cloning $REPO_URL → $INSTALL_DIR (branch $BRANCH)"
    git clone --depth 1 --branch "$BRANCH" --quiet "$REPO_URL" "$INSTALL_DIR"
  fi
  ok "hstack checkout ready"
fi

cd "$INSTALL_DIR"

[ -d skills ] || die "$INSTALL_DIR/skills not found — checkout is broken."

# ---------------------------------------------------------------------------
# Step 2: detect installed IDEs
# ---------------------------------------------------------------------------

heading "==> Detecting IDEs / agents"

declare -A IDES
[ -d "$HOME/.claude" ]    && IDES[claude]=1
[ -d "$HOME/.agents" ]    && IDES[codex]=1
[ -d "$HOME/.cursor" ]    && IDES[cursor]=1
[ -d "$HOME/.hermes" ]    && IDES[hermes]=1
[ -d "$HOME/.gemini" ]    && IDES[gemini]=1
[ -d "$HOME/.openclaw" ]  && IDES[openclaw]=1

# Filter to user-specified subset if --ide= was passed
if [ -n "$IDE_FILTER" ]; then
  declare -A REQUESTED
  IFS=',' read -ra parts <<< "$IDE_FILTER"
  for p in "${parts[@]}"; do
    p="$(echo "$p" | tr -d ' ')"
    [ "$p" = "all" ] && { REQUESTED=(); for k in claude codex cursor hermes gemini openclaw; do REQUESTED[$k]=1; done; break; }
    REQUESTED[$p]=1
  done
  declare -A KEEP
  for ide in "${!IDES[@]}"; do
    [ -n "${REQUESTED[$ide]:-}" ] && KEEP[$ide]=1
  done
  # If user asked for IDEs not detected, still honor — the setup script will create the dir
  for req in "${!REQUESTED[@]}"; do
    KEEP[$req]=1
  done
  IDES=()
  for k in "${!KEEP[@]}"; do IDES[$k]=1; done
fi

if [ "${#IDES[@]}" -eq 0 ]; then
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

for ide in claude codex cursor hermes gemini openclaw; do
  if [ -n "${IDES[$ide]:-}" ]; then
    ok "detected: $ide"
  fi
done

# ---------------------------------------------------------------------------
# Step 3: decide which skills to install
# ---------------------------------------------------------------------------

heading "==> Choosing skills"

# Always install core + platforms (deploy is useless without these)
declare -A CHOSEN
for s in ${TIERS[core]}; do CHOSEN[$s]=1; done
for s in ${TIERS[platforms]}; do CHOSEN[$s]=1; done

# All available integration tiers, in display order
INTEGRATION_TIERS=(memory database vector auth observability rag code ai-tools storage crm docs dev pm cloud payments commerce email support forms search)

pick_from_tier() {
  local tier="$1"
  local skills="${TIERS[$tier]:-}"
  [ -n "$skills" ] || return
  for s in $skills; do CHOSEN[$s]=1; done
}

if [ "$INSTALL_ALL" = "1" ]; then
  info "Installing ALL integrations (--all)"
  for t in "${INTEGRATION_TIERS[@]}"; do pick_from_tier "$t"; done
elif [ -n "$INCLUDE" ]; then
  info "Installing only: $INCLUDE"
  IFS=',' read -ra parts <<< "$INCLUDE"
  for p in "${parts[@]}"; do
    p="$(echo "$p" | tr -d ' ')"
    [ -z "$p" ] && continue
    # Try tier first
    if [ -n "${TIERS[$p]:-}" ]; then
      pick_from_tier "$p"
      continue
    fi
    # Try integration-<name>
    if [ -d "skills/integration-$p" ]; then
      CHOSEN["integration-$p"]=1
      continue
    fi
    # Try bare name (must match skills/<name>/)
    if [ -d "skills/$p" ]; then
      CHOSEN[$p]=1
      continue
    fi
    warn "unknown skill or tier: '$p' — skipping"
  done
elif [ -n "$TIER" ]; then
  info "Installing tiers: $TIER"
  IFS=',' read -ra parts <<< "$TIER"
  for t in "${parts[@]}"; do
    t="$(echo "$t" | tr -d ' ')"
    [ -z "$t" ] && continue
    if [ -n "${TIERS[$t]:-}" ]; then
      pick_from_tier "$t"
    else
      warn "unknown tier: '$t' — skipping (available: ${INTEGRATION_TIERS[*]})"
    fi
  done
elif [ "$PICK_MODE" = "1" ] || [ -t 0 ]; then
  # Interactive picker — only if TTY is present
  cat <<EOF

hstack currently has 68 integrations across 20 tiers.
Core skills (/hermes-deploy, all platforms) are ALWAYS installed.

Available integration tiers:

  1) all              - everything (68 integrations)
  2) memory           - mem0, supermemory
  3) database         - supabase, postgres, neon, redis
  4) vector           - pinecone, qdrant
  5) auth             - auth0, clerk
  6) observability    - posthog, sentry
  7) rag              - firecrawl (web scraping for RAG)
  8) code             - e2b (safe code execution)
  9) ai-tools         - openai-tools (DALL-E, Whisper, embeddings), elevenlabs (voice), replicate
 10) storage          - r2 (zero-egress S3-compat)
 11) crm              - hubspot, salesforce, pipedrive, zoho-crm
 12) docs             - notion, google-workspace, microsoft-365
 13) dev              - github, gitlab, bitbucket
 14) pm               - jira, linear, asana, clickup, monday, trello, airtable
 15) cloud            - aws, gcp, azure, digitalocean, hetzner, cloudflare, vercel, netlify, railway, render
 16) payments         - stripe, paypal, razorpay
 17) commerce         - shopify, woocommerce, webflow, wordpress
 18) email            - mailchimp, brevo, sendgrid, postmark
 19) support          - twilio, sendbird, intercom, zendesk, freshdesk
 20) forms            - typeform, tally, calendly, zoom
 21) search           - brave-search, tavily, exa

Enter tier names comma-separated (e.g. 'memory,database,ai-tools'),
or a specific integration ('notion,stripe'),
or 'all' for everything, or press Enter to skip integrations.

EOF
  # Read from /dev/tty so this works even when piped from curl
  read -rp "> " -er PICKS < /dev/tty || PICKS=""
  if [ -z "${PICKS// /}" ]; then
    info "No integrations selected. Installing core + platforms only."
  else
    IFS=',' read -ra parts <<< "$PICKS"
    for p in "${parts[@]}"; do
      p="$(echo "$p" | tr -d ' ')"
      [ -z "$p" ] && continue
      if [ "$p" = "all" ]; then
        for t in "${INTEGRATION_TIERS[@]}"; do pick_from_tier "$t"; done
        continue
      fi
      if [ -n "${TIERS[$p]:-}" ]; then
        pick_from_tier "$p"
        continue
      fi
      if [ -d "skills/integration-$p" ]; then
        CHOSEN["integration-$p"]=1
        continue
      fi
      if [ -d "skills/$p" ]; then
        CHOSEN[$p]=1
        continue
      fi
      warn "unknown: '$p' — skipping"
    done
  fi
else
  # Non-interactive, no flags — default to ALL (safe for curl-pipe use)
  info "Non-interactive install (no flags) — including all integrations."
  info "Run with --pick or --tier=... / --include=... for a smaller install."
  for t in "${INTEGRATION_TIERS[@]}"; do pick_from_tier "$t"; done
fi

# Filter chosen down to skills that actually exist on disk
declare -A FINAL
for name in "${!CHOSEN[@]}"; do
  if [ -f "skills/$name/SKILL.md" ]; then
    FINAL[$name]=1
  else
    warn "skill 'skills/$name/SKILL.md' not found in checkout — skipping"
  fi
done

SKILL_COUNT=${#FINAL[@]}
ok "$SKILL_COUNT skills chosen"

# ---------------------------------------------------------------------------
# Step 4: symlink chosen skills into each detected IDE's dir
# ---------------------------------------------------------------------------

heading "==> Wiring into IDEs"

link_or_copy() {
  local src="$1" dst="$2"
  [ -L "$dst" ] || [ -e "$dst" ] && rm -rf "$dst"
  ln -s "$src" "$dst" 2>/dev/null || cp -r "$src" "$dst"
}

install_to_claude() {
  local target="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    link_or_copy "$INSTALL_DIR/skills/$skill" "$target/$skill"
    n=$((n+1))
  done
  ok "claude    → $target ($n skills)"
}

install_to_codex() {
  local target="${CODEX_SKILLS_DIR:-$HOME/.agents/skills}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    link_or_copy "$INSTALL_DIR/skills/$skill" "$target/$skill"
    n=$((n+1))
  done
  ok "codex     → $target ($n skills)"
}

install_to_cursor() {
  local target="${CURSOR_RULES_DIR:-$HOME/.cursor/rules}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    local src="$INSTALL_DIR/skills/$skill/SKILL.md"
    local dst="$target/$skill.mdc"
    local desc
    desc=$(awk '/^description:/{sub(/^description: */,""); print; exit}' "$src")
    {
      echo "---"
      echo "description: ${desc:-hstack skill: $skill}"
      echo "globs:"
      echo "alwaysApply: false"
      echo "---"
      echo
      awk 'BEGIN{n=0} /^---$/{n++; next} n>=2{print}' "$src"
    } > "$dst"
    n=$((n+1))
  done
  ok "cursor    → $target ($n skills, converted to .mdc)"
}

install_to_hermes() {
  local target="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    link_or_copy "$INSTALL_DIR/skills/$skill" "$target/$skill"
    n=$((n+1))
  done
  ok "hermes    → $target ($n skills)"
}

install_to_gemini() {
  local target="${GEMINI_CONTEXT_DIR:-$HOME/.gemini/context/hstack}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    local src="$INSTALL_DIR/skills/$skill/SKILL.md"
    local dst="$target/$skill.md"
    [ -L "$dst" ] || [ -e "$dst" ] && rm -f "$dst"
    ln -s "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
    n=$((n+1))
  done
  ok "gemini    → $target ($n skills)"
}

install_to_openclaw() {
  local target="${OPENCLAW_SKILLS_DIR:-$HOME/.openclaw/skills}"
  mkdir -p "$target"
  local n=0
  for skill in "${!FINAL[@]}"; do
    link_or_copy "$INSTALL_DIR/skills/$skill" "$target/$skill"
    n=$((n+1))
  done
  ok "openclaw  → $target ($n skills)"
}

for ide in claude codex cursor hermes gemini openclaw; do
  if [ -n "${IDES[$ide]:-}" ]; then
    install_to_$ide
  fi
done

# ---------------------------------------------------------------------------
# Step 5: summary + next steps
# ---------------------------------------------------------------------------

heading "==> Done"

log ""
ok "$SKILL_COUNT skills installed into ${#IDES[@]} IDE(s):"
for ide in "${!IDES[@]}"; do
  log "  - $ide"
done
log ""
log "Next steps:"
log ""
log "  1. Deploy Hermes to a VPS (~30 min):"
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
