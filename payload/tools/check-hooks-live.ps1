# tools/check-hooks-live.ps1 — did the DSGS hook bridge actually mount in this session?
#
#   pwsh -File tools/check-hooks-live.ps1
#
# Background: the hook bridge (@deepseek-ai/dsh-hooks-claude-code) is a profile plugin.
# A patch edit cannot hot-mount a *new* plugin into a running session, so the hooks stay
# dormant until the profile is restarted. This script reports the observable evidence
# instead of guessing:
#
#   * the SubagentStart/SubagentStop hooks append to
#     production/session-logs/agent-audit.log on every delegation, so a fresh line there
#     after a subagent spawn means the bridge is live;
#   * the SkillChange advice fires on writes under .claude/skills or .dsh/skills.
#
# If the log is absent or stale, restart the profile (dsh web / the app), then spawn any
# subagent and run this again.
[CmdletBinding()]
param([int]$FreshMinutes = 30)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$audit = Join-Path $root 'production/session-logs/agent-audit.log'
$decisionLog = Join-Path $root 'production/session-logs/decision-log.md'
$hooksJson = Join-Path $root '.dsh/hooks.json'

Write-Host '=== hook bridge status ===' -ForegroundColor Cyan

if (-not (Test-Path $hooksJson)) {
  Write-Host '  hooks.json missing — run: node tools/build-dsh.mjs' -ForegroundColor Red
  exit 1
}
$config = Get-Content $hooksJson -Raw | ConvertFrom-Json
$enabled = 0
foreach ($event in $config.hooks.PSObject.Properties) {
  foreach ($group in $event.Value) { foreach ($hook in $group.hooks) { $enabled++ } }
}
Write-Host ("  hooks.json: {0} enabled command(s), {1} pending port(s)" -f `
  $enabled, $(if ($config.'$pendingPorts') { $config.'$pendingPorts'.Count } else { 0 }))

if (-not (Test-Path $audit)) {
  Write-Host '  agent-audit.log: absent — no subagent has been logged yet' -ForegroundColor Yellow
  Write-Host '  => the bridge is very likely NOT mounted (or no subagent ran since the restart).' -ForegroundColor Yellow
  Write-Host '     Restart the profile, spawn any subagent, then re-run this script.'
  exit 2
}

$info = Get-Item $audit
$age = [math]::Round(((Get-Date) - $info.LastWriteTime).TotalMinutes, 1)
Write-Host ("  agent-audit.log: {0} line(s), last written {1} min ago ({2})" -f `
  (Get-Content $audit | Measure-Object -Line).Lines, $age, $info.LastWriteTime)

Write-Host '  last entries:'
Get-Content $audit -Tail 3 | ForEach-Object { Write-Host "    $_" }

if (Test-Path $decisionLog) {
  Write-Host ("  decision-log.md: present, last written {0}" -f (Get-Item $decisionLog).LastWriteTime)
}

if ($age -le $FreshMinutes) {
  Write-Host '  => hook bridge is LIVE (a delegation was logged recently).' -ForegroundColor Green
  exit 0
}

Write-Host ("  => log is stale (> {0} min). Either no subagent ran since the restart, or the" -f $FreshMinutes) -ForegroundColor Yellow
Write-Host '     bridge is not mounted. Spawn a subagent and re-run before concluding.' -ForegroundColor Yellow
exit 3

