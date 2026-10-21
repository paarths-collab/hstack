# Regression test for install.ps1 and setup.ps1 (Windows / PowerShell installers).
#
# Guards against data loss: the installers must never delete a user-owned skill
# directory, .mdc rule, or instruction file. Self-contained and offline: it copies
# install.ps1, setup.ps1 and skills/ to a temp tree, uses a throwaway HOME, runs
# the installers in child PowerShell processes with -Local, and never touches the
# network or the real home directory.
#
#   pwsh -NoProfile -File tests/installer/test-install.ps1
#
# Works on Windows PowerShell 5.1 and PowerShell 7+ (Linux/macOS/Windows).
# Symlink scenarios are skipped (and reported) where symlinks cannot be created.

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Pwsh = (Get-Process -Id $PID).Path
$IsWin = ([IO.Path]::DirectorySeparatorChar -eq '\')
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$script:Failures = 0
$script:Passes = 0
$script:Skips = 0

function Assert-That {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { $script:Passes++; Write-Host "  PASS  $Message" }
    else { $script:Failures++; Write-Host "  FAIL  $Message" -ForegroundColor Red }
}

function Skip-That {
    param([string]$Message)
    $script:Skips++
    Write-Host "  SKIP  $Message" -ForegroundColor Yellow
}

function New-Dir {
    param([string]$Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Write-Text {
    param([string]$Path, [string]$Text)
    New-Dir (Split-Path -Parent $Path)
    [IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

# Text of a file, or $null when it is missing (so a failed assertion cannot crash the run)
function Read-TextOrNull {
    param([string]$Path)
    if (-not [IO.File]::Exists($Path)) { return $null }
    return [IO.File]::ReadAllText($Path)
}

function Get-TreeDigest {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return '<missing>' }
    $root = (Resolve-Path -LiteralPath $Path).ProviderPath
    $parts = foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File -Force | Sort-Object FullName)) {
        $rel = $f.FullName.Substring($root.Length)
        $rel + ':' + (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
    }
    return ($parts -join "`n")
}

function Get-FileDigest {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# Skill-dir backups live OUTSIDE the scan path: <skills-parent>/.hstack-backups/<stamp>[-N]/<name>
function Get-DirBackups {
    param([string]$SkillsDir)
    $base = Join-Path (Split-Path -Parent $SkillsDir) '.hstack-backups'
    if (-not (Test-Path -LiteralPath $base)) { return @() }
    return @(Get-ChildItem -LiteralPath $base -Directory -Force | ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Force })
}

function Get-Backups {
    param([string]$Dir)
    return @(Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*.hstack-backup-*' })
}

function New-Link {
    # Returns $true if a symlink could be created.
    param([string]$Path, [string]$Target)
    try {
        New-Item -ItemType SymbolicLink -Path $Path -Target $Target -ErrorAction Stop | Out-Null
        return $true
    } catch { return $false }
}

function Test-IsLink {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

$EnvKeys = @('HOME', 'USERPROFILE', 'CLAUDE_SKILLS_DIR', 'CODEX_SKILLS_DIR', 'CURSOR_RULES_DIR',
             'HERMES_SKILLS_DIR', 'GEMINI_CONTEXT_DIR', 'OPENCLAW_SKILLS_DIR', 'CLAUDE_MD_PATH',
             'HSTACK_REPO_URL', 'HSTACK_INSTALL_DIR', 'HSTACK_BRANCH', 'HS_STAMP')

# Run a script in a child PowerShell with a controlled environment. Returns @{ Code; Output }.
function Invoke-Child {
    param([string]$Script, [string[]]$ScriptArgs, [hashtable]$EnvVars, [string]$InputText = '', [string]$WorkDir = '')
    $saved = @{}
    foreach ($k in $EnvKeys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
    if ($WorkDir) { Push-Location -LiteralPath $WorkDir }
    try {
        foreach ($k in $EnvKeys) { [Environment]::SetEnvironmentVariable($k, $null) }
        foreach ($k in $EnvVars.Keys) { [Environment]::SetEnvironmentVariable($k, $EnvVars[$k]) }
        $psArgs = @('-NoProfile', '-NonInteractive')
        if ($IsWin) { $psArgs += @('-ExecutionPolicy', 'Bypass') }
        $psArgs += @('-File', $Script) + $ScriptArgs
        $out = $InputText | & $Pwsh @psArgs 2>&1 | Out-String
        return @{ Code = $LASTEXITCODE; Output = $out }
    } finally {
        if ($WorkDir) { Pop-Location }
        foreach ($k in $EnvKeys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
}

# --- fixture: a private copy of the hstack source tree ----------------------

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hstack-ps-test-" + [guid]::NewGuid().ToString('N'))
New-Dir $Tmp
$Src = Join-Path $Tmp 'src'
New-Dir $Src
Copy-Item -LiteralPath (Join-Path $RepoRoot 'install.ps1') -Destination $Src
Copy-Item -LiteralPath (Join-Path $RepoRoot 'setup.ps1') -Destination $Src
Copy-Item -LiteralPath (Join-Path $RepoRoot 'skills') -Destination $Src -Recurse
$SkillNames = @(Get-ChildItem -LiteralPath (Join-Path $Src 'skills') -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } | ForEach-Object { $_.Name })
$InstallPs1 = Join-Path $Src 'install.ps1'
$SetupPs1 = Join-Path $Src 'setup.ps1'
$SrcDigest = Get-TreeDigest (Join-Path $Src 'skills')

Write-Host "hstack PowerShell installer regression test"
Write-Host "  host      : $($PSVersionTable.PSVersion) ($([Environment]::OSVersion.Platform))"
Write-Host "  skills    : $($SkillNames.Count)"
Write-Host "  temp tree : $Tmp"

try {

# ===========================================================================
Write-Host "`n[1] install.ps1 -Local -All -Ide claude (planted user data)"
# ===========================================================================
$home1 = Join-Path $Tmp 'home1'
$skills1 = Join-Path (Join-Path $home1 '.claude') 'skills'
New-Dir $skills1
# user-owned dir with the same name as an hstack skill
Write-Text (Join-Path (Join-Path $skills1 'hermes-deploy') 'USER-NOTES.txt') 'my precious notes'
# unrelated user skill
Write-Text (Join-Path (Join-Path $skills1 'my-own-skill') 'SKILL.md') 'user skill body'
$unrelatedBefore = Get-TreeDigest (Join-Path $skills1 'my-own-skill')
# user-owned plain file squatting on a skill name
Write-Text (Join-Path $skills1 'integration-stripe') 'a file, not a directory'
# symlink to a user dir (NOT in the hstack tree) squatting on a skill name
$userData = Join-Path $Tmp 'user-data'
Write-Text (Join-Path $userData 'keep.txt') 'user data behind a link'
$userLink = New-Link (Join-Path $skills1 'integration-notion') $userData
# symlink INTO the hstack tree (hstack-owned): replaced silently
$ownedLink = New-Link (Join-Path $skills1 'integration-github') (Join-Path (Join-Path $Src 'skills') 'integration-github')
# symlink into an older ~/.hstack checkout (hstack-owned): replaced silently
$oldSkill = Join-Path (Join-Path (Join-Path $home1 '.hstack') 'skills') 'integration-gitlab'
Copy-Item -LiteralPath (Join-Path (Join-Path $Src 'skills') 'integration-gitlab') -Destination $oldSkill -Recurse
$oldLink = New-Link (Join-Path $skills1 'integration-gitlab') $oldSkill
# dangling links: one ending in /skills/<same name> (a removed older checkout: ours), one not (foreign)
$dangOurs = New-Link (Join-Path $skills1 'integration-render') '/nonexistent/old-hstack/skills/integration-render'
$dangForeign = New-Link (Join-Path $skills1 'integration-vercel') '/nonexistent/elsewhere/integration-vercel'
# pre-marker install: byte-identical copy of the source skill dir (what the old installer wrote)
Copy-Item -LiteralPath (Join-Path (Join-Path $Src 'skills') 'hermes-fix') -Destination (Join-Path $skills1 'hermes-fix') -Recurse

$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home1; USERPROFILE = $home1 }
Assert-That ($r.Code -eq 0) "install exits 0 (got $($r.Code))"
if ($r.Code -ne 0) { Write-Host $r.Output }

$missing = @($SkillNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $skills1 $_) 'SKILL.md')) })
Assert-That ($missing.Count -eq 0) "all $($SkillNames.Count) skills installed for claude (missing: $($missing -join ', '))"
$unmarked = @($SkillNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $skills1 $_) '.hstack-managed')) })
Assert-That ($unmarked.Count -eq 0) 'every installed skill dir carries .hstack-managed'

$bak = Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-deploy' }
Assert-That (@($bak).Count -eq 1) 'user-owned hermes-deploy dir was backed up (not deleted)'
Assert-That (@(Get-Backups $skills1).Count -eq 0) 'skill-dir backups are NOT left inside the scanned skills dir'
Assert-That ($bak[0].FullName -like (Join-Path (Join-Path (Join-Path $home1 '.claude') '.hstack-backups') '*')) 'dir backup is <skills-parent>/.hstack-backups/<stamp>/<name>'
Assert-That ($r.Output.Contains($bak[0].FullName)) 'the warning prints the exact backup path'
if (@($bak).Count -eq 1) {
    $notes = Join-Path $bak[0].FullName 'USER-NOTES.txt'
    Assert-That ((Test-Path -LiteralPath $notes) -and ([IO.File]::ReadAllText($notes) -eq 'my precious notes')) 'backup preserves the user file byte-for-byte'
}
Assert-That (Test-Path -LiteralPath (Join-Path (Join-Path $skills1 'hermes-deploy') 'SKILL.md')) 'hstack hermes-deploy installed after backup'
Assert-That ($r.Output -match 'not managed by hstack') 'a warning says the entry is not managed by hstack'
Assert-That (-not (Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-fix' })) 'byte-identical legacy (pre-marker) copy replaced silently, no backup'

$fileBak = Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-stripe' }
Assert-That ((@($fileBak).Count -eq 1) -and ([IO.File]::ReadAllText($fileBak[0].FullName) -eq 'a file, not a directory')) 'user file squatting on a skill name was backed up'

Assert-That ((Get-TreeDigest (Join-Path $skills1 'my-own-skill')) -eq $unrelatedBefore) 'unrelated user skill untouched'
Assert-That (-not (Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'my-own-skill' })) 'unrelated user skill not backed up'

if ($userLink) {
    Assert-That ([IO.File]::ReadAllText((Join-Path $userData 'keep.txt')) -eq 'user data behind a link') 'data behind a non-hstack symlink untouched'
    $linkBak = Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-notion' }
    Assert-That (@($linkBak).Count -eq 1) 'non-hstack symlink was moved to a backup, not followed or deleted'
    Assert-That (-not (Test-IsLink (Join-Path $skills1 'integration-notion'))) 'installed integration-notion is a real directory, not written through the link'
} else { Skip-That 'cannot create symlinks here: non-hstack symlink scenario' }

if ($ownedLink) {
    Assert-That (-not (Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-github' })) 'symlink into the hstack tree replaced silently (no backup)'
} else { Skip-That 'cannot create symlinks here: hstack-owned symlink scenario' }
if ($oldLink) {
    Assert-That (-not (Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-gitlab' })) 'symlink into an old ~/.hstack checkout replaced silently (no backup)'
    Assert-That (Test-Path -LiteralPath (Join-Path $oldSkill 'SKILL.md')) 'the old checkout behind that link was not deleted'
} else { Skip-That 'cannot create symlinks here: old-checkout symlink scenario' }
if ($dangOurs -and $dangForeign) {
    Assert-That (-not (Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-render' })) 'dangling link ending in /skills/<same name> counts as hstack-owned (replaced silently)'
    Assert-That (@(Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'integration-vercel' }).Count -eq 1) 'dangling link NOT ending in /skills/<name> is treated as foreign and backed up'
} else { Skip-That 'cannot create symlinks here: dangling-link scenario' }
Assert-That ((Get-TreeDigest (Join-Path $Src 'skills')) -eq $SrcDigest) 'hstack source tree unmodified by the install'

$backupsAfterFirst = @(Get-DirBackups $skills1).Count
$digestAfterFirst = Get-TreeDigest $skills1

# --- idempotent re-run ---
$r2 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home1; USERPROFILE = $home1 }
Assert-That ($r2.Code -eq 0) 're-run exits 0'
Assert-That (@(Get-DirBackups $skills1).Count -eq $backupsAfterFirst) "re-run creates no new backups ($backupsAfterFirst before and after)"
Assert-That ($r2.Output -notmatch 'WARNING') 're-run emits no warnings'
Assert-That ((Get-TreeDigest $skills1) -eq $digestAfterFirst) 're-run leaves the skills tree identical'

# --- a user-EDITED marked copy is not ours any more: backed up, not replaced ---
$edited = Join-Path (Join-Path $skills1 'hermes-home') 'SKILL.md'
[IO.File]::AppendAllText($edited, "`nMY LOCAL EDIT`n")
Write-Text (Join-Path (Join-Path $skills1 'hermes-soul') 'extra-user-file.txt') 'user added file inside a marked copy'
$backupsBeforeEdit = @(Get-DirBackups $skills1).Count
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home1; USERPROFILE = $home1 }
$eb = @(Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-home' })
Assert-That (($eb.Count -eq 1) -and ([IO.File]::ReadAllText((Join-Path $eb[0].FullName 'SKILL.md')).Contains('MY LOCAL EDIT'))) 'edited marked skill copy was backed up with the edit intact'
Assert-That (-not [IO.File]::ReadAllText($edited).Contains('MY LOCAL EDIT')) '...and a clean copy was installed in its place'
Assert-That (@(Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-soul' }).Count -eq 1) 'marked copy with an extra user file was backed up too'
Assert-That (@(Get-DirBackups $skills1).Count -eq ($backupsBeforeEdit + 2)) 'exactly the two edited copies were backed up'

# --- the dir signature covers empty directories and links, not just files ---
New-Dir (Join-Path (Join-Path $skills1 'hermes-cron') 'user-empty-dir')
$sigLink = New-Link (Join-Path (Join-Path $skills1 'hermes-model') 'user-link') $userData
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home1; USERPROFILE = $home1 }
Assert-That (@(Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-cron' }).Count -eq 1) 'marked copy with an added EMPTY directory counts as edited (backed up)'
if ($sigLink) {
    Assert-That (@(Get-DirBackups $skills1 | Where-Object { $_.Name -eq 'hermes-model' }).Count -eq 1) 'marked copy with an added symlink counts as edited (backed up)'
    Assert-That ([IO.File]::ReadAllText((Join-Path $userData 'keep.txt')) -eq 'user data behind a link') '...and the data behind that symlink was never touched'
} else { Skip-That 'cannot create symlinks here: added-symlink signature scenario' }

# --- an UNEDITED marked copy from an older source is still ours: upgraded silently ---
$srcSkill = Join-Path (Join-Path (Join-Path $Src 'skills') 'hermes-status') 'SKILL.md'
$srcOriginal = [IO.File]::ReadAllText($srcSkill)
[IO.File]::AppendAllText($srcSkill, "`nnewer upstream line`n")
$backupsBeforeUpgrade = @(Get-DirBackups $skills1).Count
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home1; USERPROFILE = $home1 }
Assert-That (@(Get-DirBackups $skills1).Count -eq $backupsBeforeUpgrade) 'unedited older marked copy upgraded silently (no backup)'
Assert-That ([IO.File]::ReadAllText((Join-Path (Join-Path $skills1 'hermes-status') 'SKILL.md')).Contains('newer upstream line')) '...and now carries the newer source'
[IO.File]::WriteAllText($srcSkill, $srcOriginal)
$SrcDigest = Get-TreeDigest (Join-Path $Src 'skills')

# ===========================================================================
Write-Host "`n[2] install.ps1 -Ide cursor (.mdc overwrite protection)"
# ===========================================================================
$home2 = Join-Path $Tmp 'home2'
$rules2 = Join-Path (Join-Path $home2 '.cursor') 'rules'
New-Dir $rules2
Write-Text (Join-Path $rules2 'hermes-deploy.mdc') "---`ndescription: MY OWN RULE`n---`nuser written rule`n"
Write-Text (Join-Path $rules2 'team-style.mdc') 'unrelated team rule'
$userMdcBefore = Get-FileDigest (Join-Path $rules2 'hermes-deploy.mdc')
$teamBefore = Get-FileDigest (Join-Path $rules2 'team-style.mdc')
# pre-marker .mdc exactly as the old installer generated it: recognised as hstack's, replaced silently
$legacySrc = Join-Path (Join-Path (Join-Path $Src 'skills') 'hermes-restart') 'SKILL.md'
$oldLines = @(Get-Content -LiteralPath $legacySrc -Encoding UTF8)
$oldDesc = ($oldLines | Where-Object { $_ -match '^description:' } | Select-Object -First 1) -replace '^description:\s*', ''
$oldBody = @($oldLines | Where-Object { $_ -notmatch '^(name|description):' -and $_ -ne '---' })
Write-Text (Join-Path $rules2 'hermes-restart.mdc') ((@('---', "description: $oldDesc", 'globs:', 'alwaysApply: false', '---', '') + $oldBody) -join "`n")
$mdcTarget = Join-Path $Tmp 'linked-rule-target.mdc'
Write-Text $mdcTarget 'file behind an .mdc symlink'
$mdcLink = New-Link (Join-Path $rules2 'hermes-model.mdc') $mdcTarget

$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'cursor') @{ HOME = $home2; USERPROFILE = $home2 }
Assert-That ($r.Code -eq 0) "cursor install exits 0 (got $($r.Code))"
if ($r.Code -ne 0) { Write-Host $r.Output }
$missingMdc = @($SkillNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path $rules2 "$_.mdc")) })
Assert-That ($missingMdc.Count -eq 0) "all $($SkillNames.Count) skills written as .mdc"
$mdcBak = Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-deploy.mdc.hstack-backup-*' }
Assert-That ((@($mdcBak).Count -eq 1) -and ((Get-FileDigest $mdcBak[0].FullName) -eq $userMdcBefore)) 'user hermes-deploy.mdc backed up byte-for-byte'
$generated = [IO.File]::ReadAllText((Join-Path $rules2 'hermes-deploy.mdc'))
$sigRx = '^<!-- hstack-managed sig=(sha256:[0-9a-f]{64}) -->$'
$genLines = $generated -split "`n"
$markerLines = @($genLines | Where-Object { $_ -cmatch $sigRx })
Assert-That ($generated.StartsWith('---') -and ($markerLines.Count -eq 1) -and ($genLines[5] -cmatch $sigRx)) 'generated .mdc keeps frontmatter first and carries ONE sig marker line right after it'
$restText = (($genLines | Where-Object { $_ -cnotmatch $sigRx }) -join "`n")
$sha = [Security.Cryptography.SHA256]::Create()
$calc = 'sha256:' + ([BitConverter]::ToString($sha.ComputeHash($Utf8NoBom.GetBytes($restText))).Replace('-', '').ToLowerInvariant())
Assert-That ($calc -ceq ([regex]::Match($markerLines[0], $sigRx).Groups[1].Value)) 'the .mdc marker sig is the sha256 of the rest of the file (same spelling as the bash installer)'
Assert-That (-not (Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-restart*' })) 'legacy (pre-marker) generated .mdc replaced silently, no backup'
Assert-That ([IO.File]::ReadAllText((Join-Path $rules2 'hermes-restart.mdc')) -cmatch '(?m)^<!-- hstack-managed sig=sha256:[0-9a-f]{64} -->$') 'legacy .mdc was upgraded to a marked file'
Assert-That ($r.Output -match 'not managed by hstack') 'cursor warning says the entry is not managed by hstack'
Assert-That ((Get-FileDigest (Join-Path $rules2 'team-style.mdc')) -eq $teamBefore) 'unrelated user .mdc untouched'
if ($mdcLink) {
    Assert-That ([IO.File]::ReadAllText($mdcTarget) -eq 'file behind an .mdc symlink') 'symlink target of a user .mdc was not written through'
    Assert-That (-not (Test-IsLink (Join-Path $rules2 'hermes-model.mdc'))) 'symlinked hermes-model.mdc replaced by a regular generated file'
    Assert-That (@(Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-model.mdc.hstack-backup-*' }).Count -eq 1) 'the symlink itself was backed up'
} else { Skip-That 'cannot create symlinks here: .mdc symlink scenario' }

# a user-EDITED generated .mdc is not ours any more
$editMdc = Join-Path $rules2 'hermes-soul.mdc'
[IO.File]::AppendAllText($editMdc, "`nMY OWN RULE LINE`n")
$editedMdcText = [IO.File]::ReadAllText($editMdc)
$r5 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'cursor') @{ HOME = $home2; USERPROFILE = $home2 }
$eb = @(Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-soul.mdc.hstack-backup-*' })
Assert-That (($eb.Count -eq 1) -and ([IO.File]::ReadAllText($eb[0].FullName) -ceq $editedMdcText)) 'edited marked .mdc backed up adjacent with the edit intact'
Assert-That ($r5.Output.Contains($eb[0].FullName)) 'the warning prints the exact .mdc backup path'
Assert-That (-not [IO.File]::ReadAllText($editMdc).Contains('MY OWN RULE LINE')) '...and a clean .mdc was written'

# a look-alike marker line typed by the user is content, not a marker: it must read as an edit
$noteMdc = Join-Path $rules2 'hermes-cron.mdc'
[IO.File]::AppendAllText($noteMdc, "<!-- hstack-managed my note -->`n")
$noteText = [IO.File]::ReadAllText($noteMdc)
# and a duplicated well-formed marker line is an edit too
$dupMdc = Join-Path $rules2 'hermes-memory.mdc'
$dupMarker = @([IO.File]::ReadAllLines($dupMdc) | Where-Object { $_ -cmatch $sigRx })[0]
[IO.File]::AppendAllText($dupMdc, "$dupMarker`n")
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'cursor') @{ HOME = $home2; USERPROFILE = $home2 }
$nb = @(Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-cron.mdc.hstack-backup-*' })
Assert-That (($nb.Count -eq 1) -and ([IO.File]::ReadAllText($nb[0].FullName) -ceq $noteText)) 'a user-typed <!-- hstack-managed my note --> line does NOT make a .mdc look unmodified (backed up)'
Assert-That (@(Get-Backups $rules2 | Where-Object { $_.Name -like 'hermes-memory.mdc.hstack-backup-*' }).Count -eq 1) 'a duplicated marker line makes a .mdc count as edited (backed up)'

$mdcBackups = @(Get-Backups $rules2).Count
$mdcDigest = Get-TreeDigest $rules2
$r2 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'cursor') @{ HOME = $home2; USERPROFILE = $home2 }
Assert-That (@(Get-Backups $rules2).Count -eq $mdcBackups) 'cursor re-run creates no new backups (marked files overwritten in place)'
Assert-That ((Get-TreeDigest $rules2) -eq $mdcDigest) 'cursor re-run output identical'
Assert-That ($r2.Output -notmatch 'WARNING') 'cursor re-run emits no warnings'

# ===========================================================================
Write-Host "`n[3] install.ps1 -Ide gemini (context file overwrite protection)"
# ===========================================================================
$home3 = Join-Path $Tmp 'home3'
$ctx3 = Join-Path (Join-Path (Join-Path $home3 '.gemini') 'context') 'hstack'
New-Dir $ctx3
Write-Text (Join-Path $ctx3 'hermes-status.md') 'user context file'
Copy-Item -LiteralPath (Join-Path (Join-Path (Join-Path $Src 'skills') 'hermes-soul') 'SKILL.md') -Destination (Join-Path $ctx3 'hermes-soul.md')
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'gemini') @{ HOME = $home3; USERPROFILE = $home3 }
Assert-That ($r.Code -eq 0) 'gemini install exits 0'
Assert-That (@(Get-Backups $ctx3 | Where-Object { $_.Name -like 'hermes-status.md.hstack-backup-*' }).Count -eq 1) 'user hermes-status.md backed up'
Assert-That (-not (Get-Backups $ctx3 | Where-Object { $_.Name -like 'hermes-soul*' })) 'byte-identical legacy hermes-soul.md replaced silently, no backup'
Assert-That ([IO.File]::ReadAllText((Join-Path $ctx3 'hermes-soul.md')) -cmatch '(?m)^<!-- hstack-managed sig=sha256:[0-9a-f]{64} -->\n?$') 'gemini copies end with a sig marker line'
$gEdit = Join-Path $ctx3 'hermes-skills.md'
[IO.File]::AppendAllText($gEdit, "`nuser note`n")
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'gemini') @{ HOME = $home3; USERPROFILE = $home3 }
Assert-That (@(Get-Backups $ctx3 | Where-Object { $_.Name -like 'hermes-skills.md.hstack-backup-*' }).Count -eq 1) 'edited marked gemini .md backed up (not replaced silently)'
$gNote = Join-Path $ctx3 'hermes-install.md'
[IO.File]::AppendAllText($gNote, "<!-- hstack-managed my note -->`n")
$null = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'gemini') @{ HOME = $home3; USERPROFILE = $home3 }
Assert-That (@(Get-Backups $ctx3 | Where-Object { $_.Name -like 'hermes-install.md.hstack-backup-*' }).Count -eq 1) 'a user-typed look-alike marker line makes a gemini .md count as edited (backed up)'
$g1 = Get-TreeDigest $ctx3
$gb = @(Get-Backups $ctx3).Count
$r2 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'gemini') @{ HOME = $home3; USERPROFILE = $home3 }
Assert-That ((@(Get-Backups $ctx3).Count -eq $gb) -and ((Get-TreeDigest $ctx3) -eq $g1)) 'gemini re-run idempotent with no new backups'

# ===========================================================================
Write-Host "`n[4] setup.ps1 (skills + CLAUDE.md marker block)"
# ===========================================================================
$home4 = Join-Path $Tmp 'home4'
$skills4 = Join-Path (Join-Path $home4 '.claude') 'skills'
$md4 = Join-Path (Join-Path $home4 '.claude') 'CLAUDE.md'
New-Dir $skills4
Write-Text (Join-Path (Join-Path $skills4 'hermes-fix') 'USER.txt') 'user dir named like an hstack skill'
Write-Text (Join-Path (Join-Path $skills4 'my-own-skill') 'SKILL.md') 'user skill body'
$unrelated4 = Get-TreeDigest (Join-Path $skills4 'my-own-skill')
$envs4 = @{ HOME = $home4; USERPROFILE = $home4; CLAUDE_SKILLS_DIR = $skills4; CLAUDE_MD_PATH = $md4 }

# marker start WITHOUT end, CRLF + non-ASCII content: must stay byte-identical
$orphan = "# My global rules`r`ncaf$([char]0xE9) notes - keep me`r`n<!-- hstack:start -->`r`nhalf a block I was editing`r`nmore of my own text`r`n"
[IO.File]::WriteAllBytes($md4, $Utf8NoBom.GetBytes($orphan))
$orphanDigest = Get-FileDigest $md4

$r = Invoke-Child $SetupPs1 @() $envs4
Assert-That ($r.Code -eq 0) "setup exits 0 (got $($r.Code))"
if ($r.Code -ne 0) { Write-Host $r.Output }
$missing = @($SkillNames | Where-Object { -not (Test-Path -LiteralPath (Join-Path (Join-Path $skills4 $_) 'SKILL.md')) })
Assert-That ($missing.Count -eq 0) "setup registered all $($SkillNames.Count) skills"
$b = Get-DirBackups $skills4 | Where-Object { $_.Name -eq 'hermes-fix' }
Assert-That ((@($b).Count -eq 1) -and ([IO.File]::ReadAllText((Join-Path $b[0].FullName 'USER.txt')) -eq 'user dir named like an hstack skill')) 'setup backed up the user-owned hermes-fix dir'
Assert-That ((Get-TreeDigest (Join-Path $skills4 'my-own-skill')) -eq $unrelated4) 'setup left the unrelated user skill untouched'
Assert-That ((Get-FileDigest $md4) -eq $orphanDigest) 'instruction file with start marker but no end marker is byte-identical'
Assert-That (@(Get-Backups (Split-Path -Parent $md4) | Where-Object { $_.Name -like 'CLAUDE.md*' }).Count -eq 0) 'no backup churn when the file was left unchanged'
Assert-That ($r.Output -match 'WARNING') 'a warning explains why the instruction file was skipped'
Assert-That ((Get-TreeDigest (Join-Path $Src 'skills')) -eq $SrcDigest) 'setup did not modify the hstack source tree'

function Get-OwnershipBlock {
    param([string]$Path)
    $t = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
    $m = [regex]::Match($t, '(?s)# >>> hstack-ownership.*?# <<< hstack-ownership')
    return $m.Value
}
$blkA = Get-OwnershipBlock $InstallPs1
Assert-That (($blkA.Length -gt 0) -and ($blkA -ceq (Get-OwnershipBlock $SetupPs1))) 'ownership helper block is identical in install.ps1 and setup.ps1 (no drift)'

$skillBackups4 = @(Get-DirBackups $skills4).Count
$r2 = Invoke-Child $SetupPs1 @() $envs4
Assert-That (@(Get-DirBackups $skills4).Count -eq $skillBackups4) 'setup re-run creates no new skill backups'

# complete block surrounded by user text: replaced in place, rest preserved, backup written
$stale = "top text`r`n<!-- hstack:start -->`r`nOLD STALE CONTENT`r`n<!-- hstack:end -->`r`nbottom text caf$([char]0xE9)`r`n"
[IO.File]::WriteAllBytes($md4, $Utf8NoBom.GetBytes($stale))
$r = Invoke-Child $SetupPs1 @() $envs4
$after = [IO.File]::ReadAllText($md4)
Assert-That ($after.StartsWith("top text`r`n") -and $after.Contains("bottom text caf$([char]0xE9)")) 'text outside the hstack block preserved'
Assert-That ((-not $after.Contains('OLD STALE CONTENT')) -and $after.Contains('/hermes-deploy')) 'hstack block refreshed'
$mdBackups = @(Get-Backups (Split-Path -Parent $md4) | Where-Object { $_.Name -like 'CLAUDE.md.hstack-backup-*' })
Assert-That ((@($mdBackups).Count -eq 1) -and ([IO.File]::ReadAllText($mdBackups[0].FullName) -eq $stale)) 'pre-rewrite backup of the instruction file written'
$mdDigest = Get-FileDigest $md4
$r2 = Invoke-Child $SetupPs1 @() $envs4
Assert-That (((Get-FileDigest $md4) -eq $mdDigest) -and (@(Get-Backups (Split-Path -Parent $md4) | Where-Object { $_.Name -like 'CLAUDE.md*' }).Count -eq 1)) 'instruction file re-run: unchanged, no new backup'

# no instruction file yet: created
Remove-Item -LiteralPath $md4 -Force
$r = Invoke-Child $SetupPs1 @() $envs4
Assert-That ((Test-Path -LiteralPath $md4) -and ([IO.File]::ReadAllText($md4).Contains('<!-- hstack:end -->'))) 'missing instruction file is created with the block'

# a second malformed shape: LF file, start marker twice, only one end -> block collapsed, nothing outside lost
$lf = "keep A`n<!-- hstack:start -->`nold1`n<!-- hstack:end -->`nkeep B`n<!-- hstack:start -->`nold2`n<!-- hstack:end -->`nkeep C`n"
[IO.File]::WriteAllBytes($md4, $Utf8NoBom.GetBytes($lf))
$r = Invoke-Child $SetupPs1 @() $envs4
$after = [IO.File]::ReadAllText($md4)
Assert-That ($after.Contains('keep A') -and $after.Contains('keep B') -and $after.Contains('keep C') -and (-not $after.Contains('old1')) -and (-not $after.Contains('old2'))) 'duplicate hstack blocks collapse; all user lines kept'

# read-only instruction file: warn + skip, no backup, no 'Updated' message
$stale2 = "top`n<!-- hstack:start -->`nOLD STALE`n<!-- hstack:end -->`nbottom`n"
[IO.File]::WriteAllBytes($md4, $Utf8NoBom.GetBytes($stale2))
$roDigest = Get-FileDigest $md4
Set-ItemProperty -LiteralPath $md4 -Name IsReadOnly -Value $true
$bcount = @(Get-Backups (Split-Path -Parent $md4)).Count
$r = Invoke-Child $SetupPs1 @() $envs4
Set-ItemProperty -LiteralPath $md4 -Name IsReadOnly -Value $false
Assert-That ((Get-FileDigest $md4) -eq $roDigest) 'read-only instruction file left byte-identical'
Assert-That (@(Get-Backups (Split-Path -Parent $md4)).Count -eq $bcount) 'read-only instruction file: no backup written'
Assert-That (($r.Output -match 'read-only') -and ($r.Output -notmatch 'Updated hstack section')) 'read-only instruction file: warning, no "Updated" message'
Assert-That ($r.Code -eq 0) 'read-only instruction file does not fail the run'
$plain = "my notes only`n"
[IO.File]::WriteAllBytes($md4, $Utf8NoBom.GetBytes($plain))
Set-ItemProperty -LiteralPath $md4 -Name IsReadOnly -Value $true
$r = Invoke-Child $SetupPs1 @() $envs4
Set-ItemProperty -LiteralPath $md4 -Name IsReadOnly -Value $false
Assert-That (([IO.File]::ReadAllText($md4) -ceq $plain) -and ($r.Output -notmatch 'Added hstack section')) 'read-only file without a block: append skipped with a warning'

# ===========================================================================
Write-Host "`n[4b] destinations that resolve into the hstack source tree are never touched"
# ===========================================================================
$srcSkillsDir = Join-Path $Src 'skills'
$srcDigestBefore = Get-TreeDigest $srcSkillsDir
$srcRootDigestBefore = Get-TreeDigest $Src
$home6 = Join-Path $Tmp 'home6'
New-Dir $home6
# (a) override IS the source skills dir
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = $srcSkillsDir }
Assert-That ($r.Output -match 'Refusing') 'install: override that IS the source skills dir is refused with a warning'
Assert-That ((Get-TreeDigest $Src) -eq $srcRootDigestBefore) 'install: source tree byte-identical after a refused install (nothing added, deleted or moved)'
# (b) cursor/gemini override pointing into the source
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'cursor,gemini') @{ HOME = $home6; USERPROFILE = $home6; CURSOR_RULES_DIR = $srcSkillsDir; GEMINI_CONTEXT_DIR = (Join-Path $srcSkillsDir 'hermes-deploy') }
Assert-That ((Get-TreeDigest $Src) -eq $srcRootDigestBefore) 'install: cursor/gemini overrides into the source tree wrote nothing there'
# (c) relative override resolving into the source (cwd = temp root, 'src/skills')
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = 'src/skills' } '' $Tmp
Assert-That (($r.Output -match 'Refusing') -and ((Get-TreeDigest $Src) -eq $srcRootDigestBefore)) 'install: relative override that lands in the source tree is refused'
# (d) relative override is resolved against the CALLER cwd, not the checkout
$work = Join-Path $Tmp 'work'
New-Dir $work
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = 'out-skills' } '' $work
Assert-That (Test-Path -LiteralPath (Join-Path (Join-Path $work 'out-skills') 'hermes-deploy')) 'install: relative override resolves against the caller cwd'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $Src 'out-skills'))) 'install: ...and was NOT resolved inside the checkout'
Assert-That ((Get-TreeDigest $Src) -eq $srcRootDigestBefore) 'install: source tree untouched by the relative-override run'
# (e) override is a symlink to the source skills dir
$linkToSrc = Join-Path $Tmp 'link-to-src-skills'
if (New-Link $linkToSrc $srcSkillsDir) {
    $r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = $linkToSrc }
    Assert-That (($r.Output -match 'Refusing') -and ((Get-TreeDigest $Src) -eq $srcRootDigestBefore)) 'install: override that is a symlink to the source skills dir is refused'
    $r = Invoke-Child $SetupPs1 @() @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = $linkToSrc; CLAUDE_MD_PATH = (Join-Path $home6 'CLAUDE.md') }
    Assert-That (($r.Output -match 'Refusing') -and ((Get-TreeDigest $Src) -eq $srcRootDigestBefore)) 'setup: symlink-to-source target is refused, source untouched'
} else { Skip-That 'cannot create symlinks here: symlinked-override scenario' }
$r = Invoke-Child $SetupPs1 @() @{ HOME = $home6; USERPROFILE = $home6; CLAUDE_SKILLS_DIR = $srcSkillsDir; CLAUDE_MD_PATH = (Join-Path $home6 'CLAUDE.md') }
Assert-That (($r.Output -match 'Refusing') -and ((Get-TreeDigest $Src) -eq $srcRootDigestBefore)) 'setup: target that IS the source skills dir is refused, source untouched'
Assert-That ((Get-TreeDigest $srcSkillsDir) -eq $srcDigestBefore) 'source skills dir identical to the pre-test snapshot'

# ===========================================================================
Write-Host "`n[4c] a backup that cannot be made means the entry is left alone (CLI level)"
# ===========================================================================
function New-UserSkillHome {
    param([string]$Name)
    $h = Join-Path $Tmp $Name
    $sk = Join-Path (Join-Path $h '.claude') 'skills'
    Write-Text (Join-Path (Join-Path $sk 'hermes-deploy') 'USER-NOTES.txt') 'irreplaceable user notes'
    Write-Text (Join-Path (Join-Path (Join-Path $sk 'hermes-deploy') 'sub') 'deep.txt') 'deep user data'
    return $h
}
function Assert-UserDataIntact {
    param([string]$SkillsDir, [string]$Label)
    $d = Join-Path $SkillsDir 'hermes-deploy'
    Assert-That (([IO.File]::ReadAllText((Join-Path $d 'USER-NOTES.txt')) -eq 'irreplaceable user notes') -and ([IO.File]::ReadAllText((Join-Path (Join-Path $d 'sub') 'deep.txt')) -eq 'deep user data') -and (-not (Test-Path -LiteralPath (Join-Path $d 'SKILL.md'))) -and (@(Get-ChildItem -LiteralPath $d -Force).Count -eq 2)) "${Label}: user's hermes-deploy is byte-identical and was not written over (no extra entries)"
}

# (a) the backups location is occupied by a FILE
$home7 = New-UserSkillHome 'home7'
$skills7 = Join-Path (Join-Path $home7 '.claude') 'skills'
$blocker = Join-Path (Join-Path $home7 '.claude') '.hstack-backups'
Write-Text $blocker 'i am a file'
$env7 = @{ HOME = $home7; USERPROFILE = $home7 }
$r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') $env7
Assert-That ($r.Code -ne 0) "backups dir is a file: install exits non-zero (got $($r.Code))"
Assert-UserDataIntact $skills7 'backups dir is a file (install)'
Assert-That ($r.Output -match 'Left untouched') 'backups dir is a file: warning says the entry was left untouched'
Assert-That ([IO.File]::ReadAllText($blocker) -eq 'i am a file') 'backups dir is a file: the blocking file is intact'
Assert-That (Test-Path -LiteralPath (Join-Path (Join-Path $skills7 'hermes-fix') 'SKILL.md')) 'backups dir is a file: unrelated skills were still installed'
Assert-That (-not (Test-Path -LiteralPath (Join-Path (Join-Path $home7 '.claude') '.hstack-staging'))) 'backups dir is a file: no staging dir left behind'
$digest7 = Get-TreeDigest (Join-Path $skills7 'hermes-deploy')
$r2 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') $env7
Assert-That (($r2.Code -ne 0) -and ((Get-TreeDigest (Join-Path $skills7 'hermes-deploy')) -eq $digest7) -and ([IO.File]::ReadAllText($blocker) -eq 'i am a file')) 'a second run after the failed first run deletes nothing and still exits non-zero'
Remove-Item -LiteralPath $blocker -Force
$r3 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') $env7
$bk7 = @(Get-DirBackups $skills7 | Where-Object { $_.Name -eq 'hermes-deploy' })
Assert-That (($r3.Code -eq 0) -and ($bk7.Count -eq 1) -and ([IO.File]::ReadAllText((Join-Path $bk7[0].FullName 'USER-NOTES.txt')) -eq 'irreplaceable user notes')) 'once the blocker is gone the next run backs the user data up and succeeds'

# (b) setup.ps1 with the same blocker
$home8 = New-UserSkillHome 'home8'
$skills8 = Join-Path (Join-Path $home8 '.claude') 'skills'
Write-Text (Join-Path (Join-Path $home8 '.claude') '.hstack-backups') 'i am a file'
$r = Invoke-Child $SetupPs1 @() @{ HOME = $home8; USERPROFILE = $home8; CLAUDE_SKILLS_DIR = $skills8; CLAUDE_MD_PATH = (Join-Path (Join-Path $home8 '.claude') 'CLAUDE.md') }
Assert-That ($r.Code -ne 0) "setup: backups dir is a file: exits non-zero (got $($r.Code))"
Assert-UserDataIntact $skills8 'setup: backups dir is a file'
$r = Invoke-Child $SetupPs1 @() @{ HOME = $home8; USERPROFILE = $home8; CLAUDE_SKILLS_DIR = $skills8; CLAUDE_MD_PATH = (Join-Path (Join-Path $home8 '.claude') 'CLAUDE.md') }
Assert-That (($r.Code -ne 0) -and (Test-Path -LiteralPath (Join-Path (Join-Path $skills8 'hermes-deploy') 'USER-NOTES.txt'))) 'setup: a second run after the failed first run deletes nothing'

# (c) the backups location is a READ-ONLY directory (needs a non-root POSIX user)
$home9 = New-UserSkillHome 'home9'
$skills9 = Join-Path (Join-Path $home9 '.claude') 'skills'
$roDir = Join-Path (Join-Path $home9 '.claude') '.hstack-backups'
New-Dir $roDir
$roReason = $null
if ($IsWin) { $roReason = 'Windows: no chmod; directory ACL denial not exercised' }
else {
    & chmod 555 $roDir
    $probeWorked = $false
    try { [IO.File]::WriteAllText((Join-Path $roDir 'probe'), 'x'); $probeWorked = $true } catch { $probeWorked = $false }
    if ($probeWorked) {
        Remove-Item -LiteralPath (Join-Path $roDir 'probe') -Force
        $roReason = 'running as root: chmod 555 does not restrict writes (run the test as a non-root user, e.g. docker run --user 1000:1000)'
    }
}
if ($roReason) {
    if (-not $IsWin) { & chmod 755 $roDir }
    Skip-That "read-only backups dir scenario: $roReason"
} else {
    $r = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home9; USERPROFILE = $home9 }
    Assert-That ($r.Code -ne 0) "read-only backups dir: install exits non-zero (got $($r.Code))"
    Assert-UserDataIntact $skills9 'read-only backups dir'
    $d9 = Get-TreeDigest (Join-Path $skills9 'hermes-deploy')
    $r2 = Invoke-Child $InstallPs1 @('-Local', '-All', '-Ide', 'claude') @{ HOME = $home9; USERPROFILE = $home9 }
    Assert-That (($r2.Code -ne 0) -and ((Get-TreeDigest (Join-Path $skills9 'hermes-deploy')) -eq $d9)) 'read-only backups dir: a second run deletes nothing'
    $r = Invoke-Child $SetupPs1 @() @{ HOME = $home9; USERPROFILE = $home9; CLAUDE_SKILLS_DIR = $skills9; CLAUDE_MD_PATH = (Join-Path (Join-Path $home9 '.claude') 'CLAUDE.md') }
    Assert-That ($r.Code -ne 0) 'read-only backups dir: setup exits non-zero'
    Assert-UserDataIntact $skills9 'read-only backups dir (setup)'
    & chmod 755 $roDir
    # instruction file in a directory we cannot write to: no backup possible -> left byte-identical, non-zero exit
    $home10 = Join-Path $Tmp 'home10'
    $cd10 = Join-Path $home10 '.claude'
    New-Dir (Join-Path $cd10 'skills')
    $md10 = Join-Path $cd10 'CLAUDE.md'
    $stale10 = "mine`n<!-- hstack:start -->`nOLD`n<!-- hstack:end -->`nmore mine`n"
    [IO.File]::WriteAllBytes($md10, $Utf8NoBom.GetBytes($stale10))
    & chmod 555 $cd10
    $r = Invoke-Child $SetupPs1 @() @{ HOME = $home10; USERPROFILE = $home10; CLAUDE_SKILLS_DIR = (Join-Path $cd10 'skills'); CLAUDE_MD_PATH = $md10 }
    & chmod 755 $cd10
    Assert-That (([IO.File]::ReadAllText($md10) -ceq $stale10) -and ($r.Code -ne 0)) 'instruction file in an unwritable dir: byte-identical and the run exits non-zero'
    Assert-That (@(Get-ChildItem -LiteralPath $cd10 -Force | Where-Object { $_.Name -like '.hstack-write-*' -or $_.Name -like 'CLAUDE.md.hstack-backup-*' }).Count -eq 0) 'instruction file in an unwritable dir: no temp stub and no bogus backup left'
}

# ===========================================================================
Write-Host "`n[4d] failure injection against the helper block itself (in-process)"
# ===========================================================================
$blockText = ([regex]::Match(([IO.File]::ReadAllText($InstallPs1) -replace "`r`n", "`n"), '(?s)# >>> hstack-ownership.*?# <<< hstack-ownership')).Value
$instrText = ([regex]::Match(([IO.File]::ReadAllText($SetupPs1) -replace "`r`n", "`n"), '(?s)# >>> hstack-instruction-block.*?# <<< hstack-instruction-block')).Value
Invoke-Expression $blockText
Invoke-Expression $instrText
$u = Join-Path $Tmp 'unit'
$uSkills = Join-Path (Join-Path $u '.claude') 'skills'
$uSrcRoot = Join-Path $u 'fsrc'
$uSrcSkill = Join-Path (Join-Path $uSrcRoot 'skills') 's1'
Write-Text (Join-Path $uSrcSkill 'SKILL.md') 'skill body'
Write-Text (Join-Path $uSrcSkill 'a.txt') 'aaa'
New-Dir $uSkills
$script:HstackRoots = @((Join-Path $uSrcRoot 'skills'))
$script:HstackSourceTree = $uSrcRoot
$userDst = Join-Path $uSkills 's1'
Write-Text (Join-Path $userDst 'mine.txt') 'user data'
$userDigest = Get-TreeDigest $userDst

function Get-ResultString { param($Items) return (@($Items | Where-Object { $_ -is [string] }) | Select-Object -Last 1) }
function Get-Warnings { param($Items) return (@($Items | Where-Object { $_ -is [System.Management.Automation.WarningRecord] } | ForEach-Object { $_.Message }) -join "`n") }

# (a) copy dies halfway: nothing partial in the skills dir, user dir untouched, staging outside, cleaned up
$script:ShimCopyDest = $null
function Copy-Item {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Recurse)
    $script:ShimCopyDest = $Destination
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    [IO.File]::WriteAllText((Join-Path $Destination 'partial.txt'), 'half a copy')
    throw 'simulated mid-copy failure'
}
$script:HstackFailures = 0
$o = @(Install-HstackDir $uSrcSkill $userDst 3>&1)
Remove-Item Function:\Copy-Item
Assert-That ((Get-ResultString $o) -eq 'failed') 'mid-copy failure: Install-HstackDir reports failed'
Assert-That ((Get-TreeDigest $userDst) -eq $userDigest) 'mid-copy failure: the user dir is untouched'
Assert-That (@(Get-ChildItem -LiteralPath $uSkills -Force).Count -eq 1) 'mid-copy failure: nothing but the user dir is in the scanned skills dir'
Assert-That (($null -ne $script:ShimCopyDest) -and (-not (Test-HstackSameOrUnder $script:ShimCopyDest $uSkills))) 'mid-copy failure: the copy was staged OUTSIDE the scanned skills dir'
Assert-That (-not (Test-Path -LiteralPath (Join-Path (Join-Path $u '.claude') '.hstack-staging'))) 'mid-copy failure: the staging dir was cleaned up'
Assert-That ($script:HstackFailures -eq 1) 'mid-copy failure counted for the non-zero exit'

# (b) the final swap fails after the user dir was moved aside: it is put back
$script:ShimFailOnce = $userDst
function Move-Item {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Destination)
    if ($script:ShimFailOnce -and ($Destination -eq $script:ShimFailOnce)) { $script:ShimFailOnce = $null; throw 'simulated swap failure' }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
$script:HstackFailures = 0
$o = @(Install-HstackDir $uSrcSkill $userDst 3>&1)
Remove-Item Function:\Move-Item
Assert-That ((Get-ResultString $o) -eq 'failed') 'swap failure: Install-HstackDir reports failed'
Assert-That ((Get-TreeDigest $userDst) -eq $userDigest) 'swap failure: the user dir was restored byte-for-byte (not left half-replaced)'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $userDst 'SKILL.md'))) 'swap failure: no hstack content landed in the user dir'
Assert-That (-not (Test-Path -LiteralPath (Join-Path (Join-Path $u '.claude') '.hstack-staging'))) 'swap failure: the staging dir was cleaned up'

# (c) moving a FILE aside fails: it is not written over
$userFile = Join-Path $u 'rule.mdc'
Write-Text $userFile 'my own rule'
function Move-Item { [CmdletBinding()] param([string]$LiteralPath, [string]$Destination) throw 'simulated move failure' }
$script:HstackFailures = 0
$o = @(Clear-HstackDst $userFile -RefText @('something else') 3>&1)
Remove-Item Function:\Move-Item
Assert-That ((Get-ResultString $o) -eq 'failed') 'file move-aside failure: Clear-HstackDst reports failed'
Assert-That ([IO.File]::ReadAllText($userFile) -eq 'my own rule') 'file move-aside failure: the user file is untouched'
Assert-That (-not (Write-HstackFileSafe $userFile ([byte[]](65, 66)))) 'file move-aside failure: Write-HstackFileSafe refuses an occupied destination'
Assert-That (([IO.File]::ReadAllText($userFile) -eq 'my own rule') -and ($script:HstackFailures -ge 2)) 'file move-aside failure: still untouched, failures counted'

# (d) the pre-rewrite backup of an instruction file cannot be written: the file is not rewritten
$ins = Join-Path $u 'CLAUDE.md'
$insText = "top`n<!-- hstack:start -->`nOLD`n<!-- hstack:end -->`nbottom`n"
[IO.File]::WriteAllBytes($ins, $Utf8NoBom.GetBytes($insText))
function Copy-Item { [CmdletBinding()] param([string]$LiteralPath, [string]$Destination) throw 'simulated backup failure' }
$script:HstackFailures = 0
$o = @(Update-HstackMarkerBlock $ins '<!-- hstack:start -->' '<!-- hstack:end -->' "<!-- hstack:start -->`nNEW`n<!-- hstack:end -->" 3>&1)
Remove-Item Function:\Copy-Item
Assert-That ((Get-ResultString $o) -eq 'skipped') 'instruction backup failure: reported as skipped'
Assert-That ([IO.File]::ReadAllText($ins) -ceq $insText) 'instruction backup failure: the file is byte-identical (never rewritten without a backup)'
Assert-That ($script:HstackFailures -eq 1) 'instruction backup failure counted for the non-zero exit'

# (e) the swap fails AFTER the temp file was completely written: original identical, backup kept
function Get-Stubs { param([string]$Dir) return @(Get-ChildItem -LiteralPath $Dir -Force | Where-Object { $_.Name -like '.hstack-write-*' }) }
$ins2 = Join-Path $u 'AGENTS.md'
$ins2Text = "top`n<!-- hstack:start -->`nOLD`n<!-- hstack:end -->`nbottom`n"
$newSec = "<!-- hstack:start -->`nNEW`n<!-- hstack:end -->"
[IO.File]::WriteAllBytes($ins2, $Utf8NoBom.GetBytes($ins2Text))
$origReplace = ${function:Invoke-HstackReplaceFile}
function Invoke-HstackReplaceFile { param($Tmp, $Path) throw 'simulated swap failure' }
$script:HstackFailures = 0
$o = @(Update-HstackMarkerBlock $ins2 '<!-- hstack:start -->' '<!-- hstack:end -->' $newSec 3>&1)
${function:Invoke-HstackReplaceFile} = $origReplace
$bakE = @(Get-Backups $u | Where-Object { $_.Name -like 'AGENTS.md.hstack-backup-*' })
Assert-That ((Get-ResultString $o) -eq 'failed') 'failed swap: reported honestly as failed (not "Updated")'
Assert-That ([IO.File]::ReadAllText($ins2) -ceq $ins2Text) 'failed swap: the original is byte-identical'
Assert-That (($bakE.Count -eq 1) -and ([IO.File]::ReadAllText($bakE[0].FullName) -ceq $ins2Text)) 'failed swap: the backup is KEPT and intact'
Assert-That ((Get-Warnings $o).Contains($bakE[0].FullName)) 'failed swap: the warning prints the exact backup path'
Assert-That ((Get-Stubs $u).Count -eq 0) 'failed swap: the temp stub was removed'
Assert-That ($script:HstackFailures -eq 1) 'failed swap counted for the non-zero exit'

# (f) the temp write itself dies halfway (disk full style)
$ins3 = Join-Path $u 'GEMINI.md'
[IO.File]::WriteAllBytes($ins3, $Utf8NoBom.GetBytes($ins2Text))
$origTemp = ${function:Write-HstackTempFile}
function Write-HstackTempFile { param($Tmp, [byte[]]$Bytes) [IO.File]::WriteAllBytes($Tmp, $Bytes[0..([int]($Bytes.Length / 2))]); throw 'simulated: no space left on device' }
$script:HstackFailures = 0
$o = @(Update-HstackMarkerBlock $ins3 '<!-- hstack:start -->' '<!-- hstack:end -->' $newSec 3>&1)
${function:Write-HstackTempFile} = $origTemp
$bakF = @(Get-Backups $u | Where-Object { $_.Name -like 'GEMINI.md.hstack-backup-*' })
Assert-That (((Get-ResultString $o) -eq 'failed') -and ([IO.File]::ReadAllText($ins3) -ceq $ins2Text)) 'partial temp write: reported failed, original byte-identical'
Assert-That (($bakF.Count -eq 1) -and ((Get-Warnings $o).Contains($bakF[0].FullName)) -and ((Get-Stubs $u).Count -eq 0)) 'partial temp write: backup kept and printed, partial stub removed'

# (g) the append path (no block yet) fails: untouched, no stub
$ins4 = Join-Path $u 'plain.md'
[IO.File]::WriteAllBytes($ins4, $Utf8NoBom.GetBytes("only my notes`n"))
function Invoke-HstackReplaceFile { param($Tmp, $Path) throw 'simulated swap failure' }
$o = @(Update-HstackMarkerBlock $ins4 '<!-- hstack:start -->' '<!-- hstack:end -->' $newSec 3>&1)
${function:Invoke-HstackReplaceFile} = $origReplace
Assert-That (((Get-ResultString $o) -eq 'failed') -and ([IO.File]::ReadAllText($ins4) -ceq "only my notes`n") -and ((Get-Stubs $u).Count -eq 0)) 'append path failure: reported failed, file byte-identical, no stub'

# (h) the success path: updated, no stub, permission bits preserved (POSIX)
$ins5 = Join-Path $u 'mode.md'
[IO.File]::WriteAllBytes($ins5, $Utf8NoBom.GetBytes($ins2Text))
$haveMode = (-not $IsWin) -and ('System.IO.UnixFileMode' -as [type])
if ($haveMode) { & chmod 640 $ins5 }
$o = @(Update-HstackMarkerBlock $ins5 '<!-- hstack:start -->' '<!-- hstack:end -->' $newSec 3>&1)
Assert-That (((Get-ResultString $o) -eq 'updated') -and ([IO.File]::ReadAllText($ins5).Contains('NEW')) -and ((Get-Stubs $u).Count -eq 0)) 'success path: block rewritten through the temp file, no stub left'
if ($haveMode) { Assert-That (([int](Get-Item -LiteralPath $ins5).UnixFileMode) -eq 416) 'success path: file permission bits preserved' } else { Skip-That 'permission-bit preservation: needs a POSIX host with .NET 7+' }

# (i) a symlinked instruction file is written through; the link stays a link
$realMd = Join-Path $u 'real-claude.md'
[IO.File]::WriteAllBytes($realMd, $Utf8NoBom.GetBytes($ins2Text))
$linkMd = Join-Path $u 'link-claude.md'
if (New-Link $linkMd $realMd) {
    $o = @(Update-HstackMarkerBlock $linkMd '<!-- hstack:start -->' '<!-- hstack:end -->' $newSec 3>&1)
    Assert-That ((Test-IsLink $linkMd) -and ([IO.File]::ReadAllText($realMd).Contains('NEW'))) 'symlinked instruction file: the link survives and its target is updated'
} else { Skip-That 'cannot create symlinks here: symlinked instruction file scenario' }

# (j) writing a generated file fails after the user's original was moved aside: original copied back, backup kept
$ruleDir = Join-Path $u 'rules'
New-Dir $ruleDir
$ruleFile = Join-Path $ruleDir 'x.mdc'
Write-Text $ruleFile 'my own rule'
$script:HstackFailures = 0
$c = Clear-HstackDst $ruleFile -RefText @('different')
$bakJ = $script:HstackLastBackup
function Write-HstackTempFile { param($Tmp, [byte[]]$Bytes) [IO.File]::WriteAllBytes($Tmp, $Bytes[0..1]); throw 'simulated: no space left on device' }
$o = @(Write-HstackFileSafe $ruleFile ([byte[]](65, 66, 67, 68)) 3>&1)
${function:Write-HstackTempFile} = $origTemp
Assert-That (($c -eq 'backed-up') -and ((Read-TextOrNull $ruleFile) -eq 'my own rule') -and ((Read-TextOrNull $bakJ) -eq 'my own rule')) 'failed generated-file write: the user rule is back in place AND the backup is kept'
Assert-That (((Get-Warnings $o).Contains($bakJ)) -and ((Get-Stubs $ruleDir).Count -eq 0) -and ($script:HstackFailures -ge 1)) 'failed generated-file write: backup path printed, no partial stub, failure counted'

# ===========================================================================
Write-Host "`n[5] install.ps1 -Pick numbers and tier membership"
# ===========================================================================
$home5 = Join-Path $Tmp 'home5'
New-Dir $home5
$skills5 = Join-Path (Join-Path $home5 '.claude') 'skills'
$r = Invoke-Child $InstallPs1 @('-Local', '-Pick', '-Ide', 'claude') @{ HOME = $home5; USERPROFILE = $home5 } "2,3`n"
Assert-That ($r.Code -eq 0) '-Pick with "2,3" exits 0'
Assert-That ((Test-Path -LiteralPath (Join-Path $skills5 'integration-mem0')) -and (Test-Path -LiteralPath (Join-Path $skills5 'integration-postgres'))) 'menu numbers 2,3 select the memory and database tiers'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $skills5 'integration-stripe'))) 'unselected tiers are not installed'
$home5b = Join-Path $Tmp 'home5b'
New-Dir $home5b
$r = Invoke-Child $InstallPs1 @('-Local', '-Pick', '-Ide', 'claude') @{ HOME = $home5b; USERPROFILE = $home5b } "1`n"
Assert-That (@(Get-ChildItem -LiteralPath (Join-Path (Join-Path $home5b '.claude') 'skills') -Directory).Count -eq $SkillNames.Count) 'menu number 1 selects everything'
$home5c = Join-Path $Tmp 'home5c'
New-Dir $home5c
$r = Invoke-Child $InstallPs1 @('-Local', '-Pick', '-Ide', 'claude') @{ HOME = $home5c; USERPROFILE = $home5c } "99,search`n"
Assert-That (($r.Output -match 'unknown menu number') -and (Test-Path -LiteralPath (Join-Path (Join-Path (Join-Path $home5c '.claude') 'skills') 'integration-exa'))) 'out-of-range menu number warns; named tier still installs'

# Tier membership vs the bash installer's fixture (generated from the original install.sh)
$fixturePath = Join-Path (Join-Path (Join-Path (Join-Path $RepoRoot 'tests') 'installer') 'fixtures') 'tiers.expected'
if (Test-Path -LiteralPath $fixturePath) {
    $fx = @{}
    $cur = $null
    foreach ($line in [IO.File]::ReadAllLines($fixturePath)) {
        if ($line.StartsWith('== ')) { $cur = $line.Substring(3); $fx[$cur] = New-Object System.Collections.Generic.List[string] }
        elseif ($cur -and $line.Trim()) { $fx[$cur].Add($line.Trim()) }
    }
    # static: parse the $Tiers table out of install.ps1
    $ps1Text = [IO.File]::ReadAllText($InstallPs1)
    $tb = [regex]::Match($ps1Text, '(?s)\$Tiers = @\{(.*?)\r?\n\}').Groups[1].Value
    $psTiers = @{}
    foreach ($m in [regex]::Matches($tb, "(?m)^\s*'?([A-Za-z0-9-]+)'?\s*=\s*@\((.*)\)\s*$")) {
        $psTiers[$m.Groups[1].Value] = @([regex]::Matches($m.Groups[2].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    }
    $bad = @()
    foreach ($t in $psTiers.Keys) {
        $label = "--tier=$t"
        if (-not $fx.ContainsKey($label)) { $bad += "$t (no fixture)"; continue }
        $expected = (@($fx[$label]) | Sort-Object) -join ','
        $actual = ((@($psTiers['core']) + @($psTiers['platforms']) + @($psTiers[$t])) | Sort-Object -Unique) -join ','
        if ($expected -ne $actual) { $bad += $t }
    }
    Assert-That ($bad.Count -eq 0) "install.ps1 tier table matches install.sh for all $($psTiers.Count) tiers (mismatches: $($bad -join ', '))"
    # dynamic: real runs against the fixture
    $cases = @(
        @{ Label = '--all'; Args = @('-All') },
        @{ Label = '--tier=memory,database'; Args = @('-Tier', 'memory,database') },
        @{ Label = '--include=notion,stripe,mem0,hermes-deploy,nope'; Args = @('-Include', 'notion,stripe,mem0,hermes-deploy,nope') }
    )
    $ci = 0
    foreach ($c in $cases) {
        $ci++
        $hx = Join-Path $Tmp "homeT$ci"
        New-Dir $hx
        $out = Join-Path $Tmp "outT$ci"
        $r = Invoke-Child $InstallPs1 (@('-Local', '-Ide', 'claude') + $c.Args) @{ HOME = $hx; USERPROFILE = $hx; CLAUDE_SKILLS_DIR = $out }
        $got = (@(Get-ChildItem -LiteralPath $out -Directory | ForEach-Object { $_.Name }) | Sort-Object) -join ','
        $want = (@($fx[$c.Label]) | Sort-Object) -join ','
        Assert-That ($got -eq $want) "install.ps1 $($c.Args -join ' ') installs the same set as install.sh $($c.Label)"
    }
} else { Skip-That 'tests/installer/fixtures/tiers.expected missing: tier parity not checked' }

# ===========================================================================
Write-Host "`nWindows-only behaviour (junctions, Developer Mode symlinks, ACLs, 5.1 parsing) is NOT proven by this run."
Write-Host ("Result: {0} passed, {1} failed, {2} skipped" -f $script:Passes, $script:Failures, $script:Skips)

} finally {
    Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Failures -gt 0) { exit 1 }
exit 0
