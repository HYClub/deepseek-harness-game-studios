# setup.ps1 — register DSGS's hook bridge with a cloned copy of this repository.
#
# Publishing is not required and no remote is touched: the user clones the repository and runs this
# once. It writes a **profile patch row** pointing at the plugin file inside that clone.
#
# Why a patch row and not `dsh plugin add <directory>`:
#
#   `dsh plugin --profile <p> add <dir>` writes a correct manifest (`dependencies: { …, "link:<dir>" }`
#   plus the bundle entry) — but a profile it creates **hangs on boot**. Reproduced twice: once with
#   this repository's root, once with a small unrelated package. The very same plugin loaded through
#   a `--patch` row pointing at its file boots normally (and this repository's own live `web` profile
#   has used exactly such a row all along). Until that install path is understood, this script uses
#   the mechanism that is proven to boot.
#
#   pwsh -File tools/setup.ps1                       # dry run: prints the row it would add
#   pwsh -File tools/setup.ps1 -Confirm              # writes it into the `web` profile
#   pwsh -File tools/setup.ps1 -Confirm -Profile p   # or another profile
#
# Restart the harness afterwards: profile rows mount at startup.
#
# @module tools/setup.ps1

[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$PluginPath = '',
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$candidates = @()
if (-not [string]::IsNullOrWhiteSpace($PluginPath)) { $candidates += $PluginPath }
$candidates += (Join-Path $root 'dist/dsgs-hooks')
$candidates += (Join-Path $root 'tools/dsh-plugin')
$plugin = $candidates | Where-Object { Test-Path (Join-Path $_ 'index.js') } | Select-Object -First 1
if ($null -eq $plugin) {
  Write-Host 'setup: no plugin entry found. Looked in:' -ForegroundColor Red
  $candidates | ForEach-Object { Write-Host "  $_" }
  exit 2
}

$entry = (Join-Path $plugin 'index.js').Replace('\', '/')
$profileDir = Join-Path $env:USERPROFILE ".dsh/profiles/$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$hooksConfig = (Join-Path $root '.dsh/hooks.json').Replace('\', '/')

$row = @"
- insert:
    - id: dsgs-hooks
      name: "file:///$entry"
      config:
        configPath: "$hooksConfig"
"@

Write-Host 'setup: DSGS hook bridge' -ForegroundColor Cyan
Write-Host "  repository : $root"
Write-Host "  plugin     : $entry"
Write-Host "  hooks      : $hooksConfig"
Write-Host "  profile    : $Profile  ($(if (Test-Path $profileDir) { 'exists' } else { 'MISSING — create/run it once first' }))"
Write-Host "  patch file : $patchFile"
Write-Host "  mode       : $(if ($Confirm) { 'CONFIRM — the profile patch will be appended' } else { 'DRY RUN — nothing will change' })"

if (-not $Confirm) {
  Write-Host ''
  Write-Host 'The row it would append:' -ForegroundColor Yellow
  $row -split "`n" | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
  Write-Host 'Then restart the harness. Verify the hooks actually RUN (not merely that the row exists):'
  Write-Host '  node tools/verify-hooks-mount.mjs'
  exit 0
}

if (-not (Test-Path $profileDir)) {
  Write-Host "setup: profile '$Profile' does not exist. Start the harness with it once, then re-run." -ForegroundColor Red
  exit 2
}

$existing = if (Test-Path $patchFile) { Get-Content $patchFile -Raw } else { '' }
if ($existing -match 'id:\s*dsgs-hooks') {
  Write-Host 'setup: the patch already has a dsgs-hooks row — nothing to do.' -ForegroundColor Yellow
  exit 0
}

# Keep the profile's own layer valid: it is a YAML array of patch entries, and an added row must be
# a list item, so an empty `[]` is replaced rather than appended to.
$merged = if ($existing.Trim() -eq '' -or $existing.Trim() -eq '[]') { $row } else { "$existing`n$row" }
Set-Content $patchFile $merged -Encoding utf8

Write-Host ''
Write-Host "Wrote the dsgs-hooks row to $patchFile" -ForegroundColor Green
Write-Host 'Restart the harness, then confirm the hooks run: `node tools/verify-hooks-mount.mjs`.'

