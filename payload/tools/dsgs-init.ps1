# dsgs-init.ps1 — 从机器级载荷把一个空目录初始化成 DSGS 项目（幂等、不覆盖已有文件）。
#
# 用户视角：空文件夹 → 新会话 → 说「初始化 DSGS」→ agent 跑本脚本 → 说「/start」。
#
#   pwsh -NoProfile -File "$env:USERPROFILE\.dsh\dsgs\tools\dsgs-init.ps1" -Target . -Confirm
#   pwsh -NoProfile -File ... -Target . -Undo              # 只打印撤销计划（DRY RUN）
#   pwsh -NoProfile -File ... -Target . -Undo -Confirm     # 真的撤销
#
# 载荷默认在 $env:USERPROFILE\.dsh\dsgs（由插件自安装 / tools/install-global.ps1 建立）。
#
# @module tools/dsgs-init.ps1

[CmdletBinding()]
param(
  [string]$Target = '.',
  # Windows uses USERPROFILE; macOS/Linux (pwsh) only set HOME. Keep the same directory name the
  # self-installer writes (`dsgs`, lowercase) — on a case-sensitive filesystem `DSGS` was a second copy.
  [string]$Payload = (Join-Path (Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }) '.dsh') 'dsgs'),
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

# 记录"这次新建"的目录（含中间层）。撤销时只清自己建的，否则初始化前就存在的空目录也会被删掉。
function Record-CreatedParents([string]$leaf, [string]$base) {
  $missing = New-Object System.Collections.Generic.List[string]
  $d = $leaf
  while ($d.Length -gt $base.Length -and -not (Test-Path $d)) {
    $missing.Add(($d.Substring($base.Length + 1) -replace '\\', '/'))
    $d = Split-Path -Parent $d
  }
  for ($i = $missing.Count - 1; $i -ge 0; $i--) {
    if (-not $script:createdDirs.Contains($missing[$i])) { $script:createdDirs.Add($missing[$i]) | Out-Null }
  }
}

if ($Undo) {
  if (-not (Test-Path $marker)) { Write-Host "没有初始化标记，拒绝撤销：$marker" -ForegroundColor Red; exit 2 }
  # 标记由 Set-Content 非原子写入，崩溃可能留下半截 JSON；那不是一个可以继续撤销的状态。
  # `ConvertFrom-Json` returns $null for an empty file without throwing, so check the shape too —
  # a 0-byte marker used to "undo" nothing and still exit 0.
  $m = $null
  try {
    $m = Get-Content $marker -Raw | ConvertFrom-Json
  } catch {
    $m = $null
    $parseError = $_.Exception.Message
  }
  if ($null -eq $m -or $m -isnot [System.Management.Automation.PSCustomObject]) {
    Write-Host "标记文件损坏（空或不是对象），拒绝撤销：$marker" -ForegroundColor Red
    if ($parseError) { Write-Host ('  ' + $parseError) -ForegroundColor DarkGray }
    Write-Host '  检查或删除该文件后重跑（删除它只会让撤销失效，不会动你的文件）。' -ForegroundColor Yellow
    exit 2
  }

  # 老标记把项目目录写成 "src/"（带斜杠）混在 written 里；新标记分开记。两种都认。
  $dirs = New-Object System.Collections.Generic.List[string]
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($rel in @($m.written | Where-Object { $_ })) {
    if ($rel.EndsWith('/') -or $rel.EndsWith('\')) { $dirs.Add($rel.TrimEnd('/', '\')) } else { $files.Add($rel) }
  }
  foreach ($rel in @($m.createdDirs | Where-Object { $_ })) { $dirs.Add($rel.TrimEnd('/', '\')) }

  # 只删"本脚本写入的文件"。目录只在仍然为空时才删——初始化之后用户放进 src/、design/ 的东西
  # 不能因为一句 -Undo 就消失（这是旧版本的真实事故）。
  $deleteFiles = @($files | Where-Object {
    $full = Join-Path $Target $_
    (Test-Path $full) -and -not (Get-Item $full).PSIsContainer
  })
  # The plan must describe the END state, not the current one: a directory that only holds files
  # scheduled for deletion will be empty afterwards and is removed, so calling it "kept" makes the
  # dry run lie. Build the sets the predicate consults, then judge every recorded directory.
  $deleteFileSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($rel in $deleteFiles) { [void]$deleteFileSet.Add((Join-Path $Target $rel)) }
  $dirSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($rel in ($dirs | Select-Object -Unique)) { [void]$dirSet.Add((Join-Path $Target $rel)) }

  function Test-DirKeepsUserContent([string]$full) {
    foreach ($child in @(Get-ChildItem $full -Force -ErrorAction SilentlyContinue)) {
      if ($child.PSIsContainer) {
        # A directory the script never recorded is user-made: keep it and its parents.
        if (-not $dirSet.Contains($child.FullName)) { return $true }
        if (Test-DirKeepsUserContent $child.FullName) { return $true }
      } elseif (-not $deleteFileSet.Contains($child.FullName)) {
        return $true
      }
    }
    return $false
  }

  $deleteDirs = @()
  $keptDirs = @()
  foreach ($rel in ($dirs | Select-Object -Unique)) {
    $full = Join-Path $Target $rel
    if (-not (Test-Path $full)) { continue }
    if (-not (Get-Item $full).PSIsContainer) { continue }
    if (Test-DirKeepsUserContent $full) { $keptDirs += $rel } else { $deleteDirs += $rel }
  }

  Write-Host ("撤销计划：删除 {0} 个文件、{1} 个空目录；保留 {2} 个非空目录" -f $deleteFiles.Count, $deleteDirs.Count, $keptDirs.Count) -ForegroundColor Yellow
  foreach ($rel in $deleteFiles) { Write-Host "  delete  $rel" }
  foreach ($rel in $deleteDirs) { Write-Host "  delete  $rel/（已空）" }
  foreach ($rel in $keptDirs) { Write-Host "  keep    $rel/（非空：里面有你的文件）" -ForegroundColor DarkGray }
  if (-not $Confirm) { Write-Host '这是 DRY RUN：加 -Confirm 才真的删除。' -ForegroundColor Cyan; exit 0 }

  $failures = 0
  foreach ($rel in $deleteFiles) {
    try { Remove-Item (Join-Path $Target $rel) -Force -ErrorAction Stop }
    catch { $failures++; Write-Host "  ! 删不掉 $rel：$($_.Exception.Message)" -ForegroundColor Red }
  }
  foreach ($rel in ($deleteDirs | Sort-Object -Property Length -Descending)) {
    try { Remove-Item (Join-Path $Target $rel) -Force -ErrorAction Stop }
    catch { $failures++; Write-Host "  ! 删不掉 $rel：$($_.Exception.Message)" -ForegroundColor Red }
  }
  if ($failures -gt 0) {
    Write-Host "撤销未完成：$failures 项失败，标记文件保留，可修好后重跑。" -ForegroundColor Red
    exit 1
  }
  # 只清"本脚本建过、现在是空的"目录（从深到浅）。用记录而不是全树扫描——扫描会把用户在初始化
  # 之前就有的空目录也删掉，实测踩到过。
  $emptied = 0
  $recorded = @($dirs | Select-Object -Unique | Sort-Object -Property Length -Descending)
  foreach ($rel in $recorded) {
    $full = Join-Path $Target $rel
    if (-not (Test-Path $full)) { continue }
    if (-not (Get-Item $full).PSIsContainer) { continue }
    if (@(Get-ChildItem $full -Force -ErrorAction SilentlyContinue).Count -ne 0) { continue }
    try { Remove-Item $full -Force -ErrorAction Stop; $emptied++ } catch { }
  }
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  Write-Host "撤销完成（保留非空目录；清掉 $emptied 个本次创建的空目录）。" -ForegroundColor Green
  exit 0
}

if (-not (Test-Path (Join-Path (Join-Path $Payload '.dsh') 'skills'))) {
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
# 目录单独记：撤销时只在仍为空的情况下删，绝不能 -Recurse 删用户后来放进去的内容。
$createdDirs = New-Object System.Collections.Generic.List[string]

foreach ($item in ($frameworkDirs + $frameworkFiles)) {
  $from = Join-Path $Payload $item
  if (-not (Test-Path $from)) {
    # npm/pnpm drop `.gitignore` / `.gitattributes`; the payload keeps `<name>.template`, which still
    # lands under the real name in the project.
    $alt = Join-Path $Payload ($item + '.template')
    if (Test-Path $alt) { $from = $alt } else { continue }
  }
  # 文件：已存在就不覆盖；目录：递归补齐缺失文件（同名文件不覆盖）
  if ((Get-Item $from).PSIsContainer) {
    Get-ChildItem $from -Recurse -File -Force | ForEach-Object {
      $rel = $_.FullName.Substring($Payload.Length + 1)
      # A `.template` copy is the package manager's fallback; write it under the real name and never
      # put the `.template` spelling into the project.
      $destRel = if ($_.Name.EndsWith('.template')) { $rel.Substring(0, $rel.Length - '.template'.Length) } else { $rel }
      # $rel 是反斜杠路径，$never 用正斜杠写；先统一再比，否则 .verify-logs 这类规则永不命中。
      $relKey = $destRel -replace '\\', '/'
      if ($never | Where-Object { $relKey -like "$_*" }) { return }
      $dest = Join-Path $Target $destRel
      if (Test-Path $dest) { return }
      $parent = Split-Path -Parent $dest
      Record-CreatedParents $parent $Target
      New-Item -ItemType Directory -Force $parent | Out-Null
      Copy-Item $_.FullName $dest -Force
      $written.Add($destRel) | Out-Null
    }
  } else {
    $dest = Join-Path $Target $item
    if (-not (Test-Path $dest)) { Copy-Item $from $dest -Force; $written.Add($item) | Out-Null }
  }
}
foreach ($dir in $projectDirs) {
  if (-not (Test-Path (Join-Path $Target $dir))) { New-Item -ItemType Directory -Force (Join-Path $Target $dir) | Out-Null; $createdDirs.Add($dir) | Out-Null }
}

$payloadVersion = '0.1.0'
if (Test-Path (Join-Path $Payload 'project.yaml')) { $payloadVersion = (Get-Content (Join-Path $Payload 'package-version.txt') -ErrorAction SilentlyContinue) ?? '0.1.0' }
$prior = @()
$priorDirs = @()
if ($already) {
  $mm = Get-Content $marker -Raw | ConvertFrom-Json
  # 老标记的目录藏在 written 里（"src/"）；读出来时按结尾斜杠拆开，两种标记都能正确撤销。
  $prior = @($mm.written | Where-Object { $_ -and -not ($_.EndsWith('/') -or $_.EndsWith('\')) })
  $priorDirs = @($mm.createdDirs | Where-Object { $_ })
  $priorDirs += @($mm.written | Where-Object { $_ -and ($_.EndsWith('/') -or $_.EndsWith('\')) } | ForEach-Object { $_.TrimEnd('/', '\') })
}
Write-Utf8 $marker (@{
  tool = 'dsgs-init'
  version = $payloadVersion
  payload = $Payload
  initializedAt = (Get-Date).ToString('s')
  written = @($prior + $written)
  createdDirs = @($priorDirs + $createdDirs)
} | ConvertTo-Json -Depth 4)

Write-Host ("  ✔ 写入 {0} 项（已存在的一律未覆盖）" -f $written.Count) -ForegroundColor Green
Write-Host ("  标记：{0}" -f $marker)
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  /start           # 引导（会检测到引擎未配置并询问）'
Write-Host '  /statusline      # 打印工作室状态行'
Write-Host ("  撤销本次初始化：pwsh -File `"{0}`" -Target `"{1}`" -Undo          # 先看计划" -f (Join-Path $Payload 'tools\dsgs-init.ps1'), $Target)
Write-Host ("                     pwsh -File `"{0}`" -Target `"{1}`" -Undo -Confirm   # 确认删除" -f (Join-Path $Payload 'tools\dsgs-init.ps1'), $Target)



