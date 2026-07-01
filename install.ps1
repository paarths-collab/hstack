# hstack universal installer (PowerShell).
#
# Usage — one-liner (installs to every detected IDE with all skills):
#   iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
#
# Usage — with interactive picker:
#   iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 -OutFile hstack-install.ps1
#   .\hstack-install.ps1 -Pick
#
# Usage — non-interactive with explicit choices:
#   iwr -useb ... | iex; hstack-install -Tier memory,database
#   .\install.ps1 -Include notion,stripe,mem0
#   .\install.ps1 -Ide claude,openclaw
#
# What it does:
#   1. Clones or updates hstack into ~\.hstack
#   2. Detects installed IDEs / agents
#   3. Optionally prompts you to pick integrations (or accepts flags)
#   4. Copies/symlinks the chosen skills into each detected IDE's skill directory
#   5. Reports what got wired where

[CmdletBinding()]
param(
    [switch]$Pick,
    [switch]$All,
    [switch]$Local,
    [string]$Include = "",
    [string]$Tier = "",
    [string]$Ide = "",
    [string]$Branch = "main",
    [switch]$Help
)

if ($Help) {
    Get-Content $PSCommandPath | Select-Object -First 30 | ForEach-Object { $_ }
    exit 0
}

$ErrorActionPreference = "Stop"

$RepoUrl     = if ($env:HSTACK_REPO_URL)     { $env:HSTACK_REPO_URL }     else { "https://github.com/paarths-collab/hstack.git" }
$InstallDir  = if ($env:HSTACK_INSTALL_DIR)  { $env:HSTACK_INSTALL_DIR }  else { "$HOME\.hstack" }
if ($env:HSTACK_BRANCH) { $Branch = $env:HSTACK_BRANCH }

# Tier → integration mapping
$Tiers = @{
    core         = @('hermes-backup','hermes-cron','hermes-deploy','hermes-fix','hermes-home','hermes-install','hermes-integrate','hermes-mcp-add','hermes-memory','hermes-model','hermes-restart','hermes-skills','hermes-soul','hermes-status','hermes-update')
    platforms    = @('platform-discord','platform-google-chat','platform-mattermost','platform-signal','platform-slack','platform-teams','platform-telegram','platform-whatsapp')
    memory       = @('integration-mem0','integration-supermemory')
    database     = @('integration-supabase','integration-postgres','integration-neon','integration-redis')
    vector       = @('integration-pinecone','integration-qdrant')
    auth         = @('integration-auth0','integration-clerk')
    observability= @('integration-posthog','integration-sentry')
    rag          = @('integration-firecrawl')
    code         = @('integration-e2b')
    'ai-tools'   = @('integration-openai-tools','integration-elevenlabs','integration-replicate')
    storage      = @('integration-r2')
    crm          = @('integration-hubspot','integration-salesforce','integration-pipedrive','integration-zoho-crm')
    docs         = @('integration-notion','integration-google-workspace','integration-microsoft-365')
    dev          = @('integration-github','integration-gitlab','integration-bitbucket')
    pm           = @('integration-jira','integration-linear','integration-asana','integration-clickup','integration-monday','integration-trello','integration-airtable')
    cloud        = @('integration-aws','integration-gcp','integration-azure','integration-digitalocean','integration-hetzner','integration-cloudflare','integration-vercel','integration-netlify','integration-railway','integration-render')
    payments     = @('integration-stripe','integration-paypal','integration-razorpay')
    commerce     = @('integration-shopify','integration-woocommerce','integration-webflow','integration-wordpress')
    email        = @('integration-mailchimp','integration-brevo','integration-sendgrid','integration-postmark')
    support      = @('integration-twilio','integration-sendbird','integration-intercom','integration-zendesk','integration-freshdesk')
    forms        = @('integration-typeform','integration-tally','integration-calendly','integration-zoom')
    search       = @('integration-brave-search','integration-tavily','integration-exa')
}

$IntegrationTiers = @('memory','database','vector','auth','observability','rag','code','ai-tools','storage','crm','docs','dev','pm','cloud','payments','commerce','email','support','forms','search')

function Write-Ok    { param($m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Info  { param($m) Write-Host $m -ForegroundColor DarkGray }
function Write-WarnX { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Write-Die   { param($m) Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Write-Head  { param($m) Write-Host ""; Write-Host $m -ForegroundColor White }

# ---------------------------------------------------------------------------
# Step 1: clone / update
# ---------------------------------------------------------------------------

if ($Local) {
    $InstallDir = Split-Path -Parent $PSCommandPath
    Write-Info "Running from local checkout: $InstallDir"
} else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Die "git is required. Install git and re-run."
    }
    Write-Head "==> Fetching hstack"
    if (Test-Path "$InstallDir\.git") {
        Write-Info "Updating existing checkout at $InstallDir"
        Push-Location $InstallDir
        try {
            git fetch origin --quiet
            git checkout --quiet $Branch
            git pull --ff-only --quiet
        } catch {
            Write-WarnX "Could not fast-forward. Continuing with existing checkout."
        }
        Pop-Location
    } elseif ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Measure-Object).Count -gt 0) {
        Write-Die "$InstallDir exists and is not a git checkout of hstack. Move it aside and re-run."
    } else {
        Write-Info "Cloning $RepoUrl → $InstallDir (branch $Branch)"
        git clone --depth 1 --branch $Branch --quiet $RepoUrl $InstallDir
    }
    Write-Ok "hstack checkout ready"
}

Set-Location $InstallDir
if (-not (Test-Path "$InstallDir\skills")) { Write-Die "$InstallDir\skills not found — checkout is broken." }

# ---------------------------------------------------------------------------
# Step 2: detect IDEs
# ---------------------------------------------------------------------------

Write-Head "==> Detecting IDEs / agents"

$Ides = @{}
if (Test-Path "$HOME\.claude")    { $Ides['claude']   = $true }
if (Test-Path "$HOME\.agents")    { $Ides['codex']    = $true }
if (Test-Path "$HOME\.cursor")    { $Ides['cursor']   = $true }
if (Test-Path "$HOME\.hermes")    { $Ides['hermes']   = $true }
if (Test-Path "$HOME\.gemini")    { $Ides['gemini']   = $true }
if (Test-Path "$HOME\.openclaw")  { $Ides['openclaw'] = $true }

if ($Ide) {
    $requested = @{}
    foreach ($p in $Ide -split ',') {
        $p = $p.Trim()
        if ($p -eq 'all') {
            foreach ($k in @('claude','codex','cursor','hermes','gemini','openclaw')) { $requested[$k] = $true }
            break
        }
        $requested[$p] = $true
    }
    $Ides = $requested
}

if ($Ides.Count -eq 0) {
    Write-WarnX "No IDEs / agents detected."
    Write-Info "Nothing to configure. Install one of:"
    Write-Info "  Claude Code:  https://docs.claude.com/en/docs/claude-code"
    Write-Info "  Cursor:       https://cursor.com"
    Write-Info "  Codex:        https://github.com/openai/codex"
    Write-Info "  Hermes:       https://github.com/NousResearch/hermes-agent"
    Write-Info "  Gemini CLI:   https://github.com/google/gemini-cli"
    Write-Info "  OpenClaw:     https://docs.openclaw.ai"
    exit 0
}

foreach ($k in @('claude','codex','cursor','hermes','gemini','openclaw')) {
    if ($Ides.ContainsKey($k)) { Write-Ok "detected: $k" }
}

# ---------------------------------------------------------------------------
# Step 3: decide which skills to install
# ---------------------------------------------------------------------------

Write-Head "==> Choosing skills"

$Chosen = @{}
foreach ($s in $Tiers['core'])      { $Chosen[$s] = $true }
foreach ($s in $Tiers['platforms']) { $Chosen[$s] = $true }

function Add-Tier {
    param($tier)
    if ($Tiers.ContainsKey($tier)) {
        foreach ($s in $Tiers[$tier]) { $script:Chosen[$s] = $true }
    }
}

if ($All) {
    Write-Info "Installing ALL integrations (-All)"
    foreach ($t in $IntegrationTiers) { Add-Tier $t }
} elseif ($Include) {
    Write-Info "Installing only: $Include"
    foreach ($p in $Include -split ',') {
        $p = $p.Trim()
        if (-not $p) { continue }
        if ($Tiers.ContainsKey($p)) { Add-Tier $p; continue }
        if (Test-Path "skills\integration-$p") { $Chosen["integration-$p"] = $true; continue }
        if (Test-Path "skills\$p") { $Chosen[$p] = $true; continue }
        Write-WarnX "unknown: '$p' — skipping"
    }
} elseif ($Tier) {
    Write-Info "Installing tiers: $Tier"
    foreach ($t in $Tier -split ',') {
        $t = $t.Trim()
        if ($Tiers.ContainsKey($t)) { Add-Tier $t } else { Write-WarnX "unknown tier: '$t'" }
    }
} elseif ($Pick -or ([Environment]::UserInteractive -and $Host.UI.RawUI)) {
    Write-Host @"

hstack currently has 68 integrations across 20 tiers.
Core skills (/hermes-deploy, all platforms) are ALWAYS installed.

Available integration tiers:
  all              - everything (68 integrations)
  memory           - mem0, supermemory
  database         - supabase, postgres, neon, redis
  vector           - pinecone, qdrant
  auth             - auth0, clerk
  observability    - posthog, sentry
  rag              - firecrawl
  code             - e2b
  ai-tools         - openai-tools, elevenlabs, replicate
  storage          - r2
  crm              - hubspot, salesforce, pipedrive, zoho-crm
  docs             - notion, google-workspace, microsoft-365
  dev              - github, gitlab, bitbucket
  pm               - jira, linear, asana, clickup, monday, trello, airtable
  cloud            - aws, gcp, azure, digitalocean, hetzner, cloudflare, vercel, netlify, railway, render
  payments         - stripe, paypal, razorpay
  commerce         - shopify, woocommerce, webflow, wordpress
  email            - mailchimp, brevo, sendgrid, postmark
  support          - twilio, sendbird, intercom, zendesk, freshdesk
  forms            - typeform, tally, calendly, zoom
  search           - brave-search, tavily, exa

Enter tier names comma-separated (e.g. 'memory,database,ai-tools'),
or specific integrations ('notion,stripe'),
or 'all' for everything, or press Enter to skip integrations.
"@
    $picks = Read-Host "> "
    if (-not $picks.Trim()) {
        Write-Info "No integrations selected. Installing core + platforms only."
    } else {
        foreach ($p in $picks -split ',') {
            $p = $p.Trim()
            if (-not $p) { continue }
            if ($p -eq 'all') { foreach ($t in $IntegrationTiers) { Add-Tier $t }; continue }
            if ($Tiers.ContainsKey($p)) { Add-Tier $p; continue }
            if (Test-Path "skills\integration-$p") { $Chosen["integration-$p"] = $true; continue }
            if (Test-Path "skills\$p") { $Chosen[$p] = $true; continue }
            Write-WarnX "unknown: '$p' — skipping"
        }
    }
} else {
    Write-Info "Non-interactive install (no flags) — including all integrations."
    foreach ($t in $IntegrationTiers) { Add-Tier $t }
}

# Filter chosen to what actually exists
$Final = @{}
foreach ($name in $Chosen.Keys) {
    if (Test-Path "skills\$name\SKILL.md") { $Final[$name] = $true }
    else { Write-WarnX "skill '$name' not found in checkout — skipping" }
}

$skillCount = $Final.Count
Write-Ok "$skillCount skills chosen"

# ---------------------------------------------------------------------------
# Step 4: install to each IDE
# ---------------------------------------------------------------------------

Write-Head "==> Wiring into IDEs"

function Copy-SkillTree {
    param($src, $dst)
    if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
    Copy-Item -Recurse -Path $src -Destination $dst
}

function Install-To-Claude {
    $target = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { "$HOME\.claude\skills" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        Copy-SkillTree "$InstallDir\skills\$skill" "$target\$skill"
        $n++
    }
    Write-Ok "claude    → $target ($n skills)"
}

function Install-To-Codex {
    $target = if ($env:CODEX_SKILLS_DIR) { $env:CODEX_SKILLS_DIR } else { "$HOME\.agents\skills" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        Copy-SkillTree "$InstallDir\skills\$skill" "$target\$skill"
        $n++
    }
    Write-Ok "codex     → $target ($n skills)"
}

function Install-To-Cursor {
    $target = if ($env:CURSOR_RULES_DIR) { $env:CURSOR_RULES_DIR } else { "$HOME\.cursor\rules" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        $src = "$InstallDir\skills\$skill\SKILL.md"
        $dst = "$target\$skill.mdc"
        $desc = ((Get-Content $src) -match '^description:' | Select-Object -First 1) -replace '^description:\s*',''
        $body = (Get-Content $src) | Where-Object { $_ -notmatch '^---$' } | Select-Object -Skip 1
        @"
---
description: $desc
globs:
alwaysApply: false
---
"@ | Set-Content -Encoding UTF8 -Path $dst
        Add-Content -Path $dst -Value ""
        Get-Content $src | Where-Object { $_ -notmatch '^(name|description):' -and $_ -ne '---' } | Add-Content -Path $dst
        $n++
    }
    Write-Ok "cursor    → $target ($n skills, converted to .mdc)"
}

function Install-To-Hermes {
    $target = if ($env:HERMES_SKILLS_DIR) { $env:HERMES_SKILLS_DIR } else { "$HOME\.hermes\skills" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        Copy-SkillTree "$InstallDir\skills\$skill" "$target\$skill"
        $n++
    }
    Write-Ok "hermes    → $target ($n skills)"
}

function Install-To-Gemini {
    $target = if ($env:GEMINI_CONTEXT_DIR) { $env:GEMINI_CONTEXT_DIR } else { "$HOME\.gemini\context\hstack" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        Copy-Item -Path "$InstallDir\skills\$skill\SKILL.md" -Destination "$target\$skill.md" -Force
        $n++
    }
    Write-Ok "gemini    → $target ($n skills)"
}

function Install-To-Openclaw {
    $target = if ($env:OPENCLAW_SKILLS_DIR) { $env:OPENCLAW_SKILLS_DIR } else { "$HOME\.openclaw\skills" }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        Copy-SkillTree "$InstallDir\skills\$skill" "$target\$skill"
        $n++
    }
    Write-Ok "openclaw  → $target ($n skills)"
}

foreach ($ide in @('claude','codex','cursor','hermes','gemini','openclaw')) {
    if ($Ides.ContainsKey($ide)) {
        & "Install-To-$($ide.Substring(0,1).ToUpper() + $ide.Substring(1))"
    }
}

# ---------------------------------------------------------------------------
# Step 5: summary
# ---------------------------------------------------------------------------

Write-Head "==> Done"
Write-Host ""
Write-Ok "$skillCount skills installed into $($Ides.Count) IDE(s):"
foreach ($k in $Ides.Keys) { Write-Host "  - $k" }
Write-Host ""
Write-Host "Next steps:"
Write-Host ""
Write-Host "  1. Deploy Hermes to a VPS (~30 min):"
Write-Host "     Open any of your IDEs and run:  /hermes-deploy"
Write-Host ""
Write-Host "  2. After deploy, wire integrations one at a time:"
Write-Host "     /integration-notion · /integration-stripe · etc."
Write-Host ""
Write-Host "  3. Or wire many at once:"
Write-Host "     /hermes-integrate"
Write-Host ""
Write-Host "Repo:    $InstallDir"
Write-Host "Docs:    https://github.com/paarths-collab/hstack"
Write-Host ""
Write-Host "To re-run this installer with different choices:"
Write-Host "  powershell -File $InstallDir\install.ps1 -Pick"
