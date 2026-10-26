# hstack universal installer (PowerShell).
#
# Usage - one-liner (installs to every detected IDE with all skills):
#   iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 | iex
#   (iex cannot pass parameters: use one of the forms below to choose tiers)
#
# Usage - with explicit choices (download first, then run the file):
#   iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1 -OutFile hstack-install.ps1
#   .\hstack-install.ps1 -Pick
#   .\hstack-install.ps1 -Tier memory,database
#   .\hstack-install.ps1 -Include notion,stripe,mem0
#   .\hstack-install.ps1 -Ide claude,openclaw
#
# Usage - without saving a file (a script block accepts parameters):
#   & ([scriptblock]::Create((iwr -useb https://raw.githubusercontent.com/paarths-collab/hstack/main/install.ps1).Content)) -Tier memory,database
#
# -Tier / -Include / -Ide take a comma list (or a single "a,b" string). Precedence when several
# selection switches are given: -All, then -Include, then -Tier.
#
# What it does:
#   1. Clones or updates hstack into ~\.hstack
#   2. Detects installed IDEs / agents
#   3. Optionally prompts you to pick integrations (or accepts flags)
#   4. Copies the chosen skills into each detected IDE's skill directory
#   5. Reports what got wired where
#
# This file is pure ASCII on purpose: Windows PowerShell 5.1 reads a BOM-less file as the
# ANSI code page and mis-parses UTF-8 punctuation (an em dash becomes a quote character).

[CmdletBinding()]
param(
    [switch]$Pick,
    [switch]$All,
    [switch]$Local,
    [string[]]$Include = @(),
    [string[]]$Tier = @(),
    [string[]]$Ide = @(),
    [string]$Branch = "main",
    [switch]$Help
)

if ($Help) {
    # print the leading comment block (the usage text above)
    foreach ($helpLine in (Get-Content $PSCommandPath)) {
        if ($helpLine -notmatch '^#') { break }
        $helpLine
    }
    exit 0
}

$ErrorActionPreference = "Stop"

$RepoUrl     = if ($env:HSTACK_REPO_URL)     { $env:HSTACK_REPO_URL }     else { "https://github.com/paarths-collab/hstack.git" }
$InstallDir  = if ($env:HSTACK_INSTALL_DIR)  { $env:HSTACK_INSTALL_DIR }  else { (Join-Path $HOME ".hstack") }
if ($env:HSTACK_BRANCH) { $Branch = $env:HSTACK_BRANCH }

# "-Tier a,b" binds as an array, "-Tier 'a,b'" as one string: accept both (and stray spaces).
function ConvertTo-HstackList {
    param($Value)
    return @($Value | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}
$IncludeList = ConvertTo-HstackList $Include
$TierList = ConvertTo-HstackList $Tier
$IdeList = ConvertTo-HstackList $Ide

# Tier -> integration mapping
$Tiers = @{
    core         = @('blueprint-install','blueprint-saas-founder','setup-ssh-keys','hermes-backup','hermes-cron','hermes-deploy','hermes-fix','hermes-home','hermes-install','hermes-integrate','hermes-mcp-add','hermes-memory','hermes-model','hermes-restart','hermes-skills','hermes-soul','hermes-status','hermes-update')
    platforms    = @('platform-discord','platform-google-chat','platform-mattermost','platform-signal','platform-slack','platform-teams','platform-telegram','platform-whatsapp')
    memory       = @('integration-mem0','integration-supermemory')
    database     = @('integration-supabase','integration-postgres','integration-neon','integration-redis')
    vector       = @('integration-pinecone','integration-qdrant')
    auth         = @('integration-auth0','integration-clerk')
    observability= @('integration-posthog','integration-sentry','integration-datadog','integration-segment')
    rag          = @('integration-firecrawl')
    code         = @('integration-e2b')
    'ai-tools'   = @('integration-openai-tools','integration-elevenlabs','integration-replicate')
    storage      = @('integration-r2')
    crm          = @('integration-hubspot','integration-salesforce','integration-pipedrive','integration-zoho-crm')
    docs         = @('integration-notion','integration-google-workspace','integration-microsoft-365','integration-obsidian')
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

function Write-Ok    { param($m) Write-Host "OK $m" -ForegroundColor Green }
function Write-Info  { param($m) Write-Host $m -ForegroundColor DarkGray }
function Write-WarnX { param($m) Write-Host "! $m" -ForegroundColor Yellow }
function Write-Die   { param($m) Write-Host "x $m" -ForegroundColor Red; exit 1 }
function Write-Head  { param($m) Write-Host ""; Write-Host $m -ForegroundColor White }

# >>> hstack-ownership (this block is identical in install.ps1 and setup.ps1, and mirrors the
# >>> bash block in install.sh / setup*; it is duplicated because install.ps1 may be run via iex)
#
# Rule: hstack replaces only what hstack itself installed. Anything else found at a
# destination (a user's own skill dir, rule file or foreign link) is moved aside to
# "<dst>.hstack-backup-<yyyyMMddHHmmss>" (-N on collision) and never deleted.
#   owned link : target resolves inside a hstack skills tree ($script:HstackRoots) or any
#                hstack checkout (symlinks and junctions both count); a dangling link whose
#                target path ends in /skills/<same name> counts too
#   owned dir  : identical to the source being installed (the .hstack-managed marker is
#                ignored), or an unedited copy hstack made earlier (the marker records a
#                digest of what was installed). A user-edited marked copy is NOT owned.
#   owned file : its single "<!-- hstack-managed sig=sha256:... -->" line matches a digest of
#                the rest of the file (unedited), or the rest equals what hstack would write
#                now. A user-edited marked file is NOT owned, and a look-alike marker line the
#                user typed is just content. Unmarked files only count when identical to
#                an older installer's output.
# Skill-directory backups go to a sibling dir outside the scan path:
#   <skills-parent>\.hstack-backups\<stamp>[-N]\<name>
# File backups stay adjacent: <file>.hstack-backup-<stamp>[-N]. The warning prints the path.
# Safety: a destination that resolves into the hstack source tree (or whose parent does) is
# never cleared or written: the install is refused for it with a warning.
# If moving an entry aside fails (backup dir unwritable, path occupied, ...) the entry is
# left exactly as it was, NOTHING is written over it, and the run exits non-zero
# ($script:HstackFailures).
# The caller sets $script:HstackRoots (absolute skills dirs) and $script:HstackSourceTree
# (absolute checkout root) before installing.

$HstackMarker = '.hstack-managed'
$HstackStamp = if ($env:HS_STAMP) { $env:HS_STAMP } else { Get-Date -Format 'yyyyMMddHHmmss' }
$script:HstackRoots = @()
$script:HstackSourceTree = ''

function Get-HstackItem {
    param([string]$Path)
    return (Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue)
}

# Absolute path relative to the current location (call BEFORE any Set-Location).
function Resolve-HstackAbs {
    param([string]$Path)
    if (-not $Path) { return $Path }
    if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path (Get-Location).ProviderPath $Path }
    return [IO.Path]::GetFullPath($Path)
}

function Test-HstackExists {
    param([string]$Path)
    if ($null -ne (Get-HstackItem $Path)) { return $true }
    return ([IO.File]::Exists($Path) -or [IO.Directory]::Exists($Path))
}

function Test-HstackLink {
    param([string]$Path)
    $item = Get-HstackItem $Path
    if ($null -eq $item) { return $false }
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

# One hop of a link: absolute target path, or $null.
function Get-HstackLinkTarget {
    param([string]$Path)
    $item = Get-HstackItem $Path
    if ($null -eq $item) { return $null }
    $t = $item.Target
    if ($t -is [array]) { $t = $t[0] }
    if (-not $t) { return $null }
    $t = [string]$t
    if ($t.StartsWith('\??\')) { $t = $t.Substring(4) }
    if (-not [IO.Path]::IsPathRooted($t)) {
        # Split-Path -Parent /var is empty on Unix; .NET preserves the filesystem root.
        $parent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))
        $t = Join-Path $parent $t
    }
    return [IO.Path]::GetFullPath($t)
}

# Follow a link chain to its final path (bounded).
function Resolve-HstackLink {
    param([string]$Path)
    $p = $Path
    $n = 0
    while ((Test-HstackLink $p) -and $n -lt 20) {
        $t = Get-HstackLinkTarget $p
        if (-not $t) { break }
        $p = $t
        $n++
    }
    return [IO.Path]::GetFullPath($p)
}

function Split-HstackPath {
    param([string]$Path)
    $seps = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    return @($Path.Split($seps) | Where-Object { $_ })
}

# Physical path: every symlinked/junctioned component (not just the last) is resolved.
function Resolve-HstackPhysical {
    param([string]$Path)
    $full = [IO.Path]::GetFullPath($Path)
    $cur = [IO.Path]::GetPathRoot($full)
    $queue = New-Object System.Collections.Generic.List[string]
    foreach ($c in (Split-HstackPath $full.Substring($cur.Length))) { $queue.Add($c) }
    $i = 0
    $hops = 0
    while ($i -lt $queue.Count) {
        $cand = Join-Path $cur $queue[$i]
        $t = $null
        if ($hops -lt 40 -and (Test-HstackLink $cand)) { $t = Get-HstackLinkTarget $cand }
        if ($t) {
            $hops++
            $troot = [IO.Path]::GetPathRoot($t)
            $next = New-Object System.Collections.Generic.List[string]
            foreach ($c in (Split-HstackPath $t.Substring($troot.Length))) { $next.Add($c) }
            for ($j = $i + 1; $j -lt $queue.Count; $j++) { $next.Add($queue[$j]) }
            $queue = $next
            $cur = $troot
            $i = 0
        } else {
            $cur = $cand
            $i++
        }
    }
    return $cur
}

function Test-HstackSameOrUnder {
    param([string]$Path, [string]$Root)
    $cmp = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $r = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($p.Equals($r, $cmp)) { return $true }
    return $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, $cmp)
}

# True when $Dst is, or sits inside, the hstack source tree once symlinks/junctions in its
# parent chain are resolved. Such a destination must never be cleared or written.
function Test-HstackDstInSource {
    param([string]$Dst)
    $parentPhys = Resolve-HstackPhysical (Split-Path -Parent $Dst)
    $dstPhys = Join-Path $parentPhys (Split-Path -Leaf $Dst)
    foreach ($r in (@($script:HstackSourceTree) + @($script:HstackRoots))) {
        if (-not $r) { continue }
        if (Test-HstackSameOrUnder $dstPhys (Resolve-HstackPhysical $r)) { return $true }
    }
    return $false
}

# Warn once and return $false when the whole target dir resolves into the source tree.
function Test-HstackTargetOk {
    param([string]$Target)
    if (Test-HstackDstInSource (Join-Path $Target '_')) {
        Write-Warning "Refusing to install into ${Target}: it resolves into the hstack source tree. Nothing was changed there."
        Add-HstackFailure
        return $false
    }
    return $true
}

function Test-HstackUnder {
    param([string]$Path, [string]$Root)
    $cmp = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $r = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $p = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    return $p.StartsWith($r + [IO.Path]::DirectorySeparatorChar, $cmp)
}

function Test-HstackOurLink {
    param([string]$Path)
    $t = Resolve-HstackLink $Path
    foreach ($root in $script:HstackRoots) {
        if ($root -and (Test-HstackUnder $t $root)) { return $true }
    }
    if (-not ([IO.File]::Exists($t) -or [IO.Directory]::Exists($t))) {
        # dangling: it was ours if it ends in /skills/<this name> (or /skills/<name>/SKILL.md for a .md link)
        $cmp = if ([IO.Path]::DirectorySeparatorChar -eq '\') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
        $norm = $t.Replace('\', '/')
        $leaf = Split-Path -Leaf $Path
        if ($norm.EndsWith('/skills/' + $leaf, $cmp)) { return $true }
        if ($leaf.EndsWith('.md') -and $norm.EndsWith('/skills/' + $leaf.Substring(0, $leaf.Length - 3) + '/SKILL.md', $cmp)) { return $true }
        return $false
    }
    if ($t.EndsWith('SKILL.md')) { $t = Split-Path -Parent $t }
    $top = Split-Path -Parent (Split-Path -Parent $t)
    if (-not $top) { return $false }
    return ([IO.File]::Exists((Join-Path $top 'install.sh')) -and [IO.File]::Exists((Join-Path $top 'setup-all')) -and [IO.File]::Exists((Join-Path $t 'SKILL.md')))
}

# Directory signature: one line per entry, sorted ordinally. Files carry their SHA-256,
# empty directories and links are listed too (links with their link text, never followed).
# Only the top-level .hstack-managed marker is excluded.
function Add-HstackTreeEntries {
    param([string]$Root, [string]$Rel, $Out)
    $dirPath = $Root
    if ($Rel) { $dirPath = Join-Path $Root $Rel }
    $di = New-Object System.IO.DirectoryInfo($dirPath)
    foreach ($e in $di.EnumerateFileSystemInfos()) {
        $r = $e.Name
        if ($Rel) { $r = $Rel + '/' + $e.Name }
        $isDir = (($e.Attributes -band [IO.FileAttributes]::Directory) -ne 0)
        if ((-not $Rel) -and (-not $isDir) -and ($e.Name -ceq $HstackMarker)) { continue }
        if (($e.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $item = Get-HstackItem $e.FullName
            $t = ''
            if ($null -ne $item -and $item.Target) { $t = (@($item.Target) -join '|') }
            $Out.Add("L $r -> $t")
        } elseif ($isDir) {
            $Out.Add("D $r")
            Add-HstackTreeEntries $Root $r $Out
        } else {
            $Out.Add("F $r " + (Get-HstackBytesSig ([IO.File]::ReadAllBytes($e.FullName))))
        }
    }
}

function Get-HstackTreeDigest {
    param([string]$Path)
    $out = New-Object System.Collections.Generic.List[string]
    Add-HstackTreeEntries ([IO.Path]::GetFullPath($Path)) "" $out
    $arr = $out.ToArray()
    [Array]::Sort($arr, [StringComparer]::Ordinal)
    return ($arr -join "`n")
}

# "sha256:<lowercase hex>" of bytes (the same spelling the bash installer uses).
function Get-HstackBytesSig {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ('sha256:' + ([BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant())) }
    finally { $sha.Dispose() }
}

function Get-HstackTextHash {
    param([string]$Text)
    return (Get-HstackBytesSig ([Text.Encoding]::UTF8.GetBytes($Text)))
}

# Marker for a copied skill dir; records a digest of the content hstack installed so an
# unedited older copy is still recognised after the source moves on.
function Write-HstackMarker {
    param([string]$Dir)
    [IO.File]::WriteAllText((Join-Path $Dir $HstackMarker), (Get-HstackTextHash (Get-HstackTreeDigest $Dir)))
}

# Generated-file marker: "<!-- hstack-managed sig=sha256:<hex of the rest of the file> -->".
# Only ONE line of exactly this shape is ever recognised; a user's own
# "<!-- hstack-managed my note -->" line is ordinary content and counts as an edit.
$HstackLatin1 = [Text.Encoding]::GetEncoding(28591)
$HstackMarkerRx = '^<!-- hstack-managed sig=(sha256:[0-9a-f]{64}) -->$'

function Get-HstackMarkerLine {
    param([string]$PlainLatin1)
    return ('<!-- hstack-managed sig=' + (Get-HstackBytesSig ($HstackLatin1.GetBytes($PlainLatin1))) + ' -->')
}

# Split a file's Latin-1 view into the recorded sig and the text without that one marker line.
function Split-HstackMarker {
    param([string]$Latin1Text)
    $lines = $Latin1Text.Split([char]10)
    for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -cmatch $HstackMarkerRx) {
            $rest = New-Object System.Collections.Generic.List[string]
            for ($j = 0; $j -lt $lines.Length; $j++) { if ($j -ne $i) { $rest.Add($lines[$j]) } }
            return @{ Sig = $Matches[1]; Rest = ($rest.ToArray() -join "`n") }
        }
    }
    return $null
}

# Text with BOM stripped, LF line endings, trailing space trimmed: only used to recognise
# UNMARKED pre-marker copies written by older installers (which could carry BOM/CRLF).
function ConvertTo-HstackNormalText {
    param([string]$Text)
    return (($Text.TrimStart([char]0xFEFF) -replace "`r`n", "`n").TrimEnd())
}

# Is $Dst something hstack installed AND still unmodified? $RefDir / $RefFile / $RefText
# describe what hstack would install there. A marker alone never makes an entry owned.
function Test-HstackOwned {
    param([string]$Dst, [string]$RefDir = '', [string]$RefFile = '', [string[]]$RefText = @())
    if (Test-HstackLink $Dst) { return (Test-HstackOurLink $Dst) }
    if ([IO.Directory]::Exists($Dst)) {
        $dstDigest = Get-HstackTreeDigest $Dst
        if ($RefDir -and [IO.Directory]::Exists($RefDir) -and ((Get-HstackTreeDigest $RefDir) -ceq $dstDigest)) { return $true }
        $mk = Join-Path $Dst $HstackMarker
        if ([IO.File]::Exists($mk)) {
            $rec = [IO.File]::ReadAllText($mk).Trim()
            if ($rec -match '^sha256:[0-9a-fA-F]{64}$') { return ($rec -ieq (Get-HstackTextHash $dstDigest)) }
        }
        return $false
    }
    if ([IO.File]::Exists($Dst)) {
        try { $latin = $HstackLatin1.GetString([IO.File]::ReadAllBytes($Dst)) } catch { return $false }
        # what hstack would write now, as Latin-1 views of the exact bytes
        $refs = New-Object System.Collections.Generic.List[string]
        if ($RefFile -and [IO.File]::Exists($RefFile)) {
            $rf = $HstackLatin1.GetString([IO.File]::ReadAllBytes($RefFile))
            $refs.Add($rf)
            $refs.Add($rf + "`n")
        }
        foreach ($t in @($RefText)) { if ($t) { $refs.Add($HstackLatin1.GetString([Text.Encoding]::UTF8.GetBytes($t))) } }
        $split = Split-HstackMarker $latin
        if ($null -ne $split) {
            # marked: unedited when the rest still hashes to the recorded sig, or equals the current source
            if ((Get-HstackBytesSig ($HstackLatin1.GetBytes($split.Rest))) -ceq $split.Sig) { return $true }
            foreach ($rf in $refs) { if ($split.Rest -ceq $rf) { return $true } }
            return $false
        }
        # unmarked: only an older installer's untouched copy (BOM / CRLF / trailing space tolerated)
        $have = ConvertTo-HstackNormalText $latin
        foreach ($rf in $refs) { if ($have -ceq (ConvertTo-HstackNormalText $rf)) { return $true } }
        return $false
    }
    return $false
}

# Remove an hstack-owned entry. Links are unlinked only; their target is never touched.
function Remove-HstackEntry {
    param([string]$Path)
    if (Test-HstackLink $Path) {
        $item = Get-HstackItem $Path
        if ($item.PSIsContainer) { [IO.Directory]::Delete($Path) } else { [IO.File]::Delete($Path) }
    } else {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

# Failures make the whole run exit non-zero; the affected entry is always left untouched.
$script:HstackFailures = 0
$script:HstackLastBackup = $null
function Add-HstackFailure { $script:HstackFailures++ }

# An unused "<path>.hstack-backup-<stamp>[-n]" name (files: stays next to the original).
function Get-HstackBackupPath {
    param([string]$Path)
    $bak = "$Path.hstack-backup-$HstackStamp"
    $n = 1
    while (Test-HstackExists $bak) { $bak = "$Path.hstack-backup-$HstackStamp-$n"; $n++ }
    return $bak
}

# Skill-dir backup: <skills-parent>\.hstack-backups\<stamp>[-N]\<name>, outside the scan path.
function Get-HstackDirBackupPath {
    param([string]$Dst)
    $name = Split-Path -Leaf $Dst
    $skillsDir = Split-Path -Parent $Dst
    $base = Join-Path (Split-Path -Parent $skillsDir) '.hstack-backups'
    $n = 0
    while ($true) {
        $d = if ($n -eq 0) { $HstackStamp } else { "$HstackStamp-$n" }
        $cand = Join-Path (Join-Path $base $d) $name
        if (-not (Test-HstackExists $cand)) { return $cand }
        $n++
    }
}

# Free $Dst for a fresh install: remove it if hstack owns it, otherwise move it aside.
# Returns 'new', 'replaced', 'backed-up', 'refused' (resolves into the source tree) or
# 'failed' (the move-aside did not verifiably happen: the entry is left exactly as it was).
# Callers must NOT write to $Dst unless the result is 'new', 'replaced' or 'backed-up'.
function Clear-HstackDst {
    param([string]$Dst, [string]$RefDir = '', [string]$RefFile = '', [string[]]$RefText = @(), [switch]$BackupOutside)
    $script:HstackLastBackup = $null
    if (Test-HstackDstInSource $Dst) {
        Write-Warning "Refusing to touch ${Dst}: it resolves into the hstack source tree. Nothing was changed there."
        Add-HstackFailure
        return 'refused'
    }
    if (-not (Test-HstackExists $Dst)) { return 'new' }
    $owned = $false
    try { $owned = Test-HstackOwned $Dst $RefDir $RefFile $RefText } catch { $owned = $false }
    if ($owned) {
        try { Remove-HstackEntry $Dst }
        catch {
            Write-Warning "Could not replace ${Dst}: $($_.Exception.Message). Left untouched."
            Add-HstackFailure
            return 'failed'
        }
        if (Test-HstackExists $Dst) {
            Write-Warning "Could not replace $Dst (it is still there). Left untouched."
            Add-HstackFailure
            return 'failed'
        }
        return 'replaced'
    }
    $bak = $null
    try {
        if ($BackupOutside) { $bak = Get-HstackDirBackupPath $Dst } else { $bak = Get-HstackBackupPath $Dst }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $bak) -ErrorAction Stop | Out-Null
        Move-Item -LiteralPath $Dst -Destination $bak -ErrorAction Stop
    } catch {
        Write-Warning "Could not move $Dst aside to a backup ($($_.Exception.Message)). Left untouched, NOT installed over."
        Add-HstackFailure
        return 'failed'
    }
    if ((Test-HstackExists $Dst) -or (-not (Test-HstackExists $bak))) {
        Write-Warning "Backup of $Dst could not be verified (backup path: $bak). Not installed over it."
        Add-HstackFailure
        return 'failed'
    }
    $script:HstackLastBackup = $bak
    Write-Warning "$Dst is not managed by hstack (or was edited) - moved to $bak (nothing deleted)"
    return 'backed-up'
}

# Put the entry Clear-HstackDst moved aside back where it was (after a failed install step).
function Restore-HstackBackup {
    param([string]$Dst)
    $bak = $script:HstackLastBackup
    if ($bak -and (Test-HstackExists $bak) -and (-not (Test-HstackExists $Dst))) {
        try {
            Move-Item -LiteralPath $bak -Destination $Dst -ErrorAction Stop
            Write-Warning "Restored $Dst from $bak."
        } catch {
            Write-Warning "Could not restore $Dst; your original is safe at $bak."
        }
    }
}

# --- file writes: never truncate in place --------------------------------------------
# New bytes always go to a temp file in the SAME directory first, are verified, and only
# then swapped in (rename / File.Replace). A failed step leaves the original byte-identical
# and removes only the temp stub; backups are never deleted.
function Write-HstackTempFile {
    param([string]$Tmp, [byte[]]$Bytes)
    [IO.File]::WriteAllBytes($Tmp, $Bytes)
}

function Invoke-HstackReplaceFile {
    param([string]$Tmp, [string]$Path)
    [IO.File]::Replace($Tmp, $Path, [NullString]::Value)
}

function New-HstackTempPath {
    param([string]$Near)
    return (Join-Path (Split-Path -Parent $Near) ('.hstack-write-' + [guid]::NewGuid().ToString('N')))
}

# Replace the content of an EXISTING user file atomically (a symlinked file is written
# through to its target, the link stays a link). Returns $null on success, else the error text;
# on error the file is byte-identical to before (restored from a verified read if needed).
function Write-HstackUserFile {
    param([string]$Path, [byte[]]$Bytes)
    $real = $Path
    if (Test-HstackLink $Path) { $real = Resolve-HstackLink $Path }
    $before = [IO.File]::ReadAllBytes($real)
    $tmp = New-HstackTempPath $real
    $err = $null
    try {
        Write-HstackTempFile $tmp $Bytes
        if ((Get-HstackBytesSig ([IO.File]::ReadAllBytes($tmp))) -cne (Get-HstackBytesSig $Bytes)) { throw 'temp file did not verify' }
        # keep the permission bits of the file being replaced (POSIX; Replace keeps Windows attributes)
        $realItem = Get-Item -LiteralPath $real -Force
        if ($realItem.PSObject.Properties['UnixFileMode']) { (Get-Item -LiteralPath $tmp -Force).UnixFileMode = $realItem.UnixFileMode }
        Invoke-HstackReplaceFile $tmp $real
        if ((Get-HstackBytesSig ([IO.File]::ReadAllBytes($real))) -cne (Get-HstackBytesSig $Bytes)) { throw 'the file did not verify after the swap' }
    } catch {
        $err = $_.Exception.Message
    }
    try { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } } catch { Write-Verbose "temp cleanup: $($_.Exception.Message)" }
    if ($err) {
        $now = $null
        try { $now = [IO.File]::ReadAllBytes($real) } catch { Write-Verbose "re-read: $($_.Exception.Message)" }
        if ($null -eq $now -or (Get-HstackBytesSig $now) -cne (Get-HstackBytesSig $before)) {
            try { [IO.File]::WriteAllBytes($real, $before) } catch { $err += ' (and the original could not be put back by this step)' }
        }
    }
    return $err
}

# Write a generated file onto a destination that Clear-HstackDst already freed. Refuses to
# write if anything (or any link) is still there. The bytes go through a temp file, so a
# failure leaves no partial file at $Dst; if the user's original was moved aside it is KEPT
# at its backup path and also copied back to $Dst.
function Write-HstackFileSafe {
    param([string]$Dst, [byte[]]$Bytes)
    if (Test-HstackExists $Dst) {
        Write-Warning "$Dst is still occupied; not writing over it."
        Add-HstackFailure
        return $false
    }
    $tmp = New-HstackTempPath $Dst
    try {
        Write-HstackTempFile $tmp $Bytes
        if ((Get-HstackBytesSig ([IO.File]::ReadAllBytes($tmp))) -cne (Get-HstackBytesSig $Bytes)) { throw 'temp file did not verify' }
        Move-Item -LiteralPath $tmp -Destination $Dst -ErrorAction Stop
    } catch {
        $msg = $_.Exception.Message
        try { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } } catch { Write-Verbose "temp cleanup: $($_.Exception.Message)" }
        $bak = $script:HstackLastBackup
        if ($bak -and (Test-HstackExists $bak)) {
            $note = "Your original is kept at $bak"
            if (-not (Test-HstackExists $Dst)) {
                try { Copy-Item -LiteralPath $bak -Destination $Dst -ErrorAction Stop; $note += ' and was copied back' }
                catch { $note += ' (copying it back failed)' }
            }
            Write-Warning "Could not write ${Dst}: $msg. $note."
        } else {
            Write-Warning "Could not write ${Dst}: $msg."
        }
        Add-HstackFailure
        return $false
    }
    return $true
}

# Skill directory: marked copy, staged OUTSIDE the scanned skills dir
# (<skills-parent>\.hstack-staging\<name>), then swapped in. A failed copy never leaves a
# partial skill in the scan path; a failed swap restores whatever was moved aside.
# Returns 'new', 'replaced', 'backed-up', 'refused' or 'failed'.
function Install-HstackDir {
    param([string]$Src, [string]$Dst)
    if (Test-HstackDstInSource $Dst) {
        Write-Warning "Refusing to install ${Dst}: it resolves into the hstack source tree. Nothing was changed there."
        Add-HstackFailure
        return 'refused'
    }
    $stageRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $Dst)) '.hstack-staging'
    $stage = Join-Path $stageRoot (Split-Path -Leaf $Dst)
    $script:HstackLastBackup = $null
    try {
        try {
            if (Test-HstackExists $stage) { Remove-HstackEntry $stage }
            New-Item -ItemType Directory -Force -Path $stageRoot -ErrorAction Stop | Out-Null
            Copy-Item -LiteralPath $Src -Destination $stage -Recurse -ErrorAction Stop
            Write-HstackMarker $stage
        } catch {
            Write-Warning "Could not stage $Dst ($($_.Exception.Message)). Left untouched."
            Add-HstackFailure
            return 'failed'
        }
        $result = Clear-HstackDst $Dst $Src -BackupOutside
        if (($result -eq 'refused') -or ($result -eq 'failed')) { return $result }
        if (Test-HstackExists $Dst) {
            Write-Warning "$Dst is still occupied; not installing over it."
            Add-HstackFailure
            return 'failed'
        }
        try { Move-Item -LiteralPath $stage -Destination $Dst -ErrorAction Stop }
        catch {
            Write-Warning "Could not move the new copy into $Dst ($($_.Exception.Message))."
            Add-HstackFailure
            Restore-HstackBackup $Dst
            return 'failed'
        }
        return $result
    } finally {
        try { if (Test-HstackExists $stage) { Remove-HstackEntry $stage } } catch { Write-Verbose "stage cleanup: $($_.Exception.Message)" }
        try {
            if ([IO.Directory]::Exists($stageRoot) -and ($null -eq (Get-ChildItem -LiteralPath $stageRoot -Force | Select-Object -First 1))) {
                Remove-Item -LiteralPath $stageRoot -Force
            }
        } catch { Write-Verbose "stage cleanup: $($_.Exception.Message)" }
    }
}
# <<< hstack-ownership

# Resolve every path override to an absolute path NOW, before any Set-Location, so a
# relative override can never end up pointing into the checkout.
$InstallDir = Resolve-HstackAbs $InstallDir
$EnvInstallDir = Resolve-HstackAbs $env:HSTACK_INSTALL_DIR
function Get-TargetDir {
    param([string]$Override, [string[]]$DefaultParts)
    if ($Override) { return (Resolve-HstackAbs $Override) }
    $p = $HOME
    foreach ($part in $DefaultParts) { $p = Join-Path $p $part }
    return (Resolve-HstackAbs $p)
}
$TargetDirs = @{
    claude   = Get-TargetDir $env:CLAUDE_SKILLS_DIR @('.claude', 'skills')
    codex    = Get-TargetDir $env:CODEX_SKILLS_DIR @('.agents', 'skills')
    cursor   = Get-TargetDir $env:CURSOR_RULES_DIR @('.cursor', 'rules')
    hermes   = Get-TargetDir $env:HERMES_SKILLS_DIR @('.hermes', 'skills')
    gemini   = Get-TargetDir $env:GEMINI_CONTEXT_DIR @('.gemini', 'context', 'hstack')
    openclaw = Get-TargetDir $env:OPENCLAW_SKILLS_DIR @('.openclaw', 'skills')
}

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
    # Native commands do not throw on failure: every git call below checks $LASTEXITCODE.
    function Invoke-HstackGit {
        param([string[]]$GitArgs, [switch]$Quiet)
        if ($Quiet) { & git @GitArgs | Out-Null } else { & git @GitArgs | Out-Host }
        return $LASTEXITCODE
    }
    if ((Invoke-HstackGit @('check-ref-format', '--branch', $Branch) -Quiet) -ne 0) {
        Write-Die "'$Branch' is not a valid branch name."
    }
    Write-Head "==> Fetching hstack"
    if (Test-Path (Join-Path $InstallDir ".git")) {
        Write-Info "Updating existing checkout at $InstallDir (branch $Branch)"
        $updated = $false
        Push-Location $InstallDir
        try {
            # The first clone is --depth 1 and single-branch: fetch the requested branch explicitly
            # (shallow when we have none of it yet), then switch and fast-forward.
            $spec = "+refs/heads/${Branch}:refs/remotes/origin/${Branch}"
            $haveRef = (Invoke-HstackGit @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$Branch") -Quiet) -eq 0
            if ($haveRef) { $fetchArgs = @('fetch', '--quiet', 'origin', $spec) }
            else { $fetchArgs = @('fetch', '--quiet', '--depth', '1', 'origin', $spec) }
            # (a single-branch clone's refspec hides other branches from checkout's own DWIM,
            # so a branch we have not had before is created from the ref fetched above)
            $haveLocal = (Invoke-HstackGit @('show-ref', '--verify', '--quiet', "refs/heads/$Branch") -Quiet) -eq 0
            if ($haveLocal) { $coArgs = @('checkout', '--quiet', $Branch) }
            else { $coArgs = @('checkout', '--quiet', '-b', $Branch, "refs/remotes/origin/$Branch") }
            $updated = ((Invoke-HstackGit $fetchArgs) -eq 0) -and
                ((Invoke-HstackGit $coArgs) -eq 0) -and
                ((Invoke-HstackGit @('merge', '--ff-only', '--quiet', "refs/remotes/origin/$Branch")) -eq 0)
            $current = ((& git symbolic-ref --quiet --short HEAD) | Out-String).Trim()
        } finally {
            Pop-Location
        }
        if (-not $updated) {
            if ($current -ne $Branch) {
                if (-not $current) { $current = 'a detached HEAD' }
                Write-Die "Could not switch the existing checkout at $InstallDir to branch '$Branch' (it is on '$current'). Fix the branch name or the checkout and re-run."
            }
            Write-WarnX "Could not fast-forward. Continuing with existing checkout."
        }
    } elseif ((Test-Path $InstallDir) -and (Get-ChildItem $InstallDir -Force | Measure-Object).Count -gt 0) {
        Write-Die "$InstallDir exists and is not a git checkout of hstack. Move it aside and re-run."
    } else {
        Write-Info "Cloning $RepoUrl -> $InstallDir (branch $Branch)"
        if ((Invoke-HstackGit @('clone', '--depth', '1', '--branch', $Branch, '--quiet', $RepoUrl, $InstallDir)) -ne 0) {
            Write-Die "git clone of $RepoUrl (branch $Branch) into $InstallDir failed."
        }
    }
    Write-Ok "hstack checkout ready"
}

Set-Location $InstallDir
if (-not (Test-Path (Join-Path $InstallDir "skills"))) { Write-Die "$InstallDir\skills not found - checkout is broken." }
$SourceRoot = (Get-Location).ProviderPath
# Skills trees whose links count as "ours": the one being installed, the default
# ~\.hstack checkout, and a custom HSTACK_INSTALL_DIR.
$script:HstackRoots = @((Join-Path $SourceRoot "skills"), (Join-Path (Join-Path $HOME ".hstack") "skills"))
if ($EnvInstallDir) { $script:HstackRoots += (Join-Path $EnvInstallDir "skills") }
$script:HstackSourceTree = $SourceRoot

# ---------------------------------------------------------------------------
# Step 2: detect IDEs
# ---------------------------------------------------------------------------

Write-Head "==> Detecting IDEs / agents"

$Ides = @{}
if (Test-Path (Join-Path $HOME ".claude"))    { $Ides['claude']   = $true }
if (Test-Path (Join-Path $HOME ".agents"))    { $Ides['codex']    = $true }
if (Test-Path (Join-Path $HOME ".cursor"))    { $Ides['cursor']   = $true }
if (Test-Path (Join-Path $HOME ".hermes"))    { $Ides['hermes']   = $true }
if (Test-Path (Join-Path $HOME ".gemini"))    { $Ides['gemini']   = $true }
if (Test-Path (Join-Path $HOME ".openclaw"))  { $Ides['openclaw'] = $true }

if ($IdeList.Count -gt 0) {
    $knownIdes = @('claude','codex','cursor','hermes','gemini','openclaw')
    $requested = @{}
    foreach ($p in $IdeList) {
        if ($p -ceq 'all') {
            foreach ($k in $knownIdes) { $requested[$k] = $true }
            break
        }
        if ($knownIdes -ccontains $p) { $requested[$p] = $true }
        else { Write-WarnX "unknown IDE '$p' - skipping (available: $($knownIdes -join ' '), all)" }
    }
    if ($requested.Count -eq 0) {
        Write-Host "x no valid IDE in -Ide $($IdeList -join ',') (available: $($knownIdes -join ' '), all)" -ForegroundColor Red
        exit 2
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

# $script:Chosen on purpose: Add-Tier writes it as $script:Chosen, and a plain $Chosen would be a
# different variable when this file runs as a script block (& ([scriptblock]::Create(...))).
$script:Chosen = @{}
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
    if (($IncludeList.Count -gt 0) -or ($TierList.Count -gt 0)) {
        Write-WarnX "-All given: ignoring -Include / -Tier"
    }
    foreach ($t in $IntegrationTiers) { Add-Tier $t }
} elseif ($IncludeList.Count -gt 0) {
    Write-Info "Installing only: $($IncludeList -join ',')"
    if ($TierList.Count -gt 0) {
        Write-WarnX "-Include overrides -Tier: ignoring -Tier $($TierList -join ',') (core + platforms + the -Include items are installed)"
    }
    foreach ($p in $IncludeList) {
        if ($Tiers.ContainsKey($p)) { Add-Tier $p; continue }
        if (Test-Path (Join-Path "skills" "integration-$p")) { $Chosen["integration-$p"] = $true; continue }
        if (Test-Path (Join-Path "skills" $p)) { $Chosen[$p] = $true; continue }
        Write-WarnX "unknown: '$p' - skipping"
    }
} elseif ($TierList.Count -gt 0) {
    Write-Info "Installing tiers: $($TierList -join ',')"
    foreach ($t in $TierList) {
        if ($Tiers.ContainsKey($t)) { Add-Tier $t } else { Write-WarnX "unknown tier: '$t'" }
    }
} elseif ($Pick -or (-not [Console]::IsInputRedirected)) {
    # Interactive picker: only on a terminal (or with -Pick); piped stdin falls through to "all".
    Write-Host @"

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

"@
    if ([Console]::IsInputRedirected) {
        Write-Host -NoNewline "> "
        $picks = [Console]::In.ReadLine()
    } else {
        $picks = Read-Host "> "
    }
    if ($null -eq $picks) { $picks = "" }
    if (-not $picks.Trim()) {
        Write-Info "No integrations selected. Installing core + platforms only."
    } else {
        foreach ($p in $picks -split ',') {
            $p = $p.Trim()
            if (-not $p) { continue }
            if ($p -eq 'all') { foreach ($t in $IntegrationTiers) { Add-Tier $t }; continue }
            if ($p -match '^[0-9]+$') {
                # a menu number: 1 = all, 2.. = $IntegrationTiers in order
                $num = 0
                if ([int]::TryParse($p, [ref]$num) -and $num -eq 1) {
                    foreach ($t in $IntegrationTiers) { Add-Tier $t }
                } elseif ($num -ge 2 -and $num -le ($IntegrationTiers.Count + 1)) {
                    Add-Tier $IntegrationTiers[$num - 2]
                } else {
                    Write-WarnX "unknown menu number: '$p' - skipping (1-$($IntegrationTiers.Count + 1))"
                }
                continue
            }
            if ($Tiers.ContainsKey($p)) { Add-Tier $p; continue }
            if (Test-Path (Join-Path "skills" "integration-$p")) { $Chosen["integration-$p"] = $true; continue }
            if (Test-Path (Join-Path "skills" $p)) { $Chosen[$p] = $true; continue }
            Write-WarnX "unknown: '$p' - skipping"
        }
    }
} else {
    Write-Info "Non-interactive install (no flags) - including all integrations."
    foreach ($t in $IntegrationTiers) { Add-Tier $t }
}

# Filter chosen to what actually exists
$Final = @{}
foreach ($name in $Chosen.Keys) {
    if (Test-Path (Join-Path (Join-Path "skills" $name) "SKILL.md")) { $Final[$name] = $true }
    else { Write-WarnX "skill '$name' not found in checkout - skipping" }
}

$skillCount = $Final.Count
Write-Ok "$skillCount skills chosen"

# ---------------------------------------------------------------------------
# Step 4: install to each IDE
# ---------------------------------------------------------------------------

Write-Head "==> Wiring into IDEs"

# Copy every chosen skill directory into $target. hstack-owned destinations are
# replaced silently; anything else is moved to <dst>.hstack-backup-<stamp> first.
function Install-SkillDirs {
    param([string]$target)
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    foreach ($skill in $Final.Keys) {
        $r = Install-HstackDir (Join-Path (Join-Path $InstallDir "skills") $skill) (Join-Path $target $skill)
        if (($r -ne 'refused') -and ($r -ne 'failed')) { $n++ }
    }
    return $n
}

# Cursor rule text for one skill (unmarked). -Legacy reproduces the pre-marker generator so
# old installs are recognised.
function Get-HstackMdcText {
    param([string]$Skill, [string]$Src, [switch]$Legacy)
    $lines = @(Get-Content -LiteralPath $Src -Encoding UTF8)
    $desc = ($lines | Where-Object { $_ -match '^description:' } | Select-Object -First 1)
    if ($desc) { $desc = $desc -replace '^description:\s*','' }
    if (-not $desc) { $desc = "hstack skill: $Skill" }
    if ($Legacy) {
        $body = @($lines | Where-Object { $_ -notmatch '^(name|description):' -and $_ -ne '---' })
    } else {
        $body = @()
        $fences = 0
        foreach ($l in $lines) {
            if ($fences -ge 2) { $body += $l }
            elseif ($l.TrimEnd() -eq '---') { $fences++ }
        }
    }
    $out = @('---', "description: $desc", 'globs:', 'alwaysApply: false', '---', '')
    $out += $body
    return (($out -join "`n") + "`n")
}

# The same text with the ownership line inserted right after the frontmatter.
function Add-HstackMdcMarker {
    param([string]$Plain)
    $lines = $Plain.Split([char]10)
    $marker = Get-HstackMarkerLine ([Text.Encoding]::GetEncoding(28591).GetString([Text.Encoding]::UTF8.GetBytes($Plain)))
    $head = @($lines[0..4])
    $tail = @($lines[5..($lines.Length - 1)])
    return ((@($head) + @($marker) + @($tail)) -join "`n")
}

function Install-To-Claude {
    $target = $TargetDirs.claude
    if (-not (Test-HstackTargetOk $target)) { return }
    $n = Install-SkillDirs $target
    Write-Ok "claude    -> $target ($n skills)"
}

function Install-To-Codex {
    $target = $TargetDirs.codex
    if (-not (Test-HstackTargetOk $target)) { return }
    $n = Install-SkillDirs $target
    Write-Ok "codex     -> $target ($n skills)"
}

function Install-To-Cursor {
    $target = $TargetDirs.cursor
    if (-not (Test-HstackTargetOk $target)) { return }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($skill in $Final.Keys) {
        $src = Join-Path (Join-Path (Join-Path $InstallDir "skills") $skill) "SKILL.md"
        $dst = Join-Path $target "$skill.mdc"
        $plain = Get-HstackMdcText -Skill $skill -Src $src
        $legacy = Get-HstackMdcText -Skill $skill -Src $src -Legacy
        $marked = Add-HstackMdcMarker $plain
        # Clear first (owned: removed, otherwise backed up) so a symlink is never written through.
        $res = Clear-HstackDst $dst -RefText @($plain, $legacy)
        if (($res -eq 'refused') -or ($res -eq 'failed')) { continue }
        if (-not (Write-HstackFileSafe $dst ($utf8.GetBytes($marked)))) { continue }
        $n++
    }
    Write-Ok "cursor    -> $target ($n skills, converted to .mdc)"
}

function Install-To-Hermes {
    $target = $TargetDirs.hermes
    if (-not (Test-HstackTargetOk $target)) { return }
    $n = Install-SkillDirs $target
    Write-Ok "hermes    -> $target ($n skills)"
}

function Install-To-Gemini {
    $target = $TargetDirs.gemini
    if (-not (Test-HstackTargetOk $target)) { return }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $n = 0
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    foreach ($skill in $Final.Keys) {
        $src = Join-Path (Join-Path (Join-Path $InstallDir "skills") $skill) "SKILL.md"
        $dst = Join-Path $target "$skill.md"
        $res = Clear-HstackDst $dst -RefFile $src
        if (($res -eq 'refused') -or ($res -eq 'failed')) { continue }
        # the source bytes verbatim, a newline, then the ownership line (sig covers all before it)
        $body = $latin1.GetString([IO.File]::ReadAllBytes($src)) + "`n"
        if (-not (Write-HstackFileSafe $dst ($latin1.GetBytes($body + (Get-HstackMarkerLine $body) + "`n")))) { continue }
        $n++
    }
    Write-Ok "gemini    -> $target ($n skills)"
}

function Install-To-Openclaw {
    $target = $TargetDirs.openclaw
    if (-not (Test-HstackTargetOk $target)) { return }
    $n = Install-SkillDirs $target
    Write-Ok "openclaw  -> $target ($n skills)"
}

# (not $ide: variable names are case-insensitive and $Ide is the [string[]] parameter)
foreach ($ideName in @('claude','codex','cursor','hermes','gemini','openclaw')) {
    if ($Ides.ContainsKey($ideName)) {
        & "Install-To-$($ideName.Substring(0,1).ToUpper() + $ideName.Substring(1))"
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
Write-Host "  1. Deploy Hermes to your own server (~30 min):"
Write-Host "     Open any of your IDEs and run:  /hermes-deploy"
Write-Host ""
Write-Host "  2. After deploy, wire integrations one at a time:"
Write-Host "     /integration-notion / /integration-stripe / etc."
Write-Host ""
Write-Host "  3. Or wire many at once:"
Write-Host "     /hermes-integrate"
Write-Host ""
Write-Host "Repo:    $InstallDir"
Write-Host "Docs:    https://github.com/paarths-collab/hstack"
Write-Host ""
Write-Host "To re-run this installer with different choices:"
Write-Host "  powershell -File $(Join-Path $InstallDir 'install.ps1') -Pick"
if ($script:HstackFailures -gt 0) {
    Write-WarnX "$($script:HstackFailures) entries could not be installed and were left untouched (see the warnings above). Exiting with an error."
    exit 1
}
