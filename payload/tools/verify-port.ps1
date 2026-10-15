# tools/verify-port.ps1 — one entry point for the whole DSH-port verification.
#
#   pwsh -File tools/verify-port.ps1                 # everything
#   pwsh -File tools/verify-port.ps1 -SkipTests      # fast structural pass
#   pwsh -File tools/verify-port.ps1 -Filter hooks   # only suites whose name matches
#
# It runs the f（见仓库 README）al
# check, reference audit, and the behaviour test suites. Exit code 0 means every step
# passed; 1 means at least one failed (the failing suites are listed at the end).
#
# Windows note: nothing here captures a child's output through a pipe at the Node
# level; PowerShell's own pipeline is fine, and the ported hooks/scripts use
# file-redirect capture internally so they work inside the confined sandbox too.
[CmdletBinding()]
param(
  [switch]$SkipTests,
  [string]$Filter = ''
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

$results = [ordered]@{}

function Invoke-Step {
  param([string]$Name, [scriptblock]$Body)
  Write-Host ''
  Write-Host "=== $Name ===" -ForegroundColor Cyan
  & $Body
  $code = $LASTEXITCODE
  $results[$Name] = $code
  if ($code -eq 0) { Write-Host "[ok] $Name" -ForegroundColor Green }
  else { Write-Host "[FAIL] $Name (exit $code)" -ForegroundColor Red }
  return $code
}

try {
  Invoke-Step '1/7 regenerate .dsh' { node tools/build-dsh.mjs } | Out-Null
  Invoke-Step '2/7 structural check' { node tools/check-dsh.mjs } | Out-Null
  Invoke-Step '3/7 skill reference audit' { node tools/audit-skill-refs.mjs } | Out-Null
  Invoke-Step '4/7 content fidelity (no missing prose)' { node tools/verify-fidelity.mjs } | Out-Null
  Invoke-Step '5/7 hook bridge protocol' { node tools/verify-hooks-bridge.mjs } | Out-Null
  Invoke-Step '6/7 hook bridge mount' { node tools/verify-hooks-mount.mjs } | Out-Null

  if (-not $SkipTests) {
    Write-Host ''
    Write-Host '=== 7/7 behaviour tests ===' -ForegroundColor Cyan
    $suites = @()
    $suites += Get-ChildItem (Join-Path $root 'tools/tests') -Recurse -Filter '*.test.mjs'
    $yamlHelperTest = Join-Path $root 'tools/yaml-helper.test.mjs'
    if (Test-Path $yamlHelperTest) { $suites += Get-Item $yamlHelperTest }

    $failed = @()
    $passed = 0
    foreach ($suite in ($suites | Sort-Object FullName)) {
      if ($Filter -ne '' -and $suite.Name -notlike "*$Filter*") { continue }
      $args = @()
      if ($suite.Name -eq 'yaml-helper.test.mjs') { $args = @('--node-only') }
      $output = & node $suite.FullName @args 2>&1
      $code = $LASTEXITCODE
      $summary = ($output | Select-String -Pattern 'passed|通过|fail' | Select-Object -Last 1).Line
      if ($code -eq 0) {
        $passed++
        Write-Host ("  ok   {0,-34} {1}" -f $suite.Name, ($summary -replace '\s+', ' '))
      } else {
        $failed += $suite.Name
        Write-Host ("  FAIL {0,-34}" -f $suite.Name) -ForegroundColor Red
        $output | Select-Object -Last 8 | ForEach-Object { Write-Host "       $_" }
      }
    }
    $results["7/7 behaviour tests ($passed passed, $($failed.Count) failed)"] = $(if ($failed.Count -eq 0) { 0 } else { 1 })
    if ($failed.Count -gt 0) { Write-Host "  failing: $($failed -join ', ')" -ForegroundColor Red }
  }

  Write-Host ''
  Write-Host '=== summary ===' -ForegroundColor Cyan
  foreach ($entry in $results.GetEnumerator()) {
    $mark = if ($entry.Value -eq 0) { 'ok  ' } else { 'FAIL' }
    Write-Host ("  {0} {1}" -f $mark, $entry.Key)
  }
  $worst = ($results.Values | Measure-Object -Maximum).Maximum
  exit $worst
} finally {
  Pop-Location
}




