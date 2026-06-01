# hstack setup (Windows / PowerShell). Registers the hstack skills with Claude Code.
# Note: Hermes itself has no native Windows support — deploy targets should be Linux/WSL2/VPS.
# This only installs the Claude Code skills locally. Safe to re-run.
$ErrorActionPreference = "Stop"

$HstackDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillsSrc = Join-Path $HstackDir "skills"
$ClawSkills = if ($env:CLAUDE_SKILLS_DIR) { $env:CLAUDE_SKILLS_DIR } else { Join-Path $env:USERPROFILE ".claude\skills" }

Write-Host "hstack setup"
Write-Host "  source : $SkillsSrc"
Write-Host "  target : $ClawSkills`n"

if (-not (Test-Path $SkillsSrc)) { throw "skills/ not found - run setup.ps1 from inside the hstack repo." }
New-Item -ItemType Directory -Force -Path $ClawSkills | Out-Null

$count = 0
foreach ($dir in Get-ChildItem -Directory $SkillsSrc) {
  if (-not (Test-Path (Join-Path $dir.FullName "SKILL.md"))) { continue }
  $link = Join-Path $ClawSkills $dir.Name
  if (Test-Path $link) { Remove-Item -Recurse -Force $link }
  try { New-Item -ItemType SymbolicLink -Path $link -Target $dir.FullName -ErrorAction Stop | Out-Null }
  catch { Copy-Item -Recurse -Force $dir.FullName $link }   # symlink needs dev mode; fall back to copy
  $count++
}
Write-Host "Registered $count skills."

$ClaudeMd = if ($env:CLAUDE_MD_PATH) { $env:CLAUDE_MD_PATH } else { Join-Path $env:USERPROFILE ".claude\CLAUDE.md" }
$markStart = "<!-- hstack:start -->"; $markEnd = "<!-- hstack:end -->"
$section = @"
$markStart
## hstack - self-hosted Hermes Agent deploy

One command to deploy and operate a self-hosted Hermes Agent. Run /hermes-deploy for the full
setup. Setup: /hermes-install /hermes-model /hermes-skills /hermes-memory /hermes-soul /hermes-home
/hermes-cron. Platforms: /platform-telegram /platform-discord /platform-whatsapp /platform-slack
/platform-mattermost. Ops: /hermes-status /hermes-restart /hermes-update /hermes-fix /hermes-backup.
Pin Hermes v0.15.2; enforce allowlists and keep secrets in .env with chmod 600.
$markEnd
"@

New-Item -ItemType Directory -Force -Path (Split-Path $ClaudeMd) | Out-Null
if (-not (Test-Path $ClaudeMd)) { New-Item -ItemType File $ClaudeMd | Out-Null }
$content = Get-Content $ClaudeMd -Raw -ErrorAction SilentlyContinue
if ($content -match [regex]::Escape($markStart)) {
  $pattern = "(?s)" + [regex]::Escape($markStart) + ".*?" + [regex]::Escape($markEnd)
  ($content -replace $pattern, $section).TrimEnd() | Set-Content $ClaudeMd
  Write-Host "Updated hstack section in $ClaudeMd"
} else {
  Add-Content $ClaudeMd "`n$section"
  Write-Host "Added hstack section to $ClaudeMd"
}
Write-Host "`nDone. In Claude Code, run:  /hermes-deploy"
