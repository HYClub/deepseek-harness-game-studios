# publish.ps1 — put DSGS on a remote, in one command, without committing anything by surprise.
#
# The studio's own protocol (CLAUDE.md) says "No commits without user instruction", so this script
# PRINTS the plan by default and only touches git when you pass -Confirm. Everything it would do is
# reversible: the plugin repo is generated under dist/ (gitignored), and the main repo's first
# commit is `git update-ref -d HEAD` away.
#
#   pwsh -File tools/publish.ps1 -PluginRepoUrl <url> -MainRepoUrl <url>              # dry run
#   pwsh -File tools/publish.ps1 -PluginRepoUrl <url> -MainRepoUrl <url> -Confirm     # do it
#
# @module tools/publish.ps1

[CmdletBinding()]
param(
  [string]$PluginRepoUrl = '',
  [string]$MainRepoUrl = '',
  [string]$Tag = 'v0.1.0',
  [string]$GitUserName = 'DeepSeek Game Studios',
  [string]$GitUserEmail = 'DSGS@example.invalid',
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$plugin = Join-Path $root 'dist/dsgs-hooks'
$bundle = Join-Path $root 'dist/dsgs-hooks.bundle'

function Show-Step([string]$title) { Write-Host "`n=== $title ===" -ForegroundColor Cyan }
function Show-Cmd([string]$line) { Write-Host "  $line" -ForegroundColor Yellow }
function Run([string]$file, [string[]]$arguments, [string]$workdir) {
  Write-Host "  > $file $($arguments -join ' ')" -ForegroundColor DarkGray
  & $file @arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "$file $($arguments -join ' ') failed with exit $LASTEXITCODE" }
}

Show-Step '0. Preconditions'
Write-Host "  plugin repo : $plugin"
Write-Host "  bundle      : $bundle"
Write-Host "  mode        : $(if ($Confirm) { 'CONFIRM — git will be modified' } else { 'DRY RUN — nothing will change' })"

$ignore = Join-Path $root '.gitignore'
if (Test-Path $ignore) {
  $text = Get-Content $ignore -Raw
  foreach ($needed in 'dist/', '.smoke/', '.verify-logs/', '_external/', '.local-backups/') {
    if ($text -notmatch [regex]::Escape($needed)) {
      Write-Host "  WARNING: .gitignore does not list $needed — it would be pushed" -ForegroundColor Red
    }
  }
}

Show-Step '1. Build the plugin repository (regenerates dist/dsgs-hooks)'
Run 'node' @('tools/build-plugin-repo.mjs') $root
Run 'node' @('dist/dsgs-hooks/test/plugin.test.mjs') $root

Show-Step '2. Plugin repository: remote and push'
$hasRemote = $false
try { $hasRemote = [bool](& git -C $plugin remote 2>$null) } catch { $hasRemote = $false }
if ([string]::IsNullOrWhiteSpace($PluginRepoUrl)) {
  Write-Host '  no -PluginRepoUrl given; commands you would run:' -ForegroundColor DarkYellow
  Show-Cmd "git -C `"$plugin`" remote add origin <plugin-repo-url>"
  Show-Cmd "git -C `"$plugin`" push -u origin main --tags"
} else {
  Show-Cmd "git -C `"$plugin`" remote add origin $PluginRepoUrl"
  Show-Cmd "git -C `"$plugin`" push -u origin main --tags"
  if ($Confirm) {
    if (-not $hasRemote) { Run 'git' @('-C', $plugin, 'remote', 'add', 'origin', $PluginRepoUrl) $root }
    Run 'git' @('-C', $plugin, 'push', '-u', 'origin', 'main', '--tags') $root
  }
}

Show-Step '3. Main repository: first commit, remote, push'
$status = & git -C $root status --porcelain 2>$null
$commits = (& git -C $root rev-list --count HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($commits)) { $commits = '0' }
Write-Host "  working tree: $((($status | Measure-Object).Count)) path(s) reported by git status"
Write-Host "  commits so far: $commits"
Show-Cmd 'git add -A'
Show-Cmd "git -c user.name=... -c user.email=... commit -m `"DeepSeek Game Studios — DSH port of the Claude Code Game Studios template`""
Show-Cmd 'git tag -a <tag> -m <tag>'
if ([string]::IsNullOrWhiteSpace($MainRepoUrl)) {
  Show-Cmd 'git remote add origin <main-repo-url>'
  Show-Cmd 'git push -u origin main --tags'
} else {
  Show-Cmd "git remote add origin $MainRepoUrl"
  Show-Cmd 'git push -u origin main --tags'
}

if ($Confirm) {
  Push-Location $root
  try {
    Run 'git' @('add', '-A') $root
    Run 'git' @('-c', "user.name=$GitUserName", '-c', "user.email=$GitUserEmail",
      'commit', '-m', 'DeepSeek Game Studios — DSH port of the Claude Code Game Studios template') $root
    Run 'git' @('tag', '-a', $Tag, '-m', $Tag) $root
    if (-not [string]::IsNullOrWhiteSpace($MainRepoUrl)) {
      $hasMainRemote = [bool](& git remote 2>$null)
      if (-not $hasMainRemote) { Run 'git' @('remote', 'add', 'origin', $MainRepoUrl) $root }
      Run 'git' @('push', '-u', 'origin', 'main', '--tags') $root
    }
  } finally { Pop-Location }
} else {
  Write-Host "`nDry run complete. Re-run with -Confirm once the addresses are right." -ForegroundColor Green
}


