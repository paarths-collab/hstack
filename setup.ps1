# hstack setup (Windows / PowerShell). Registers the hstack skills with Claude Code.
# Note: Hermes itself has no native Windows support - deploy targets should be Linux/WSL2/VPS.
# This only installs the Claude Code skills locally. Safe to re-run.
#
# Safety: setup never deletes anything it did not create. It replaces only
# hstack-owned entries (a link into this checkout, or a copy carrying a
# .hstack-managed marker). Any other same-named skill is moved to
# <name>.hstack-backup-<yyyyMMddHHmmss>. The CLAUDE.md edit is limited to the
# hstack marker block and is skipped (with a warning) if the block is malformed.
$ErrorActionPreference = "Stop"

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

# >>> hstack-instruction-block (mirrors hs_write_block in setup / setup-codex / setup-gemini / setup-openclaw)
#
# Update-HstackMarkerBlock <file> <start-marker> <end-marker> <section>
# Replaces the marked section in place, or appends it. Never truncates: if a start marker
# line has no matching end marker line the file is left untouched and a warning is printed.
# Before any in-place rewrite a backup copy "<file>.hstack-backup-<stamp>" is written; no
# write and no backup when nothing changes. Works on raw bytes (Latin-1 round trip), so
# encoding, BOM and line endings outside the block are preserved exactly.
# Returns 'created', 'added', 'updated', 'unchanged', 'skipped' or 'failed'. The new bytes are
# written to a temp file and swapped in atomically; the file is never truncated in place.
function Test-HstackWritable {
    param([string]$Path)
    $item = Get-HstackItem $Path
    if ($null -eq $item) { return $false }
    if ($item.IsReadOnly) { return $false }
    try {
        $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $fs.Dispose()
        return $true
    } catch { return $false }
}

function Update-HstackMarkerBlock {
    param([string]$Path, [string]$Start, [string]$End, [string]$Section)
    $latin1 = [Text.Encoding]::GetEncoding(28591)
    if (-not (Test-HstackExists $Path)) {
        # nothing of the user's to lose: write via a temp file anyway so no partial stub is left
        $tmpNew = New-HstackTempPath $Path
        try {
            Write-HstackTempFile $tmpNew ($latin1.GetBytes(($Section -replace "`r?`n", "`n") + "`n"))
            Move-Item -LiteralPath $tmpNew -Destination $Path -ErrorAction Stop
        } catch {
            try { if ([IO.File]::Exists($tmpNew)) { [IO.File]::Delete($tmpNew) } } catch { Write-Verbose "temp cleanup: $($_.Exception.Message)" }
            Write-Warning "Could not create ${Path}: $($_.Exception.Message)"
            Add-HstackFailure
            return 'failed'
        }
        return 'created'
    }
    if (-not [IO.File]::Exists($Path)) {
        Write-Warning "$Path is not a readable file - left unchanged."
        return 'skipped'
    }
    $bytes = [IO.File]::ReadAllBytes($Path)
    $text = $latin1.GetString($bytes)
    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $cr = if ($eol -eq "`r`n") { "`r" } else { "" }
    $lines = $text.Split([char]10)
    $bom = [string][char]0xEF + [char]0xBB + [char]0xBF
    $hasStart = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $t = $lines[$i].TrimEnd("`r")
        if ($i -eq 0 -and $t.StartsWith($bom)) { $t = $t.Substring(3) }
        if ($t -ceq $Start) { $hasStart = $true; break }
    }
    if (-not $hasStart) {
        if (-not (Test-HstackWritable $Path)) {
            Write-Warning "$Path is read-only - left unchanged (no backup written). Make it writable, or add the hstack section by hand."
            return 'skipped'
        }
        $add = ""
        if ($bytes.Length -gt 0) {
            if (-not $text.EndsWith("`n")) { $add += $eol }
            $add += $eol
        }
        $add += (($Section -replace "`r?`n", $eol)) + $eol
        $err = Write-HstackUserFile $Path ($bytes + $latin1.GetBytes($add))
        if ($err) {
            Write-Warning "Could not update ${Path}: $err. The file was left unchanged."
            Add-HstackFailure
            return 'failed'
        }
        return 'added'
    }
    $out = New-Object System.Collections.Generic.List[string]
    $skip = $false
    $done = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $t = $line.TrimEnd("`r")
        if ($i -eq 0 -and $t.StartsWith($bom)) { $t = $t.Substring(3) }
        if ((-not $skip) -and $t -ceq $Start) {
            if (-not $done) {
                $lead = ""
                if ($i -eq 0 -and $line.StartsWith($bom)) { $lead = $bom }
                foreach ($sl in ($Section -split "`r?`n")) { $out.Add($lead + $sl + $cr); $lead = "" }
                $done = $true
            }
            $skip = $true
            continue
        }
        if ($skip) {
            if ($t -ceq $End) { $skip = $false }
            continue
        }
        $out.Add($line)
    }
    if ($skip) {
        Write-Warning "$Path has '$Start' but no matching '$End' - left unchanged. Add the end marker (or remove the start marker) and re-run."
        return 'skipped'
    }
    $new = $out -join "`n"
    if ($new -ceq $text) { return 'unchanged' }
    if (-not (Test-HstackWritable $Path)) {
        Write-Warning "$Path is read-only - left unchanged (no backup written). Make it writable, or update the hstack section by hand."
        return 'skipped'
    }
    $bak = Get-HstackBackupPath $Path
    try {
        Copy-Item -LiteralPath $Path -Destination $bak -ErrorAction Stop
        if (-not [IO.File]::Exists($bak)) { throw "backup file was not created" }
    } catch {
        Write-Warning "Could not back up $Path ($($_.Exception.Message)); left unchanged."
        Add-HstackFailure
        return 'skipped'
    }
    $err = Write-HstackUserFile $Path ($latin1.GetBytes($new))
    if ($err) {
        Write-Warning "Could not update ${Path}: $err. The file was left unchanged; your backup is KEPT at $bak"
        Add-HstackFailure
        return 'failed'
    }
    Write-Host "  backup : $bak"
    return 'updated'
}
# <<< hstack-instruction-block

$HstackDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UserHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$SkillsSrc = Join-Path $HstackDir "skills"
$script:HstackRoots = @($SkillsSrc, (Join-Path (Join-Path $UserHome ".hstack") "skills"))
$script:HstackSourceTree = $HstackDir
$ClawSkills = if ($env:CLAUDE_SKILLS_DIR) { Resolve-HstackAbs $env:CLAUDE_SKILLS_DIR } else { Join-Path (Join-Path $UserHome ".claude") "skills" }

Write-Host "hstack setup"
Write-Host "  source : $SkillsSrc"
Write-Host "  target : $ClawSkills`n"

if (-not (Test-Path $SkillsSrc)) { throw "skills/ not found - run setup.ps1 from inside the hstack repo." }
$targetOk = Test-HstackTargetOk $ClawSkills
if (-not $targetOk) { Write-Host "Skipped skill registration (see warning above)." }
if ($targetOk) { New-Item -ItemType Directory -Force -Path $ClawSkills | Out-Null }

$count = 0
foreach ($dir in Get-ChildItem -Directory $SkillsSrc) {
  if (-not $targetOk) { break }
  if (-not (Test-Path (Join-Path $dir.FullName "SKILL.md"))) { continue }
  $link = Join-Path $ClawSkills $dir.Name
  $res = Clear-HstackDst $link $dir.FullName -BackupOutside
  if (($res -eq 'refused') -or ($res -eq 'failed')) { continue }
  if (Test-HstackExists $link) { Write-Warning "$link is still occupied; not installing over it."; Add-HstackFailure; continue }
  try { New-Item -ItemType SymbolicLink -Path $link -Target $dir.FullName -ErrorAction Stop | Out-Null }
  catch {
    # symlink needs dev mode; fall back to a marked copy, staged outside the scanned dir
    $null = Install-HstackDir $dir.FullName $link
    if (-not (Test-HstackExists $link)) { Restore-HstackBackup $link; continue }
  }
  $count++
}
Write-Host "Registered $count skills."

$ClaudeMd = if ($env:CLAUDE_MD_PATH) { Resolve-HstackAbs $env:CLAUDE_MD_PATH } else { Join-Path (Join-Path $UserHome ".claude") "CLAUDE.md" }
$markStart = "<!-- hstack:start -->"; $markEnd = "<!-- hstack:end -->"
$section = @"
$markStart
## hstack - self-hosted Hermes Agent deploy

One command to deploy and operate a self-hosted Hermes Agent. Run /hermes-deploy for the full
setup. Setup: /hermes-install /hermes-model /hermes-skills /hermes-memory /hermes-soul /hermes-home
/hermes-cron. Platforms: /platform-telegram /platform-discord /platform-whatsapp /platform-slack
/platform-mattermost /platform-teams /platform-google-chat /platform-signal.
Ops: /hermes-status /hermes-restart /hermes-update /hermes-fix /hermes-backup.
Enforce allowlists and keep secrets in .env with chmod 600.
Target: Hermes v0.22.5 (source-verified; vendor and live gateway validation remain pending).
Use the native catalog/MCP or installed skill route documented for each integration. Reload with
/hermes-restart: default profile, guarded restart, readiness and new-instance proof; interrupt chats only with explicit consent.
$markEnd
"@

New-Item -ItemType Directory -Force -Path (Split-Path $ClaudeMd) | Out-Null
$status = Update-HstackMarkerBlock $ClaudeMd $markStart $markEnd $section
switch ($status) {
  'created'   { Write-Host "Created $ClaudeMd with the hstack section" }
  'added'     { Write-Host "Added hstack section to $ClaudeMd" }
  'updated'   { Write-Host "Updated hstack section in $ClaudeMd" }
  'unchanged' { Write-Host "hstack section in $ClaudeMd already up to date" }
  'failed'    { Write-Host "Could not update $ClaudeMd (see warning above); it was left unchanged." }
  default     { Write-Host "Skipped $ClaudeMd (see warning above); skills were still registered." }
}
Write-Host "`nDone. In Claude Code, run:  /hermes-deploy"
if ($script:HstackFailures -gt 0) {
  Write-Warning "$($script:HstackFailures) entries could not be installed and were left untouched (see the warnings above). Exiting with an error."
  exit 1
}
