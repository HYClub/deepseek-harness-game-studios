# dsgs-init.ps1 — 从机器级载荷把一个空目录初始化成 DSGS 项目（幂等、不覆盖已有文件）。
#
# 用户视角：空文件夹 → 新会话 → 说「初始化 DSGS」→ agent 跑本脚本 → 说「/start」。
#
#   pwsh -NoProfile -File "$env:USERPROFILE.dsh\dsgs\tools\dsgs-init.ps1" -Target . -Confirm
#   pwsh -NoProfile -File ... -Target . -Confirm -Undo     # 只删本脚本写过的东西（按标记文件）
#
# 载荷默认在 $env:USERPROFILE.dsh\dsgs（由 tools/install-global.ps1 建立）。
#
# @module tools/dsgs-init.ps1

[CmdletBinding()]
param(
  [string]$Target = '.',
  [string]$Payload = (Join-Path $env:USERPROFILE '.dsh\DSGS'),
  [switch]$Undo,
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$Target = [System.IO.Path]::GetFullPath($Target)
$Payload = [System.IO.Path]::GetFullPath($Payload)
$marker = Join-Path $Target '.dsgs-installed.json'

# 要铺的框架载体；项目目录只建空的
$frameworkDirs = @('.claude', '.dsh', 'dsh-src', 'tools', 'docs', 'DSGS Skill Testing Framework')
$frameworkFiles = @('AGENTS.md', 'CLAUDE.md', 'project.yaml', '.gitattributes', '.gitignore', 'LICENSE')
$projectDirs = @('design', 'production', 'src', 'assets', 'tests', 'prototypes')
# 框架自己的运行噪声：不铺
$never = @('production/session-logs', 'dist', '.smoke', '_external', '.verify-logs', '.local-backups', 'node_modules')

function Write-Utf8([string]$p, [string]$text) { New-Item -ItemType Directory -Force (Split-Path -Parent $p) | Out-Null; Set-Content $p $text -Encoding utf8 }

if ($Undo) {
  if (-not (Test-Path $marker)) { Write-Host "没有初始化标记，拒绝撤销：$marker" -ForegroundColor Red; exit 2 }
  $m = Get-Content $marker -Raw | ConvertFrom-Json
  Write-Host "撤销：将删除本脚本写过的 $($m.written.Count) 项（仅这些）" -ForegroundColor Yellow
  foreach ($rel in $m.written) {
    $full = Join-Path $Target $rel
    if (Test-Path $full) { Write-Host "  - $rel"; Remove-Item $full -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  Write-Host '撤销完成。' -ForegroundColor Green
  exit 0
}

if (-not (Test-Path (Join-Path $Payload '.dsh\skills'))) {
  Write-Host "载荷不存在或不完整：$Payload" -ForegroundColor Red
  Write-Host '先跑一次：pwsh -File <DSGS 仓库>\tools\install-global.ps1 -Confirm' -ForegroundColor Yellow
  exit 3
}

$already = Test-Path $marker
if (-not $Confirm) {
  Write-Host 'dsgs-init: DRY RUN（加 -Confirm 才写入）' -ForegroundColor Cyan
  Write-Host "  载荷 : $Payload"
  Write-Host "  目标 : $Target"
  Write-Host "  标记 : $(if ($already) { '已存在（会补齐缺失项）' } else { '不存在（首次初始化）' })"
  Write-Host "  会铺 : $((($frameworkDirs + $frameworkFiles) -join ', '))"
  Write-Host "  会建 : $($projectDirs -join ', ')"
  exit 0
}

Write-Host "dsgs-init: 从载荷初始化 $Target" -ForegroundColor Cyan
$written = New-Object System.Collections.Generic.List[string]

foreach ($item in ($frameworkDirs + $frameworkFiles)) {
  $from = Join-Path $Payload $item
  if (-not (Test-Path $from)) { continue }
  # 文件：已存在就不覆盖；目录：递归补齐缺失文件（同名文件不覆盖）
  if ((Get-Item $from).PSIsContainer) {
    Get-ChildItem $from -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($Payload.Length + 1)
      if ($never | Where-Object { $rel -like "$_*" }) { return }
      $dest = Join-Path $Target $rel
      if (Test-Path $dest) { return }
      New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
      Copy-Item $_.FullName $dest -Force
      $written.Add($rel) | Out-Null
    }
  } else {
    $dest = Join-Path $Target $item
    if (-not (Test-Path $dest)) { Copy-Item $from $dest -Force; $written.Add($item) | Out-Null }
  }
}
foreach ($dir in $projectDirs) {
  if (-not (Test-Path (Join-Path $Target $dir))) { New-Item -ItemType Directory -Force (Join-Path $Target $dir) | Out-Null; $written.Add($dir + '/') | Out-Null }
}

$payloadVersion = '0.1.0'
if (Test-Path (Join-Path $Payload 'project.yaml')) { $payloadVersion = (Get-Content (Join-Path $Payload 'package-version.txt') -ErrorAction SilentlyContinue) ?? '0.1.0' }
$prior = @()
if ($already) { $prior = (Get-Content $marker -Raw | ConvertFrom-Json).written }
Write-Utf8 $marker (@{
  tool = 'dsgs-init'
  version = $payloadVersion
  payload = $Payload
  initializedAt = (Get-Date).ToString('s')
  written = @($prior + $written)
} | ConvertTo-Json -Depth 4)

Write-Host ("  ✔ 写入 {0} 项（已存在的一律未覆盖）" -f $written.Count) -ForegroundColor Green
Write-Host ("  标记：{0}" -f $marker)
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  /start           # 引导（会检测到引擎未配置并询问）'
Write-Host '  /statusline      # 打印工作室状态行'
Write-Host ("  撤销本次初始化：pwsh -File `"{0}`" -Target `"{1}`" -Undo" -f (Join-Path $Payload 'tools\dsgs-init.ps1'), $Target)



