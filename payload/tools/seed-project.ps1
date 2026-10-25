# seed-project.ps1 — 把一个空目录变成 DSGS 项目（铺框架 + 可选装插件）。
#
# 用法（在空目录里，或在任何地方指定 -Target）：
#   pwsh -File tools\seed-project.ps1 -Target .\mygame            # dry run，只打印
#   pwsh -File tools\seed-project.ps1 -Target .\mygame -Confirm  # 真的铺
#   pwsh -File tools\seed-project.ps1 -Target .\mygame -Confirm -Install   # 再装插件
#
# 为什么需要它：DSH 的技能来自「项目里的 .dsh/skills」或「用户级 ~/.dsh/skills」，**插件安装带不来技能**。
# 所以"空目录 → 能用的 DSGS 项目"这一步，本质是把框架铺进去（上游也是这个用法：clone 模板当项目）。
#
# @module tools/seed-project.ps1

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$Profile = 'web',
  [switch]$Install,
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$Target = [System.IO.Path]::GetFullPath($Target)
$Source = [System.IO.Path]::GetFullPath($Source)

# 框架载体：技能/代理/规则/钩子/工具/文档/指令/配置模板
$frameworkDirs = @('.claude', '.dsh', 'dsh-src', 'tools', 'docs', 'DSGS Skill Testing Framework')
$frameworkFiles = @('AGENTS.md', 'CLAUDE.md', 'project.yaml', '.gitattributes', '.gitignore', 'LICENSE')
# 项目目录（框架自带的分目录指令与登记表模板会被一并复制，其余为空）
$projectDirs = @('design', 'production', 'src', 'assets', 'tests', 'prototypes')
# 框架自己的展示类文件：不复制
$skip = @('README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'UPGRADING.md', '.github', 'dist', '.smoke', '_external', '.verify-logs', '.local-backups', 'node_modules', 'out.txt')

Write-Host 'seed-project: 把空目录变成 DSGS 项目' -ForegroundColor Cyan
Write-Host "  框架来源 : $Source"
Write-Host "  目标目录 : $Target"
Write-Host "  模式     : $(if ($Confirm) { 'CONFIRM — 会写入文件' } else { 'DRY RUN — 不写任何东西' })"

if (-not (Test-Path (Join-Path $Source '.dsh/skills'))) { Write-Host "  来源不像 DSGS 框架：$Source" -ForegroundColor Red; exit 2 }
if (-not (Test-Path $Target)) { if ($Confirm) { New-Item -ItemType Directory -Force $Target | Out-Null } else { Write-Host '  （目标不存在，-Confirm 时会创建）' } }

$existing = @(Get-ChildItem $Target -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.' })
if ($existing.Count -gt 0) { Write-Host "  注意：目标目录已有 $($existing.Count) 项，同名项会被覆盖" -ForegroundColor Yellow }

if (-not $Confirm) {
  Write-Host ''
  Write-Host '会复制：' -ForegroundColor Yellow
  ($frameworkDirs + $frameworkFiles) | ForEach-Object { Write-Host "  $_" }
  Write-Host "会创建/保留的项目目录：$($projectDirs -join ', ')"
  Write-Host "会跳过（框架展示类）：$($skip -join ', ')"
  if ($Install) { Write-Host "最后会执行：dsh plugin --profile $Profile add `"$Source\dist/deepseek-harness-game-studios`"" }
  Write-Host ''
  Write-Host '加上 -Confirm 才会真的执行。'
  exit 0
}

foreach ($item in ($frameworkDirs + $frameworkFiles)) {
  $from = Join-Path $Source $item
  if (-not (Test-Path $from)) { Write-Host "  跳过（来源没有）：$item" -ForegroundColor DarkGray; continue }
  Copy-Item $from (Join-Path $Target $item) -Recurse -Force
}
foreach ($dir in $projectDirs) { New-Item -ItemType Directory -Force (Join-Path $Target $dir) | Out-Null }
# 不把框架自己的运行日志带进新项目
Remove-Item (Join-Path $Target 'production/session-logs') -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "  ✔ 框架已铺到 $Target" -ForegroundColor Green

if ($Install) {
  $pkg = Join-Path $Source 'dist/deepseek-harness-game-studios'
  if (-not (Test-Path $pkg)) { Write-Host "  没有 $pkg —— 先跑 node tools/build-dsgs-package.mjs" -ForegroundColor Red; exit 3 }
  Write-Host "  装插件：dsh plugin --profile $Profile add $pkg"
  & dsh plugin --profile $Profile add $pkg
  if ($LASTEXITCODE -ne 0) { Write-Host "  插件安装失败，exit $LASTEXITCODE" -ForegroundColor Red; exit $LASTEXITCODE }
  Write-Host '  ✔ 插件已装（**需要重启 dsh web 才生效**）' -ForegroundColor Green
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host "  1) 在 GUI 里把工作区指向 $Target 并新建会话"
Write-Host '  2) 重启 dsh web（如果装了插件）'
Write-Host '  3) 会话里依次：/start → /setup-engine → /statusline'



