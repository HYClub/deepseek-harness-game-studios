# tools/verify-all.ps1 — run every verification step and keep a durable log.
#
#   pwsh -File tools/verify-all.ps1                 # 完整跑一遍并写日志
#   pwsh -File tools/verify-all.ps1 -Note "重启前"   # 给这次运行加个标记
#   pwsh -File tools/verify-all.ps1 -SkipTests      # 跳过 24 个测试套件（快）
#
# 为什么要它：验证结果需要留痕。日志写到 .verify-logs\verify-<时间戳>.log，
# 并把最新一份复制成 .verify-logs\latest.log，方便事后（例如重启 dsh 之后）直接读。
#
# 退出码：0 = 仓库健康检查全部通过；1 = 有一步失败。
# 注意：钩子"活体"那一步是**信息性**的（重启 profile 前必然是 NOT mounted），
#       它只记录状态与退出码，不影响本脚本的退出码。
[CmdletBinding()]
param(
  [string]$Note = '',
  [switch]$SkipTests
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$logDir = Join-Path $root '.verify-logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir "verify-$stamp.log"
New-Item -ItemType File -Force -Path $log | Out-Null

function Write-Log {
  param([string]$Text = '')
  # Deliberately NOT Tee-Object: that writes into the PowerShell output stream, which
  # would merge with this script's return values and break `-ne 0` comparisons.
  Write-Host $Text
  Add-Content -Path $log -Value $Text
}

function Invoke-Section {
  param(
    [string]$Title,
    [scriptblock]$Body,
    [switch]$Informational
  )
  Write-Log ''
  Write-Log "=== $Title ==="
  # Stream the section: one of them runs 24 test suites and takes minutes, and capturing
  # the output first (to print it afterwards) makes the whole run look frozen.
  & $Body 2>&1 | ForEach-Object {
    Write-Host $_
    Add-Content -Path $log -Value $_
  }
  $code = $LASTEXITCODE
  if ($Informational) {
    Write-Log "[info] $Title — exit=$code（信息性，不计入总判定）"
    return $code
  }
  if ($code -eq 0) { Write-Log "[ok] $Title" }
  else { Write-Log "[FAIL] $Title (exit $code)" }
  return $code
}

$failures = @()

Write-Log "DSH port verification — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
if ($Note -ne '') { Write-Log "note: $Note" }
Write-Log "root: $root"
Write-Log "log : $log"

# ------------------------------------------------------------------ environment
Write-Log ''
Write-Log '=== environment ==='
$envLines = @()
$envLines += 'powershell : ' + $PSVersionTable.PSVersion.ToString()
$envLines += 'node       : ' + (& node --version 2>&1)
$envLines += 'dsh        : ' + (& dsh --version 2>&1)
$envLines += 'DSH_HOME   : ' + $env:DSH_HOME
$envLines += 'DSH_PROFILE: ' + $env:DSH_PROFILE
$envLines | ForEach-Object { Write-Log "  $_" }

$dshPkg = Join-Path ($env:APPDATA) 'npm/node_modules/@deepseek-ai/dsh/package.json'
if (Test-Path $dshPkg) {
  $dshVersion = (Get-Content $dshPkg -Raw | ConvertFrom-Json).version
  Write-Log "  dsh runtime version: $dshVersion"
}
$gitHead = & git -C $root rev-parse --short HEAD 2>&1
if ($LASTEXITCODE -eq 0) { Write-Log "  git HEAD: $gitHead" } else { Write-Log '  git HEAD: (还没有提交)' }

# ------------------------------------------------------- profile / bridge wiring
# A plain PowerShell (outside a dsh-spawned shell) has no DSH_* variables, so fall back
# to the standard locations instead of skipping this section.
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profileName = if ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }
$profileDir = if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $dshHome "profiles/$profileName" }
Write-Log ''
Write-Log '=== profile wiring ==='
Write-Log "  dsh home   : $dshHome"
Write-Log "  profile    : $profileName"
if ($profileDir -ne '' -and (Test-Path $profileDir)) {
  Write-Log "  profile dir: $profileDir"
  $pkg = Join-Path $profileDir 'package.json'
  if (Test-Path $pkg) {
    $p = Get-Content $pkg -Raw | ConvertFrom-Json
    Write-Log ('  bundles    : ' + (($p.dsh.profile.bundles) -join ', '))
    $deps = if ($p.dependencies) { ($p.dependencies.PSObject.Properties | ForEach-Object { "$($_.Name)@$($_.Value)" }) -join ', ' } else { '(none)' }
    Write-Log "  dependencies: $deps"
  }
  $bridgePkg = Join-Path $profileDir 'node_modules/@deepseek-ai/dsh-hooks-claude-code/package.json'
  if (Test-Path $bridgePkg) {
    Write-Log ('  profile-local bridge: ' + (Get-Content $bridgePkg -Raw | ConvertFrom-Json).version)
  } else {
    Write-Log '  profile-local bridge: (无本地副本，解析会回落到 dsh 自带的那份)'
  }
} else {
  Write-Log '  (未能定位 profile 目录，跳过)'
}

# ------------------------------------------------------------------- the checks
if ((Invoke-Section '1/5 preflight-hooks（挂载前静态条件）' { & node tools/preflight-hooks.mjs }) -ne 0) { $failures += 'preflight-hooks' }

$portArgs = @('-NoProfile', '-File', (Join-Path $root 'tools/verify-port.ps1'))
if ($SkipTests) { $portArgs += '-SkipTests' }
if ((Invoke-Section '2/5 verify-port（生成/结构/引用/协议/挂载/测试）' { & pwsh @portArgs }) -ne 0) { $failures += 'verify-port' }

Invoke-Section '3/5 check-hooks-live（信息性：钩子是否已在会话里跑过）' { & pwsh -NoProfile -File (Join-Path $root 'tools/check-hooks-live.ps1') } -Informational | Out-Null

Invoke-Section '4/5 配置解析抽查' {
  & node tools/yaml-helper.mjs resolve_config --keys review_mode,workflow,qa.level,team.size
  Write-Output "resolve_code_root : $(& node tools/yaml-helper.mjs __call resolve_code_root)"
  & node tools/yaml-helper.mjs __call session_state_enabled
  Write-Output "session_state_enabled exit=$LASTEXITCODE (0=on)"
} | Out-Null

Invoke-Section '5/5 审计日志内容（若存在）' {
  $audit = Join-Path $root 'production/session-logs/agent-audit.log'
  if (Test-Path $audit) { Get-Content $audit -Tail 5 } else { Write-Output '(不存在 —— 钩子还没在会话里跑过)' }
} | Out-Null

# ---------------------------------------------------------------------- summary
Write-Log ''
Write-Log '=== summary ==='
if ($failures.Count -eq 0) {
  Write-Log '  仓库健康检查：全部通过'
} else {
  Write-Log ('  失败：' + ($failures -join ', '))
}
Write-Log "  日志：$log"

Copy-Item $log (Join-Path $logDir 'latest.log') -Force
Write-Log "  最新日志副本：$(Join-Path $logDir 'latest.log')"

Pop-Location
exit $(if ($failures.Count -eq 0) { 0 } else { 1 })
