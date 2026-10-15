# install-global.ps1 — 机器级安装 DSGS：建载荷 + 装"引导技能"，之后任何空文件夹都能"初始化 DSGS"。
#
#   pwsh -File tools/install-global.ps1                 # dry run
#   pwsh -File tools/install-global.ps1 -Confirm        # 真的装
#   pwsh -File tools/install-global.ps1 -Confirm -InstallPlugin   # 顺带把插件装进 profile
#
# 装三样东西（都在用户级，不在任何项目里）：
#   1) 载荷  ~/.dsh/dsgs/**                 ← 框架本体（初始化项目时从这里铺）
#   2) 引导技能 ~/.dsh/skills/dsgs-init/SKILL.md  ← 让"初始化 DSGS"这句话在**任何**工作区都能被理解
#   3) 可选：把插件装进 profile（钩子桥）
#
# @module tools/install-global.ps1

[CmdletBinding()]
param(
  [string]$Source = (Split-Path -Parent $PSScriptRoot),
  [string]$Payload = (Join-Path $env:USERPROFILE '.dsh\DSGS'),
  [string]$SkillsHome = (Join-Path $env:USERPROFILE '.dsh\skills'),
  [string]$Profile = 'web',
  [switch]$InstallPlugin,
  [switch]$Confirm
)

$ErrorActionPreference = 'Stop'
$Source = [System.IO.Path]::GetFullPath($Source)
$Payload = [System.IO.Path]::GetFullPath($Payload)
$SkillsHome = [System.IO.Path]::GetFullPath($SkillsHome)

$frameworkDirs = @('.claude', '.dsh', 'dsh-src', 'tools', 'docs', 'DSGS Skill Testing Framework')
$frameworkFiles = @('AGENTS.md', 'CLAUDE.md', 'project.yaml', '.gitattributes', '.gitignore', 'LICENSE')
$skipTop = @('README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'UPGRADING.md', 'out.txt', '.github', 'dist', '.smoke', '_external', '.verify-logs', '.local-backups', 'node_modules', '.git')
$skipRel = @('production/session-logs', 'docs/README-port-original.md', 'docs/README.preview.html', 'docs/README.zh-CN.preview.html', 'docs/license-sidebar-diagram.svg', 'docs/awesome-submission-HYClub__deepseek-harness-game-studios.yml', 'dsh-src/package-CHANGELOG.md')

Write-Host 'install-global: 机器级安装 DSGS' -ForegroundColor Cyan
Write-Host "  框架来源 : $Source"
Write-Host "  载荷     : $Payload"
Write-Host "  技能目录 : $SkillsHome"
Write-Host "  模式     : $(if ($Confirm) { 'CONFIRM — 会写入' } else { 'DRY RUN — 不写' })"
if (-not (Test-Path (Join-Path $Source '.dsh\skills'))) { Write-Host "  来源不像 DSGS 框架：$Source" -ForegroundColor Red; exit 2 }
if (-not $Confirm) {
  Write-Host ''
  Write-Host '会做：' -ForegroundColor Yellow
  Write-Host "  1) 复制框架到载荷 $Payload"
  Write-Host "  2) 写引导技能 $SkillsHome\dsgs-init\SKILL.md"
  if ($InstallPlugin) { Write-Host "  3) dsh plugin --profile $Profile add <dist 包>" }
  Write-Host ''
  Write-Host '之后用户流程：空文件夹 → 新会话 → 说「初始化 DSGS」→ 说「/start」'
  exit 0
}

# --- ① 载荷 -------------------------------------------------------------------
if (Test-Path $Payload) { Write-Host '  载荷已存在，增量补齐…' -ForegroundColor DarkGray } else { New-Item -ItemType Directory -Force $Payload | Out-Null }
foreach ($item in ($frameworkDirs + $frameworkFiles)) {
  $from = Join-Path $Source $item
  if (-not (Test-Path $from)) { continue }
  if ((Get-Item $from).PSIsContainer) {
    Get-ChildItem $from -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($Source.Length + 1)
      if ($skipRel | Where-Object { $rel -like "$_*" }) { return }
      $dest = Join-Path $Payload $rel
      New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
      Copy-Item $_.FullName $dest -Force
    }
  } else {
    Copy-Item $from (Join-Path $Payload $item) -Force
  }
}
Set-Content (Join-Path $Payload 'package-version.txt') '0.1.0' -Encoding utf8
Write-Host "  ✔ 载荷就绪：$Payload" -ForegroundColor Green

# --- ② 引导技能（让"初始化 DSGS"在任何工作区都可执行）---------------------------
$initPs1 = Join-Path $Payload 'tools\dsgs-init.ps1'
$skill = @"
---
name: dsgs-init
description: "初始化 DeepSeek Game Studios（DSGS）到当前工作区。用户说\"初始化 DSGS\"\"安装 DSGS\"\"把 DSGS 装到这个目录\"时用这个技能：它从机器级载荷铺框架（技能/代理/规则/钩子/工具/文档/指令），然后让用户可以直接 /start。幂等，绝不覆盖已有文件。"
user-invocable: true
---

# DSGS 初始化（initialize DSGS in this workspace）

用户在**空文件夹**里说"初始化 DSGS"时执行本技能。DSGS 的机器级载荷安装在这台机器上：

- 载荷：``$Payload``
- 初始化脚本：``$initPs1``

## 做什么

1. 先跑 dry run 看会写什么（**不要跳过这一步**）：

   ```pwsh
   pwsh -NoProfile -File "$initPs1" -Target . 
   ```

2. 向用户复述要点，然后真的初始化（用户的"初始化 DSGS"就是授权）：

   ```pwsh
   pwsh -NoProfile -File "$initPs1" -Target . -Confirm
   ```

3. 报告：写入了多少项、标记文件路径（``.dsgs-installed.json``）、以及下一步。

## 规则

- **幂等**：脚本只补缺失文件，**绝不覆盖**已存在的文件；重复运行安全。
- 如果工作区**已经有** ``.dsh/skills``（说明已经是 DSGS 项目），不要重新初始化——告诉用户可以直接 ``/start``，
  或按需 ``pwsh -NoProfile -File "$initPs1" -Target . -Confirm`` 补齐缺失项。
- 撤销：``pwsh -NoProfile -File "$initPs1" -Target . -Undo``（只删它标记过的项）。
- 初始化完成后，让用户**新开一个会话**再用 ``/start``（技能目录在会话启动时装载；同一会话能否立刻看到新技能不确定）。

## 初始化之后

``/start`` → 引导（检测引擎未配置并询问）→ ``/setup-engine`` → ``/statusline``。
"@
New-Item -ItemType Directory -Force (Join-Path $SkillsHome 'dsgs-init') | Out-Null
Set-Content (Join-Path $SkillsHome 'dsgs-init\SKILL.md') $skill -Encoding utf8
Write-Host "  ✔ 引导技能：$SkillsHome\dsgs-init\SKILL.md" -ForegroundColor Green

# --- ③ 可选：装插件 -----------------------------------------------------------
if ($InstallPlugin) {
  $pkg = Join-Path $Source 'dist\deepseek-harness-game-studios'
  if (-not (Test-Path $pkg)) { Write-Host "  没有 $pkg —— 先跑 node tools/build-dsgs-package.mjs" -ForegroundColor Red; exit 3 }
  & dsh plugin --profile $Profile add $pkg
  if ($LASTEXITCODE -ne 0) { Write-Host "  插件安装失败 exit $LASTEXITCODE" -ForegroundColor Red; exit $LASTEXITCODE }
  Write-Host "  ✔ 插件已装进 profile $Profile（需重启 dsh web 生效）" -ForegroundColor Green
}

Write-Host ''
Write-Host '机器级安装完成。用户流程：' -ForegroundColor Cyan
Write-Host '  1) 新建一个空文件夹，作为工作区开新会话'
Write-Host '  2) 说：「初始化 DSGS」'
Write-Host '  3) 说：「/start」'





